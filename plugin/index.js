import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from './lib/define-tool.js';
import { probeMedia } from './lib/probe.js';
import { requireDirectory, requireInputFile, requireOutputPath, sessionCwd } from './lib/paths.js';
import { ensureParentDir } from './lib/run.js';
import { globMatcher, pool, runFfmpegJob } from './lib/media-job.js';
import { audioCodecForFile, buildClipArgs, buildConcatArgs, buildExtractArgs, buildTranscodeArgs, concatListLine } from './lib/recipes.js';
import { PLOT_KINDS, renderPlots } from './lib/plot.js';

/** Cordis plugin identity. */
export const name = 'media-agent';
/** Services this plugin registers against. */
export const inject = ['tools', 'subprocess'];

/** Video codec vocabulary shared by every tool that writes video. */
const VIDEO_CODEC_ENUM = ['copy', 'h264', 'hevc', 'av1', 'vp9', 'none'];
/** Audio codec vocabulary shared by every tool that re-encodes audio. */
const AUDIO_CODEC_ENUM = ['copy', 'aac', 'opus', 'mp3', 'flac', 'vorbis', 'pcm_s16le', 'none'];
/** The single speed knob, translated per encoder inside `recipes`. */
const SPEED_ENUM = ['fastest', 'fast', 'balanced', 'slow', 'slowest'];
/** Accelerator families the tools accept; the platform decides which exist. */
const HWACCEL_ENUM = ['software', 'nvenc', 'qsv', 'amf', 'videotoolbox'];

/**
 * Render one completed ffmpeg job as the model-facing text block.
 * @param label - a short verb describing the job.
 * @param output - the output path.
 * @param job - the job result from {@link runFfmpegJob}.
 * @returns the text block content.
 */
function jobText(label, output, job) {
  const lines = [`${label} -> ${output ?? '(unknown output)'}`];
  const facts = [];
  if (job.bytes !== undefined) facts.push(`${(job.bytes / 1048576).toFixed(2)} MiB`);
  if (job.elapsedMs !== undefined) facts.push(`${(job.elapsedMs / 1000).toFixed(1)} s`);
  if (job.progress?.speed !== undefined) facts.push(`${job.progress.speed} speed`);
  if (facts.length > 0) lines.push(facts.join(' · '));
  // `render` also runs while replaying a logged call, so it must tolerate a
  // value that predates the current shape instead of throwing.
  if (Array.isArray(job.argv) && job.argv.length > 0) lines.push(`argv: ${job.argv.join(' ')}`);
  if (job.log) lines.push(job.log);
  return lines.join('\n');
}

