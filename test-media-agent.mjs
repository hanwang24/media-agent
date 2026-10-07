import assert from 'node:assert/strict';
import {
  buildClipArgs,
  buildConcatArgs,
  buildExtractArgs,
  buildTranscodeArgs,
  concatListLine,
  parseTimestamp,
  resolveVideoEncoder,
  audioCodecForFile,
} from './plugin/lib/recipes.js';
import { globMatcher, parseProgress, pool } from './plugin/lib/media-job.js';
import { resolveTool, toolchainReport } from './plugin/lib/toolchain.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

/** The flag immediately following `flag` in an argv. */
function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

// ---------------------------------------------------------------- toolchain
test('toolchain resolves the installed ffmpeg absolutely', () => {
  const path = resolveTool('ffmpeg');
  assert.match(path, /ffmpeg(\.exe)?$/u);
  assert.ok(path.includes('tools'), `expected the portable root, got ${path}`);
});
test('toolchain report covers all three tools', () => {
  const report = toolchainReport();
  for (const id of ['ffmpeg', 'ffprobe', 'mediainfo']) assert.ok(report.tools[id].bundled, `${id} not bundled`);
});

// ------------------------------------------------------------- parseTimestamp
test('parseTimestamp handles bare seconds', () => assert.equal(parseTimestamp('90'), 90));
test('parseTimestamp handles MM:SS as minutes', () => assert.equal(parseTimestamp('01:30'), 90));
test('parseTimestamp handles HH:MM:SS', () => assert.equal(parseTimestamp('1:02:03'), 3723));
test('parseTimestamp handles fractions', () => assert.equal(parseTimestamp('0.5'), 0.5));
test('parseTimestamp handles MM:SS.mmm', () => assert.equal(parseTimestamp('2:03.25'), 123.25));
test('parseTimestamp accepts numbers', () => assert.equal(parseTimestamp(12), 12));
test('parseTimestamp rejects too many parts', () => assert.throws(() => parseTimestamp('1:2:3:4')));
test('parseTimestamp rejects negatives', () => assert.throws(() => parseTimestamp('-5')));
test('parseTimestamp rejects garbage', () => assert.throws(() => parseTimestamp('abc')));

// ------------------------------------------------------- resolveVideoEncoder
test('h264 software encoder', () => assert.equal(resolveVideoEncoder('h264', 'software'), 'libx264'));
test('h264 nvenc encoder', () => assert.equal(resolveVideoEncoder('h264', 'nvenc'), 'h264_nvenc'));
test('av1 software encoder is libaom', () => assert.equal(resolveVideoEncoder('av1', 'software'), 'libaom-av1'));
test('copy yields no encoder', () => assert.equal(resolveVideoEncoder('copy'), undefined));
test('none yields no encoder', () => assert.equal(resolveVideoEncoder('none'), undefined));
test('vp9 has no nvenc encoder', () => assert.throws(() => resolveVideoEncoder('vp9', 'nvenc')));
test('unknown codec throws', () => assert.throws(() => resolveVideoEncoder('mpeg2')));
test('h264 videotoolbox encoder (macOS)', () => assert.equal(resolveVideoEncoder('h264', 'videotoolbox'), 'h264_videotoolbox'));
test('hevc videotoolbox encoder (macOS)', () => assert.equal(resolveVideoEncoder('hevc', 'videotoolbox'), 'hevc_videotoolbox'));
test('av1 has no videotoolbox encoder and fails loud', () => assert.throws(() => resolveVideoEncoder('av1', 'videotoolbox')));

// --------------------------------------------------------- buildTranscodeArgs
const base = { input: 'in.mp4', output: 'out.mp4' };

