// The explorer's data: a small pre-aggregated "cube". For up to five dimensions and a few measures DuckDB computes every
// grouping of one dimension and every grouping of two, plus the grand total, once, at build time. The page then slices and
// charts these tables instantly, with no data engine in the browser and no raw rows in the output.

import { aggSql, bucketSql, dimSql, fromOf } from './charts.mjs';
import { measureLabel } from './plan.mjs';

export const CUBE_LIMITS = Object.freeze({ groupRows: 5000 });

/** { dims, measures } for an explorer entry of the plan, with the labels the page shows. */
export function cubeDefinition(explorer, dataset) {
  const dims = explorer.dimensions.map((name) => {
    const column = dataset.columns.find((candidate) => candidate.name === name);
    return column.role === 'temporal' ? { column: name, label: name, kind: 'time', grain: column.grain } : { column: name, label: name, kind: 'category' };
  });
  const measures = [{ agg: 'count', label: 'Rows' }];
  const seen = new Set(['count|']);
  for (const measure of explorer.measures) {
    const key = `${measure.agg}|${measure.column ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    measures.push({ ...measure, label: measureLabel(measure) });
  }
  return { dims, measures };
}

const dimExpr = (dim) => (dim.kind === 'time' ? `coalesce(${bucketSql(dim.column, dim.grain)}, '(empty)')` : dimSql(dim.column));

/** Every grouping to compute: [] (the total), each single dimension, each pair. */
export function cubeGroups(definition) {
  const count = definition.dims.length;
  const groups = [[]];
  for (let i = 0; i < count; i += 1) groups.push([i]);
  for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) groups.push([i, j]);
  return groups;
}

export function cubeSql(definition, dataset, indexes) {
  const keys = indexes.map((index, n) => `${dimExpr(definition.dims[index])} AS k${n}`);
  const values = definition.measures.map((measure, j) => `${aggSql(measure)} AS m${j}`);
  const from = fromOf(dataset);
  if (indexes.length === 0) return `SELECT ${values.join(', ')} FROM ${from}`;
  const positions = indexes.map((_, n) => n + 1).join(', ');
  return `SELECT ${[...keys, ...values].join(', ')} FROM ${from} GROUP BY ${positions} ORDER BY ${positions} LIMIT ${CUBE_LIMITS.groupRows + 1}`;
}

const finite = (value) => {
  const number = typeof value === 'number' ? value : Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : number;
};

/** The data object the page loads: groups keyed "", "0", "0,2" ... with rows [key..., measure...]; too-big groups are listed as unavailable. */
export function finishCube(definition, groups, results) {
  const out = { dims: definition.dims.map((dim) => ({ label: dim.label, kind: dim.kind, ...(dim.grain ? { grain: dim.grain } : {}) })), measures: definition.measures.map((measure) => ({ label: measure.label, agg: measure.agg })), groups: {}, unavailable: [] };
  groups.forEach((indexes, n) => {
    const key = indexes.join(',');
    const rows = results[n];
    if (rows.length > CUBE_LIMITS.groupRows) {
      out.unavailable.push(key);
      return;
    }
    out.groups[key] = rows.map((row) => [...indexes.map((_, k) => String(row[`k${k}`])), ...definition.measures.map((_, j) => finite(row[`m${j}`]))]);
  });
  return out;
}