/**
 * Register the audio-video tools.
 *
 * Every tool passes its arguments to the subprocess provider as an argv array,
 * so no shell ever parses a path or a filter value. No tool declares
 * `timeoutMs`: the timeout policy only cuts tools that ask for a budget, and a
 * long encode must be allowed to finish. Cancellation still works because each
 * tool hands the caller's `signal` to the child process.
 * @param ctx - context carrying the tool and subprocess registries.
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'av_probe',
    description:
      'Inspect one audio/video file with ffprobe and MediaInfo and return its container, duration, '
      + 'size, bitrate, and per-stream codec facts, including HDR format, channel layout, rotation, and '
      + 'attached subtitle languages. Call this before deciding encode settings instead of guessing from '
      + 'the file name. Set includeRaw to also receive the verbatim tool documents.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the media file to inspect.' },
      inputFormat: {
        type: 'string',
        description: 'Input demuxer for a raw elementary stream (h264, hevc, aac, mpegts, ...), so ffprobe can read its parameters.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return the verbatim ffprobe and MediaInfo documents in addition to the merged facts.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          container: { type: 'string' },
          durationSeconds: { type: 'number' },
          sizeBytes: { type: 'integer' },
          bitRate: { type: 'integer' },
          video: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                codec: { type: 'string' },
                profile: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                pixFmt: { type: 'string' },
                frameRate: { type: 'number' },
                bitRate: { type: 'integer' },
                colorPrimaries: { type: 'string' },
                colorTransfer: { type: 'string' },
                hdr: { type: 'string', description: 'hdr10, hdr10+, hlg, pq, or dolby-vision when present.' },
                rotation: { type: 'integer' },
              },
            },
          },
          audio: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                codec: { type: 'string' },
                channels: { type: 'integer' },
                channelLayout: { type: 'string' },
                sampleRate: { type: 'integer' },
                bitRate: { type: 'integer' },
                language: { type: 'string' },
              },
            },
          },
          subtitle: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                codec: { type: 'string' },
                language: { type: 'string' },
                title: { type: 'string' },
                forced: { type: 'boolean' },
              },
            },
          },
          chapterCount: { type: 'integer' },
          mediainfo: { type: 'object', description: 'Condensed MediaInfo tracks keyed by kind.' },
          summary: { type: 'string', required: true },
          raw: { type: 'object', description: 'Verbatim ffprobe and MediaInfo documents, only with includeRaw.' },
        },
      },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: value.summary }];
        if (args.includeRaw === true && value.raw !== undefined) {
          blocks.push({ type: 'text', text: JSON.stringify(value.raw, undefined, 2) });
        }
        return blocks;
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      return probeMedia(ctx, requireInputFile(cwd, args.path, 'path'), {
        signal: exec.signal,
        includeRaw: args.includeRaw === true,
        inputFormat: args.inputFormat,
        cwd,
      });
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'Probe media', kind: 'read', rawInput: args.path }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'Media probe',
      content: result.content,
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'av_transcode',
    description:
      'Transcode one audio/video file with ffmpeg. Choose a target codec, a single `speed` knob, and '
      + 'either `quality` (lower is better) or `bitrate`. Use videoCodec "copy" and audioCodec "copy" to '
      + 'remux without re-encoding. `start`/`duration`/`end` trim while transcoding. `scale` takes an '
      + 'ffmpeg scale expression such as 1920:-2. Hardware encoders are opt-in through `hwaccel` and fail '
      + 'loudly when the build or the machine cannot provide them. Returns the output path, size, elapsed '
      + 'time, and the exact argv used.',
    parameters: {
      input: { type: 'string', required: true, description: 'Input file path.' },
      inputFormat: {
        type: 'string',
        description: 'Input demuxer for a raw elementary stream (h264, hevc, aac, mpegts, ...). Probe first, then pass this so a container-less stream can be read.',
      },
      output: { type: 'string', required: true, description: 'Output file path; its extension picks the container.' },
      outputFormat: {
        type: 'string',
        description: 'Force the output muxer independently of the extension (mp4, mpegts, matroska, ...).',
      },
      videoCodec: { type: 'string', enum: VIDEO_CODEC_ENUM, description: 'h264 (default), hevc, av1, vp9, copy, or none.' },
      audioCodec: { type: 'string', enum: AUDIO_CODEC_ENUM, description: 'aac (default), opus, mp3, flac, vorbis, pcm_s16le, copy, or none.' },
      quality: { type: 'integer', description: 'Rate-control quality from 0 to 51; lower is better. Ignored when bitrate is set.' },
      bitrate: { type: 'string', description: 'Explicit video bitrate such as 4M, used instead of quality.' },
      speed: { type: 'string', enum: SPEED_ENUM, description: 'Encoding speed/efficiency trade-off; mapped to this encoder\'s own preset.' },
      pixelFormat: { type: 'string', description: 'Output pixel format. Defaults to yuv420p for h264/hevc, which keeps 10-bit sources playable.' },
      scale: { type: 'string', description: 'Scale expression, for example 1280:-2 or 1920:1080.' },
      fps: { type: 'number', description: 'Output frame rate.' },
      start: { type: 'string', description: 'Trim start as seconds or HH:MM:SS.mmm.' },
      duration: { type: 'string', description: 'Trim length as seconds or HH:MM:SS.mmm.' },
      end: { type: 'string', description: 'Trim end position; used only when duration is absent.' },
      hwaccel: { type: 'string', enum: HWACCEL_ENUM, description: 'software (default), nvenc/qsv/amf on Windows, or videotoolbox on macOS.' },
      audioBitrate: { type: 'string', description: 'Audio bitrate such as 192k.' },
      audioChannels: { type: 'integer', description: 'Audio channel count.' },
      audioSampleRate: { type: 'integer', description: 'Audio sample rate in Hz.' },
      extraArgs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional ffmpeg flags appended before the output, each as its own argv entry.',
      },
      overwrite: { type: 'boolean', description: 'Replace an existing output; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          bytes: { type: 'integer' },
          elapsedMs: { type: 'integer', required: true },
          speed: { type: 'string' },
          outTimeSeconds: { type: 'number' },
          argv: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: jobText('transcoded', value.output, {
          bytes: value.bytes,
          elapsedMs: value.elapsedMs,
          progress: { speed: value.speed },
          argv: value.argv,
        }),
      }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const input = requireInputFile(cwd, args.input, 'input');
      const output = requireOutputPath(cwd, args.output, 'output');
      ensureParentDir(output);
      const argv = buildTranscodeArgs({ ...args, input, output });
      const job = await runFfmpegJob(ctx, argv, { signal: exec.signal, output, cwd });
      return {
        output,
        bytes: job.bytes,
        elapsedMs: job.elapsedMs,
        speed: job.progress.speed,
        outTimeSeconds: job.progress.outTimeSeconds,
        argv,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Transcode media', kind: 'execute', rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: 'av_extract',
    description:
      'Extract one essence from a media file: a full audio track, a subtitle track, an image sequence, a '
      + 'single thumbnail, or a waveform image. `streamIndex` selects among multiple audio or subtitle '
      + 'tracks, counted per type in the order av_probe reports them. Frames are written as a numbered '
      + 'sequence, so give an output pattern such as frames-%04d.png.',
    parameters: {
      input: { type: 'string', required: true, description: 'Input file path.' },
      output: { type: 'string', required: true, description: 'Output path; for frames, a pattern containing %d.' },
      what: {
        type: 'string',
        required: true,
        enum: ['audio', 'subtitle', 'frames', 'thumbnail', 'waveform'],
        description: 'Which essence to extract.',
      },
      streamIndex: { type: 'integer', description: 'Zero-based index among audio or subtitle tracks; defaults to 0.' },
      audioCodec: { type: 'string', enum: AUDIO_CODEC_ENUM, description: 'Audio codec for extraction; copy (default) keeps the original.' },
      audioBitrate: { type: 'string', description: 'Audio bitrate such as 192k when re-encoding.' },
      audioChannels: { type: 'integer', description: 'Audio channel count when re-encoding.' },
      subtitleFormat: { type: 'string', enum: ['copy', 'srt', 'ass', 'vtt', 'mov_text'], description: 'Subtitle format; copy keeps the original.' },
      fps: { type: 'number', description: 'Frames per second to sample for the frames kind.' },
      count: { type: 'integer', description: 'Maximum number of frames to write.' },
      time: { type: 'string', description: 'Timestamp for a thumbnail, as seconds or HH:MM:SS.mmm.' },
      scale: { type: 'string', description: 'Scale expression for thumbnail (for example 640:-2) or WxH for waveform (default 1200x400).' },
      color: { type: 'string', description: 'Waveform colour name; defaults to white.' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Additional ffmpeg flags.' },
      overwrite: { type: 'boolean', description: 'Replace an existing output; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          bytes: { type: 'integer' },
          elapsedMs: { type: 'integer', required: true },
          argv: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: jobText('extracted', value.output, {
          bytes: value.bytes,
          elapsedMs: value.elapsedMs,
          argv: value.argv,
        }),
      }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const input = requireInputFile(cwd, args.input, 'input');
      const output = requireOutputPath(cwd, args.output, 'output');
      if (args.what === 'frames' && !output.includes('%')) {
        const extension = extname(output);
        const stem = extension.length > 0 ? output.slice(0, -extension.length) : output;
        throw new Error(
          'the frames kind writes a numbered sequence, so output must contain a %d pattern such as '
          + `${stem}-%04d${extension.length > 0 ? extension : '.png'}`,
        );
      }
      ensureParentDir(output);
      const argv = buildExtractArgs({ ...args, input, output });
      const job = await runFfmpegJob(ctx, argv, { signal: exec.signal, output, cwd });
      return { output, bytes: job.bytes, elapsedMs: job.elapsedMs, argv };
    },
    presentCall: (args) => ({ card: 'generic', title: `Extract ${args.what}`, kind: 'execute', rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: 'av_clip',
    description:
      'Trim one media file. The requested length is honored in both modes. mode "copy" is nearly instant and '
      + 'lossless but the start snaps back to the nearest keyframe at or before the requested time, so the '
      + 'first moments may include a little extra material and the cut rarely starts on a keyframe; mode '
      + '"reencode" cuts at the exact frame and is the right choice when the start point must be precise. '
      + 'Give start plus either duration or end.',
    parameters: {
      input: { type: 'string', required: true, description: 'Input file path.' },
      output: { type: 'string', required: true, description: 'Output file path.' },
      start: { type: 'string', required: true, description: 'Start position as seconds or HH:MM:SS.mmm.' },
      duration: { type: 'string', description: 'Clip length.' },
      end: { type: 'string', description: 'End position; used when duration is absent.' },
      mode: { type: 'string', enum: ['copy', 'reencode'], description: 'copy (default, keyframe-aligned) or reencode (exact).' },
      videoCodec: { type: 'string', enum: VIDEO_CODEC_ENUM, description: 'Video codec when re-encoding; h264 by default.' },
      audioCodec: { type: 'string', enum: AUDIO_CODEC_ENUM, description: 'Audio codec when re-encoding; aac by default.' },
      quality: { type: 'integer', description: 'Rate-control quality 0-51, lower is better.' },
      bitrate: { type: 'string', description: 'Explicit video bitrate instead of quality.' },
      speed: { type: 'string', enum: SPEED_ENUM, description: 'Encoding speed/efficiency trade-off.' },
      pixelFormat: { type: 'string', description: 'Output pixel format; defaults to yuv420p.' },
      hwaccel: { type: 'string', enum: HWACCEL_ENUM, description: 'software (default), nvenc/qsv/amf on Windows, or videotoolbox on macOS.' },
      audioBitrate: { type: 'string', description: 'Audio bitrate such as 192k.' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Additional ffmpeg flags.' },
      overwrite: { type: 'boolean', description: 'Replace an existing output; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          bytes: { type: 'integer' },
          elapsedMs: { type: 'integer', required: true },
          mode: { type: 'string', required: true },
          argv: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${jobText('clipped', value.output, {
          bytes: value.bytes,
          elapsedMs: value.elapsedMs,
          argv: value.argv,
        })}\nmode: ${value.mode}`,
      }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const input = requireInputFile(cwd, args.input, 'input');
      const output = requireOutputPath(cwd, args.output, 'output');
      ensureParentDir(output);
      // `end` and `duration` are mutually exclusive in the recipe builder, and
      // building the argv is what validates the timestamps.
      const argv = buildClipArgs({ ...args, input, output, mode: args.mode ?? 'copy', overwrite: args.overwrite ?? true });
      const job = await runFfmpegJob(ctx, argv, { signal: exec.signal, output, cwd });
      return {
        output,
        bytes: job.bytes,
        elapsedMs: job.elapsedMs,
        mode: args.mode ?? 'copy',
        argv,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Clip media', kind: 'execute', rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: 'av_concat',
    description:
      'Join several media files in the given order using the concat demuxer. mode "copy" is fast and '
      + 'lossless but requires every input to share the same codecs, timebase, and resolution; mode '
      + '"reencode" re-encodes to one target format but still requires compatible stream layouts. All '
      + 'inputs must carry the same number and kind of streams. Probe the inputs first when unsure.',
    parameters: {
      inputs: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Input file paths, in the order they should appear.',
      },
      output: { type: 'string', required: true, description: 'Output file path.' },
      mode: { type: 'string', enum: ['copy', 'reencode'], description: 'copy (default) or reencode.' },
      videoCodec: { type: 'string', enum: VIDEO_CODEC_ENUM, description: 'Video codec when re-encoding; h264 by default.' },
      audioCodec: { type: 'string', enum: AUDIO_CODEC_ENUM, description: 'Audio codec when re-encoding; aac by default.' },
      quality: { type: 'integer', description: 'Rate-control quality 0-51, lower is better.' },
      speed: { type: 'string', enum: SPEED_ENUM, description: 'Encoding speed/efficiency trade-off.' },
      pixelFormat: { type: 'string', description: 'Output pixel format; defaults to yuv420p.' },
      scale: { type: 'string', description: 'Scale expression applied while re-encoding.' },
      fps: { type: 'number', description: 'Output frame rate while re-encoding.' },
      audioBitrate: { type: 'string', description: 'Audio bitrate such as 192k.' },
      hwaccel: { type: 'string', enum: HWACCEL_ENUM, description: 'software (default), nvenc/qsv/amf on Windows, or videotoolbox on macOS.' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Additional ffmpeg flags.' },
      overwrite: { type: 'boolean', description: 'Replace an existing output; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          inputs: { type: 'array', items: { type: 'string' }, required: true },
          bytes: { type: 'integer' },
          elapsedMs: { type: 'integer', required: true },
          mode: { type: 'string', required: true },
          argv: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${jobText(`joined ${value.inputs?.length ?? 0} files`, value.output, {
          bytes: value.bytes,
          elapsedMs: value.elapsedMs,
          argv: value.argv,
        })}\nmode: ${value.mode}`,
      }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      if (!Array.isArray(args.inputs) || args.inputs.length < 2) {
        throw new Error('inputs must list at least two files to join');
      }
      // The concat demuxer resolves a list entry against the list file's own
      // directory, so every entry must be absolute.
      const inputs = args.inputs.map((input) => requireInputFile(cwd, input, 'inputs'));
      const output = requireOutputPath(cwd, args.output, 'output');
      ensureParentDir(output);
      const listFile = join(tmpdir(), `dsh-av-concat-${randomUUID()}.txt`);
      writeFileSync(listFile, `${inputs.map(concatListLine).join('\n')}\n`, { encoding: 'utf8' });
      const mode = args.mode ?? 'copy';
      try {
        const argv = buildConcatArgs({ ...args, inputs, output, mode, listFile, overwrite: args.overwrite ?? true });
        const job = await runFfmpegJob(ctx, argv, { signal: exec.signal, output, cwd });
        return {
          output,
          inputs,
          bytes: job.bytes,
          elapsedMs: job.elapsedMs,
          mode,
          // The temporary list file is an implementation detail, so the reported
          // argv is rewritten to a reproducible one without the random name.
          argv: argv.map((entry) => (entry === listFile ? '<concat-list>' : entry)),
        };
      } finally {
        rmSync(listFile, { force: true });
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Join ${Array.isArray(args.inputs) ? args.inputs.length : 0} files`,
      kind: 'execute',
      rawInput: args,
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'av_batch',
    description:
      'Process every matching file in a directory with one operation: transcode, remux, extract-audio, '
      + 'thumbnail, or probe. Runs a small bounded number of jobs at a time and reports one result per '
      + 'file, so a single failure never hides the others. Existing outputs are skipped unless '
      + 'skipExisting is false, which makes a large run resumable.',
    parameters: {
      inputDir: { type: 'string', required: true, description: 'Directory holding the inputs.' },
      outputDir: { type: 'string', description: 'Directory for outputs; required except for the probe operation.' },
      operation: {
        type: 'string',
        required: true,
        enum: ['transcode', 'remux', 'extract-audio', 'thumbnail', 'plot', 'probe'],
        description: 'What to do with each file.',
      },
      pattern: { type: 'string', description: 'File-name glob such as *.mp4; defaults to every file.' },
      recursive: { type: 'boolean', description: 'Also walk subdirectories, mirroring them into outputDir.' },
      outputExtension: {
        type: 'string',
        description: 'Output extension without the dot. Defaults to mp4, m4a, or jpg per operation.',
      },
      videoCodec: { type: 'string', enum: VIDEO_CODEC_ENUM, description: 'Video codec for transcode; h264 by default.' },
      audioCodec: { type: 'string', enum: AUDIO_CODEC_ENUM, description: 'Audio codec for transcode; aac by default.' },
      quality: { type: 'integer', description: 'Rate-control quality 0-51, lower is better.' },
      speed: { type: 'string', enum: SPEED_ENUM, description: 'Encoding speed/efficiency trade-off.' },
      scale: { type: 'string', description: 'Scale expression for transcode, for example 1280:-2.' },
      fps: { type: 'number', description: 'Output frame rate for transcode.' },
      audioBitrate: { type: 'string', description: 'Audio bitrate such as 192k.' },
      thumbnailTime: { type: 'string', description: 'Timestamp for the thumbnail operation; defaults to 0.' },
      plotKinds: { type: 'array', items: { type: 'string', enum: PLOT_KINDS }, description: 'Plot kinds for the plot operation: waveform, spectrogram, freq_response.' },
      plotChannels: { type: 'string', enum: ['mixed', 'separate'], description: 'Waveform channel mode for the plot operation.' },
      plotWidth: { type: 'integer', description: 'Plot width in pixels; defaults to 1400.' },
      plotHeight: { type: 'integer', description: 'Plot height in pixels; defaults to 900.' },
      hwaccel: { type: 'string', enum: HWACCEL_ENUM, description: 'software (default), nvenc/qsv/amf on Windows, or videotoolbox on macOS.' },
      concurrency: { type: 'integer', description: 'Jobs in flight at once, 1 to 8; defaults to 2.' },
      limit: { type: 'integer', description: 'Stop after this many files, for a trial run.' },
      skipExisting: { type: 'boolean', description: 'Skip a file whose output already exists; defaults to true.' },
      overwrite: { type: 'boolean', description: 'Replace existing outputs when skipExisting is false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          succeeded: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                input: { type: 'string', required: true },
                output: { type: 'string' },
                ok: { type: 'boolean', required: true },
                skipped: { type: 'boolean' },
                bytes: { type: 'integer' },
                elapsedMs: { type: 'integer' },
                summary: { type: 'string' },
                error: { type: 'string' },
                outputs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true },
                      path: { type: 'string', required: true },
                      bytes: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const results = value.results ?? [];
        const lines = [
          `${value.operation}: ${value.succeeded} succeeded, ${value.failed} failed, ${value.skipped} skipped (of ${value.total})`,
        ];
        for (const result of results) {
          const name = basename(result.input);
          if (result.skipped === true) {
            lines.push(`  skip  ${name}`);
          } else if (result.ok) {
            const size = result.bytes === undefined ? '' : ` ${(result.bytes / 1048576).toFixed(2)} MiB`;
            lines.push(`  ok    ${name}${size}`);
          } else {
            lines.push(`  FAIL  ${name}: ${result.error ?? 'unknown error'}`);
          }
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      // A trailing separator would double up when deriving relative paths.
      const inputDir = requireDirectory(cwd, args.inputDir, 'inputDir').replace(/[\\/]+$/u, '');
      const operation = args.operation;
      const needsOutput = operation !== 'probe';
      let outputDir;
      if (needsOutput) {
        if (typeof args.outputDir !== 'string' || args.outputDir.length === 0) {
          throw new Error(`outputDir is required for the ${operation} operation`);
        }
        outputDir = requireOutputPath(cwd, args.outputDir, 'outputDir').replace(/[\\/]+$/u, '');
        ensureParentDir(join(outputDir, 'placeholder'));
      }

      const files = collectFiles(inputDir, args.pattern ?? '*', args.recursive === true);
      const limited = typeof args.limit === 'number' && args.limit > 0 ? files.slice(0, args.limit) : files;
      if (limited.length === 0) {
        return { operation, total: 0, succeeded: 0, failed: 0, skipped: 0, results: [] };
      }

      const extension = args.outputExtension ?? { transcode: 'mp4', remux: 'mkv', 'extract-audio': 'm4a', thumbnail: 'jpg' }[operation];
      const results = await pool(limited, async (file) => {
        const relative = file.slice(inputDir.length).replace(/^[\\/]/u, '');
        if (operation === 'plot') {
          const rendered = await renderPlots(ctx, file, {
            kinds: args.plotKinds ?? ['waveform'],
            outputDir,
            prefix: basename(file, extname(file)),
            width: args.plotWidth ?? 1400,
            height: args.plotHeight ?? 900,
            channels: args.plotChannels ?? 'mixed',
            signal: exec.signal,
            cwd,
          });
          return {
            input: file,
            ok: true,
            outputs: rendered.outputs,
            summary: rendered.outputs.map((entry) => basename(entry.path)).join(', '),
          };
        }
        const target = needsOutput ? outputPath(outputDir, relative, extension, operation) : undefined;
        if (needsOutput && args.skipExisting !== false && existsSync(target)) {
          return { input: file, output: target, ok: true, skipped: true };
        }
        if (operation === 'probe') {
          const facts = await probeMedia(ctx, file, { signal: exec.signal, cwd });
          return { input: file, ok: true, summary: facts.summary };
        }
        if (needsOutput) ensureParentDir(target);
        const job = await runFfmpegJob(ctx, batchArgv(operation, file, target, args), {
          signal: exec.signal,
          output: target,
          cwd,
        });
        return { input: file, output: target, ok: true, bytes: job.bytes, elapsedMs: job.elapsedMs };
      }, args.concurrency ?? 2);

      const succeeded = results.filter((entry) => entry.ok === true && entry.skipped !== true).length;
      const skipped = results.filter((entry) => entry.skipped === true).length;
      const failed = results.filter((entry) => entry.ok !== true).length;
      return { operation, total: results.length, succeeded, failed, skipped, results };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Batch ${args.operation}`,
      kind: 'execute',
      rawInput: args,
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'av_plot',
    description:
      'Render audio visualizations for one media file: an Audition-style waveform, a spectrogram, '
      + 'and/or a frequency-response curve. The source is decoded with ffmpeg and drawn with the bundled '
      + 'Python (numpy + Pillow), producing one PNG per requested kind. For a whole directory, use av_batch '
      + 'with operation "plot".',
    parameters: {
      input: { type: 'string', required: true, description: 'Video or audio file to plot.' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: PLOT_KINDS },
        required: true,
        description: 'Which plots to render: waveform, spectrogram, and/or freq_response.',
      },
      outputDir: { type: 'string', description: 'Directory for the PNGs; defaults to the input file\'s directory.' },
      prefix: { type: 'string', description: 'Output file stem; defaults to the input name without its extension.' },
      width: { type: 'integer', description: 'Image width in pixels; defaults to 1400.' },
      height: { type: 'integer', description: 'Image height in pixels; defaults to 900.' },
      channels: { type: 'string', enum: ['mixed', 'separate'], description: 'Waveform channel mode; mixed (default) or separate left/right.' },
      streamIndex: { type: 'integer', description: 'Audio track to plot; defaults to 0.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          durationSeconds: { type: 'number' },
          sampleRate: { type: 'integer' },
          channels: { type: 'integer' },
          outputs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                path: { type: 'string', required: true },
                bytes: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const outputs = value.outputs ?? [];
        const lines = [`rendered ${outputs.length} audio plot(s):`];
        for (const output of outputs) {
          const size = output.bytes === undefined ? '' : ` (${(output.bytes / 1024).toFixed(1)} KiB)`;
          lines.push(`  ${output.kind}: ${output.path}${size}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const input = requireInputFile(cwd, args.input, 'input');
      const outputDir = args.outputDir
        ? requireOutputPath(cwd, args.outputDir, 'outputDir')
        : dirname(input);
      const result = await renderPlots(ctx, input, {
        kinds: args.kinds,
        outputDir,
        prefix: args.prefix,
        width: args.width ?? 1400,
        height: args.height ?? 900,
        channels: args.channels ?? 'mixed',
        streamIndex: args.streamIndex ?? 0,
        signal: exec.signal,
        cwd,
      });
      return {
        durationSeconds: result.durationSeconds,
        sampleRate: result.sampleRate,
        channels: result.channels,
        outputs: result.outputs,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Render audio plots', kind: 'execute', rawInput: args }),
  }));
}

/**
 * Build the ffmpeg argv for one batch item.
 * @param operation - the batch operation.
 * @param input - the input file.
 * @param target - the output path.
 * @param args - the batch request, carrying the shared recipe options.
 * @returns the complete argv.
 */
