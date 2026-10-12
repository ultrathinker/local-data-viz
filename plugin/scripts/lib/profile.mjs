// Looks at every dataset and says what each column is: a number to measure, a category to split by, a date, an identifier, free text.
// The numbers come from DuckDB (SUMMARIZE and a few small queries); the decisions are plain rules in `classify`, kept pure so they can
// be tested without DuckDB.

import { ident, lit, queryAll } from './duck.mjs';
import { buildPrelude } from './datasets.mjs';

const NUMERIC = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/i;
const INTEGER = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT)/i;
const ADDITIVE_NAME = /(amount|total|revenue|sales|income|expense|cost|spend|profit|loss|qty|quantity|units|volume|count|number_of|^num_|^n_|clicks|views|visits|orders|sessions|impressions|downloads|bytes|hours|minutes|planned|actual|budget|forecast)/i;
const ACCUMULATED_NAME = /(^|[_\s.-])(rain(fall)?|precip\w*|snow(fall)?|passengers|tickets|cases|deaths|errors|requests|transactions|items|calls|messages|kwh|mwh|energy|consumption|usage|emissions)([_\s.-]|$)/i;
const AVERAGE_NAME = /(avg|average|mean|rate|ratio|pct|percent|price|score|rating|age|temp|duration|latency|weight|height|margin|discount|length|stay|elapsed|wait|delay|speed|humidity|pressure|voltage)/i;
const ID_NAME = /(^|[_\s-])(id|uuid|guid|key|code|ref|reference|number|no)$/i;
const YEAR_NAME = /(^|[_\s-])(year|yr)$/i;

// "$12.30", "1,234.50", "12%": numbers written with a currency or percent sign or thousands separators, which DuckDB reads as text
const SYMBOL = '[$\\x{20AC}\\x{A3}\\x{A5}%]';
const NUMBER_WITH_SYMBOLS = `^\\s*[-+(]?\\s*${SYMBOL}?\\s*[-+]?\\d[\\d,.\\s]*\\s*${SYMBOL}?\\s*\\)?\\s*$`;
const HAS_SYMBOL = '[$\\x{20AC}\\x{A3}\\x{A5}%,]';

const MISSING_CODES = [-9999999, -999999, -99999, -9999, -999, 999, 9999, 99999, 999999, 9999999];

/** A number column whose lowest (or highest) value is 999-like and far from the rest: a code for "missing" read as a real number. */
export function missingCode(column) {
  const scale = Math.max(Math.abs(column.median ?? column.mean ?? 0), 1);
  for (const code of MISSING_CODES) {
    if ((code < 0 ? column.min : column.max) === code && Math.abs(code) >= 20 * scale) return code;
  }
  return null;
}

const number = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function typeFamily(type) {
  const text = String(type);
  if (text.includes('[') || /^(STRUCT|MAP|LIST|UNION|ARRAY)/i.test(text)) return 'complex';
  if (/^(DATE|TIMESTAMP)/i.test(text)) return 'temporal';
  if (/^BOOLEAN/i.test(text)) return 'boolean';
  if (/^UUID/i.test(text)) return 'uuid';
  if (/^(VARCHAR|ENUM|STRING)/i.test(text)) return 'string';
  if (NUMERIC.test(text)) return 'numeric';
  return 'complex';
}

/** The additive measures (money, counts) are summed; the rest (prices, rates, ages) are averaged. */
export function defaultAggregate(name) {
  if (AVERAGE_NAME.test(name)) return 'avg';
  if (ADDITIVE_NAME.test(name) || ACCUMULATED_NAME.test(name)) return 'sum';
  return 'avg';
}

/**
 * One SUMMARIZE row (plus the dataset's row count) -> { role, ordered }.
 * Roles: temporal, measure, dimension (up to 20 values), dimension_high (21 and more, used for top-N), id, text, constant, empty, complex.
 */
