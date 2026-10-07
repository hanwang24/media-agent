#!/usr/bin/env node
/**
 * Install or refresh the portable audio-video toolchain into
 * `<home>/.dsh/tools/av/bin`, which is where the av_* tools and `av-doctor`
 * look for it. Run with the bundled Node (no external dependencies):
 *
 *   node install-toolchain.mjs            # skip anything already present
 *   node install-toolchain.mjs --force    # re-download / re-copy everything
 *
 * Platforms:
 *   - Windows: static builds from gyan.dev (ffmpeg/ffprobe) and MediaArea
 *     (MediaInfo CLI), unpacked with the system `tar` (bsdtar ships with
 *     Windows 10+).
 *   - macOS: Homebrew (`brew install ffmpeg mediainfo`), then copied into the
 *     portable root so the DSH app does not depend on a login-shell PATH.
 *
 * Nothing is added to the system PATH and no system directory is modified.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, realpathSync,
  readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FORCE = process.argv.includes('--force');
const TARGET = join(homedir(), '.dsh', 'tools', 'av', 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';
const TOOLS = ['ffmpeg', 'ffprobe', 'mediainfo'].map((id) => id + EXE);

const WIN_FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const WIN_MEDIAINFO_ZIP = 'https://mediaarea.net/download/binary/mediainfo/26.10/MediaInfo_CLI_26.10_Windows_x64.zip';

/** Resolve one command on the current PATH, or return undefined. */
function which(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) return undefined;
  const line = (result.stdout ?? '').split(/\r?\n/u).find((entry) => entry.trim().length > 0);
  return line === undefined ? undefined : line.trim();
}

/** Run a command and throw a readable error on failure. */
function sh(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

/** Download a URL to a file, following redirects. */
function download(url, destination) {
  return new Promise((resolve, reject) => {
    const attempt = (target, redirects) => {
      const get = target.startsWith('https:') ? httpsGet : httpGet;
      get(target, { headers: { 'User-Agent': 'dsh-media-agent-installer' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 5) return reject(new Error(`too many redirects for ${target}`));
          return attempt(new URL(response.headers.location, target).toString(), redirects + 1);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`GET ${target} -> ${response.statusCode}`));
        }
        const file = createWriteStream(destination);
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      }).on('error', reject);
    };
    attempt(url, 0);
  });
}

/** Recursively find the first file with a given name under a directory. */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested !== undefined) return nested;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return undefined;
}

/** Whether every tool is already present at the target root. */
function complete() {
  return TOOLS.every((tool) => existsSync(join(TARGET, tool)) && statSync(join(TARGET, tool)).isFile());
}

/**
 * Copy a binary into the target root, following symlinks so a Homebrew shim
 * becomes a real, self-contained executable.
 * @param source - the resolved binary path.
 * @param targetName - the name inside the target root.
 */
function installBinary(source, targetName) {
  const resolved = existsSync(source) ? realpathSync(source) : source;
  copyFileSync(resolved, join(TARGET, targetName));
  console.log(`  installed  ${join(TARGET, targetName)}`);
}

async function installWindows() {
  console.log('Downloading the ffmpeg essentials build...');
  const work = join(TARGET, '.dl');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const ffmpegZip = join(work, 'ffmpeg.zip');
  await download(WIN_FFMPEG_ZIP, ffmpegZip);
  console.log('  downloaded ffmpeg.zip');
  sh('tar', ['-xf', ffmpegZip, '-C', work]);
  const ffmpegDir = dirname(findFile(work, 'ffmpeg.exe'));
  if (ffmpegDir === undefined || !existsSync(join(ffmpegDir, 'ffprobe.exe'))) {
    throw new Error('the ffmpeg archive did not contain ffmpeg.exe and ffprobe.exe');
  }
  installBinary(join(ffmpegDir, 'ffmpeg.exe'), 'ffmpeg.exe');
  installBinary(join(ffmpegDir, 'ffprobe.exe'), 'ffprobe.exe');

  console.log('Downloading the MediaInfo CLI build...');
  const miZip = join(work, 'mediainfo.zip');
  await download(WIN_MEDIAINFO_ZIP, miZip);
  sh('tar', ['-xf', miZip, '-C', work]);
  const mediaInfo = findFile(work, 'MediaInfo.exe');
  if (mediaInfo === undefined) throw new Error('the MediaInfo archive did not contain MediaInfo.exe');
  installBinary(mediaInfo, 'mediainfo.exe');

  rmSync(work, { recursive: true, force: true });
}

function installMacos() {
  if (which('brew') === undefined) {
    throw new Error(
      'Homebrew is required on macOS to install the toolchain. Install it from https://brew.sh, '
      + 'then re-run this script, or install ffmpeg/ffprobe/mediainfo yourself and set DSH_AV_TOOLS '
      + 'to the directory holding them.',
    );
  }
  console.log('Installing ffmpeg and mediainfo with Homebrew...');
  sh('brew', ['install', 'ffmpeg', 'mediainfo']);

  const ffmpeg = which('ffmpeg');
  const ffprobe = which('ffprobe');
  const mediainfo = which('mediainfo');
  if (!ffmpeg || !ffprobe || !mediainfo) {
    throw new Error('Homebrew reported success but the binaries are not on PATH; re-run or set DSH_AV_TOOLS.');
  }
  installBinary(ffmpeg, 'ffmpeg');
  installBinary(ffprobe, 'ffprobe');
  installBinary(mediainfo, 'mediainfo');
}

function verify() {
  const missing = TOOLS.filter((tool) => !existsSync(join(TARGET, tool)));
  if (missing.length > 0) {
    console.error(`Missing after install: ${missing.join(', ')}`);
    process.exit(1);
  }
  const versions = TOOLS.map((tool) => {
    const args = tool === 'mediainfo.exe' ? ['--Version'] : ['-version'];
    const result = spawnSync(join(TARGET, tool), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return `${tool}: ${(result.stdout ?? '').split('\n').find((line) => line.trim()) ?? '?'}`.trim();
  });
  console.log('\nInstalled toolchain:');
  for (const version of versions) console.log(`  ${version.slice(0, 96)}`);
  console.log('\nRun av-doctor.mjs for the full capability report, and restart DeepSeek Harness if the');
  console.log('tools were not previously present.');
}

async function main() {
  mkdirSync(TARGET, { recursive: true });
  console.log(`Toolchain root: ${TARGET}\n`);
  if (complete() && !FORCE) {
    console.log('All tools are already present; nothing to do. Re-run with --force to reinstall.');
    verify();
    return;
  }

  if (process.platform === 'win32') {
    await installWindows();
  } else if (process.platform === 'darwin') {
    installMacos();
  } else {
    throw new Error(
      `no automatic install for ${process.platform}. Install ffmpeg/ffprobe/mediainfo yourself `
      + `(e.g. apt, or a static build) and set DSH_AV_TOOLS to the directory holding them.`,
    );
  }
  verify();
}

main().catch((error) => {
  console.error(`install-toolchain failed: ${error.message}`);
  process.exit(1);
});
