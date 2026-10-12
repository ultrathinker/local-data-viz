// The plan: what to chart, written as plain JSON. `recommend.mjs` writes the first draft, Claude (or the person) edits it, `build`
// reads it. Every name in it is checked against the profile here, so a typo or a made-up column fails with a clear message
// instead of turning into SQL.

import { normalizeFilter, normalizeFilters } from './filters.mjs';

export const PLAN_VERSION = 1;
export const KINDS = ['line', 'bar', 'hist', 'scatter', 'heatmap', 'corr'];
export const AGGS = ['sum', 'avg', 'min', 'max', 'median', 'count', 'count_distinct'];
export const GRAINS = ['hour', 'day', 'week', 'month', 'quarter', 'year'];
export const PLAN_LIMITS = Object.freeze({ pageFilters: 16, views: 40, explorers: 12, explorerDimensions: 5, explorerMeasures: 4, titleLength: 120, noteLength: 400, bins: 100, topN: 30, split: 8 });

const AGG_WORDS = { sum: 'Sum of', avg: 'Average of', min: 'Minimum of', max: 'Maximum of', median: 'Median of', count_distinct: 'Distinct values of' };

export function measureLabel(measure) {
  if (measure.agg === 'count' && !measure.column) return 'Rows';
  if (measure.agg === 'count') return `Count of ${measure.column}`;
  return `${AGG_WORDS[measure.agg]} ${measure.column}`;
}

const COMMON_VIEW_KEYS = ['id', 'kind', 'dataset', 'title', 'note', 'filters'];
const VIEW_KEYS = {
  line: ['x', 'measure', 'split', 'grain'],
  bar: ['x', 'measure', 'split', 'limit'],
  hist: ['column', 'bins'],
  scatter: ['x', 'y', 'color'],
  heatmap: ['x', 'y', 'measure', 'limit'],
  corr: ['columns'],
};
const FILTER_WORDS = /^(filter|where|having|query|sql|condition|select|exclude|include|from|to|since|until)$/i;

/** Two-way edit distance up to 2 (enough to catch a typo such as "mesure" or "mesures"). */
function nearly(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] <= 2;
}

const cleanText = (value, limit) =>String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, limit);

