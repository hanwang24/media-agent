import { requireTool } from './toolchain.js';

/**
 * Software and hardware encoder per requested codec. A missing hardware entry
 * means that family has no encoder for the codec in this build, so the request
 * fails loud instead of silently falling back to software. `videotoolbox` is
 * the macOS hardware path; `nvenc`/`qsv`/`amf` are the Windows/Linux paths. A
 * platform never exposes an encoder family it cannot compile, so a cross
 * platform request for the wrong family fails with a clear message.
 */
const VIDEO_ENCODERS = {
  h264: { software: 'libx264', nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf', videotoolbox: 'h264_videotoolbox' },
  hevc: { software: 'libx265', nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf', videotoolbox: 'hevc_videotoolbox' },
  // This build ships libaom-av1 for software AV1; libsvtav1 is absent.
  av1: { software: 'libaom-av1', nvenc: 'av1_nvenc', qsv: 'av1_qsv', amf: 'av1_amf' },
  vp9: { software: 'libvpx-vp9' },
};

/** Audio encoder per requested audio codec. */
const AUDIO_ENCODERS = {
  aac: 'aac',
  opus: 'libopus',
  mp3: 'libmp3lame',
  flac: 'flac',
  vorbis: 'libvorbis',
  pcm_s16le: 'pcm_s16le',
};

/** Audio codec implied by a container, in the same vocabulary the tools accept. */
const AUDIO_BY_FORMAT = {
  mp3: 'mp3',
  m4a: 'aac',
  aac: 'aac',
  opus: 'opus',
  ogg: 'opus',
  flac: 'flac',
  wav: 'pcm_s16le',
};

/** Subtitle encoder per requested subtitle format. */
const SUBTITLE_ENCODERS = {
  srt: 'subrip',
  ass: 'ass',
  vtt: 'webvtt',
  mov_text: 'mov_text',
};

/** The single speed knob, translated per encoder family so no preset can be invalid. */
const SPEED_TABLE = {
  'libx264': { fastest: 'ultrafast', fast: 'veryfast', balanced: 'medium', slow: 'slow', slowest: 'veryslow' },
  'libx265': { fastest: 'ultrafast', fast: 'veryfast', balanced: 'medium', slow: 'slow', slowest: 'veryslow' },
  'h264_nvenc': { fastest: 'p1', fast: 'p3', balanced: 'p4', slow: 'p6', slowest: 'p7' },
  'hevc_nvenc': { fastest: 'p1', fast: 'p3', balanced: 'p4', slow: 'p6', slowest: 'p7' },
  'av1_nvenc': { fastest: 'p1', fast: 'p3', balanced: 'p4', slow: 'p6', slowest: 'p7' },
  'h264_qsv': { fastest: 'veryfast', fast: 'veryfast', balanced: 'medium', slow: 'slow', slowest: 'veryslow' },
  'hevc_qsv': { fastest: 'veryfast', fast: 'veryfast', balanced: 'medium', slow: 'slow', slowest: 'veryslow' },
  'av1_qsv': { fastest: 'veryfast', fast: 'veryfast', balanced: 'medium', slow: 'slow', slowest: 'veryslow' },
  'h264_amf': { fastest: 'speed', fast: 'speed', balanced: 'balanced', slow: 'quality', slowest: 'quality' },
  'hevc_amf': { fastest: 'speed', fast: 'speed', balanced: 'balanced', slow: 'quality', slowest: 'quality' },
  'av1_amf': { fastest: 'speed', fast: 'speed', balanced: 'balanced', slow: 'quality', slowest: 'quality' },
};

/** Containers that benefit from moving the index to the front for streaming. */
const FASTSTART_EXTENSIONS = ['.mp4', '.m4v', '.mov'];

/** Codecs whose bitrate is carried on the video stream for a `-b:v` request. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * Parse a timestamp the way ffmpeg accepts it, as plain seconds or
 * `HH:MM:SS.mmm`, into a decimal second count.
 * @param value - number of seconds, or a colon-separated timestamp.
 * @returns the decimal seconds.
 */
export function parseTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid timestamp: ${value}`);
    return value;
  }
  const text = String(value).trim();
  if (text.length === 0) throw new Error('invalid timestamp: empty string');
  const parts = text.split(':');
  if (parts.length > 3) throw new Error(`invalid timestamp: ${text}`);
  const numbers = parts.map((part) => {
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid timestamp: ${text}`);
    return n;
  });
  if (numbers.length === 1) return numbers[0];
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