export function classify(summary, rows) {
  const family = typeFamily(summary.type);
  const nonNull = Math.round(rows * (1 - (summary.nullPct ?? 0) / 100));
  const unique = summary.unique ?? 0;
  if (family === 'complex') return { role: 'complex', ordered: false };
  if (nonNull === 0) return { role: 'empty', ordered: false };
  if (unique <= 1) return { role: 'constant', ordered: false };
  if (family === 'temporal') return { role: 'temporal', ordered: true };
  if (family === 'boolean') return { role: 'dimension', ordered: false };
  if (family === 'uuid') return { role: 'id', ordered: false };
  if (family === 'string') {
    if (rows >= 20 && unique >= 0.9 * nonNull) return { role: ID_NAME.test(summary.name) ? 'id' : 'text', ordered: false };
    if (unique <= 20) return { role: 'dimension', ordered: false };
    if (unique <= Math.min(2000, nonNull * 0.5)) return { role: 'dimension_high', ordered: false };
    return { role: 'text', ordered: false };
  }
  const isInteger = INTEGER.test(summary.type);
  if (isInteger && YEAR_NAME.test(summary.name) && summary.min !== null && summary.min >= 1800 && summary.max <= 2200) return { role: 'dimension', ordered: true };
  if (isInteger && rows >= 20 && unique >= 0.98 * nonNull) {
    // all different: a key (by its name, or a run of consecutive numbers) or a measure that happens to never repeat
    const span = summary.max - summary.min + 1;
    if (ID_NAME.test(summary.name) || (Number.isFinite(span) && span <= unique * 1.1)) return { role: 'id', ordered: false };
  }
  if (isInteger && unique <= 10 && rows >= 30 && !ADDITIVE_NAME.test(summary.name)) return { role: 'dimension', ordered: true };
  return { role: 'measure', ordered: false };
}

