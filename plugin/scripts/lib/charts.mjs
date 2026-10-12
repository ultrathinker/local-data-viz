// One chart = one SQL query (run by DuckDB, so the browser only ever gets a small aggregated table) + one Vega-Lite spec + one
// plain-words sentence about what the chart shows.
//
// Safety rule: the data fields in every spec have FIXED names (t, k, v, g, a, b, x, y ...), never a column name from the data.
// Column names only appear as text (axis titles, tooltips) and as quoted identifiers in SQL built with `ident()`.

import { ident } from './duck.mjs';
import { measureLabel, titleOfView } from './plan.mjs';

const MAX_LINE_ROWS = 20_000;
const MAX_SPLIT = 8;
const SCATTER_POINTS = 2000;
const INTEGER_TYPE = /^U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)/i;

export const dimSql = (column) => `coalesce(CAST(${ident(column)} AS VARCHAR), '(empty)')`;

/**
 * A decimal number as 6 places, the same whatever order DuckDB added the rows in. Adding doubles in another order moves the last
 * bit, and an average that falls exactly between two roundings (0.1434375) would then round up in one build and down in the next.
 * Cutting to 12 significant digits first removes that noise, so building twice gives the same page.
 */
export const stableRound = (expression) => `round(CAST(printf('%.12g', ${expression}) AS DOUBLE), 6)`;

export function aggSql(measure) {
  if (measure.agg === 'count') return measure.column ? `count(${ident(measure.column)})` : 'count(*)';
  if (measure.agg === 'count_distinct') return `count(DISTINCT ${ident(measure.column)})`;
  const fn = { sum: 'sum', avg: 'avg', min: 'min', max: 'max', median: 'median' }[measure.agg];
  return stableRound(`${fn}(CAST(${ident(measure.column)} AS DOUBLE))`);
}

/** A date or timestamp column cut to a grain, as an ISO text that the browser reads as UTC. */
export function bucketSql(column, grain) {
  const format = grain === 'hour' ? '%Y-%m-%dT%H:%M:%SZ' : '%Y-%m-%d';
  return `strftime(date_trunc('${grain}', CAST(${ident(column)} AS TIMESTAMP)), '${format}')`;
}

/** What a query reads: the dataset's typed view, or a subquery of it that keeps only the rows the filters allow (set by the build). */
export const fromOf = (dataset) => dataset.from ?? ident(dataset.id);

const top = (column, dataset, limit, order = 'count(*) DESC, 1') => `SELECT ${dimSql(column)} AS k FROM ${fromOf(dataset)} GROUP BY 1 ORDER BY ${order} LIMIT ${limit}`;

export function fmtNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 10000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: abs >= 100 ? 0 : 2 }).format(value);
}

/** Sums and counts of different groups can be added up; averages, minimums, maximums, medians and distinct counts cannot. */
const isAdditive = (measure) => measure.agg === 'sum' || measure.agg === 'count';

const DAY = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The last day a bucket covers, from its first day (an ISO date) and the grain. */
function bucketEnd(start, grain) {
  const [year, month, day] = start.slice(0, 10).split('-').map(Number);
  if (grain === 'week') return isoDay(Date.UTC(year, month - 1, day) + 6 * DAY);
  if (grain === 'month') return isoDay(Date.UTC(year, month, 1) - DAY);
  if (grain === 'quarter') return isoDay(Date.UTC(year, month + 2, 1) - DAY);
  if (grain === 'year') return isoDay(Date.UTC(year + 1, 0, 1) - DAY);
  return start.slice(0, 10);
}

/** True when the data starts after the first week/month/quarter/year starts, or stops before the last one ends: that period is only part covered. */
export function partlyCovered(grain, column, firstStart, lastStart) {
  if (!['week', 'month', 'quarter', 'year'].includes(grain) || !column) return false;
  const from = typeof column.min === 'string' ? column.min.slice(0, 10) : null;
  const to = typeof column.max === 'string' ? column.max.slice(0, 10) : null;
  return (from !== null && from > firstStart.slice(0, 10)) || (to !== null && to < bucketEnd(lastStart, grain));
}

/** The sentence that says a split chart draws only the largest groups. */
function splitNote(view, dataset) {
  const column = view.split ? dataset.columns.find((candidate) => candidate.name === view.split) : null;
  return column && !dataset.filtered && column.unique > MAX_SPLIT ? ` Only the ${MAX_SPLIT} largest of about ${column.unique} groups are drawn.` : '';
}

