// From a list of files to "datasets": Excel sheets are converted to CSV in the work folder, every file is described by DuckDB, and
// files with the same set of columns (the monthly exports of one table, say) become ONE dataset that is read together.
// A dataset is a DuckDB view; its SQL is built here and nowhere else, with every path and name quoted.

import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';
import { readXlsx, sheetToCsv } from './xlsx.mjs';
import { ident, lit, pathLit, queryAll } from './duck.mjs';
import { utf16Encoding, utf8CopyOf } from './encoding.mjs';

function shortHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const safeStem = (text) => String(text).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'sheet';

/**
 * Data sources for DuckDB: the CSV, JSON and Parquet files as they are, plus one converted CSV per Excel sheet (written once into
 * `<workDir>/xlsx`, a name that is already there is reused, never replaced).
 * Returns { sources: [{ abs, kind, label, size }], skipped: [{ file, reason }], notes: [{ file, text }] }.
 */
export function prepareSources(scan, workDir) {
  const sources = [];
  const skipped = [];
  const notes = [];
  for (const file of scan.files) {
    if (file.kind !== 'xlsx') {
      let abs = file.abs;
      if (file.kind === 'csv') {
        try {
          const encoding = utf16Encoding(file.abs);
          if (encoding !== null) {
            abs = utf8CopyOf(file.abs, encoding, path.join(workDir, 'utf8'), `${shortHash(`${file.rel}|${file.size}|${file.mtimeMs}`)}-${safeStem(path.basename(file.rel, file.extension))}`);
            notes.push({ file: file.rel, text: `saved as UTF-16 (${encoding === 'utf-16le' ? 'little' : 'big'}-endian); a UTF-8 copy in the work folder is read, the original is untouched` });
          }
        } catch (error) {
          skipped.push({ file: file.rel, reason: `is saved as UTF-16 and could not be converted (${String(error.message).slice(0, 120)}); save it as UTF-8` });
          continue;
        }
      }
      sources.push({ abs, kind: file.kind, label: file.rel, size: file.size, rel: file.rel });
      continue;
    }
    try {
      const book = readXlsx(fs.readFileSync(file.abs));
      for (const sheet of book.skipped) skipped.push({ file: `${file.rel} [${sheet.sheet}]`, reason: sheet.reason });
      if (book.sheets.length === 0) {
        skipped.push({ file: file.rel, reason: 'no sheet with data' });
        continue;
      }
      const target = path.join(workDir, 'xlsx');
      fs.mkdirSync(target, { recursive: true });
      for (const sheet of book.sheets) {
        const name = `${shortHash(`${file.rel}|${file.size}|${file.mtimeMs}|${sheet.name}`)}-${safeStem(path.basename(file.rel, file.extension))}__${safeStem(sheet.name)}.csv`;
        const csv = path.join(target, name);
        if (!fs.existsSync(csv)) fs.writeFileSync(csv, sheetToCsv(sheet), { flag: 'wx' });
        if (sheet.titleRows > 0) notes.push({ file: `${file.rel} [${sheet.name}]`, text: `skipped ${sheet.titleRows} title row${sheet.titleRows === 1 ? '' : 's'} above the header` });
        sources.push({
          abs: csv,
          kind: 'csv',
          label: `${file.rel} [${sheet.name}]`,
          size: fs.statSync(csv).size,
          rel: `${file.rel} [${sheet.name}]`,
          note: sheet.truncated ? 'sheet cut at 2,000,000 rows' : undefined,
        });
      }
    } catch (error) {
      skipped.push({ file: file.rel, reason: `cannot read the workbook (${error.message})`.slice(0, 200) });
    }
  }
  return { sources, skipped, notes };
}

function listLiteral(files) {
  return `[${files.map((file) => pathLit(file)).join(', ')}]`;
}

/**
 * The DuckDB reader call for files of one kind. `lenient` lets DuckDB skip rows it cannot parse, `decimal` reads "1,5" as 1.5
 * (both CSV only).
 */