/** The date grain that gives a readable number of points for a time range. */
export function pickGrain(minText, maxText, type = 'DATE', unique = null) {
  const from = Date.parse(`${String(minText).replace(' ', 'T').slice(0, 19)}Z`);
  const to = Date.parse(`${String(maxText).replace(' ', 'T').slice(0, 19)}Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'day';
  const days = (to - from) / 86400000;
  if (unique !== null && unique > 1) {
    // sparse dates (one per month, one per year) are shown at the spacing they have
    const gap = days / (unique - 1);
    if (gap >= 300) return 'year';
    if (gap >= 80) return 'quarter';
    if (gap >= 25) return 'month';
  }
  if (days <= 3 && /^TIMESTAMP/i.test(type)) return 'hour';
  if (days <= 120) return 'day';
  if (days <= 400) return 'week';
  if (days <= 365 * 12) return 'month';
  return 'year';
}

function summaryOf(row, noValues) {
  const family = typeFamily(row.column_type);
  const numeric = family === 'numeric';
  return {
    name: row.column_name,
    type: row.column_type,
    unique: row.approx_unique ?? null,
    nullPct: number(row.null_percentage) ?? 0,
    min: numeric ? number(row.min) : noValues && family === 'string' ? null : row.min,
    max: numeric ? number(row.max) : noValues && family === 'string' ? null : row.max,
    mean: numeric ? number(row.avg) : null,
    std: numeric ? number(row.std) : null,
    median: numeric ? number(row.q50) : null,
  };
}

const MAX_LISTED_CATEGORIES = 30;
const MISSING_SHARE_NOTE = 20;
const EXACT_ROWS_LIMIT = 2_000_000;
const EXACT_COLUMNS_LIMIT = 200;

/**
 * Exact numbers of different values, in one pass. SUMMARIZE only estimates them (an estimate can exceed the row count, or miss
 * one value of a few), and a wrong "5 values" for six categories misleads. Larger tables keep the estimate, clamped to what is
 * possible, and the report says "about".
 */
async function exactDistinct(bin, prelude, datasetId, summaryRows, rows) {
  if (rows === 0 || rows > EXACT_ROWS_LIMIT) return new Map();
  const names = summaryRows.filter((row) => typeFamily(row.column_type) !== 'complex').map((row) => row.column_name).slice(0, EXACT_COLUMNS_LIMIT);
  if (names.length === 0) return new Map();
  try {
    const select = names.map((name, i) => `count(DISTINCT ${ident(name)}) AS u${i}`);
    const [[found]] = await queryAll(bin, prelude, [`SELECT ${select.join(', ')} FROM ${ident(datasetId)}`]);
    return new Map(names.map((name, i) => [name, Number(found[`u${i}`])]));
  } catch {
    return new Map();
  }
}

/** Profile every dataset: row counts, column roles, measures, dimensions, time columns, strongest correlations. */
export async function profileDatasets(bin, datasets, { noValues = false } = {}) {
  const profiled = [];
  for (const dataset of datasets) {
    const rawPrelude = buildPrelude([dataset]);
    const raw = ident(`raw_${dataset.id}`);
    const [[counted], summary] = await queryAll(bin, rawPrelude, [`SELECT count(*) AS n FROM ${raw}`, `SUMMARIZE ${raw}`]);
    const rows = Number(counted.n);

    // text columns that hold dates (JSON files, odd CSVs) are read as timestamps
    const textColumns = summary.filter((row) => typeFamily(row.column_type) === 'string' && (row.approx_unique ?? 0) >= 3).map((row) => row.column_name);
    const typed = [];
    const symbolic = new Map();
    if (textColumns.length > 0 && rows > 0) {
      const checks = textColumns.map((name, i) => {
        const text = `CAST(${ident(name)} AS VARCHAR)`;
        const numberSql = `regexp_matches(${text}, ${lit(NUMBER_WITH_SYMBOLS)})`;
        const symbolSql = `${numberSql} AND regexp_matches(${text}, ${lit(HAS_SYMBOL)})`;
        return `count(try_cast(${ident(name)} AS TIMESTAMP)) AS ok${i}, count(${ident(name)}) AS n${i}, avg(length(${ident(name)})) AS len${i}, count(*) FILTER (WHERE ${numberSql}) AS num${i}, count(*) FILTER (WHERE ${symbolSql}) AS sym${i}, min(${text}) FILTER (WHERE ${symbolSql}) AS ex${i}, min(${text}) FILTER (WHERE ${text} IS NOT NULL AND NOT ${numberSql}) AS odd${i}`;
      });
      const [[found]] = await queryAll(bin, rawPrelude, [`SELECT ${checks.join(', ')} FROM ${raw}`]);
      textColumns.forEach((name, i) => {
        const total = Number(found[`n${i}`]);
        if (total > 0 && Number(found[`ok${i}`]) / total >= 0.98 && Number(found[`len${i}`]) >= 6) typed.push(name);
        else if (total > 0 && Number(found[`num${i}`]) / total >= 0.9) {
          if (Number(found[`sym${i}`]) / total >= 0.05) symbolic.set(name, { kind: 'symbols', example: found[`ex${i}`] });
          else if (Number(found[`num${i}`]) < total) symbolic.set(name, { kind: 'mixed', example: found[`odd${i}`] });
        }
      });
    }
    const prelude = buildPrelude([dataset], { [dataset.id]: typed });
    const finalSummary = typed.length === 0 ? summary : (await queryAll(bin, prelude, [`SUMMARIZE ${ident(dataset.id)}`]))[0];

    const exact = await exactDistinct(bin, prelude, dataset.id, finalSummary, rows);
    const columns = finalSummary.map((row, index) => {
      const base = summaryOf(row, noValues);
      const nonNull = Math.round(rows * (1 - base.nullPct / 100));
      const uniqueApprox = !exact.has(base.name) && typeFamily(base.type) !== 'complex';
      base.unique = exact.has(base.name) ? exact.get(base.name) : Math.min(base.unique ?? 0, nonNull);
      const verdict = classify(base, rows);
      const column = { ...base, alias: `c${index}`, role: verdict.role, ordered: verdict.ordered, numeric: typeFamily(base.type) === 'numeric', castFromText: typed.includes(base.name), ...(uniqueApprox ? { uniqueApprox: true } : {}) };
      if (verdict.role === 'measure') {
        column.agg = defaultAggregate(base.name);
        const spread = base.std !== null && base.mean !== null && base.mean !== 0 ? Math.min(3, Math.abs(base.std / base.mean)) : base.std !== null && base.std > 0 ? 1 : 0;
        column.interest = Math.round((1 - base.nullPct / 100) * spread * 1000) / 1000;
      }
      if (verdict.role === 'temporal') column.grain = pickGrain(base.min, base.max, base.type, base.unique);
      return column;
    });

    // the values of the categories, so a reader (and Claude) can see what they are; skipped with --no-values
    let listedOnlyFirst = 0;
    if (!noValues && rows > 0) {
      const categories = columns.filter((column) => column.role === 'dimension' || column.role === 'dimension_high');
      const dimensions = categories.slice(0, MAX_LISTED_CATEGORIES);
      if (categories.length > dimensions.length) listedOnlyFirst = categories.length - dimensions.length;
      if (dimensions.length > 0) {
        const queries = dimensions.map((column) => `SELECT CAST(${ident(column.name)} AS VARCHAR) AS value, count(*) AS count FROM ${ident(dataset.id)} WHERE ${ident(column.name)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12`);
        const results = await queryAll(bin, prelude, queries);
        dimensions.forEach((column, i) => {
          column.top = results[i].map((row) => ({ value: row.value, count: Number(row.count) }));
        });
      }
    }

    const measures = columns.filter((column) => column.role === 'measure').sort((a, b) => b.interest - a.interest || (a.name < b.name ? -1 : 1));
    let correlations = [];
    const top = measures.slice(0, 8);
    if (top.length >= 2 && rows >= 10) {
      const pairs = [];
      for (let i = 0; i < top.length; i += 1) for (let j = i + 1; j < top.length; j += 1) pairs.push([top[i], top[j]]);
      const select = pairs.map(([a, b], i) => `corr(CAST(${ident(a.name)} AS DOUBLE), CAST(${ident(b.name)} AS DOUBLE)) AS r${i}`);
      const [[row]] = await queryAll(bin, prelude, [`SELECT ${select.join(', ')} FROM ${ident(dataset.id)}`]);
      correlations = pairs
        .map(([a, b], i) => ({ a: a.name, b: b.name, r: number(row[`r${i}`]) }))
        .filter((pair) => pair.r !== null)
        .sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
    }

    const quality = [];
    for (const column of columns) {
      if (column.role === 'empty') quality.push(`${column.name}: every value is missing`);
      else if (column.nullPct >= MISSING_SHARE_NOTE) quality.push(`${column.name}: ${column.nullPct}% of the values are missing`);
      else if (column.role === 'constant') quality.push(`${column.name}: the same value in every row`);
      else if (column.role === 'complex') quality.push(`${column.name}: nested data (${column.type}) is not charted`);
      const code = column.role === 'measure' ? missingCode(column) : null;
      if (code !== null) {
        const what = noValues ? 'an extreme value that looks like a code for "missing"' : `the value ${code}, which looks like a code for "missing"`;
        quality.push(`${column.name}: contains ${what}; it is counted as a real number in every sum, average and histogram (the plan cannot filter rows: clean the files, or say so in the chart's note)`);
      }
    }
    for (const column of columns) {
      const found = symbolic.get(column.name);
      if (found === undefined) continue;
      const shown = noValues || found.example === null || found.example === undefined ? null : String(found.example).slice(0, 20);
      if (found.kind === 'symbols') {
        quality.push(`${column.name}: the values look like numbers written with symbols or separators (${shown === null ? 'a currency or percent sign, or thousands separators' : `for example "${shown}"`}), so the column is read as text and cannot be summed or averaged; take the symbols out of the file to use it as a number`);
      } else {
        quality.push(`${column.name}: most values are numbers but some are text${shown === null ? '' : ` (for example "${shown}")`}, so the column is read as text and cannot be summed or averaged; clear those cells in the file to use it as a number`);
      }
    }
    if (listedOnlyFirst > 0) quality.push(`${listedOnlyFirst} more category columns are listed without their values (the report shows the values of the first ${MAX_LISTED_CATEGORIES})`);
    profiled.push({ ...dataset, rows, columns, typed, correlations, quality });
  }
  return profiled;
}

/** The SQL that defines every profiled dataset as a view (raw and typed), ready to prepend to a query. */
export function preludeOf(datasets) {
  return buildPrelude(datasets, Object.fromEntries(datasets.map((dataset) => [dataset.id, dataset.typed ?? []])));
}