function histogramGeometry(column, bins) {
  const lo = column.min;
  const hi = column.max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (INTEGER_TYPE.test(column.type) && hi - lo + 1 <= bins) return { lo, width: 1, count: hi - lo + 1, shift: -0.5 };
  if (hi === lo) return { lo, width: 1, count: 1, shift: -0.5 };
  return { lo, width: (hi - lo) / bins, count: bins, shift: 0 };
}

/** The SQL for a view. corr returns one row of correlations, the others return the rows the chart draws. */
export function viewSql(view, dataset) {
  const from = fromOf(dataset);
  const column = (name) => dataset.columns.find((candidate) => candidate.name === name);
  if (view.kind === 'line') {
    const split = view.split ? `, ${dimSql(view.split)} AS g` : '';
    const restrict = view.split ? ` AND ${dimSql(view.split)} IN (${top(view.split, dataset, MAX_SPLIT)})` : '';
    return `SELECT ${bucketSql(view.x, view.grain)} AS t${split}, ${aggSql(view.measure)} AS v FROM ${from} WHERE ${ident(view.x)} IS NOT NULL${restrict} GROUP BY ALL ORDER BY t, ${view.split ? 'g' : 't'} LIMIT ${MAX_LINE_ROWS + 1}`;
  }
  if (view.kind === 'bar') {
    const best = `SELECT ${dimSql(view.x)} AS k, ${aggSql(view.measure)} AS v FROM ${from} GROUP BY 1 ORDER BY v DESC NULLS LAST, k LIMIT ${view.limit}`;
    if (!view.split) return `SELECT k, v FROM (${best}) ORDER BY v DESC NULLS LAST, k`;
    return `SELECT ${dimSql(view.x)} AS k, ${dimSql(view.split)} AS g, ${aggSql(view.measure)} AS v FROM ${from} WHERE ${dimSql(view.x)} IN (SELECT k FROM (${best})) AND ${dimSql(view.split)} IN (${top(view.split, dataset, MAX_SPLIT)}) GROUP BY 1, 2 ORDER BY 1, 2`;
  }
  if (view.kind === 'hist') {
    const geometry = histogramGeometry(column(view.column), view.bins);
    if (geometry === null) return null;
    const x = `CAST(${ident(view.column)} AS DOUBLE)`;
    const number = (value) => `CAST(${String(value)} AS DOUBLE)`; // numbers from the profile, always finite; typed so DuckDB does not make them DECIMAL
    const k = `least(floor((${x} - ${number(geometry.lo)}) / ${number(geometry.width)}), ${geometry.count - 1})`;
    const start = number(geometry.lo + geometry.shift);
    const width = number(geometry.width);
    const counted = `SELECT CAST(${k} AS INTEGER) AS k, count(*) AS n FROM ${from} WHERE ${x} IS NOT NULL AND isfinite(${x}) GROUP BY 1`;
    return `SELECT round(${start} + k * ${width}, 9) AS a, round(${start} + (k + 1) * ${width}, 9) AS b, n AS v FROM (${counted}) ORDER BY a`;
  }
  if (view.kind === 'scatter') {
    const x = `CAST(${ident(view.x)} AS DOUBLE)`;
    const y = `CAST(${ident(view.y)} AS DOUBLE)`;
    const group = view.color ? `, CASE WHEN ${dimSql(view.color)} IN (${top(view.color, dataset, 6)}) THEN ${dimSql(view.color)} ELSE '(other)' END AS g` : '';
    return `SELECT ${x} AS x, ${y} AS y${group} FROM ${from} WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL AND isfinite(${x}) AND isfinite(${y}) ORDER BY hash(${x}, ${y}), x, y${view.color ? ', g' : ''} LIMIT ${SCATTER_POINTS}`;
  }
  if (view.kind === 'heatmap') {
    return `SELECT ${dimSql(view.x)} AS kx, ${dimSql(view.y)} AS ky, ${aggSql(view.measure)} AS v FROM ${from} WHERE ${dimSql(view.x)} IN (${top(view.x, dataset, view.limit)}) AND ${dimSql(view.y)} IN (${top(view.y, dataset, view.limit)}) GROUP BY 1, 2 ORDER BY 1, 2`;
  }
  const names = view.columns;
  const parts = [];
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) parts.push(`${stableRound(`corr(CAST(${ident(names[i])} AS DOUBLE), CAST(${ident(names[j])} AS DOUBLE))`)} AS r_${i}_${j}`);
  return `SELECT ${parts.join(', ')} FROM ${from}`;
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function pearson(rows) {
  const n = rows.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const row of rows) {
    sx += row.x;
    sy += row.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const row of rows) {
    sxx += (row.x - mx) ** 2;
    syy += (row.y - my) ** 2;
    sxy += (row.x - mx) * (row.y - my);
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

export function describeStrength(r) {
  const size = Math.abs(r);
  const word = size >= 0.7 ? 'strong' : size >= 0.4 ? 'moderate' : size >= 0.2 ? 'weak' : 'negligible';
  return size < 0.2 ? 'no clear linear relationship' : `a ${word} ${r > 0 ? 'positive' : 'negative'} relationship`;
}

/** The result rows of the SQL -> { rows, spec, insight, truncated }. The spec has no data: the page adds the rows. */
export function finishView(view, dataset, sqlRows) {
  const title = titleOfView(view);
  let rows = sqlRows;
  let truncated = false;
  let spec;
  let insight = '';

  if (view.kind === 'line') {
    if (rows.length > MAX_LINE_ROWS) {
      rows = rows.slice(0, MAX_LINE_ROWS);
      truncated = true;
    }
    rows = rows.map((row) => ({ t: row.t, v: finite(row.v), ...(view.split ? { g: row.g } : {}) }));
    spec = { type: 'line', xTitle: view.x, yTitle: measureLabel(view.measure), grain: view.grain, ...(view.split ? { colorTitle: view.split } : {}) };
    if (view.split && !isAdditive(view.measure)) {
      const valid = rows.filter((row) => row.v !== null);
      if (valid.length >= 2) {
        const high = valid.reduce((best, row) => (row.v > best.v ? row : best));
        const low = valid.reduce((best, row) => (row.v < best.v ? row : best));
        insight = `${valid.length} points. Highest: ${fmtNumber(high.v)} (${high.g}) on ${high.t.slice(0, 10)}. Lowest: ${fmtNumber(low.v)} (${low.g}) on ${low.t.slice(0, 10)}.`;
      } else insight = 'Fewer than two points: there is no trend to show.';
    } else {
      const totals = new Map();
      const groups = new Map();
      for (const row of rows) {
        if (row.v === null) continue;
        totals.set(row.t, (totals.get(row.t) ?? 0) + row.v);
        if (view.split) groups.set(row.g, (groups.get(row.g) ?? 0) + row.v);
      }
      const points = [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (points.length >= 2) {
        const peak = points.reduce((best, point) => (point[1] > best[1] ? point : best));
        const [firstPoint, lastPoint] = [points[0], points[points.length - 1]];
        // a percentage is only honest for amounts that add up, from a positive start, over whole periods
        let change = '';
        if (!isAdditive(view.measure)) change = ` The first point is ${fmtNumber(firstPoint[1])}, the last is ${fmtNumber(lastPoint[1])}.`;
        else if (firstPoint[1] > 0) {
          if (partlyCovered(view.grain, findColumn(dataset, view.x), firstPoint[0], lastPoint[0])) change = ' The first or last period is only partly covered, so no change from first to last is given.';
          else {
            const percent = ((lastPoint[1] - firstPoint[1]) / firstPoint[1]) * 100;
            change = ` The last point is ${fmtNumber(Math.abs(percent))}% ${percent >= 0 ? 'above' : 'below'} the first.`;
          }
        }
        insight = `${points.length} points from ${firstPoint[0].slice(0, 10)} to ${lastPoint[0].slice(0, 10)}. Highest${view.split ? ' (all groups together)' : ''}: ${fmtNumber(peak[1])} on ${peak[0].slice(0, 10)}.${change}`;
        const sumAll = [...groups.values()].reduce((acc, value) => acc + value, 0);
        if (view.split && groups.size > 1 && sumAll > 0) {
          const [leader, amount] = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
          insight += ` Largest group: ${leader} (${Math.round((amount / sumAll) * 100)}% of the total).`;
        }
      } else insight = 'Fewer than two points: there is no trend to show.';
    }
    insight += splitNote(view, dataset);
    if (truncated) insight += ` Only the first ${MAX_LINE_ROWS} points are drawn; use a coarser grain.`;
  } else if (view.kind === 'bar') {
    rows = rows.map((row) => ({ k: row.k, v: finite(row.v), ...(view.split ? { g: row.g } : {}) }));
    spec = { type: 'bar', yTitle: view.x, xTitle: measureLabel(view.measure), ...(view.split ? { colorTitle: view.split } : {}) };
    if (view.split && !isAdditive(view.measure)) {
      const valid = rows.filter((row) => row.v !== null);
      if (valid.length > 0) {
        const high = valid.reduce((best, row) => (row.v > best.v ? row : best));
        const low = valid.reduce((best, row) => (row.v < best.v ? row : best));
        insight = `Highest: ${high.k} / ${high.g} with ${fmtNumber(high.v)}. Lowest: ${low.k} / ${low.g} with ${fmtNumber(low.v)}.`;
      }
    } else {
      const totals = new Map();
      for (const row of rows) if (row.v !== null) totals.set(row.k, (totals.get(row.k) ?? 0) + row.v);
      const everything = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      // missing values are not a group to put first or last; they are mentioned on their own
      const ranked = everything.filter(([name]) => name !== '(empty)');
      const missing = everything.find(([name]) => name === '(empty)');
      if (ranked.length > 0) {
        const sum = ranked.reduce((acc, item) => acc + item[1], 0);
        const flat = ranked.length > 1 && ranked[0][1] === ranked[ranked.length - 1][1];
        if (flat) insight = `All ${ranked.length} shown are equal (${fmtNumber(ranked[0][1])}).`;
        else {
          insight = `${ranked[0][0]} is highest with ${fmtNumber(ranked[0][1])}${isAdditive(view.measure) && sum > 0 && ranked.length > 1 ? ` (${Math.round((ranked[0][1] / sum) * 100)}% of the ${ranked.length} shown)` : ''}.`;
          if (ranked.length > 1) insight += ` Lowest shown: ${ranked[ranked.length - 1][0]} with ${fmtNumber(ranked[ranked.length - 1][1])}.`;
        }
        const total = dataset.filtered ? null : findColumn(dataset, view.x)?.unique;
        if (total && total > everything.length) insight += ` Top ${everything.length} of about ${total} values.`;
      }
      if (missing !== undefined) insight += `${insight === '' ? '' : ' '}Missing values: ${fmtNumber(missing[1])}.`;
    }
    insight += splitNote(view, dataset);
  } else if (view.kind === 'hist') {
    rows = rows.map((row) => ({ a: finite(row.a), b: finite(row.b), v: Number(row.v) }));
    spec = { type: 'hist', xTitle: view.column, yTitle: 'Rows' };
    const column = findColumn(dataset, view.column);
    const peak = rows.reduce((best, row) => (row.v > best.v ? row : best), rows[0] ?? { v: -1 });
    insight = rows.length === 0 ? 'No values.' : `Most rows fall between ${fmtNumber(peak.a)} and ${fmtNumber(peak.b)}. Range ${fmtNumber(column.min)} to ${fmtNumber(column.max)}; average ${fmtNumber(column.mean)}, median ${fmtNumber(column.median)}.`;
  } else if (view.kind === 'scatter') {
    rows = rows.map((row) => ({ x: finite(row.x), y: finite(row.y), ...(view.color ? { g: row.g } : {}) }));
    spec = { type: 'scatter', xTitle: view.x, yTitle: view.y, ...(view.color ? { colorTitle: view.color } : {}) };
    const r = pearson(rows);
    insight = r === null ? 'Not enough points to compare.' : rows.length < 10 ? `Only ${rows.length} points: too few to say whether the two are related.` : `Correlation ${r.toFixed(2)}: ${describeStrength(r)}. ${rows.length} points${rows.length >= SCATTER_POINTS ? ` (a fixed sample of ${SCATTER_POINTS})` : ''}. Correlation is not causation.`;
  } else if (view.kind === 'heatmap') {
    rows = rows.map((row) => ({ kx: row.kx, ky: row.ky, v: finite(row.v) }));
    spec = { type: 'heatmap', xTitle: view.x, yTitle: view.y, valueTitle: measureLabel(view.measure) };
    const best = rows.filter((row) => row.v !== null).sort((a, b) => b.v - a.v)[0];
    insight = best === undefined ? 'No values.' : `The highest cell is ${best.kx} / ${best.ky} with ${fmtNumber(best.v)}.`;
  } else {
    const names = view.columns;
    const row = sqlRows[0] ?? {};
    const cells = [];
    const pairs = [];
    for (let i = 0; i < names.length; i += 1) {
      for (let j = 0; j < names.length; j += 1) {
        const r = i === j ? 1 : finite(Number(row[`r_${Math.min(i, j)}_${Math.max(i, j)}`]));
        cells.push({ a: names[i], b: names[j], r });
        if (i < j && r !== null) pairs.push({ a: names[i], b: names[j], r });
      }
    }
    rows = cells;
    spec = { type: 'corr' };
    pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
    insight = pairs.length === 0 ? 'No pair of columns could be compared.' : `Strongest pair: ${pairs[0].a} and ${pairs[0].b} (${pairs[0].r.toFixed(2)}, ${describeStrength(pairs[0].r)}). Correlation is not causation.`;
  }
  return { rows, spec, insight, truncated };
}

function findColumn(dataset, name) {
  return dataset.columns.find((column) => column.name === name);
}
