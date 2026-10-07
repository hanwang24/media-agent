import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { safeCwd } from './run.js';

/**
 * The working directory of the calling session.
 *
 * This mirrors the first-party shell tools, which read the session header's cwd
 * rather than the Host process's own directory: a model hands over paths
 * relative to the session it is working in, and the Host process may well have
 * been started somewhere else entirely.
 * @param exec - the tool run context.
 * @returns an absolute directory to resolve relative paths against.
 */
export function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  return safeCwd();
}

/**
 * Resolve a caller-supplied path against a base directory.
 * @param base - the directory relative paths are resolved against.
 * @param value - the caller-supplied path.
 * @returns an absolute path.
 */
export function resolvePath(base, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('expected a non-empty path');
  }
  return isAbsolute(value) ? value : resolve(base, value);
}

/**
 * Resolve one input path and assert that it names an existing file.
 *
 * The error names the absolute path that was checked, so a caller that passed a
 * path relative to the wrong base can correct itself immediately.
 * @param base - the directory relative paths are resolved against.
 * @param value - the caller-supplied path.
 * @param label - the argument name, used in the message.
 * @returns the resolved absolute path.
 */
export function requireInputFile(base, value, label = 'input') {
  const absolute = resolvePath(base, value);
  if (!existsSync(absolute)) {
    throw new Error(`${label} file does not exist: ${absolute} (resolved against ${base})`);
  }
  if (!statSync(absolute).isFile()) throw new Error(`${label} is not a file: ${absolute}`);
  return absolute;
}

/**
 * Resolve one directory argument and assert that it exists.
 * @param base - the directory relative paths are resolved against.
 * @param value - the caller-supplied path.
 * @param label - the argument name, used in the message.
 * @returns the resolved absolute path.
 */
export function requireDirectory(base, value, label = 'directory') {
  const absolute = resolvePath(base, value);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`${label} is not a directory: ${absolute} (resolved against ${base})`);
  }
  return absolute;
}

/**
 * Resolve an output path. Outputs need no existence check, only a base.
 * @param base - the directory relative paths are resolved against.
 * @param value - the caller-supplied path.
 * @param label - the argument name, used in the message.
 * @returns the resolved absolute path.
 */
export function requireOutputPath(base, value, label = 'output') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }
  return isAbsolute(value) ? value : resolve(base, value);
}
