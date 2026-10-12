// The first draft of the plan, from rules only (no guessing): time columns get line charts, categories get bars, numbers get
// histograms, strongly related numbers get scatter plots. Claude then reads the profile, edits this plan and builds.

import { PLAN_VERSION } from './plan.mjs';

const MAX_VIEWS_PER_DATASET = 10;
const MAX_DATASETS = 12;

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// of two time columns (start and end, created and closed) the one that says when it began is the better axis
const LATE_TIME = /(^|[_\s.-])(end|ended|finish|finished|stop|stopped|close|closed|return|returned|update|updated|modified|expire|expires|expiry|due|delivered|completed)([_\s.-]|$)/i;
const lateTime = (column) => (LATE_TIME.test(column.name) ? 1 : 0);

/** Prefer categories with a few values: 3 to 8 read best on a chart. */
const dimensionRank = (column) => Math.abs((column.unique ?? 0) - 6);

export function recommendDataset(dataset) {
  const views = [];
  const columns = dataset.columns;
  const temporal = columns.filter((column) => column.role === 'temporal').sort((a, b) => lateTime(a) - lateTime(b) || (b.unique ?? 0) - (a.unique ?? 0) || byName(a, b));
  const measures = columns.filter((column) => column.role === 'measure').sort((a, b) => b.interest - a.interest || byName(a, b));
  // a category with (nearly) as many values as rows is a label of single rows: averaging or stacking it says nothing
  const groupable = (column) => (column.unique ?? 0) <= Math.max(2, dataset.rows * 0.5) && (column.unique ?? 0) < dataset.rows;
  const dimensions = columns.filter((column) => column.role === 'dimension' && groupable(column)).sort((a, b) => dimensionRank(a) - dimensionRank(b) || byName(a, b));
  const high = columns.filter((column) => column.role === 'dimension_high' && groupable(column)).sort((a, b) => (a.unique ?? 0) - (b.unique ?? 0) || byName(a, b));
  const primary = measures.find((column) => column.agg === 'sum') ?? measures[0];
  const primaryMeasure = primary === undefined ? { agg: 'count' } : { column: primary.name, agg: primary.agg };
  const add = (view) => {
    if (views.length < MAX_VIEWS_PER_DATASET) views.push({ dataset: dataset.id, ...view });
  };

  const time = temporal[0];
  if (time !== undefined) {
    // events with a time of day (trips, requests) and nothing to add up: how many per period is the first thing to see
    if (measures.length === 0 || (/^TIMESTAMP/i.test(time.type) && !measures.some((column) => column.agg === 'sum'))) add({ kind: 'line', x: time.name, grain: time.grain, measure: { agg: 'count' } });
    for (const measure of measures.slice(0, 2)) add({ kind: 'line', x: time.name, grain: time.grain, measure: { column: measure.name, agg: measure.agg } });
    const split = dimensions.find((column) => column.unique <= 8);
    if (split !== undefined) add({ kind: 'line', x: time.name, grain: time.grain, measure: primaryMeasure, split: split.name });
  }
  for (const dimension of dimensions.slice(0, 3)) add({ kind: 'bar', x: dimension.name, measure: primaryMeasure });
  if (high[0] !== undefined) add({ kind: 'bar', x: high[0].name, measure: primaryMeasure, limit: 15 });

  const strong = dataset.correlations.filter((pair) => Math.abs(pair.r) >= 0.3).slice(0, 2);
  const colour = dimensions.find((column) => column.unique <= 6);
  for (const pair of strong) add({ kind: 'scatter', x: pair.a, y: pair.b, ...(colour ? { color: colour.name } : {}) });

  const [first, second] = dimensions;
  if (first !== undefined && second !== undefined && first.unique * second.unique <= 400) add({ kind: 'heatmap', x: first.name, y: second.name, measure: primaryMeasure });
  if (measures.length >= 3) add({ kind: 'corr', columns: measures.slice(0, 8).map((column) => column.name) });
  // a histogram of a handful of values says nothing
  if (dataset.rows >= 20) for (const measure of measures.filter((column) => (column.unique ?? 0) > 2).slice(0, 3)) add({ kind: 'hist', column: measure.name });

  const exploreDimensions = [...temporal.slice(0, 1), ...dimensions.slice(0, 4)].slice(0, 5);
  const explorer =
    exploreDimensions.length === 0
      ? null
      : { dataset: dataset.id, dimensions: exploreDimensions.map((column) => column.name), measures: measures.slice(0, 3).map((column) => ({ column: column.name, agg: column.agg })) };
  return { views, explorer };
}

/** A complete plan for every dataset in the profile. */
export function recommendPlan(datasets, { title = 'Data overview' } = {}) {
  const views = [];
  const explorers = [];
  for (const dataset of datasets.slice(0, MAX_DATASETS)) {
    if (dataset.rows === 0) continue;
    const draft = recommendDataset(dataset);
    views.push(...draft.views);
    if (draft.explorer !== null) explorers.push(draft.explorer);
  }
  return { version: PLAN_VERSION, title, views: views.map((view, index) => ({ id: `v${index + 1}`, ...view })), explorers };
}
