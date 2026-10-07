import { statSync } from 'node:fs';
import { runOrThrow, runTool, safeCwd } from './run.js';
import { requireTool } from './toolchain.js';

/**
 * Drop absent members so an output object only carries real facts. `0` and
 * `false` are kept: a zero bitrate or a non-forced subtitle are answers, while
 * `undefined` and `null` are gaps.
 * @param source - the object to compact.
 * @returns a copy without undefined, null, and empty-string values.
 */
function compact(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Parse an ffprobe rational such as `30000/1001` into a decimal.
 * @param value - the raw rational string.
 * @returns the decimal value, or undefined when unusable.
 */
function ratio(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const [num, den] = value.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  const result = n / d;
  return Number.isFinite(result) ? Math.round(result * 1000) / 1000 : undefined;
}

/**
 * Classify a video stream's dynamic range from transfer characteristics and
 * side data, which is what decides whether a tone-mapping step is required.
 * @param stream - one ffprobe video stream.
 * @returns a short label, or undefined for standard dynamic range.
 */
function dynamicRange(stream) {
  const side = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const types = side.map((entry) => entry?.side_data_type).filter((value) => typeof value === 'string');
  const transfer = typeof stream.color_transfer === 'string' ? stream.color_transfer : '';
  const hasDovi = types.some((type) => /dovi|dolby vision/iu.test(type));
  const hasHdr10Plus = types.some((type) => /hdr10\+|dynamic metadata/iu.test(type));
  const hasMastering = types.some((type) => /mastering display/iu.test(type));
  if (hasDovi) return 'dolby-vision';
  if (hasHdr10Plus) return 'hdr10+';
  if (transfer === 'smpte2084') return hasMastering ? 'hdr10' : 'pq';
  if (transfer === 'arib-std-b67') return 'hlg';
  return undefined;
}

/**
 * Pull a named value out of a MediaInfo `extra` block, where MediaInfo reports
 * derived facts such as HDR format and channel layout.
 * @param track - one MediaInfo track object.
 * @param name - the `extra` entry name to read.
 * @returns the string value, or undefined.
 */
function extraValue(track, name) {
  const extra = track?.extra;
  if (!extra || typeof extra !== 'object') return undefined;
  const value = extra[name];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

/** MediaInfo `@type` values mapped onto the stream vocabulary used here. */
const MEDIAINFO_KINDS = { General: 'general', Video: 'video', Audio: 'audio', Text: 'subtitle', Menu: 'menu' };

/**
 * Condense MediaInfo tracks into a small, stable per-kind summary. MediaInfo
 * carries derived fields ffprobe omits (HDR format, channel layout, writing
 * library), so this is kept alongside the ffprobe view rather than merged away.
 * @param mediainfo - the parsed `--Output=JSON` document.
 * @returns condensed tracks keyed by kind.
 */
function condenseMediaInfo(mediainfo) {
  const tracks = mediainfo?.media?.track;
  if (!Array.isArray(tracks)) return {};
  const grouped = {};
  for (const track of tracks) {
    const kind = MEDIAINFO_KINDS[track?.['@type']] ?? 'other';
    const entry = compact({
      format: track.Format,
      codec: track.CodecID,
      profile: track.Format_Profile,
      durationSeconds: track.Duration === undefined ? undefined : Math.round(Number(track.Duration) * 1000) / 1000,
      bitRate: track.BitRate === undefined ? undefined : Number(track.BitRate),
      width: track.Width === undefined ? undefined : Number(track.Width),
      height: track.Height === undefined ? undefined : Number(track.Height),
      frameRate: track.FrameRate === undefined ? undefined : Number(track.FrameRate),
      channels: track.Channels === undefined ? undefined : Number(track.Channels),
      channelLayout: track.ChannelLayout,
      sampleRate: track.SamplingRate === undefined ? undefined : Number(track.SamplingRate),
      bitDepth: track.BitDepth === undefined ? undefined : Number(track.BitDepth),
      hdrFormat: extraValue(track, 'HDR_Format'),
      writingLibrary: track.Encoded_Library,
      language: track.Language,
      title: track.Title,
    });
    if (Object.keys(entry).length === 0) continue;
    (grouped[kind] ??= []).push(entry);
  }
  return grouped;
}

/**
 * Human- and model-readable one-block summary of a probed file.
 * @param facts - the assembled facts.
 * @returns the summary text.
 */
function summarize(facts) {
  const lines = [];
  const duration = facts.durationSeconds === undefined ? '?' : `${facts.durationSeconds.toFixed(3)} s`;
  const size = facts.sizeBytes === undefined ? '?' : `${(facts.sizeBytes / 1048576).toFixed(2)} MiB`;
  const rate = facts.bitRate === undefined ? '?' : `${(facts.bitRate / 1000).toFixed(0)} kb/s`;
  lines.push(`${facts.path}`);
  lines.push(`container ${facts.container ?? '?'} · ${duration} · ${size} · ${rate}`);
  for (const stream of facts.video ?? []) {
    const parts = [
      `video #${stream.index}`,
      stream.codec,
      stream.profile === undefined ? undefined : `(${stream.profile})`,
      stream.width !== undefined && stream.height !== undefined ? `${stream.width}x${stream.height}` : undefined,
      stream.pixFmt,
      stream.frameRate === undefined ? undefined : `${stream.frameRate} fps`,
      stream.bitRate === undefined ? undefined : `${(stream.bitRate / 1000).toFixed(0)} kb/s`,
      stream.hdr === undefined ? undefined : `HDR=${stream.hdr}`,
    ].filter(Boolean);
    lines.push(parts.join(' '));
  }
  for (const stream of facts.audio ?? []) {
    const parts = [
      `audio #${stream.index}`,
      stream.codec,
      stream.channels === undefined ? undefined : `${stream.channels}ch`,
      stream.channelLayout,
      stream.sampleRate === undefined ? undefined : `${stream.sampleRate} Hz`,
      stream.bitRate === undefined ? undefined : `${(stream.bitRate / 1000).toFixed(0)} kb/s`,
      stream.language === undefined ? undefined : `[${stream.language}]`,
    ].filter(Boolean);
    lines.push(parts.join(' '));
  }
  for (const stream of facts.subtitle ?? []) {
    const parts = [
      `subtitle #${stream.index}`,
      stream.codec,
      stream.language === undefined ? undefined : `[${stream.language}]`,
      stream.title,
    ].filter(Boolean);
    lines.push(parts.join(' '));
  }
  if (facts.chapterCount) lines.push(`${facts.chapterCount} chapter(s)`);
  if ((facts.video ?? []).length === 0 && (facts.audio ?? []).length === 0) {
    lines.push('no audio or video stream reported');
  }
  return lines.join('\n');
}

/**
 * Probe one media file with ffprobe and MediaInfo and return the merged facts.
 * @param ctx - a context carrying `ctx.subprocess`.
 * @param file - path to the media file.
 * @param options - cancellation and whether to include the raw tool documents.
 * @returns the merged probe result, including a text `summary`.
 */
export async function probeMedia(ctx, file, options = {}) {
  const { signal, includeRaw = false, inputFormat } = options;
  const cwd = options.cwd ?? safeCwd();
  const argv = [
    requireTool('ffprobe'),
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
  ];
  // A raw elementary stream has no container to probe; the caller names the
  // demuxer so ffprobe can read SPS/PPS and report width/height/level.
  if (typeof inputFormat === 'string' && inputFormat.length > 0) {
    argv.push('-f', inputFormat);
  }
  argv.push(file);
  const ffprobe = await runOrThrow(
    ctx,
    argv,
    { cwd, signal, maxBytes: 4 * 1024 * 1024 },
  );
  let parsed;
  try {
    parsed = JSON.parse(ffprobe.stdout);
  } catch {
    throw new Error(`ffprobe returned output that is not JSON for ${file}`);
  }

  const format = parsed.format ?? {};
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const size = format.size === undefined ? safeSize(file) : Number(format.size);

  const video = [];
  const audio = [];
  const subtitle = [];
  for (const stream of streams) {
    const index = Number(stream.index);
    const language = stream.tags?.language;
    if (stream.codec_type === 'video') {
      // Album art and embedded thumbnails are video streams with no timing.
      if (stream.disposition?.attached_pic === 1) continue;
      video.push(compact({
        index,
        codec: stream.codec_name,
        profile: stream.profile,
        width: stream.width,
        height: stream.height,
        pixFmt: stream.pix_fmt,
        frameRate: ratio(stream.r_frame_rate),
        bitRate: stream.bit_rate === undefined ? undefined : Number(stream.bit_rate),
        colorPrimaries: stream.color_primaries,
        colorTransfer: stream.color_transfer,
        hdr: dynamicRange(stream),
        rotation: rotationOf(stream),
      }));
    } else if (stream.codec_type === 'audio') {
      audio.push(compact({
        index,
        codec: stream.codec_name,
        channels: stream.channels,
        channelLayout: stream.channel_layout,
        sampleRate: stream.sample_rate === undefined ? undefined : Number(stream.sample_rate),
        bitRate: stream.bit_rate === undefined ? undefined : Number(stream.bit_rate),
        language,
      }));
    } else if (stream.codec_type === 'subtitle') {
      subtitle.push(compact({
        index,
        codec: stream.codec_name,
        language,
        title: stream.tags?.title,
        forced: stream.disposition?.forced === 1 ? true : undefined,
      }));
    }
  }

  // MediaInfo is optional enrichment: a file ffprobe reads but MediaInfo
  // rejects should still probe successfully.
  let mediainfo = {};
  const mediainfoRaw = await runToolQuiet(ctx, [
    requireTool('mediainfo'),
    '--Output=JSON',
    file,
  ], { cwd, signal });
  if (mediainfoRaw !== undefined) {
    try {
      mediainfo = condenseMediaInfo(JSON.parse(mediainfoRaw));
    } catch {
      mediainfo = {};
    }
  }

  const facts = compact({
    path: file,
    container: format.format_name,
    durationSeconds: format.duration === undefined ? undefined : Math.round(Number(format.duration) * 1000) / 1000,
    sizeBytes: Number.isFinite(size) ? size : undefined,
    bitRate: format.bit_rate === undefined ? undefined : Number(format.bit_rate),
    video: video.length > 0 ? video : undefined,
    audio: audio.length > 0 ? audio : undefined,
    subtitle: subtitle.length > 0 ? subtitle : undefined,
    chapterCount: Array.isArray(parsed.chapters) ? parsed.chapters.length : undefined,
    mediainfo: Object.keys(mediainfo).length > 0 ? mediainfo : undefined,
  });
  facts.summary = summarize(facts);
  if (includeRaw) {
    facts.raw = {
      ffprobe: parsed,
      mediainfo: mediainfoRaw === undefined ? null : safeJson(mediainfoRaw),
    };
  }
  return facts;
}

/**
 * Read a stream's rotation from the display matrix side data, which decides
 * whether a phone-shot clip is stored landscape and displayed portrait.
 * @param stream - one ffprobe video stream.
 * @returns the rotation in degrees, or undefined when absent.
 */
function rotationOf(stream) {
  const side = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  for (const entry of side) {
    const rotation = entry?.rotation;
    if (rotation !== undefined && Number.isFinite(Number(rotation))) return Number(rotation);
  }
  return undefined;
}

/**
 * Stat a file size without failing the probe when the path is unreadable.
 * @param file - the file path.
 * @returns the size in bytes, or NaN.
 */
function safeSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return Number.NaN;
  }
}

/**
 * Parse JSON without throwing, so a malformed raw document cannot break echo.
 * @param text - candidate JSON text.
 * @returns the parsed value, or null.
 */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Run a command where a non-zero exit is an acceptable answer rather than a
 * failure, used for MediaInfo enrichment.
 * @param ctx - a context carrying `ctx.subprocess`.
 * @param argv - the complete argv.
 * @param options - see `runTool`.
 * @returns stdout on success, else undefined.
 */
async function runToolQuiet(ctx, argv, options) {
  try {
    const result = await runTool(ctx, argv, { ...options, maxBytes: 4 * 1024 * 1024 });
    return result.exitCode === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}
