import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  buildClipArgs,
  buildConcatArgs,
  buildExtractArgs,
  buildTranscodeArgs,
  concatListLine,
} from './plugin/lib/recipes.js';
import { resolveTool } from './plugin/lib/toolchain.js';
import { parseProgress } from './plugin/lib/media-job.js';

const OUT = 'e2e-out';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const INPUT = 'sample/probe-test.mp4';
assert.ok(existsSync(INPUT), `fixture missing: ${INPUT}`);

const failures = [];
let step = 0;

/**
 * Execute one argv built by the plugin and record the outcome. `-progress pipe:1`
 * writes machine-readable progress to stdout, so stdout is parsed exactly the
 * way the plugin's job runner parses it.
 */
function run(label, argv, expectOutput) {
  step += 1;
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const progress = parseProgress(result.stdout ?? '');
  const ok = result.status === 0;
  const bytes = expectOutput && existsSync(expectOutput) ? statSync(expectOutput).size : undefined;
  if (!ok) {
    const detail = (result.stderr ?? '').split('\n').filter((line) => line.trim().length > 0).slice(-4).join(' | ');
    failures.push(`${label}: exit ${result.status}: ${detail}`);
    console.log(`       stderr: ${detail}`);
  } else if (expectOutput && !(bytes > 0)) {
    failures.push(`${label}: expected a non-empty output at ${expectOutput}`);
  }
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${String(step).padStart(2)}. ${label.padEnd(30)} `
    + `exit=${result.status} bytes=${bytes ?? '-'} speed=${progress.speed ?? '-'} out=${progress.outTimeSeconds ?? '-'}s`,
  );
  return { result, progress };
}

/** Probe a produced file with the real ffprobe and return duration/stream counts. */
function inspect(file) {
  const probe = spawnSync(
    resolveTool('ffprobe'),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(probe.status, 0, `ffprobe rejected ${file}: ${probe.stderr}`);
  const parsed = JSON.parse(probe.stdout);
  return {
    duration: Number(parsed.format.duration),
    video: parsed.streams.filter((s) => s.codec_type === 'video').length,
    audio: parsed.streams.filter((s) => s.codec_type === 'audio').length,
    videoCodec: parsed.streams.find((s) => s.codec_type === 'video')?.codec_name,
    audioCodec: parsed.streams.find((s) => s.codec_type === 'audio')?.codec_name,
  };
}

console.log('executing plugin-built argv against the real ffmpeg\n');

// 1. Full transcode: scale down, re-encode both streams.
run(
  'transcode h264 640x360',
  buildTranscodeArgs({
    input: INPUT, output: `${OUT}/transcoded.mp4`,
    videoCodec: 'h264', audioCodec: 'aac', quality: 30, speed: 'fastest',
    scale: '640:-2', audioBitrate: '96k',
  }),
  `${OUT}/transcoded.mp4`,
);
const transcoded = inspect(`${OUT}/transcoded.mp4`);
assert.equal(transcoded.videoCodec, 'h264');
assert.equal(transcoded.audioCodec, 'aac');
assert.ok(Math.abs(transcoded.duration - 6) < 0.5, `duration drifted: ${transcoded.duration}`);
console.log(`     -> ${transcoded.videoCodec}/${transcoded.audioCodec} ${transcoded.duration.toFixed(2)}s`);

// 2. Trim with a stream copy (the regression case: -t must reach ffmpeg).
run(
  'clip copy 1s..4s',
  buildClipArgs({ input: INPUT, output: `${OUT}/clipped.mp4`, start: '1', end: '4', mode: 'copy' }),
  `${OUT}/clipped.mp4`,
);
const clipped = inspect(`${OUT}/clipped.mp4`);
assert.ok(clipped.duration >= 2.5 && clipped.duration <= 3.6, `copy trim duration was ${clipped.duration}`);
console.log(`     -> copy trim produced ${clipped.duration.toFixed(2)}s (requested 3s)`);

// 3. Trim with an exact re-encode, plus a resize.
run(
  'clip reencode 480 wide',
  buildClipArgs({
    input: INPUT, output: `${OUT}/clipped-exact.mp4`,
    start: '1', duration: '3', mode: 'reencode', quality: 32, speed: 'fastest',
  }),
  `${OUT}/clipped-exact.mp4`,
);
const exact = inspect(`${OUT}/clipped-exact.mp4`);
assert.ok(Math.abs(exact.duration - 3) < 0.35, `exact trim duration was ${exact.duration}`);

// 4. Remux to Matroska with no re-encoding at all.
run(
  'remux to mkv',
  buildTranscodeArgs({ input: INPUT, output: `${OUT}/remuxed.mkv`, videoCodec: 'copy', audioCodec: 'copy' }),
  `${OUT}/remuxed.mkv`,
);
const remuxed = inspect(`${OUT}/remuxed.mkv`);
assert.equal(remuxed.videoCodec, 'h264', 'a copy must keep the source codec');

// 5. Extract the audio track losslessly.
run(
  'extract audio copy',
  buildExtractArgs({ input: INPUT, output: `${OUT}/audio.m4a`, what: 'audio' }),
  `${OUT}/audio.m4a`,
);
assert.ok(inspect(`${OUT}/audio.m4a`).audio === 1);

// 6. Re-encode the audio to mp3.
run(
  'extract audio mp3',
  buildExtractArgs({ input: INPUT, output: `${OUT}/audio.mp3`, what: 'audio', audioCodec: 'mp3', audioBitrate: '128k' }),
  `${OUT}/audio.mp3`,
);
assert.equal(inspect(`${OUT}/audio.mp3`).audioCodec, 'mp3');

// 7. A single thumbnail at a chosen timestamp.
run(
  'thumbnail at 3s',
  buildExtractArgs({ input: INPUT, output: `${OUT}/thumb.png`, what: 'thumbnail', time: '3', scale: '480:-2' }),
  `${OUT}/thumb.png`,
);

// 8. A waveform image.
run(
  'waveform',
  buildExtractArgs({ input: INPUT, output: `${OUT}/wave.png`, what: 'waveform' }),
  `${OUT}/wave.png`,
);

// 9. An image sequence.
run(
  'frames at 1 fps',
  buildExtractArgs({ input: INPUT, output: `${OUT}/frame-%03d.png`, what: 'frames', fps: 1, count: 4 }),
  `${OUT}/frame-001.png`,
);
const frameCount = (await import('node:fs')).readdirSync(OUT).filter((f) => f.startsWith('frame-')).length;
assert.equal(frameCount, 4, `expected 4 frames, got ${frameCount}`);

// 10. Join: split the clip in two, then concatenate them back with the demuxer.
run(
  'prepare part A',
  buildClipArgs({ input: INPUT, output: `${OUT}/part-a.mp4`, start: '0', duration: '2.5', mode: 'reencode', quality: 32, speed: 'fastest' }),
  `${OUT}/part-a.mp4`,
);
run(
  'prepare part B',
  buildClipArgs({ input: INPUT, output: `${OUT}/part-b.mp4`, start: '2.5', duration: '2.5', mode: 'reencode', quality: 32, speed: 'fastest' }),
  `${OUT}/part-b.mp4`,
);
const listFile = `${OUT}/concat-list.txt`;
// Absolute entries, because the concat demuxer resolves relative ones against
// the list file's directory rather than the process working directory.
writeFileSync(
  listFile,
  `${[`${OUT}/part-a.mp4`, `${OUT}/part-b.mp4`].map((file) => concatListLine(resolve(file))).join('\n')}\n`,
  'utf8',
);
run(
  'concat copy (2 parts)',
  buildConcatArgs({ inputs: [], output: `${OUT}/joined.mp4`, mode: 'copy', listFile }),
  `${OUT}/joined.mp4`,
);
const joined = inspect(`${OUT}/joined.mp4`);
assert.ok(Math.abs(joined.duration - 5) < 0.6, `joined duration was ${joined.duration}`);
assert.equal(joined.video, 1);
assert.equal(joined.audio, 1);
console.log(`     -> joined ${joined.duration.toFixed(2)}s with ${joined.video} video / ${joined.audio} audio`);

// 11. Precision on a clip with a realistic one-second keyframe interval: both
//     modes must honor the requested length, because a copy trim that returns
//     the wrong duration is the failure this check exists to catch.
run(
  'build 1s-keyframe source',
  [
    resolveTool('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    `${OUT}/kf.mp4`,
  ],
  `${OUT}/kf.mp4`,
);

for (const start of ['1', '5', '7']) {
  run(
    `copy trim @${start}s for 4s`,
    buildClipArgs({ input: `${OUT}/kf.mp4`, output: `${OUT}/kf-copy-${start}.mp4`, start, duration: '4', mode: 'copy' }),
    `${OUT}/kf-copy-${start}.mp4`,
  );
  const cut = inspect(`${OUT}/kf-copy-${start}.mp4`);
  if (Math.abs(cut.duration - 4) > 0.06) {
    failures.push(`copy trim @${start}s: expected 4s, got ${cut.duration}`);
  }
  console.log(`     -> copy trim @${start}s = ${cut.duration.toFixed(3)}s (requested 4s)`);

  run(
    `exact trim @${start}s for 4s`,
    buildClipArgs({
      input: `${OUT}/kf.mp4`, output: `${OUT}/kf-exact-${start}.mp4`,
      start, duration: '4', mode: 'reencode', quality: 32, speed: 'fastest',
    }),
    `${OUT}/kf-exact-${start}.mp4`,
  );
  const exactCut = inspect(`${OUT}/kf-exact-${start}.mp4`);
  if (Math.abs(exactCut.duration - 4) > 0.06) {
    failures.push(`exact trim @${start}s: expected 4s, got ${exactCut.duration}`);
  }
  console.log(`     -> exact trim @${start}s = ${exactCut.duration.toFixed(3)}s (requested 4s)`);
}

console.log(`\n${step} ffmpeg invocations executed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