test('transcode defaults to h264/aac with crf and faststart', () => {
  const argv = buildTranscodeArgs({ ...base, quality: 23 });
  assert.equal(valueAfter(argv, '-c:v'), 'libx264');
  assert.equal(valueAfter(argv, '-crf'), '23');
  assert.equal(valueAfter(argv, '-c:a'), 'aac');
  assert.equal(valueAfter(argv, '-pix_fmt'), 'yuv420p');
  assert.ok(argv.includes('+faststart'));
  assert.equal(argv.at(-1), 'out.mp4');
});
test('transcode carries -progress and suppresses interaction', () => {
  const argv = buildTranscodeArgs(base);
  assert.ok(argv.includes('-nostdin'));
  assert.equal(valueAfter(argv, '-progress'), 'pipe:1');
  assert.ok(argv.includes('-nostats'));
});
test('transcode slaps -t on a stream copy (regression)', () => {
  const argv = buildTranscodeArgs({ ...base, videoCodec: 'copy', audioCodec: 'copy', start: '10', duration: '5' });
  assert.equal(valueAfter(argv, '-c:v'), 'copy');
  assert.equal(valueAfter(argv, '-t'), '5');
  assert.ok(argv.indexOf('-ss') < argv.indexOf('-i'), '-ss must precede -i for input seeking');
});
test('transcode derives -t from start and end', () => {
  const argv = buildTranscodeArgs({ ...base, start: '10', end: '25' });
  assert.equal(valueAfter(argv, '-t'), '15');
});
test('transcode rejects scaling a stream copy', () => {
  assert.throws(() => buildTranscodeArgs({ ...base, videoCodec: 'copy', scale: '1280:-2' }), /re-encoding/u);
});
test('transcode maps nvenc quality onto cq', () => {
  const argv = buildTranscodeArgs({ ...base, videoCodec: 'hevc', hwaccel: 'nvenc', quality: 28 });
  assert.equal(valueAfter(argv, '-c:v'), 'hevc_nvenc');
  assert.equal(valueAfter(argv, '-cq'), '28');
  assert.equal(valueAfter(argv, '-rc'), 'vbr');
});
test('transcode maps speed onto this encoder preset', () => {
  assert.equal(valueAfter(buildTranscodeArgs({ ...base, speed: 'slowest' }), '-preset'), 'veryslow');
  assert.equal(valueAfter(buildTranscodeArgs({ ...base, hwaccel: 'nvenc', speed: 'fastest' }), '-preset'), 'p1');
  assert.equal(valueAfter(buildTranscodeArgs({ ...base, videoCodec: 'av1', speed: 'slow' }), '-cpu-used'), '2');
});
test('videotoolbox maps CRF quality onto the inverse q:v scale', () => {
  assert.equal(valueAfter(buildTranscodeArgs({ ...base, videoCodec: 'h264', hwaccel: 'videotoolbox', quality: 23 }), '-q:v'), '55');
  assert.equal(valueAfter(buildTranscodeArgs({ ...base, videoCodec: 'hevc', hwaccel: 'videotoolbox', quality: 0 }), '-q:v'), '100');
  assert.equal(valueAfter(buildTranscodeArgs({ ...base, videoCodec: 'hevc', hwaccel: 'videotoolbox', quality: 51 }), '-q:v'), '0');
});
test('videotoolbox takes no preset, so speed is left untouched', () => {
  const argv = buildTranscodeArgs({ ...base, videoCodec: 'h264', hwaccel: 'videotoolbox', speed: 'slowest' });
  assert.ok(!argv.includes('-preset'));
});
test('transcode bitrate replaces quality', () => {
  const argv = buildTranscodeArgs({ ...base, bitrate: '4M', quality: 20 });
  assert.equal(valueAfter(argv, '-b:v'), '4M');
  assert.ok(!argv.includes('-crf'));
});
test('transcode can drop audio', () => {
  assert.ok(buildTranscodeArgs({ ...base, audioCodec: 'none' }).includes('-an'));
});
test('transcode appends extraArgs verbatim as argv entries', () => {
  const argv = buildTranscodeArgs({ ...base, extraArgs: ['-tune', 'film'] });
  assert.equal(valueAfter(argv, '-tune'), 'film');
});
test('transcode names the demuxer for a raw elementary stream', () => {
  const argv = buildTranscodeArgs({ input: 'stream.h264', inputFormat: 'h264', output: 'out.mp4', videoCodec: 'copy', audioCodec: 'none' });
  assert.equal(valueAfter(argv, '-f'), 'h264');
  assert.ok(argv.indexOf('-f') < argv.indexOf('-i'), '-f must precede -i for input demuxing');
});
test('transcode forces the output muxer independently of the extension', () => {
  const argv = buildTranscodeArgs({ input: 'in.mp4', output: 'out.bin', outputFormat: 'mpegts', videoCodec: 'copy', audioCodec: 'copy' });
  assert.equal(valueAfter(argv, '-f'), 'mpegts');
});
test('transcode demuxer and muxer can both be forced', () => {
  const argv = buildTranscodeArgs({ input: 's.aac', inputFormat: 'aac', output: 'out.mp4', outputFormat: 'mp4', videoCodec: 'none', audioCodec: 'copy' });
  assert.equal(argv[argv.indexOf('-f') + 1], 'aac');
  assert.equal(argv[argv.lastIndexOf('-f') + 1], 'mp4');
});
test('transcode rejects an unknown audio codec', () => {
  assert.throws(() => buildTranscodeArgs({ ...base, audioCodec: 'aac2' }));
});

