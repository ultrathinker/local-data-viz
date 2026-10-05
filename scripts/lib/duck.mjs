// The only place that talks to DuckDB: finds the `duckdb` command-line program, feeds it SQL on stdin and reads its JSON back.
// DuckDB is the data engine (it reads CSV, JSON, Parquet and does all the grouping); it runs on this computer, in memory,
// with automatic extension downloads switched off, so nothing here ever touches the network.

import { spawn } from 'node:child_process';

export const MIN_DUCKDB = [1, 0, 0];
export const ENV_DUCKDB = 'LOCAL_DATA_VIZ_DUCKDB';

/** SQL identifier: always double-quoted, quotes doubled. Column names from user files go through this and nothing else. */
export function ident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** SQL string literal: single-quoted, quotes doubled (backslashes are plain characters in DuckDB strings). */
export function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** A path as DuckDB wants it inside a string literal: forward slashes. */
export function pathLit(file) {
  return lit(String(file).replace(/\\/g, '/'));
}

export const SAFE_PRELUDE = [
  'SET autoinstall_known_extensions=false;',
  'SET autoload_known_extensions=false;',
  'SET enable_progress_bar=false;',
].join('\n');

/** Split DuckDB's JSON output (one JSON array per statement) into parsed arrays. Tolerates the bare Infinity / NaN it prints. */
export function parseJsonArrays(text) {
  const arrays = [];
  let depth = 0;
  let inString = false;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        i += 1;
        out += text[i] ?? '';
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (depth > 0) out += ch;
      continue;
    }
    if (depth === 0) {
      if (ch === '[') {
        depth = 1;
        out = '[';
      }
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      out += ch;
      if (depth === 0) {
        arrays.push(JSON.parse(out));
        out = '';
      }
      continue;
    }
    // a bare number-like token: Infinity, -Infinity, NaN become null
    if (ch === 'I' && text.startsWith('Infinity', i)) {
      out += 'null';
      i += 'Infinity'.length - 1;
      continue;
    }
    if (ch === 'N' && text.startsWith('NaN', i)) {
      out += 'null';
      i += 2;
      continue;
    }
    if (ch === '-' && text.startsWith('-Infinity', i)) {
      out += 'null';
      i += '-Infinity'.length - 1;
      continue;
    }
    out += ch;
  }
  return arrays;
}

export function runProcess(bin, args, { input = '', timeoutMs = 600_000, maxBytes = 512 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error.message), error });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -2, stdout: Buffer.concat(out).toString('utf8'), stderr: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill();
        finish({ code: -3, stdout: '', stderr: 'the output was too large' });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 200) err.push(chunk);
    });
    child.on('error', (error) => finish({ code: -1, stdout: '', stderr: String(error.message), error }));
    child.on('close', (code) => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Which duckdb to use: the one named in LOCAL_DATA_VIZ_DUCKDB, else `duckdb` on the PATH. */
export async function findDuckdb(env = process.env) {
  const candidates = [];
  if (typeof env[ENV_DUCKDB] === 'string' && env[ENV_DUCKDB].trim() !== '') candidates.push({ bin: env[ENV_DUCKDB].trim(), via: ENV_DUCKDB });
  candidates.push({ bin: 'duckdb', via: 'PATH' });
  for (const candidate of candidates) {
    const result = await runProcess(candidate.bin, ['--version'], { timeoutMs: 20_000 });
    if (result.code === 0) {
      const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
      const version = match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
      return { found: true, bin: candidate.bin, via: candidate.via, version, versionText: match === null ? result.stdout.trim() : match[0], supported: version !== null && compareVersions(version, MIN_DUCKDB) >= 0 };
    }
  }
  return { found: false, bin: null, via: null, version: null, versionText: null, supported: false };
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Run `prelude` (statements that print nothing, such as CREATE VIEW) and then every query, in ONE duckdb process, and return
 * one array of row objects per query. Throws an Error with DuckDB's own message when a statement fails.
 */
export async function queryAll(bin, prelude, queries, options = {}) {
  const script = [SAFE_PRELUDE, prelude ?? '', ...queries.map((query) => `${query.replace(/;\s*$/, '')};`)].join('\n');
  const result = await runProcess(bin, ['-json', '-bail'], { input: script, ...options });
  if (result.code !== 0) {
    const message = result.stderr.trim().split('\n').slice(0, 6).join(' ').slice(0, 600);
    throw new Error(`duckdb failed: ${message === '' ? `exit code ${result.code}` : message}`);
  }
  const arrays = parseJsonArrays(result.stdout);
  if (arrays.length !== queries.length) {
    throw new Error(`duckdb returned ${arrays.length} result sets for ${queries.length} queries`);
  }
  return arrays;
}

export async function queryOne(bin, prelude, query, options) {
  return (await queryAll(bin, prelude, [query], options))[0];
}