function findColumn(dataset, name) {
  if (typeof name !== 'string') return null;
  const exact = dataset.columns.find((column) => column.name === name);
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  const matches = dataset.columns.filter((column) => column.name.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : null;
}

const DIMENSION_ROLES = new Set(['dimension', 'dimension_high']);

/**
 * Check a plan against the profiled datasets and return a normalised copy (canonical column names, defaults filled in).
 * Throws one Error that lists every problem found, so they can all be fixed in one go.
 */
export function normalizePlan(input, datasets) {
  const problems = [];
  const fail = (where, message) => problems.push(`${where}: ${message}`);
  // a field the plan does not know would otherwise be ignored in silence (a "filter" that filters nothing, a typo that falls back
  // to the default), and the page would show something other than what was asked for
  const checkKeys = (where, object, allowed) => {
    for (const key of Object.keys(object)) {
      if (allowed.includes(key)) continue;
      const shown = cleanText(key, 40);
      const close = allowed.find((name) => nearly(key.toLowerCase(), name));
      if (FILTER_WORDS.test(key)) fail(where, `unknown field "${shown}": rows are filtered with "filters", a list such as [{ "column": "region", "op": "=", "value": "North" }] (see docs/PLAN-FORMAT.md)`);
      else fail(where, `unknown field "${shown}"${close === undefined ? '' : ` (did you mean "${close}"?)`}; allowed here: ${allowed.join(', ')}`);
    }
  };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('the plan must be a JSON object');
  checkKeys('plan', input, ['version', 'title', 'filters', 'views', 'explorers']);
  if (input.version !== PLAN_VERSION) fail('version', `must be ${PLAN_VERSION}`);
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const plan = { version: PLAN_VERSION, title: cleanText(input.title, PLAN_LIMITS.titleLength) || 'Data overview', filters: [], views: [], explorers: [] };

  // filters of the whole page: each names its dataset and applies to every chart, explorer and key number of that dataset
  if (input.filters !== undefined && input.filters !== null) {
    if (!Array.isArray(input.filters)) fail('filters', 'must be a list of filters, each with a "dataset"');
    else {
      if (input.filters.length > PLAN_LIMITS.pageFilters) fail('filters', `at most ${PLAN_LIMITS.pageFilters} filters`);
      input.filters.slice(0, PLAN_LIMITS.pageFilters).forEach((raw, index) => {
        const where = `filters[${index}]`;
        const target = raw !== null && typeof raw === 'object' ? byId.get(raw.dataset) : undefined;
        if (target === undefined) return fail(where, `"dataset" must name a dataset (have: ${[...byId.keys()].join(', ')})`);
        const filter = normalizeFilter(where, raw, target, fail, findColumn, { withDataset: true });
        if (filter !== undefined) plan.filters.push(filter);
      });
    }
  }

  // `numeric`: a whole-number column with few values (a rating, a quantity) is listed as a category, but may be summed or averaged
  const columnRef = (where, dataset, name, roles, label, { numeric = false } = {}) => {
    const column = findColumn(dataset, name);
    if (column === null) {
      fail(where, `${label} "${String(name).slice(0, 60)}" is not a column of ${dataset.id} (${dataset.columns.map((c) => c.name).slice(0, 12).join(', ')}${dataset.columns.length > 12 ? ', ...' : ''})`);
      return null;
    }
    if (!roles.has(column.role) && !(numeric && column.numeric === true && column.role === 'dimension')) {
      fail(where, `${label} "${column.name}" is a ${column.role} column; allowed: ${[...roles].join(', ')}`);
      return null;
    }
    return column.name;
  };
  const measureRef = (where, dataset, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(where, 'measure must be { "column": ..., "agg": ... } (or { "agg": "count" } for the number of rows)');
      return null;
    }
    checkKeys(where, value, ['column', 'agg']);
    const agg = value.agg ?? (value.column === undefined ? 'count' : 'sum');
    if (!AGGS.includes(agg)) {
      fail(where, `agg must be one of ${AGGS.join(', ')}`);
      return null;
    }
    if (agg === 'count' && (value.column === undefined || value.column === null || value.column === '*')) return { agg };
    const roles = agg === 'count' || agg === 'count_distinct' ? new Set(['measure', 'dimension', 'dimension_high', 'temporal', 'id', 'text']) : new Set(['measure']);
    const column = columnRef(where, dataset, value.column, roles, 'measure column', { numeric: true });
    return column === null ? null : { column, agg };
  };

  const views = Array.isArray(input.views) ? input.views : (fail('views', 'must be a list'), []);
  if (views.length > PLAN_LIMITS.views) fail('views', `at most ${PLAN_LIMITS.views} views`);
  const usedIds = new Set();
  views.slice(0, PLAN_LIMITS.views).forEach((raw, index) => {
    const where = `views[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(where, 'must be an object');
    if (!KINDS.includes(raw.kind)) return fail(where, `kind must be one of ${KINDS.join(', ')}`);
    checkKeys(where, raw, [...COMMON_VIEW_KEYS, ...VIEW_KEYS[raw.kind]]);
    const dataset = byId.get(raw.dataset);
    if (dataset === undefined) return fail(where, `unknown dataset "${String(raw.dataset).slice(0, 40)}" (have: ${[...byId.keys()].join(', ')})`);
    const view = { id: '', kind: raw.kind, dataset: dataset.id, title: cleanText(raw.title, PLAN_LIMITS.titleLength), note: cleanText(raw.note, PLAN_LIMITS.noteLength), filters: normalizeFilters(`${where}.filters`, raw.filters, dataset, fail, findColumn) };
    let id = typeof raw.id === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(raw.id) ? raw.id : `v${index + 1}`;
    while (usedIds.has(id)) id = `${id}x`;
    usedIds.add(id);
    view.id = id;

    if (raw.kind === 'line') {
      view.x = columnRef(where, dataset, raw.x, new Set(['temporal']), 'x');
      view.measure = measureRef(`${where}.measure`, dataset, raw.measure ?? { agg: 'count' });
      if (raw.split !== undefined && raw.split !== null) view.split = columnRef(where, dataset, raw.split, new Set(['dimension']), 'split');
      const column = view.x === null ? null : findColumn(dataset, view.x);
      view.grain = raw.grain ?? column?.grain ?? 'day';
      if (!GRAINS.includes(view.grain)) fail(where, `grain must be one of ${GRAINS.join(', ')}`);
    } else if (raw.kind === 'bar') {
      view.x = columnRef(where, dataset, raw.x, DIMENSION_ROLES, 'x');
      view.measure = measureRef(`${where}.measure`, dataset, raw.measure ?? { agg: 'count' });
      if (raw.split !== undefined && raw.split !== null) view.split = columnRef(where, dataset, raw.split, new Set(['dimension']), 'split');
      view.limit = clampInt(raw.limit, 15, 3, PLAN_LIMITS.topN);
    } else if (raw.kind === 'hist') {
      view.column = columnRef(where, dataset, raw.column, new Set(['measure']), 'column', { numeric: true });
      view.bins = clampInt(raw.bins, 30, 5, PLAN_LIMITS.bins);
    } else if (raw.kind === 'scatter') {
      view.x = columnRef(where, dataset, raw.x, new Set(['measure']), 'x', { numeric: true });
      view.y = columnRef(where, dataset, raw.y, new Set(['measure']), 'y', { numeric: true });
      if (raw.color !== undefined && raw.color !== null) view.color = columnRef(where, dataset, raw.color, new Set(['dimension']), 'color');
    } else if (raw.kind === 'heatmap') {
      view.x = columnRef(where, dataset, raw.x, DIMENSION_ROLES, 'x');
      view.y = columnRef(where, dataset, raw.y, DIMENSION_ROLES, 'y');
      view.measure = measureRef(`${where}.measure`, dataset, raw.measure ?? { agg: 'count' });
      view.limit = clampInt(raw.limit, 12, 3, 20);
    } else if (raw.kind === 'corr') {
      const names = Array.isArray(raw.columns) ? raw.columns : [];
      view.columns = names.map((name) => columnRef(where, dataset, name, new Set(['measure']), 'column', { numeric: true })).filter((name) => name !== null);
      if (new Set(view.columns).size < 3 || view.columns.length > 8) fail(where, 'columns needs 3 to 8 different numeric columns');
    }
    plan.views.push(view);
  });

  const explorers = input.explorers === undefined ? [] : input.explorers;
  if (!Array.isArray(explorers)) fail('explorers', 'must be a list');
  else {
    if (explorers.length > PLAN_LIMITS.explorers) fail('explorers', `at most ${PLAN_LIMITS.explorers}`);
    explorers.slice(0, PLAN_LIMITS.explorers).forEach((raw, index) => {
      const where = `explorers[${index}]`;
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) checkKeys(where, raw, ['dataset', 'dimensions', 'measures', 'filters']);
      const dataset = byId.get(raw?.dataset);
      if (dataset === undefined) return fail(where, `unknown dataset "${String(raw?.dataset).slice(0, 40)}"`);
      const dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : []).map((name) => columnRef(where, dataset, name, new Set(['dimension', 'temporal']), 'dimension')).filter((name) => name !== null);
      const measures = (Array.isArray(raw.measures) ? raw.measures : []).map((measure) => measureRef(`${where}.measures`, dataset, measure)).filter((measure) => measure !== null);
      if (dimensions.length === 0) fail(where, 'needs at least one dimension');
      if (dimensions.length > PLAN_LIMITS.explorerDimensions) fail(where, `at most ${PLAN_LIMITS.explorerDimensions} dimensions`);
      if (measures.length > PLAN_LIMITS.explorerMeasures) fail(where, `at most ${PLAN_LIMITS.explorerMeasures} measures`);
      if (new Set(dimensions).size !== dimensions.length) fail(where, 'dimensions must be different');
      plan.explorers.push({ dataset: dataset.id, dimensions, measures, filters: normalizeFilters(`${where}.filters`, raw.filters, dataset, fail, findColumn) });
    });
  }
  if (problems.length > 0) throw new Error(`the plan has problems:\n- ${problems.slice(0, 25).join('\n- ')}${problems.length > 25 ? `\n- ... and ${problems.length - 25} more` : ''}`);
  return plan;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/** A readable title for a view that has none. */
export function titleOfView(view) {
  if (view.title) return view.title;
  if (view.kind === 'line') return `${measureLabel(view.measure)} per ${view.grain}${view.split ? `, by ${view.split}` : ''}`;
  if (view.kind === 'bar') return `${measureLabel(view.measure)} by ${view.x}${view.split ? ` and ${view.split}` : ''}`;
  if (view.kind === 'hist') return `Distribution of ${view.column}`;
  if (view.kind === 'scatter') return `${view.y} vs ${view.x}${view.color ? `, by ${view.color}` : ''}`;
  if (view.kind === 'heatmap') return `${measureLabel(view.measure)} by ${view.x} and ${view.y}`;
  return 'Correlations between numeric columns';
}