// ------------------------------------------------------------- buildClipArgs
test('clip copy mode uses input seeking and copy', () => {
  const argv = buildClipArgs({ input: 'in.mp4', output: 'out.mp4', start: '5', duration: '3', mode: 'copy' });
  assert.equal(valueAfter(argv, '-c'), 'copy');
  assert.equal(valueAfter(argv, '-t'), '3');
  assert.ok(argv.indexOf('-ss') < argv.indexOf('-i'));
  // Regression: `-avoid_negative_ts make_zero` kept the pre-seek packets and
  // stretched a 3 s copy trim into a 4 s file on this build.
  assert.ok(!argv.includes('-avoid_negative_ts'), 'make_zero must not be used for a copy trim');
});
test('clip reencode mode refuses copy as a codec', () => {
  assert.throws(
    () => buildClipArgs({ input: 'in.mp4', output: 'out.mp4', start: '1', mode: 'reencode', videoCodec: 'copy' }),
    /real video codec/u,
  );
});

// ----------------------------------------------------------- buildExtractArgs
test('extract audio maps to a copy by default', () => {
  const argv = buildExtractArgs({ input: 'in.mp4', output: 'a.m4a', what: 'audio' });
  assert.equal(valueAfter(argv, '-map'), '0:a:0');
  assert.equal(valueAfter(argv, '-c:a'), 'copy');
  assert.ok(argv.includes('-vn'));
});
test('extract audio honours a stream index and encoder', () => {
  const argv = buildExtractArgs({ input: 'in.mp4', output: 'a.mp3', what: 'audio', streamIndex: 2, audioCodec: 'mp3', audioBitrate: '192k' });
  assert.equal(valueAfter(argv, '-map'), '0:a:2');
  assert.equal(valueAfter(argv, '-c:a'), 'libmp3lame');
  assert.equal(valueAfter(argv, '-b:a'), '192k');
});
test('extract subtitle maps the track', () => {
  const argv = buildExtractArgs({ input: 'in.mkv', output: 's.srt', what: 'subtitle', streamIndex: 1, subtitleFormat: 'srt' });
  assert.equal(valueAfter(argv, '-map'), '0:s:1');
  assert.equal(valueAfter(argv, '-c:s'), 'subrip');
});
test('extract thumbnail seeks before input', () => {
  const argv = buildExtractArgs({ input: 'in.mp4', output: 't.png', what: 'thumbnail', time: '3', scale: '640:-2' });
  assert.ok(argv.indexOf('-ss') < argv.indexOf('-i'));
  assert.equal(valueAfter(argv, '-frames:v'), '1');
  assert.equal(valueAfter(argv, '-vf'), 'scale=640:-2');
});
test('extract frames sets fps and a frame cap', () => {
  const argv = buildExtractArgs({ input: 'in.mp4', output: 'f-%04d.png', what: 'frames', fps: 2, count: 10 });
  assert.equal(valueAfter(argv, '-vf'), 'fps=2');
  assert.equal(valueAfter(argv, '-frames:v'), '10');
});
test('extract waveform builds a showwavespic filter', () => {
  const argv = buildExtractArgs({ input: 'in.mp4', output: 'w.png', what: 'waveform' });
  assert.match(valueAfter(argv, '-filter_complex'), /showwavespic=s=1200x400/u);
});
test('extract rejects an unknown kind', () => {
  assert.throws(() => buildExtractArgs({ input: 'in.mp4', output: 'o', what: 'magic' }));
});