function batchArgv(operation, input, target, args) {
  const shared = {
    input,
    output: target,
    overwrite: args.overwrite ?? true,
    videoCodec: args.videoCodec ?? 'h264',
    audioCodec: args.audioCodec ?? 'aac',
    quality: args.quality,
    speed: args.speed,
    scale: args.scale,
    fps: args.fps,
    audioBitrate: args.audioBitrate,
    hwaccel: args.hwaccel ?? 'software',
  };
  if (operation === 'transcode') return buildTranscodeArgs(shared);
  if (operation === 'remux') return buildTranscodeArgs({ ...shared, videoCodec: 'copy', audioCodec: 'copy' });
  if (operation === 'extract-audio') {
    return buildExtractArgs({
      input,
      output: target,
      what: 'audio',
      audioCodec: audioCodecForFile(target) ?? 'copy',
      overwrite: args.overwrite ?? true,
    });
  }
  if (operation === 'thumbnail') {
    return buildExtractArgs({
      input,
      output: target,
      what: 'thumbnail',
      time: args.thumbnailTime ?? '0',
      scale: args.scale,
      overwrite: args.overwrite ?? true,
    });
  }
  throw new Error(`unknown batch operation: ${operation}`);
}

/**
 * Resolve the output path for one batch item, preserving subdirectories so a
 * recursive run mirrors its input tree.
 * @param outputDir - the batch output root.
 * @param relative - the input path relative to the batch input root.
 * @param extension - the target extension without a dot.
 * @param operation - the batch operation.
 * @returns the output path.
 */
function outputPath(outputDir, relative, extension, operation) {
  const source = extname(relative);
  const stem = source.length > 0 ? relative.slice(0, -source.length) : relative;
  if (operation === 'thumbnail') return join(outputDir, `${stem}.${extension ?? 'jpg'}`);
  return join(outputDir, `${stem}.${extension ?? 'mp4'}`);
}

/**
 * List candidate input files under one directory.
 * @param root - the directory to scan.
 * @param pattern - a file-name glob.
 * @param recursive - whether to walk subdirectories.
 * @returns absolute file paths, sorted for a stable order.
 */
function collectFiles(root, pattern, recursive) {
  const matches = globMatcher(pattern);
  const found = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (entry.isFile() && matches(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}
