// Row filters of the plan: "only the emergency ward", "only the last 3 months". A filter is plain JSON (never SQL text):
//   { "column": "department", "op": "=", "value": "emergency" }
//   { "column": "visit_time", "op": "last", "n": 3, "unit": "month" }
// `normalizeFilters` checks every filter against the profiled columns and returns a canonical copy; `filterSql` turns canonical
// filters into a WHERE condition in which every name goes through ident() and every value through lit() or a checked number.

import { ident, lit } from './duck.mjs';

export const FILTER_OPS = ['=', '!=', '<', '<=', '>', '>=', 'between', 'in', 'not_in', 'is_null', 'not_null', 'contains', 'starts_with', 'last'];
export const FILTER_UNITS = ['day', 'week', 'month', 'quarter', 'year'];
export const FILTER_LIMITS = Object.freeze({ perList: 8, values: 100, text: 200, last: 1000 });

const FILTER_KEYS = ['column', 'op', 'value', 'values', 'to', 'n', 'unit'];
const ORDERED_OPS = new Set(['<', '<=', '>', '>=', 'between']);
const TEXT_OPS = new Set(['contains', 'starts_with']);
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

const clean = (value, limit) => String(value ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, limit);

/** What a column is for a filter: 'time' (dates), 'number' or 'text' (everything else is compared as text). */
export function filterKind(column) {
  if (column.role === 'temporal') return 'time';
  if (column.numeric === true || column.role === 'measure') return 'number';
  return 'text';
}

function typedValue(kind, raw) {
  if (kind === 'time') {
    if (typeof raw !== 'string') return null;
    const match = ISO.exec(raw.trim());
    if (match === null) return null;
    const [, year, month, day, hour, minute, second] = match;
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
    const date = `${year}-${month}-${day}`;
    return hour === undefined ? date : `${date} ${hour}:${minute}:${second ?? '00'}`;
  }
  if (kind === 'number') {
    const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(number) ? number : null;
  }
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    const text = clean(raw, FILTER_LIMITS.text);
    return text === '' && typeof raw === 'string' ? null : text;
  }
  return null;
}

const KIND_WORDS = { time: 'a date as "2025-01-31" or "2025-01-31 08:30:00"', number: 'a number', text: 'a text' };

/**
 * Check a list of filters from the plan against a dataset (its profiled columns) and return the canonical list.
 * `fail(where, message)` collects the problems; `findColumn(dataset, name)` finds a column by name.
 */
export function normalizeFilter(here, raw, dataset, fail, findColumn, { withDataset = false } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(here, 'must be an object such as { "column": "region", "op": "=", "value": "North" }');
  const allowed = withDataset ? ['dataset', ...FILTER_KEYS] : FILTER_KEYS;
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(here, `unknown field "${clean(key, 40)}"; allowed here: ${allowed.join(', ')}`);
  if (!FILTER_OPS.includes(raw.op)) return fail(here, `op must be one of ${FILTER_OPS.join(', ')}`);
  const column = findColumn(dataset, raw.column);
  if (column === null) return fail(here, `column "${clean(raw.column, 60)}" is not a column of ${dataset.id} (${dataset.columns.map((c) => c.name).slice(0, 12).join(', ')}${dataset.columns.length > 12 ? ', ...' : ''})`);
  if (column.role === 'complex') return fail(here, `column "${column.name}" holds nested data and cannot be filtered`);
  const kind = filterKind(column);
  const filter = { column: column.name, op: raw.op };
  if (raw.op === 'last' && kind !== 'time') return fail(here, `op "last" needs a date column; "${column.name}" is ${kind === 'text' ? 'text' : 'a number'}`);
  if (ORDERED_OPS.has(raw.op) && kind === 'text') return fail(here, `op "${raw.op}" needs a number or date column; "${column.name}" is text (use =, !=, in, not_in, contains, starts_with, is_null or not_null)`);
  if (TEXT_OPS.has(raw.op) && kind !== 'text') return fail(here, `op "${raw.op}" needs a text column; "${column.name}" is ${kind === 'time' ? 'a date' : 'a number'}`);

  const one = (field) => {
    const value = typedValue(kind, raw[field]);
    if (value === null) {
      fail(here, `${field} must be ${KIND_WORDS[kind]} for the column "${column.name}"`);
      return undefined;
    }
    return value;
  };
  if (['=', '!=', '<', '<=', '>', '>=', 'contains', 'starts_with'].includes(raw.op)) filter.value = one('value');
  else if (raw.op === 'between') {
    filter.value = one('value');
    filter.to = one('to');
    if (filter.value !== undefined && filter.to !== undefined && filter.value > filter.to) fail(here, '"value" must not be greater than "to"');
  } else if (raw.op === 'in' || raw.op === 'not_in') {
    if (!Array.isArray(raw.values) || raw.values.length === 0) fail(here, '"values" must be a non-empty list');
    else if (raw.values.length > FILTER_LIMITS.values) fail(here, `at most ${FILTER_LIMITS.values} values`);
    else {
      const values = raw.values.map((item) => typedValue(kind, item));
      if (values.some((item) => item === null)) fail(here, `every item of "values" must be ${KIND_WORDS[kind]} for the column "${column.name}"`);
      else filter.values = values;
    }
  } else if (raw.op === 'last') {
    const n = Number(raw.n);
    if (!Number.isInteger(n) || n < 1 || n > FILTER_LIMITS.last) fail(here, `"n" must be a whole number from 1 to ${FILTER_LIMITS.last}`);
    else filter.n = n;
    if (!FILTER_UNITS.includes(raw.unit)) fail(here, `"unit" must be one of ${FILTER_UNITS.join(', ')}`);
    else filter.unit = raw.unit;
  }
  if (withDataset) filter.dataset = dataset.id;
  return filter;
}