export function readerSql(kind, files, lenient = false, decimal = false, flatten = []) {
  if (flatten.length > 0) {
    const extra = flatten.flatMap((item) => item.fields.map((field) => `struct_extract(${ident(item.column)}, ${lit(field)}) AS ${ident(`${item.column}.${field}`)}`));
    return `(SELECT * EXCLUDE (${flatten.map((item) => ident(item.column)).join(', ')}), ${extra.join(', ')} FROM ${readerSql(kind, files, lenient, decimal)})`;
  }
  if (kind === 'csv') return `read_csv(${listLiteral(files)}, union_by_name=true${lenient ? ', ignore_errors=true' : ''}${decimal ? ", decimal_separator=','" : ''})`;
  if (kind === 'json') return `read_json_auto(${listLiteral(files)}, union_by_name=true)`;
  return `read_parquet(${listLiteral(files)}, union_by_name=true)`;
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const NUMERIC_TYPE = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/i;
const countNumeric = (columns) => columns.filter((column) => NUMERIC_TYPE.test(column.type)).length;

async function describeOne(bin, source, lenient, decimal) {
  const [rows] = await queryAll(bin, '', [`DESCRIBE SELECT * FROM ${readerSql(source.kind, [source.abs], lenient, decimal)}`]);
  if (rows.length === 0) throw new Error('no columns');
  return rows.map((row) => ({ name: row.column_name, type: row.column_type }));
}

/** The columns of one CSV, read with a decimal comma instead when that finds more numeric columns (European files: "1234,56"). */
async function describeCsv(bin, source, lenient) {
  let columns = await describeOne(bin, source, lenient, false);
  let decimal = false;
  if (columns.some((column) => /^VARCHAR/i.test(column.type))) {
    try {
      const alternative = await describeOne(bin, source, lenient, true);
      if (countNumeric(alternative) > countNumeric(columns)) {
        columns = alternative;
        decimal = true;
      }
    } catch {
      /* the comma is the delimiter, or the file does not parse that way: keep the plain reading */
    }
  }
  return { columns, decimal };
}

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The first `count` lines of a text file (reads at most 256 KB, the byte order mark is dropped). */
function firstLines(file, count) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return stripBom(buffer.subarray(0, read).toString('utf8')).split(/\r?\n/).slice(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

const SUMMARY_WORD = /^(grand[ _-]?)?(sub[ _-]?)?totals?$|^sum$/i;

/** The first word of the last line of a CSV when it says Total, Grand total, Sum (a summary row exported with the data), else null. */
function summaryRowWord(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 4096);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length < 2) return null;
    const first = lines[lines.length - 1].split(/[,;\t|]/)[0].replace(/^["'\s]+|["'\s]+$/g, '');
    return SUMMARY_WORD.test(first) ? first : null;
  } finally {
    fs.closeSync(fd);
  }
}

async function eachLine(file, handler) {
  const reader = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let number = 0;
  for await (const line of reader) {
    await handler(line, number);
    number += 1;
  }
}

/**
 * Files joined by hand (or exported in pieces) often repeat the header line in the middle; DuckDB then reads that line as data and
 * turns every number column into text. When a CSV has text columns and some row equals the header, a copy without those lines is
 * written into `<workDir>/clean` (the original is never touched) and read instead. Returns { abs, removed } or null.
 */
async function withoutRepeatedHeaders(bin, source, columns, lenient, workDir) {
  const same = columns.slice(0, 6).map((column) => `${ident(column.name)} = ${lit(column.name)}`).join(' AND ');
  const reader = `read_csv(${listLiteral([source.abs])}, union_by_name=true, all_varchar=true${lenient ? ', ignore_errors=true' : ''})`;
  const [[found]] = await queryAll(bin, '', [`SELECT count(*) AS n FROM ${reader} WHERE ${same}`]);
  if (Number(found.n) === 0) return null;

  // the header is not always line 0: comment lines (`# exported ...`) may come first, so look for the first line (among the first
  // 100) that holds all the column names; fall back to line 0 when the names were changed on the way (duplicates, empty names)
  const names = columns.slice(0, 6).map((column) => column.name);
  const top = firstLines(source.abs, 100);
  const at = top.findIndex((line) => names.every((name) => line.includes(name)));
  const headerAt = at === -1 ? 0 : at;
  const header = (top[headerAt] ?? '').trim();
  if (header === '') return null;
  let removed = 0;
  await eachLine(source.abs, (line, number) => {
    if (number > headerAt && line.trim() === header) removed += 1;
  });
  if (removed === 0) return null;

  const stat = fs.statSync(source.abs);
  const target = path.join(workDir, 'clean', `${shortHash(`${source.abs}|${stat.size}|${Math.round(stat.mtimeMs)}`)}-${safeStem(path.basename(source.abs, path.extname(source.abs)))}.csv`);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = fs.createWriteStream(target, { flags: 'wx' });
    await eachLine(source.abs, async (line, number) => {
      if (number > headerAt && line.trim() === header) return;
      if (!out.write(`${line}\n`)) await once(out, 'drain');
    });
    out.end();
    await once(out, 'finish');
  }
  return { abs: target, removed };
}

