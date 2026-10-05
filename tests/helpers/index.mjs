// Shared bits for the tests: paths, temp folders, a DuckDB probe (tests that need it are skipped when it is not installed),
// and a runner for the command line.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDuckdb } from '../../scripts/lib/duck.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VIZ = path.join(ROOT, 'scripts', 'viz.mjs');

/** A new empty folder in the system temp directory (tests leave them there; they are small). */
export function makeTmp(prefix = 'ldv-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let duckPromise = null;
/** { bin, versionText } when a usable DuckDB is installed, else null. */
export function duckdb() {
  duckPromise ??= findDuckdb(process.env).then((found) => (found.found && found.supported ? found : null));
  return duckPromise;
}

export function runViz(args, { env = {}, cwd = ROOT } = {}) {
  const result = spawnSync(process.execPath, [VIZ, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, cwd, windowsHide: true, timeout: 300_000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Every file under a folder with its SHA-256, to prove that something was (not) changed. */
export function snapshot(directory) {
  const out = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out[path.relative(directory, full).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  visit(directory);
  return out;
}

export function listFiles(directory) {
  return Object.keys(snapshot(directory)).sort();
}

/** The `Folder:` line of a successful build. */
export function builtFolder(stdout) {
  const match = /^Folder: (.+)$/m.exec(stdout);
  if (match === null) throw new Error(`no "Folder:" line in the build output:\n${stdout}`);
  return match[1].trim();
}