/** A list of filters (of a view or an explorer) -> the canonical list. */
export function normalizeFilters(where, input, dataset, fail, findColumn) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    fail(where, 'must be a list of filters');
    return [];
  }
  if (input.length > FILTER_LIMITS.perList) fail(where, `at most ${FILTER_LIMITS.perList} filters`);
  return input
    .slice(0, FILTER_LIMITS.perList)
    .map((raw, index) => normalizeFilter(`${where}[${index}]`, raw, dataset, fail, findColumn))
    .filter((filter) => filter !== undefined);
}

const literal = (kind, value) => (kind === 'time' ? `CAST(${lit(value)} AS TIMESTAMP)` : kind === 'number' ? `CAST(${String(Number(value))} AS DOUBLE)` : lit(String(value)));

/** One canonical filter as a SQL condition on the dataset's typed view. */
function conditionSql(filter, dataset, findColumn) {
  const column = findColumn(dataset, filter.column);
  const kind = filterKind(column);
  const name = ident(column.name);
  const expr = kind === 'time' ? `CAST(${name} AS TIMESTAMP)` : kind === 'number' ? `CAST(${name} AS DOUBLE)` : `CAST(${name} AS VARCHAR)`;
  const value = (item) => literal(kind, item);
  switch (filter.op) {
    case '=':
      return `${expr} = ${value(filter.value)}`;
    case '!=':
      return `(${name} IS NULL OR ${expr} <> ${value(filter.value)})`;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return `${expr} ${filter.op} ${value(filter.value)}`;
    case 'between':
      return `${expr} BETWEEN ${value(filter.value)} AND ${value(filter.to)}`;
    case 'in':
      return `${expr} IN (${filter.values.map(value).join(', ')})`;
    case 'not_in':
      return `(${name} IS NULL OR ${expr} NOT IN (${filter.values.map(value).join(', ')}))`;
    case 'is_null':
      return `${name} IS NULL`;
    case 'not_null':
      return `${name} IS NOT NULL`;
    case 'contains':
      return `contains(lower(${expr}), lower(${lit(String(filter.value))}))`;
    case 'starts_with':
      return `starts_with(lower(${expr}), lower(${lit(String(filter.value))}))`;
    case 'last': {
      if (!Number.isInteger(filter.n) || !FILTER_UNITS.includes(filter.unit)) throw new Error('bad "last" filter');
      return `${expr} > (SELECT max(CAST(${name} AS TIMESTAMP)) FROM ${ident(dataset.id)}) - INTERVAL ${filter.n} ${filter.unit.toUpperCase()}`;
    }
    default:
      throw new Error(`unknown filter op ${String(filter.op).slice(0, 20)}`);
  }
}

/** The FROM expression for a dataset under filters: the typed view itself, or a subquery that keeps only the matching rows. */
export function sourceSql(dataset, filters, findColumn) {
  if (!filters || filters.length === 0) return ident(dataset.id);
  return `(SELECT * FROM ${ident(dataset.id)} WHERE ${filters.map((filter) => conditionSql(filter, dataset, findColumn)).join(' AND ')})`;
}

const SYMBOL = { '=': '=', '!=': 'is not', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

/** A filter in plain words, for the page and the report. */
export function describeFilter(filter) {
  const shown = (value) => String(value).slice(0, 60);
  switch (filter.op) {
    case 'between':
      return `${filter.column} from ${shown(filter.value)} to ${shown(filter.to)}`;
    case 'in':
      return `${filter.column} is one of ${filter.values.slice(0, 8).map(shown).join(', ')}${filter.values.length > 8 ? `, ... (${filter.values.length})` : ''}`;
    case 'not_in':
      return `${filter.column} is none of ${filter.values.slice(0, 8).map(shown).join(', ')}${filter.values.length > 8 ? `, ... (${filter.values.length})` : ''}`;
    case 'is_null':
      return `${filter.column} is missing`;
    case 'not_null':
      return `${filter.column} is not missing`;
    case 'contains':
      return `${filter.column} contains "${shown(filter.value)}"`;
    case 'starts_with':
      return `${filter.column} starts with "${shown(filter.value)}"`;
    case 'last':
      return `${filter.column}: the last ${filter.n} ${filter.unit}${filter.n === 1 ? '' : 's'} of the data`;
    default:
      return `${filter.column} ${SYMBOL[filter.op] ?? filter.op} ${shown(filter.value)}`;
  }
}