/** A reason a file could not be read that says what it means, then what DuckDB said (cut at a word, never in the middle). */
export function explainReadError(message) {
  const text = String(message).replace(/^duckdb failed: /, '').replace(/\s+/g, ' ').trim();
  let lead = '';
  if (/sniff/i.test(text)) lead = 'cannot be read as a CSV table (the file looks binary or damaged). ';
  else if (/invalid unicode|byte sequence|utf-?8/i.test(text)) lead = 'is not valid UTF-8 text (saved in an old code page? save it as UTF-8). ';
  else if (/parquet/i.test(text)) lead = 'is not a valid Parquet file. ';
  const limit = lead === '' ? 400 : 200;
  let cut = text;
  if (cut.length > limit) {
    cut = cut.slice(0, limit);
    cut = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), limit - 40))}...`;
  }
  return lead === '' ? cut : `${lead}DuckDB said: ${cut}`;
}

const STRUCT_TYPE = /^STRUCT\(/i;
const MAX_FLAT_FIELDS = 60;

/**
 * One level of nested objects ({"user": {"id": 1, "country": "NL"}}) becomes columns named user.id and user.country, so the
 * categories inside them can be charted. Arrays and deeper objects stay as they are (listed as not charted).
 * Returns { columns, flatten: [{ column, fields }] }.
 */
async function flattenStructs(bin, source, columns) {
  if (!columns.some((column) => STRUCT_TYPE.test(column.type))) return { columns, flatten: [] };
  const out = [];
  const flatten = [];
  for (const column of columns) {
    if (!STRUCT_TYPE.test(column.type)) {
      out.push(column);
      continue;
    }
    try {
      const [fields] = await queryAll(bin, '', [`DESCRIBE SELECT unnest(${ident(column.name)}) FROM ${readerSql(source.kind, [source.abs], false)}`]);
      if (fields.length === 0 || fields.length > MAX_FLAT_FIELDS) throw new Error('not flattened');
      flatten.push({ column: column.name, fields: fields.map((field) => field.column_name) });
      for (const field of fields) out.push({ name: `${column.name}.${field.column_name}`, type: field.column_type });
    } catch {
      out.push(column);
    }
  }
  return { columns: out, flatten };
}

/**
 * Ask DuckDB for the columns of each source. A CSV that does not parse is retried leniently; one that still fails is skipped.
 * Returns { described, skipped, notes }; `notes` say what was done to a file on the way (repeated header lines removed).
 */
export async function describeSources(bin, sources, workDir = null) {
  const described = [];
  const skipped = [];
  const notes = [];
  await mapPool(sources, 4, async (source, index) => {
    for (const lenient of source.kind === 'csv' ? [false, true] : [false]) {
      try {
        let current = source;
        let result = source.kind === 'csv' ? await describeCsv(bin, source, lenient) : { columns: await describeOne(bin, source, lenient, false), decimal: false };
        let flatten = [];
        if (source.kind !== 'csv') ({ columns: result.columns, flatten } = await flattenStructs(bin, source, result.columns));
        if (source.kind === 'csv' && workDir !== null && result.columns.some((column) => /^VARCHAR/i.test(column.type))) {
          const cleaned = await withoutRepeatedHeaders(bin, source, result.columns, lenient, workDir);
          if (cleaned !== null) {
            current = { ...source, abs: cleaned.abs };
            result = await describeCsv(bin, current, lenient);
            notes.push({ file: source.label, text: `removed ${cleaned.removed} repeated header line${cleaned.removed === 1 ? '' : 's'}; a cleaned copy in the work folder is read, the original is untouched` });
          }
        }
        if (source.kind === 'csv') {
          const summary = summaryRowWord(source.abs);
          if (summary !== null) notes.push({ file: source.label, text: `the last line starts with "${summary}": it looks like a summary row and is counted as data; take it out of the file if it should not be` });
        }
        described[index] = { ...current, lenient, decimal: result.decimal, flatten, columns: result.columns };
        return;
      } catch (error) {
        if (!lenient && source.kind === 'csv') continue;
        skipped.push({ file: source.label, reason: explainReadError(error.message) });
        return;
      }
    }
  });
  return { described: described.filter(Boolean), skipped, notes };
}

function commonDirectory(labels) {
  const lists = labels.map((label) => label.replace(/ \[[^\]]*\]$/, '').split('/').slice(0, -1));
  const first = lists[0] ?? [];
  const common = [];
  for (let i = 0; i < first.length; i += 1) {
    if (lists.every((list) => list[i] === first[i])) common.push(first[i]);
    else break;
  }
  return common;
}

function nameOf(group) {
  const labels = group.sources.map((source) => source.label);
  if (labels.length === 1) {
    const base = labels[0].split('/').pop();
    const sheet = /\[([^\]]*)\]$/.exec(base);
    const stem = base.replace(/ \[[^\]]*\]$/, '').replace(/\.[^.]+$/, '');
    return sheet === null ? stem : `${stem} - ${sheet[1]}`;
  }
  const common = commonDirectory(labels).filter((part) => !/^[\d._-]+$/.test(part));
  if (common.length > 0) return `${common[common.length - 1]} (${labels.length} files)`;
  const stem = labels[0].split('/').pop().replace(/ \[[^\]]*\]$/, '').replace(/\.[^.]+$/, '');
  return `${stem} and ${labels.length - 1} similar`;
}

/** Group described sources by their set of column names. */
export function groupDatasets(described) {
  const groups = new Map();
  for (const source of described) {
    const key = source.columns.map((column) => column.name.toLowerCase()).sort().join('\u0001');
    if (!groups.has(key)) groups.set(key, { sources: [], columns: source.columns });
    groups.get(key).sources.push(source);
  }
  const list = [...groups.values()].map((group) => ({ ...group, bytes: group.sources.reduce((sum, source) => sum + source.size, 0) }));
  list.sort((a, b) => b.bytes - a.bytes || (a.sources[0].label < b.sources[0].label ? -1 : 1));
  const used = new Set();
  return list.map((group, index) => {
    let name = nameOf(group);
    let n = 2;
    while (used.has(name)) {
      name = `${nameOf(group)} #${n}`;
      n += 1;
    }
    used.add(name);
    return { id: `ds${index + 1}`, name, sources: group.sources, files: group.sources.map((source) => source.label), bytes: group.bytes };
  });
}