/**
 * Build the shared leading options every invocation carries.
 * @param overwrite - whether to replace an existing output.
 * @returns the leading argv entries up to and including the log options.
 */
function leading(overwrite) {
  return [
    requireTool('ffmpeg'),
    '-hide_banner',
    '-nostdin',
    overwrite ? '-y' : '-n',
    '-progress', 'pipe:1',
    '-nostats',
    '-loglevel', 'error',
  ];
}

/**
 * Trailing output options: faststart for streaming-friendly containers.
 * @param output - the output path.
 * @returns trailing argv entries.
 */
function trailing(output) {
  const lower = output.toLowerCase();
  if (FASTSTART_EXTENSIONS.some((ext) => lower.endsWith(ext))) return ['-movflags', '+faststart'];
  return [];
}

/**
 * Resolve a requested video codec and accelerator to a concrete encoder.
 * @param codec - `h264`, `hevc`, `av1`, `vp9`, or `copy`/`none`.
 * @param hwaccel - `auto`, `software`, or a named accelerator family.
 * @returns the encoder name, or undefined when the codec is copied or dropped.
 */
export function resolveVideoEncoder(codec, hwaccel = 'software') {
  if (codec === undefined || codec === 'copy' || codec === 'none') return undefined;
  const family = VIDEO_ENCODERS[codec];
  if (family === undefined) throw new Error(`unknown video codec: ${codec}`);
  if (hwaccel === 'software' || hwaccel === 'auto') {
    // `auto` stays on the software encoder: an accelerator that is compiled in
    // may still have no usable device, and that failure is opaque.
    return family.software;
  }
  const encoder = family[hwaccel];
  if (encoder === undefined) {
    throw new Error(`video codec ${codec} has no ${hwaccel} encoder in this build`);
  }
  return encoder;
}

/**
 * Translate the single `speed` knob into this encoder's native preset flag.
 * @param encoder - the resolved encoder name.
 * @param speed - `fastest`, `fast`, `balanced`, `slow`, or `slowest`.
 * @returns the preset argv entries.
 */
function speedArgs(encoder, speed) {
  if (speed === undefined) return [];
  if (encoder === 'libaom-av1' || encoder === 'libvpx-vp9') {
    const cpuUsed = { fastest: '8', fast: '6', balanced: '4', slow: '2', slowest: '0' }[speed];
    if (cpuUsed === undefined) throw new Error(`unknown speed: ${speed}`);
    if (encoder === 'libvpx-vp9') return ['-deadline', 'good', '-cpu-used', cpuUsed];
    return ['-cpu-used', cpuUsed];
  }
  const table = SPEED_TABLE[encoder];
  if (table === undefined) return [];
  const preset = table[speed];
  if (preset === undefined) throw new Error(`unknown speed: ${speed}`);
  return ['-preset', preset];
}

/**
 * Translate the quality knob into this encoder family's rate-control flags.
 * @param encoder - the resolved encoder name.
 * @param quality - 0-51, lower is better; ignored when a bitrate is set.
 * @returns the rate-control argv entries.
 */
function qualityArgs(encoder, quality) {
  if (quality === undefined) return [];
  const value = String(quality);
  if (encoder.endsWith('_nvenc')) return ['-rc', 'vbr', '-cq', value];
  if (encoder.endsWith('_qsv')) return ['-global_quality', value];
  if (encoder.endsWith('_amf')) return ['-rc', 'cqp', '-qp_i', value, '-qp_p', value];
  if (encoder.endsWith('_videotoolbox')) {
    // videotoolbox -q:v runs 0-100 where HIGHER is better, the inverse of CRF.
    // Map the tool's CRF-style 0-51 (lower is better) onto it monotonically so
    // the `quality` argument keeps one meaning across every platform.
    const vt = Math.max(0, Math.min(100, Math.round(100 - (Number(value) / 51) * 100)));
    return ['-q:v', String(vt)];
  }
  if (encoder === 'libvpx-vp9') return ['-crf', value, '-b:v', '0'];
  return ['-crf', value];
}

/**
 * Build the video filter chain from the requested geometry and frame rate.
 * @param options - scale and fps requests.
 * @returns `-vf` argv entries, or an empty array.
 */
