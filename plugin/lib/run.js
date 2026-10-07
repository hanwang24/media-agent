import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

/**
 * A working directory that is guaranteed to exist. `spawn` rejects a cwd that
 * is missing, and the Host process's own cwd may have been removed underneath
 * it, so fall back to the user's home directory.
 * @returns an existing absolute directory.
 */
export function safeCwd() {
  const cwd = process.cwd();
  if (typeof cwd === 'string' && existsSync(cwd)) return cwd;
  return homedir();
}

/** Default stdout/stderr capture ceiling before a collect reader reports loss. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** Default spill ceiling holding the complete stream behind a truncated read. */
export const DEFAULT_SPILL_BYTES = 64 * 1024 * 1024;

/**
 * Ensure the directory that will hold an output path exists.
 * @param file - target output path whose parent directory must exist.
 * @returns the parent directory.
 */
export function ensureParentDir(file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run one argv-only command through the Host subprocess service and collect its
 * output.
 *
 * Arguments are always passed as an argv array, so no shell ever parses them
 * and a path containing spaces, quotes, or `&` cannot change the command. The
 * caller's `signal` is forwarded, so cancelling the tool call terminates the
 * child through the provider's documented procedure.
 * @param ctx - a context carrying `ctx.subprocess`.
 * @param argv - the complete argv, executable first.
 * @param options - working directory, cancellation, and capture ceilings.
 * @returns exit facts plus captured stdout/stderr text.
 */
export async function runTool(ctx, argv, options = {}) {
  const {
    cwd,
    signal,
    maxBytes = DEFAULT_MAX_BYTES,
    spillMaxBytes = DEFAULT_SPILL_BYTES,
    graceMs = 5000,
  } = options;
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    graceMs,
    signal,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes, spill: { maxBytes: spillMaxBytes } },
      stderr: { maxBytes, spill: { maxBytes: spillMaxBytes } },
    },
  });
  const outcome = await handle.done;
  const stdout = handle.collected.stdout?.readFrom(0);
  const stderr = handle.collected.stderr?.readFrom(0);
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    truncated: Boolean(stdout?.lossy || stderr?.lossy),
    argv,
  };
}

/**
 * Tail of a captured log, so an error report stays small but keeps the lines
 * that actually explain the failure.
 * @param text - full captured text.
 * @param lines - how many trailing lines to keep.
 * @returns the trailing excerpt.
 */
export function tail(text, lines = 20) {
  const all = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return all.slice(-lines).join('\n');
}

/**
 * Run a command and throw a compact, quoted error when it fails.
 * @param ctx - a context carrying `ctx.subprocess`.
 * @param argv - the complete argv, executable first.
 * @param options - see {@link runTool}.
 * @returns the successful run result.
 */
export async function runOrThrow(ctx, argv, options = {}) {
  const result = await runTool(ctx, argv, options);
  if (result.exitCode !== 0) {
    const detail = tail(result.stderr) || tail(result.stdout) || '(no output)';
    throw new Error(
      `command failed with exit code ${result.exitCode}: ${argv[0]} ${argv.slice(1).join(' ')}\n${detail}`,
    );
  }
  return result;
}
