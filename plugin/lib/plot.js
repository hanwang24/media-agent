import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureParentDir, runOrThrow } from './run.js';
import { requireTool, resolvePython } from './toolchain.js';

/** The plot script bundled beside this plugin, resolved from the module URL. */
const PLOT_SCRIPT = fileURLToPath(new URL('../assets/plot.py', import.meta.url));

/** Plot kinds the renderer supports, mapped onto their CLI flag and file suffix. */
const KIND_MAP = {
  waveform: { flag: '--waveform', suffix: 'waveform' },
  spectrogram: { flag: '--spectrogram', suffix: 'spectrogram' },
  freq_response: { flag: '--freq', suffix: 'freq' },
};

export const PLOT_KINDS = Object.keys(KIND_MAP);

/**
 * Render audio plots for one media file.
 *
 * The source is decoded to a temporary 16-bit stereo WAV with ffmpeg, then the
 * bundled Python script (numpy + Pillow, no scipy/matplotlib) draws the
 * requested figures. One Python process reads the WAV once and writes every
 * plot, so a multi-kind request is a single extra subprocess.
 *
 * @param ctx - context carrying `ctx.subprocess`.
 * @param input - the media file to plot.
 * @param options - kinds, output location, size, channel mode, cancellation.
 * @returns the decoded facts plus one result per generated plot.
 */
export async function renderPlots(ctx, input, options = {}) {
  const {
    kinds = ['waveform'],
    outputDir = dirname(input),
    prefix = basename(input, extname(input)),
    width = 1400,
    height = 900,
    channels = 'mixed',
    streamIndex = 0,
    signal,
    cwd,
  } = options;

  const unknown = kinds.filter((kind) => KIND_MAP[kind] === undefined);
  if (unknown.length > 0) {
    throw new Error(`unknown plot kind(s): ${unknown.join(', ')} (allowed: ${PLOT_KINDS.join(', ')})`);
  }

  const python = resolvePython();
  // Fail early and clearly when the interpreter lacks the two packages.
  await runOrThrow(ctx, [python, '-c', 'import numpy, PIL'], {
    cwd,
    signal,
    maxBytes: 1024 * 1024,
  });

  const wav = join(tmpdir(), `media-agent-plot-${randomUUID()}.wav`);
  try {
    await runOrThrow(
      ctx,
      [
        requireTool('ffmpeg'),
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', input,
        '-map', `0:a:${streamIndex}`,
        '-ac', '2',
        '-ar', '44100',
        '-f', 'wav',
        wav,
      ],
      { cwd, signal, maxBytes: 2 * 1024 * 1024 },
    );

    const outputs = [];
    const argv = [python, PLOT_SCRIPT, '--input', wav, '--width', String(width), '--height', String(height), '--channels', channels];
    for (const kind of kinds) {
      const path = join(outputDir, `${prefix}-${KIND_MAP[kind].suffix}.png`);
      ensureParentDir(path);
      argv.push(KIND_MAP[kind].flag, path);
      outputs.push({ kind, path });
    }

    const result = await runOrThrow(ctx, argv, { cwd, signal, maxBytes: 1024 * 1024 });
    let facts = {};
    try {
      facts = JSON.parse(result.stdout);
    } catch {
      // A non-JSON stdout means the script printed a traceback; the next line
      // would have thrown, so this only protects against a half-written print.
    }

    const files = outputs.map((entry) => ({
      kind: entry.kind,
      path: entry.path,
      bytes: existsSync(entry.path) ? statSync(entry.path).size : undefined,
    }));

    return {
      durationSeconds: facts.durationSeconds,
      sampleRate: facts.sampleRate,
      channels: facts.channels,
      outputs: files,
    };
  } finally {
    rmSync(wav, { force: true });
  }
}