function videoFilters(options) {
  const filters = [];
  if (typeof options.scale === 'string' && options.scale.length > 0) {
    // A value the model controls still reaches ffmpeg as one argv entry, so a
    // malformed value fails inside ffmpeg instead of escaping into a shell.
    filters.push(`scale=${options.scale}`);
  }
  if (typeof options.fps === 'number') {
    if (!Number.isFinite(options.fps) || options.fps <= 0) throw new Error(`invalid fps: ${options.fps}`);
    filters.push(`fps=${options.fps}`);
  }
  return filters.length === 0 ? [] : ['-vf', filters.join(',')];
}

/**
 * Append caller-supplied extra arguments, each as its own argv entry.
 * @param args - the argv being built.
 * @param extraArgs - additional flags supplied by the caller.
 * @returns the same array for chaining.
 */
function appendExtra(args, extraArgs) {
  if (extraArgs === undefined) return args;
  if (!Array.isArray(extraArgs)) throw new Error('extraArgs must be an array of strings');
  for (const entry of extraArgs) {
    if (typeof entry !== 'string') throw new Error('extraArgs must be an array of strings');
    args.push(entry);
  }
  return args;
}

/** Options accepted by {@link buildTranscodeArgs}. */
const TRANSCODE_DEFAULTS = { videoCodec: 'h264', audioCodec: 'aac', overwrite: true };

/**
 * Build the argv for a full transcode.
 * @param options - transcode request.
 * @returns the complete argv.
 */
export function buildTranscodeArgs(options) {
  const settings = { ...TRANSCODE_DEFAULTS, ...options };
  const args = leading(settings.overwrite);
  if (typeof settings.start !== 'undefined') args.push('-ss', String(parseTimestamp(settings.start)));
  // A raw elementary stream has no container to probe, so the caller names its
  // demuxer explicitly (h264, hevc, aac, mpegts, ...). This must precede -i.
  if (typeof settings.inputFormat === 'string' && settings.inputFormat.length > 0) {
    args.push('-f', settings.inputFormat);
  }
  args.push('-i', settings.input);

  const encoder = resolveVideoEncoder(settings.videoCodec, settings.hwaccel);
  const filters = videoFilters(settings);
  if (encoder === undefined && filters.length > 0) {
    throw new Error(
      'scale and fps require re-encoding: pass a real video codec instead of '
      + `"${settings.videoCodec}"`,
    );
  }
  if (settings.videoCodec === 'none') {
    args.push('-vn');
  } else if (encoder === undefined) {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', encoder);
    args.push(...speedArgs(encoder, settings.speed));
    if (typeof settings.bitrate === 'string' && settings.bitrate.length > 0) {
      args.push('-b:v', settings.bitrate);
    } else {
      args.push(...qualityArgs(encoder, settings.quality));
    }
    if (encoder === 'libx264' || encoder === 'libx265' || encoder.endsWith('_nvenc')) {
      args.push('-pix_fmt', settings.pixelFormat ?? 'yuv420p');
    } else if (typeof settings.pixelFormat === 'string') {
      args.push('-pix_fmt', settings.pixelFormat);
    }
    args.push(...filters);
  }

  // Trimming is an output option that applies to every mode, including a
  // stream copy, so it must not live inside the re-encode branch.
  if (typeof settings.duration !== 'undefined') {
    args.push('-t', String(parseTimestamp(settings.duration)));
  } else if (typeof settings.end !== 'undefined') {
    const start = typeof settings.start === 'undefined' ? 0 : parseTimestamp(settings.start);
    args.push('-t', String(Math.max(0, parseTimestamp(settings.end) - start)));
  }

  if (settings.audioCodec === 'none') {
    args.push('-an');
  } else if (settings.audioCodec === 'copy') {
    args.push('-c:a', 'copy');
  } else {
    const audioEncoder = AUDIO_ENCODERS[settings.audioCodec];
    if (audioEncoder === undefined) throw new Error(`unknown audio codec: ${settings.audioCodec}`);
    args.push('-c:a', audioEncoder);
    if (typeof settings.audioBitrate === 'string' && settings.audioBitrate.length > 0) {
      args.push('-b:a', settings.audioBitrate);
    }
    if (typeof settings.audioChannels === 'number') args.push('-ac', String(settings.audioChannels));
    if (typeof settings.audioSampleRate === 'number') args.push('-ar', String(settings.audioSampleRate));
  }

  appendExtra(args, settings.extraArgs);
  // Force the output muxer independently of the file extension, useful when a
  // raw or transport stream must be written to a specific container.
  if (typeof settings.outputFormat === 'string' && settings.outputFormat.length > 0) {
    args.push('-f', settings.outputFormat);
  }
  args.push(...trailing(settings.output));
  args.push(settings.output);
  return args;
}

