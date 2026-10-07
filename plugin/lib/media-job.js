import { existsSync, statSync } from 'node:fs';
import { runTool, safeCwd, tail } from './run.js';

/**
 * Parse ffmpeg's `-progress pipe:1` key=value stream, keeping the last value
 * seen for each key. Progress is a stream of blocks ending in `progress=end`,
 * so the final values describe the whole run.
 * @param stdout - the captured progress stream.
 * @returns the final progress values.
 */
export function parseProgress(stdout) {
  const values = {};
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!/^[a-z_]+$/u.test(key)) continue;
    values[key] = line.slice(eq + 1);
  }
  const seconds = values.out_time_us === undefined ? undefined : Number(values.out_time_us) / 1e6;
  return {
    outTimeSeconds: Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : undefined,
    speed: values.speed === 'N/A' ? undefined : values.speed,
    frame: values.frame === undefined ? undefined : Number(values.frame),
    fps: values.fps === undefined ? undefined : Number(values.fps),
    totalSize: values.total_size === undefined ? undefined : Number(values.total_size),
  };
}

/**
 * Run one ffmpeg invocation, timing it and reporting where it wrote.
 *
 * Cancelling the tool call aborts `signal`, which makes the subprocess provider
 * terminate the child; that is reported as a cancellation rather than as an
 * encoder failure.
 * @param ctx - a context carrying `ctx.subprocess`.
 * @param argv - the complete ffmpeg argv.
 * @param options - cancellation and the output path being written.
 * @returns timing, progress, and the resulting file size.
 */
export async function runFfmpegJob(ctx, argv, options) {
  const { signal, output } = options;
  const started = Date.now();
  const result = await runTool(ctx, argv, {
    cwd: options.cwd ?? safeCwd(),
    signal,
    maxBytes: 8 * 1024 * 1024,
    spillMaxBytes: 64 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - started;
  if (result.exitCode !== 0) {
    if (signal?.aborted === true) throw new Error(`cancelled after ${elapsedMs} ms`);
    const detail = tail(result.stderr) || tail(result.stdout) || '(no output)';
    throw new Error(`ffmpeg exited with code ${result.exitCode} after ${elapsedMs} ms\n${detail}`);
  }
  const bytes = existsSync(output) ? statSync(output).size : undefined;
  return {
    elapsedMs,
    bytes,
    progress: parseProgress(result.stdout),
    log: tail(result.stderr, 8),
    truncated: result.truncated || undefined,
  };
}

/**
 * Convert a simple glob (`*` and `?` on the file name) into a matcher.
 * @param pattern - the glob pattern.
 * @returns a predicate over candidate names.
 */
export function globMatcher(pattern) {
  const source = String(pattern ?? '*')
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  const regex = new RegExp(`^${source}$`, 'iu');
  return (name) => regex.test(name);
}

/**
 * Run one job per input with a bounded number of jobs in flight.
 *
 * Media work is both CPU-heavy and I/O-heavy, so the pool is deliberately small
 * and configurable rather than unbounded. Every input yields exactly one result
 * in input order, and one failure never removes its neighbours' results.
 * @param inputs - the inputs to process.
 * @param runOne - async worker invoked per input.
 * @param concurrency - maximum overlapping jobs.
 * @returns one result per input, in input order.
 */
export async function pool(inputs, runOne, concurrency = 2) {
  const results = new Array(inputs.length);
  const limit = Math.max(1, Math.min(Number.isFinite(concurrency) ? Math.trunc(concurrency) : 2, 8));
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= inputs.length) return;
      const input = inputs[index];
      try {
        results[index] = await runOne(input, index);
      } catch (error) {
        results[index] = { input, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, inputs.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}