/** SQL that defines, for each dataset, the raw view `raw_<id>` (all its files together) and the typed view `<id>`. */
export function buildPrelude(datasets, typed = {}) {
  const statements = [];
  for (const dataset of datasets) {
    const byKind = new Map();
    for (const source of dataset.sources) {
      const lenient = source.kind === 'csv' && source.lenient === true;
      const decimal = source.kind === 'csv' && source.decimal === true;
      const flatten = Array.isArray(source.flatten) ? source.flatten : [];
      const key = `${source.kind}|${lenient}|${decimal}|${JSON.stringify(flatten)}`;
      if (!byKind.has(key)) byKind.set(key, { kind: source.kind, lenient, decimal, flatten, files: [] });
      byKind.get(key).files.push(source.abs);
    }
    const selects = [...byKind.values()].map((group) => `SELECT * FROM ${readerSql(group.kind, group.files, group.lenient, group.decimal, group.flatten)}`);
    statements.push(`CREATE OR REPLACE VIEW ${ident(`raw_${dataset.id}`)} AS ${selects.join(' UNION ALL BY NAME ')};`);
    const casts = (typed[dataset.id] ?? []).map((column) => `try_cast(${ident(column)} AS TIMESTAMP) AS ${ident(column)}`);
    statements.push(
      casts.length === 0
        ? `CREATE OR REPLACE VIEW ${ident(dataset.id)} AS SELECT * FROM ${ident(`raw_${dataset.id}`)};`
        : `CREATE OR REPLACE VIEW ${ident(dataset.id)} AS SELECT * REPLACE (${casts.join(', ')}) FROM ${ident(`raw_${dataset.id}`)};`,
    );
  }
  return statements.join('\n');
}
