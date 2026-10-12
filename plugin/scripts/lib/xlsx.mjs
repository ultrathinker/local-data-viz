// Reads an Excel workbook (.xlsx) with no dependencies and turns every visible sheet into plain rows, so DuckDB can read them as CSV.
// Cell values become text the way Excel shows the data: numbers as written, booleans as true/false, dates as ISO dates.
// Formulas are not evaluated: the value Excel last saved is used.

import { listZip, readEntry } from './zip.mjs';

const MAX_ROWS = 2_000_000;

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME_ONLY = new Set([18, 19, 20, 21, 45, 46, 47]);

export function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) => safeChar(parseInt(hex, 16)));
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
  return String.fromCodePoint(code);
}

function attribute(text, name) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(text);
  return match === null ? null : decodeXml(match[1]);
}

function columnIndex(reference) {
  const letters = /^([A-Z]+)/i.exec(reference ?? '');
  if (letters === null) return -1;
  let index = 0;
  for (const ch of letters[1].toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function sharedStringsOf(xml) {
  if (xml === null) return [];
  const out = [];
  const items = xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g);
  for (const item of items) {
    const body = (item[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let text = '';
    for (const part of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) text += part[1] ?? '';
    out.push(decodeXml(text));
  }
  return out;
}

/** Does this custom number format show a date or a time? Quoted text, [colours] and escaped characters do not count. */
function formatKind(code) {
  const cleaned = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');
  const hasDate = /[ymd]/i.test(cleaned) && !/^general$/i.test(cleaned.trim());
  const hasTime = /[hs]/i.test(cleaned) || /am\/pm|a\/p/i.test(cleaned);
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}

function dateStylesOf(xml) {
  const styles = [];
  if (xml === null) return styles;
  const custom = new Map();
  for (const match of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const id = Number(attribute(match[1], 'numFmtId'));
    const code = attribute(match[1], 'formatCode');
    if (Number.isFinite(id) && code !== null) custom.set(id, code);
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (cellXfs === null) return styles;
  for (const xf of cellXfs[1].matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(attribute(xf[1], 'numFmtId') ?? 0);
    let kind = null;
    if (custom.has(id)) kind = formatKind(custom.get(id));
    else if (BUILTIN_TIME_ONLY.has(id)) kind = 'time';
    else if (BUILTIN_DATE_FORMATS.has(id)) kind = 'date';
    styles.push(kind);
  }
  return styles;
}

const pad = (value, width = 2) => String(value).padStart(width, '0');

/** An Excel serial number as an ISO date, date-time or time of day; the plain number when it cannot be a date. */
export function serialToText(serial, kind, date1904) {
  if (!Number.isFinite(serial)) return String(serial);
  if (kind === 'time') {
    const fraction = serial - Math.floor(serial);
    const seconds = Math.round(fraction * 86400);
    return `${pad(Math.floor(seconds / 3600) % 24)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  }
  const days = date1904 ? serial + 1462 : serial;
  const ms = Math.round(((days - 25569) * 86400000) / 1000) * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return String(serial);
  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return time === '00:00:00' ? day : `${day} ${time}`;
}

function cleanHeader(cells) {
  const seen = new Set();
  return cells.map((cell, index) => {
    let name = String(cell ?? '').trim();
    if (name === '') name = `column_${index + 1}`;
    let candidate = name;
    let n = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${name}_${n}`;
      n += 1;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

function parseSheet(xml, shared, styles, date1904) {
  const rows = [];
  let truncated = false;
  let width = 0;
  for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (row[2] === undefined) continue;
    const cells = [];
    for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (cell[2] === undefined) continue;
      const attrs = cell[1];
      const column = columnIndex(attribute(attrs, 'r'));
      const type = attribute(attrs, 't') ?? 'n';
      const style = Number(attribute(attrs, 's') ?? 0);
      let text = '';
      const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cell[2]);
      const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2]);
      if (inline !== null) {
        for (const part of inline[1].matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) text += part[1] ?? '';
        text = decodeXml(text);
      } else if (value !== null) {
        const raw = decodeXml(value[1]);
        if (type === 's') text = shared[Number(raw)] ?? '';
        else if (type === 'b') text = raw === '1' ? 'true' : 'false';
        else if (type === 'e') text = '';
        else if (type === 'str' || type === 'd') text = raw;
        else {
          const kind = styles[style] ?? null;
          text = kind === null ? raw : serialToText(Number(raw), kind, date1904);
        }
      }
      if (text === '' || column < 0) continue;
      while (cells.length <= column) cells.push('');
      cells[column] = text;
    }
    if (cells.every((value) => value === '')) continue;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    width = Math.max(width, cells.length);
    rows.push(cells);
  }
  for (const cells of rows) while (cells.length < width) cells.push('');
  return { rows, width, truncated };
}

/**
 * A report title (or a merged heading cell) above the table: leading rows with ONE filled cell while the next row has several.
 * They are removed from `rows` (at most 5) and counted, so the real header row becomes the header.
 */
export function dropTitleRows(rows, width) {
  const filled = (row) => row.filter((cell) => cell !== '').length;
  let dropped = 0;
  while (dropped < 5 && rows.length >= 3 && width >= 3 && filled(rows[0]) === 1 && filled(rows[1]) >= 2) {
    rows.shift();
    dropped += 1;
  }
  return dropped;
}

/** { sheets: [{ name, header, rows, truncated, titleRows }], skipped: [{ sheet, reason }] } for the visible sheets of a workbook. */
export function readXlsx(buffer) {
  const entries = listZip(buffer);
  const text = (name) => {
    const entry = entries.get(name);
    return entry === undefined ? null : readEntry(buffer, entry).toString('utf8');
  };
  const workbook = text('xl/workbook.xml');
  if (workbook === null) throw new Error('not an Excel workbook (no xl/workbook.xml)');
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map();
  for (const rel of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attribute(rel[1], 'Id');
    const target = attribute(rel[1], 'Target');
    if (id !== null && target !== null) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/i.test(workbook);
  const shared = sharedStringsOf(text('xl/sharedStrings.xml'));
  const styles = dateStylesOf(text('xl/styles.xml'));
  const sheets = [];
  const skipped = [];
  for (const sheet of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = attribute(sheet[1], 'name') ?? 'Sheet';
    const state = attribute(sheet[1], 'state');
    if (state === 'hidden' || state === 'veryHidden') {
      skipped.push({ sheet: name, reason: 'hidden sheet' });
      continue;
    }
    const target = targets.get(attribute(sheet[1], 'r:id') ?? attribute(sheet[1], 'id') ?? '');
    const xml = target === undefined ? null : text(target);
    if (xml === null) {
      skipped.push({ sheet: name, reason: 'sheet data not found' });
      continue;
    }
    const parsed = parseSheet(xml, shared, styles, date1904);
    const titleRows = dropTitleRows(parsed.rows, parsed.width);
    if (parsed.rows.length < 2 || parsed.width < 1) {
      skipped.push({ sheet: name, reason: 'no data rows' });
      continue;
    }
    const [headerCells, ...rows] = parsed.rows;
    sheets.push({ name, header: cleanHeader(headerCells), rows, truncated: parsed.truncated, titleRows });
  }
  return { sheets, skipped };
}

function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function sheetToCsv(sheet) {
  const lines = [sheet.header.map(csvField).join(',')];
  for (const row of sheet.rows) lines.push(row.map(csvField).join(','));
  return `${lines.join('\n')}\n`;
}
