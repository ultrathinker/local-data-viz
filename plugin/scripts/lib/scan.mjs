// Looks through the folder the user pointed at and lists the data files in it. Read-only: nothing is written, links are never
// followed, hidden folders and the output folders of this plugin are skipped, and every limit is explicit.

import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = Object.freeze({
  maxFiles: 400,
  maxDepth: 8,
  maxXlsxBytes: 80 * 1024 * 1024,
  maxListedSkips: 25,
});

export const EXTENSIONS = Object.freeze({
  '.csv': 'csv',
  '.tsv': 'csv',
  '.tab': 'csv',
  '.json': 'json',
  '.jsonl': 'json',
  '.ndjson': 'json',
  '.parquet': 'parquet',
  '.xlsx': 'xlsx',
});

const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '__pycache__', '$recycle.bin']);

/** The folder must be a real directory (not a link), and not the root of a drive. */
export function checkRoot(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('give the folder that holds the data files');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) || /^www\./i.test(input.trim())) {
    throw new Error(`"${input.trim().slice(0, 80)}" is a web address. This plugin reads a folder on this computer: download the data into a folder and give that folder`);
  }
  if (input.trim().startsWith('~')) throw new Error('"~" is not expanded here: give the full path of the folder');
  const root = path.resolve(input);
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    throw new Error(`${root} does not exist`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${root} is a link: give the real folder`);
  if (!stat.isDirectory()) throw new Error(`${root} is not a folder (this plugin reads a folder of data files, not a single file)`);
  if (path.parse(root).root === root) throw new Error('refusing to read a whole drive: give the folder with the data');
  return root;
}

/**
 * List the supported data files under `root`: { root, files, skipped, ignoredByType, truncated, totalBytes }.
 * `files` is sorted by relative path so everything downstream is deterministic.
 */
export function scanFolder(root, limits = LIMITS) {
  const files = [];
  const skipped = [];
  const ignoredByType = {};
  const ignoredNames = [];
  let truncated = false;
  let hitDepth = false;

  const skip = (rel, reason) => {
    if (skipped.length < limits.maxListedSkips) skipped.push({ file: rel, reason });
  };

  const walk = (directory, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      skip(path.relative(root, directory) || '.', `cannot read the folder (${error.code ?? 'error'})`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) {
        skip(rel, 'a link (links are never followed)');
        continue;
      }
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIPPED_DIRECTORY_NAMES.has(lower)) continue;
        if (lower.endsWith('-viz')) {
          skip(rel, 'looks like an output folder of this plugin');
          continue;
        }
        if (depth >= limits.maxDepth) {
          hitDepth = true;
          continue;
        }
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      const kind = EXTENSIONS[extension];
      if (kind === undefined) {
        const key = extension === '' ? '(no extension)' : extension;
        ignoredByType[key] = (ignoredByType[key] ?? 0) + 1;
        if (ignoredNames.length < 60) ignoredNames.push(rel);
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch {
        skip(rel, 'cannot be read');
        continue;
      }
      if (stat.size === 0) {
        skip(rel, 'empty file');
        continue;
      }
      if (kind === 'xlsx' && stat.size > limits.maxXlsxBytes) {
        skip(rel, `Excel file larger than ${Math.round(limits.maxXlsxBytes / 1048576)} MB`);
        continue;
      }
      if (files.length >= limits.maxFiles) {
        truncated = true;
        continue;
      }
      files.push({ abs: absolute, rel, extension, kind, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    }
  };

  walk(root, 0);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    root,
    files,
    skipped,
    ignoredByType,
    ignoredNames,
    truncated,
    hitDepth,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

/** A short fingerprint of what was scanned, so a later command can tell whether the folder changed. */
export function fingerprint(scan) {
  const parts = scan.files.map((file) => `${file.rel}|${file.size}|${file.mtimeMs}`);
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${scan.files.length}-${hash.toString(16)}`;
}