/**
 * Build the argv that extracts one kind of essence from a file.
 * @param options - extraction request.
 * @returns the complete argv.
 */
export function buildExtractArgs(options) {
  const overwrite = options.overwrite ?? true;
  const args = leading(overwrite);
  const streamIndex = typeof options.streamIndex === 'number' ? options.streamIndex : 0;

  if (options.what === 'thumbnail' || options.what === 'waveform') {
    if (options.what === 'thumbnail') {
      args.push('-ss', String(parseTimestamp(options.time ?? 0)));
      args.push('-i', options.input, '-frames:v', '1');
      if (typeof options.scale === 'string' && options.scale.length > 0) {
        args.push('-vf', `scale=${options.scale}`);
      }
    } else {
      args.push('-i', options.input);
      const size = typeof options.scale === 'string' && options.scale.length > 0 ? options.scale : '1200x400';
      const color = typeof options.color === 'string' && options.color.length > 0 ? options.color : 'white';
      args.push('-filter_complex', `showwavespic=s=${size}:colors=${color}`, '-frames:v', '1');
    }
    if (options.what === 'waveform') args.push('-an');
  } else if (options.what === 'frames') {
    args.push('-i', options.input);
    const fps = typeof options.fps === 'number' ? options.fps : 1;
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`invalid fps: ${fps}`);
    args.push('-vf', `fps=${fps}`);
    if (typeof options.count === 'number' && options.count > 0) args.push('-frames:v', String(options.count));
    args.push('-an');
  } else if (options.what === 'audio') {
    args.push('-i', options.input, '-vn', '-map', `0:a:${streamIndex}`);
    if (options.audioCodec === 'copy' || options.audioCodec === undefined) args.push('-c:a', 'copy');
    else {
      const audioEncoder = AUDIO_ENCODERS[options.audioCodec];
      if (audioEncoder === undefined) throw new Error(`unknown audio codec: ${options.audioCodec}`);
      args.push('-c:a', audioEncoder);
      if (typeof options.audioBitrate === 'string' && options.audioBitrate.length > 0) {
        args.push('-b:a', options.audioBitrate);
      }
      if (typeof options.audioChannels === 'number') args.push('-ac', String(options.audioChannels));
    }
  } else if (options.what === 'subtitle') {
    args.push('-i', options.input, '-vn', '-an', '-map', `0:s:${streamIndex}`);
    if (options.subtitleFormat === 'copy' || options.subtitleFormat === undefined) args.push('-c:s', 'copy');
    else {
      const subtitleEncoder = SUBTITLE_ENCODERS[options.subtitleFormat];
      if (subtitleEncoder === undefined) throw new Error(`unknown subtitle format: ${options.subtitleFormat}`);
      args.push('-c:s', subtitleEncoder);
    }
  } else {
    throw new Error(`unknown extraction kind: ${options.what}`);
  }

  appendExtra(args, options.extraArgs);
  args.push(options.output);
  return args;
}

/**
 * Strips a leading `file:` so a path is treated as a filesystem path.
 * @param value - the input path.
 * @returns the path without a `file:` prefix.
 */
function plainPath(value) {
  return value.startsWith('file:') ? value.slice('file:'.length) : value;
}

/**
 * Render one concat-demuxer list line. The demuxer treats `'` as a quote, so a
 * literal quote is escaped by closing, escaping, and reopening the quote.
 *
 * Callers must pass an ABSOLUTE path: the concat demuxer resolves a relative
 * entry against the list file's own directory, not the process working
 * directory, so a relative entry silently points at the wrong file.
 * @param file - the input path, absolute.
 * @returns the list file line.
 */
export function concatListLine(file) {
  const escaped = plainPath(file).replaceAll('\\', '/').replaceAll("'", "'\\''");
  return `file '${escaped}'`;
}

