import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Executable suffix for the current platform. The bundled toolchain is a
 * Windows portable install today, but the search also accepts a POSIX layout
 * so the same plugin keeps working from a POSIX profile.
 */
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Canonical tool ids this plugin drives. */
export const TOOL_IDS = ['ffmpeg', 'ffprobe', 'mediainfo'];

/**
 * Directories searched for the portable toolchain, in priority order.
 * `DSH_AV_TOOLS` lets a deployment point at another install without editing
 * this plugin; the default is the profile-local portable root this toolkit
 * ships alongside.
 * @returns absolute candidate directories, highest priority first.
 */
function searchDirs() {
  const dirs = [];
  const configured = process.env.DSH_AV_TOOLS;
  if (typeof configured === 'string' && configured.length > 0) dirs.push(configured);
  dirs.push(join(homedir(), '.dsh', 'tools', 'av', 'bin'));
  return dirs;
}

/**
 * Resolve one executable to an absolute path, falling back to the bare name so
 * the subprocess provider's own PATH lookup can still satisfy it.
 *
 * Resolution happens per call rather than at activation so installing or
 * moving the toolchain does not require reloading the plugin.
 * @param id - one of {@link TOOL_IDS}.
 * @returns an absolute path when a bundled build is present, else the bare name.
 */
export function resolveTool(id) {
  const file = id + EXE;
  for (const dir of searchDirs()) {
    const candidate = join(dir, file);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return file;
}

/**
 * Report the resolved path of every tool plus whether the bundled portable
 * root was found, so a failure can name the missing executable instead of
 * surfacing as an opaque spawn error.
 * @returns a per-tool resolution report.
 */
export function toolchainReport() {
  const tools = {};
  for (const id of TOOL_IDS) {
    const path = resolveTool(id);
    tools[id] = { path, bundled: path !== id + EXE };
  }
  return { dirs: searchDirs(), tools };
}

/**
 * Assert that an absolute executable is usable, with an actionable message.
 * @param id - one of {@link TOOL_IDS}.
 * @returns the resolved absolute path.
 */
export function requireTool(id) {
  const path = resolveTool(id);
  if (path === id + EXE) {
    throw new Error(
      `${id} was not found. Expected a portable build under `
        + `${join(homedir(), '.dsh', 'tools', 'av', 'bin')} or on PATH. `
        + `Set DSH_AV_TOOLS to the directory holding ${id}${EXE}, or install the `
        + `toolchain (see the media-agent skill).`,
    );
  }
  return path;
}

/**
 * Resolve a Python interpreter that can run the bundled plot script.
 *
 * Order: the `DSH_PYTHON` override, then the DSH-managed runtime Python under
 * `~/.dsh/dsh-runtimes/<name>/dependencies/python`, then a bare `python` or
 * `python3` for the subprocess provider to find on PATH. Plot rendering needs
 * numpy and Pillow, which the DSH runtime ships; the plot runner verifies that
 * capability before invoking the script.
 * @returns an absolute path when one is found, else a bare command name.
 */
export function resolvePython() {
  const configured = process.env.DSH_PYTHON;
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) {
    return configured;
  }
  const pyName = process.platform === 'win32' ? 'python.exe' : 'python';
  const runtimesRoot = join(homedir(), '.dsh', 'dsh-runtimes');
  if (existsSync(runtimesRoot)) {
    for (const entry of readdirSync(runtimesRoot)) {
      const candidate = join(runtimesRoot, entry, 'dependencies', 'python', pyName);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}