// ----------------------------------------------------------- buildConcatArgs
test('concat copy uses the demuxer with unsafe paths allowed', () => {
  const argv = buildConcatArgs({ inputs: ['a.mp4', 'b.mp4'], output: 'o.mp4', mode: 'copy', listFile: 'list.txt' });
  assert.equal(valueAfter(argv, '-f'), 'concat');
  assert.equal(valueAfter(argv, '-safe'), '0');
  assert.equal(valueAfter(argv, '-i'), 'list.txt');
  assert.equal(valueAfter(argv, '-c'), 'copy');
});
test('concat reencode refuses copy as a codec', () => {
  assert.throws(
    () => buildConcatArgs({ inputs: [], output: 'o.mp4', mode: 'reencode', videoCodec: 'copy', listFile: 'l.txt' }),
    /real video codec/u,
  );
});
test('concat list line escapes a quote and normalizes separators', () => {
  assert.equal(concatListLine("C:\\a\\it's.mp4"), "file 'C:/a/it'\\''s.mp4'");
});
test('audioCodecForFile maps containers to the tool vocabulary', () => {
  assert.equal(audioCodecForFile('x.m4a'), 'aac');
  assert.equal(audioCodecForFile('x.mp3'), 'mp3');
  assert.equal(audioCodecForFile('x.opus'), 'opus');
  assert.equal(audioCodecForFile('x.wav'), 'pcm_s16le');
  assert.equal(audioCodecForFile('x.xyz'), undefined);
});

// -------------------------------------------------------------- media-job
test('parseProgress keeps the last value of each key', () => {
  const stream = [
    'frame=10', 'fps=25', 'out_time_us=400000', 'speed=1.5x',
    'progress=continue', 'frame=20', 'fps=26', 'out_time_us=800000', 'speed=N/A', 'progress=end',
  ].join('\n');
  const progress = parseProgress(stream);
  assert.equal(progress.outTimeSeconds, 0.8);
  assert.equal(progress.frame, 20);
  assert.equal(progress.fps, 26);
  assert.equal(progress.speed, undefined, 'N/A must not surface as a speed');
});
test('parseProgress tolerates an empty stream', () => {
  assert.equal(parseProgress('').outTimeSeconds, undefined);
});
test('globMatcher matches names, not paths', () => {
  assert.ok(globMatcher('*.mp4')('a.mp4'));
  assert.ok(!globMatcher('*.mp4')('a.mkv'));
  assert.ok(globMatcher('clip-?.mov')('clip-1.mov'));
  assert.ok(!globMatcher('*.mp4')('a.mp4.bak'));
  assert.ok(globMatcher('*.mp4')('A.MP4'), 'matching is case-insensitive');
});

const poolResult = await (async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  const results = await pool([1, 2, 3, 4, 5], async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    seen.push(value);
    if (value === 3) throw new Error('boom');
    return { value, ok: true };
  }, 2);
  return { results, peak, seen };
})();

test('pool keeps results in input order despite concurrency', () => {
  assert.deepEqual(poolResult.results.map((entry) => entry?.value ?? entry?.input), [1, 2, 3, 4, 5]);
});
test('pool bounds concurrency', () => assert.ok(poolResult.peak <= 2, `peak was ${poolResult.peak}`));
test('pool isolates one failure from its neighbours', () => {
  assert.equal(poolResult.results[2].ok, false);
  assert.match(poolResult.results[2].error, /boom/u);
  assert.equal(poolResult.results[4].ok, true);
});
test('pool runs everything', () => assert.equal(poolResult.seen.length, 5));

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