/**
 * Build the argv that joins several files.
 * @param options - concat request.
 * @returns the complete argv, plus the list file content for copy mode.
 */
export function buildConcatArgs(options) {
  const args = leading(options.overwrite ?? true);
  args.push('-f', 'concat', '-safe', '0', '-i', options.listFile);
  if (options.mode === 'copy') {
    args.push('-c', 'copy');
  } else {
    const encoder = resolveVideoEncoder(options.videoCodec ?? 'h264', options.hwaccel ?? 'software');
    if (encoder === undefined) {
      throw new Error(`reencode mode requires a real video codec, got "${options.videoCodec}"`);
    }
    args.push('-c:v', encoder);
    args.push(...speedArgs(encoder, options.speed));
    args.push(...qualityArgs(encoder, options.quality));
    args.push('-pix_fmt', options.pixelFormat ?? 'yuv420p');
    args.push(...videoFilters(options));
    const audioEncoder = options.audioCodec === 'copy'
      ? 'copy'
      : AUDIO_ENCODERS[options.audioCodec ?? 'aac'];
    if (audioEncoder === undefined) throw new Error(`unknown audio codec: ${options.audioCodec}`);
    args.push('-c:a', audioEncoder);
    if (typeof options.audioBitrate === 'string' && options.audioBitrate.length > 0) {
      args.push('-b:a', options.audioBitrate);
    }
  }
  appendExtra(args, options.extraArgs);
  args.push(...trailing(options.output));
  args.push(options.output);
  return args;
}

/**
 * Build the argv that trims one file.
 * @param options - clip request.
 * @returns the complete argv.
 */
export function buildClipArgs(options) {
  const args = leading(options.overwrite ?? true);
  const start = typeof options.start === 'undefined' ? 0 : parseTimestamp(options.start);
  let duration;
  if (typeof options.duration !== 'undefined') duration = parseTimestamp(options.duration);
  else if (typeof options.end !== 'undefined') duration = Math.max(0, parseTimestamp(options.end) - start);

  // Input seeking before `-i` is the fast path, and for a re-encode the decoder
  // still lands on the requested frame; for a copy it can only start at a
  // keyframe, which the tool description states.
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', options.input);
  if (duration !== undefined) args.push('-t', String(duration));

  if (options.mode === 'copy') {
    // No `-avoid_negative_ts make_zero` here: measured against this build it
    // keeps the pre-seek packets and stretches a 3 s copy trim to 4 s, while
    // the default timestamp handling drops them and honors `-t`.
    args.push('-c', 'copy');
  } else {
    const encoder = resolveVideoEncoder(options.videoCodec ?? 'h264', options.hwaccel ?? 'software');
    if (encoder === undefined) {
      throw new Error(`reencode mode requires a real video codec, got "${options.videoCodec}"`);
    }
    args.push('-c:v', encoder);
    args.push(...speedArgs(encoder, options.speed));
    if (typeof options.bitrate === 'string' && options.bitrate.length > 0) args.push('-b:v', options.bitrate);
    else args.push(...qualityArgs(encoder, options.quality));
    args.push('-pix_fmt', options.pixelFormat ?? 'yuv420p');
    const audioEncoder = options.audioCodec === 'copy' ? 'copy' : AUDIO_ENCODERS[options.audioCodec ?? 'aac'];
    if (audioEncoder === undefined) throw new Error(`unknown audio codec: ${options.audioCodec}`);
    args.push('-c:a', audioEncoder);
    if (typeof options.audioBitrate === 'string' && options.audioBitrate.length > 0) {
      args.push('-b:a', options.audioBitrate);
    }
  }
  appendExtra(args, options.extraArgs);
  args.push(...trailing(options.output));
  args.push(options.output);
  return args;
}

/**
 * Audio codec a bare audio container implies, used by batch extraction when the
 * caller names only a target extension.
 * @param file - the output path.
 * @returns the audio codec name, or undefined.
 */
export function audioCodecForFile(file) {
  const match = /\.([a-z0-9]+)$/iu.exec(file);
  if (match === null) return undefined;
  return AUDIO_BY_FORMAT[match[1].toLowerCase()];
}

/**
 * Whether a path is an image target, which changes how a thumbnail is encoded.
 * @param file - the output path.
 * @returns true for a still-image extension.
 */
export function isImageTarget(file) {
  const lower = file.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
