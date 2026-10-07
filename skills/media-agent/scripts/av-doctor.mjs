#!/usr/bin/env node
/**
 * Audio-video toolchain health check.
 *
 * Resolves the portable ffmpeg / ffprobe / MediaInfo executables, prints their
 * versions, and reports which encoders, capture devices, muxers, and filters
 * are actually present in this build. Run it before assuming a capability, and
 * run it first when a media command fails unexpectedly.
 *
 * Usage:  node av-doctor.mjs [--full]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FULL = process.argv.includes('--full');
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Directories searched, highest priority first. Mirrors the plugin's resolver. */
function searchDirs() {
  const dirs = [];
  if (process.env.DSH_AV_TOOLS) dirs.push(process.env.DSH_AV_TOOLS);
  dirs.push(join(homedir(), '.dsh', 'tools', 'av', 'bin'));
  return dirs;
}

/** Resolve one executable to an absolute path, or fall back to the bare name. */
function resolveTool(id) {
  for (const dir of searchDirs()) {
    const candidate = join(dir, id + EXE);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return id;
}

/** Run a command and capture stdout, tolerating a non-zero exit. */
function run(exe, args) {
  const result = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let problems = 0;

console.log('Toolchain');
console.log('=========');
console.log(`search order: ${[process.env.DSH_AV_TOOLS ? `$DSH_AV_TOOLS=${process.env.DSH_AV_TOOLS}` : null, join(homedir(), '.dsh', 'tools', 'av', 'bin'), 'PATH'].filter(Boolean).join('  ->  ')}`);
console.log('');

const resolved = {};
for (const id of ['ffmpeg', 'ffprobe', 'mediainfo']) {
  const path = resolveTool(id);
  resolved[id] = path;
  const probe = run(path, id === 'mediainfo' ? ['--Version'] : ['-version']);
  const line = probe.out.split('\n').find((entry) => entry.trim().length > 0) ?? '';
  const bundled = path !== id + EXE;
  if (!probe.ok) problems += 1;
  console.log(`${probe.ok ? 'ok  ' : 'MISS'} ${id.padEnd(10)} ${bundled ? 'bundled' : 'PATH   '} ${path}`);
  if (line) console.log(`                ${line.trim().slice(0, 96)}`);
}
console.log('');

/** Report which of `names` appear in a `-encoders`/`-filters`/`-muxers` listing. */
function capability(title, listing, names, essential = []) {
  const present = [];
  const missing = [];
  for (const name of names) {
    const found = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(\\s|$)`, 'mu').test(listing);
    (found ? present : missing).push(name);
  }
  console.log(`${title}: ${present.length}/${names.length} present`);
  console.log(`  present: ${present.join(', ') || '(none)'}`);
  if (missing.length > 0) console.log(`  absent : ${missing.join(', ')}`);
  for (const name of essential) {
    if (missing.includes(name)) {
      problems += 1;
      console.log(`  PROBLEM: ${name} is required but absent`);
    }
  }
  console.log('');
}

if (!existsSync(resolved.ffmpeg)) {
  console.log('ffmpeg is not resolvable, so no capability report is possible.');
  console.log(`Install it under ${join(homedir(), '.dsh', 'tools', 'av', 'bin')} or set DSH_AV_TOOLS.`);
  process.exit(1);
}

const encoders = run(resolved.ffmpeg, ['-hide_banner', '-encoders']).out;
capability('Video encoders', encoders, [
  'libx264', 'libx265', 'libaom-av1', 'libsvtav1', 'libvpx-vp9',
  'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf',
  'h264_videotoolbox', 'hevc_videotoolbox',
], ['libx264', 'libx265', 'aac']);

capability('Audio encoders', encoders, ['aac', 'libopus', 'libmp3lame', 'flac', 'libvorbis', 'pcm_s16le']);

const filters = run(resolved.ffmpeg, ['-hide_banner', '-filters']).out;
capability('Filters', filters, [
  'subtitles', 'ass', 'loudnorm', 'dynaudnorm', 'tonemap', 'zscale',
  'showwavespic', 'showspectrumpic', 'palettegen', 'paletteuse',
  'silencedetect', 'ebur128', 'drawtext', 'overlay', 'xfade', 'select',
], ['scale', 'fps']);

const devices = run(resolved.ffmpeg, ['-hide_banner', '-devices']).out;
const captureDevices = process.platform === 'win32'
  ? ['gdigrab', 'dshow', 'lavfi']
  : process.platform === 'darwin'
    ? ['avfoundation', 'lavfi']
    : ['x11grab', 'lavfi'];
capability('Capture devices', devices, captureDevices, ['lavfi']);

const muxers = run(resolved.ffmpeg, ['-hide_banner', '-muxers']).out;
capability('Muxers', muxers, ['hls', 'segment', 'tee', 'rtsp', 'flv', 'mpegts', 'matroska', 'mp4'], ['mp4', 'matroska']);

const hwaccels = run(resolved.ffmpeg, ['-hide_banner', '-hwaccels']).out;
console.log('Hardware acceleration methods compiled in');
console.log('=========================================');
console.log(hwaccels.split('\n').slice(1).map((line) => line.trim()).filter(Boolean).join(', ') || '(none)');
console.log('A method being compiled in does not prove a usable device exists; hardware encoders are opt-in');
console.log('through the tools\' hwaccel argument and fail loudly when the machine cannot provide one.');
console.log('');

if (FULL) {
  console.log('Full encoder list');
  console.log('=================');
  console.log(encoders);
}

console.log(problems === 0
  ? 'RESULT: toolchain is complete.'
  : `RESULT: ${problems} problem(s) found.`);
process.exit(problems === 0 ? 0 : 1);
