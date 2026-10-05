// Turns a profile and a plan into the finished folder: index.html, assets/ (the page code and the chart library), data/ (small
// aggregated tables as .js files, so the page opens straight from disk), plan.json and a short README.
// Nothing is ever overwritten: the run folder is created fresh and every file is written with the exclusive flag.

import fs from 'node:fs';
import path from 'node:path';
import { ident, queryAll } from './duck.mjs';
import { preludeOf } from './profile.mjs';
import { aggSql, finishView, fmtNumber, fromOf, viewSql } from './charts.mjs';
import { describeFilter, sourceSql } from './filters.mjs';
import { cubeDefinition, cubeGroups, cubeSql, finishCube } from './cube.mjs';
import { measureLabel, titleOfView } from './plan.mjs';

export const SITE_FILES = [
  ['viewer/index.html', 'index.html'],
  ['viewer/viewer.css', 'assets/viewer.css'],
  ['viewer/viewer.js', 'assets/viewer.js'],
  ['viewer/charts.js', 'assets/charts.js'],
];

const pad = (n) => String(n).padStart(2, '0');

export function runStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Create a new, empty run folder inside `parent` (made if missing); an existing name is never reused. */
export function createRunDirectory(parent, stamp = runStamp()) {
  fs.mkdirSync(parent, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const directory = path.join(parent, attempt === 0 ? `run-${stamp}` : `run-${stamp}-${attempt + 1}`);
    try {
      fs.mkdirSync(directory);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('cannot create a new run folder');
}

function writeNew(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { flag: 'wx' });
}

const jsData = (id, value) => `(window.LDV_DATA = window.LDV_DATA || {})[${JSON.stringify(id)}] = ${JSON.stringify(value)};\n`;

function describeColumn(column) {
  return { name: column.name, type: column.type, role: column.role, nullPct: Math.round(column.nullPct * 10) / 10, unique: column.unique, min: column.min ?? null, max: column.max ?? null, mean: column.mean ?? null, top: column.top ?? [] };
}

function dateRange(dataset) {
  const time = dataset.columns.filter((column) => column.role === 'temporal').sort((a, b) => (b.unique ?? 0) - (a.unique ?? 0))[0];
  return time === undefined ? null : { column: time.name, from: String(time.min).slice(0, 10), to: String(time.max).slice(0, 10) };
}

const columnNamed = (dataset, name) => dataset.columns.find((column) => column.name === name) ?? null;

/** A copy of the dataset that reads only the rows the filters keep (the dataset itself when there are none). */
function filteredDataset(dataset, filters) {
  if (filters.length === 0) return dataset;
  return { ...dataset, from: sourceSql(dataset, filters, columnNamed), filtered: true };
}

const toNumber = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * Under filters the numbers the profile holds (range, average, first and last date of a column) describe all the rows, not the kept
 * ones. A histogram and the first-to-last sentence of a line chart need the kept rows' own numbers, so they are asked for here.
 */
async function withKeptRowStats(bin, prelude, view, dataset) {
  if (!dataset.filtered) return dataset;
  const replace = (name, changes) => ({ ...dataset, columns: dataset.columns.map((column) => (column.name === name ? { ...column, ...changes } : column)) });
  if (view.kind === 'hist') {
    const x = `CAST(${ident(view.column)} AS DOUBLE)`;
    const [[row]] = await queryAll(bin, prelude, [`SELECT min(${x}) AS lo, max(${x}) AS hi, avg(${x}) AS mean, median(${x}) AS med FROM ${fromOf(dataset)} WHERE isfinite(${x})`]);
    return replace(view.column, { min: toNumber(row.lo), max: toNumber(row.hi), mean: toNumber(row.mean), median: toNumber(row.med) });
  }
  if (view.kind === 'line') {
    const x = `CAST(${ident(view.x)} AS TIMESTAMP)`;
    const [[row]] = await queryAll(bin, prelude, [`SELECT min(${x}) AS lo, max(${x}) AS hi FROM ${fromOf(dataset)}`]);
    return replace(view.x, { min: row.lo === null ? null : String(row.lo), max: row.hi === null ? null : String(row.hi) });
  }
  return dataset;
}

/**
 * Build the site. `log(message)` reports progress. Returns { outDir, indexFile, views, explorers, skipped }.
 * `skipped` lists views whose query failed (the rest of the site is still built).
 */
export async function buildSite({ bin, pluginRoot, datasets, plan, scan, skippedFiles, parentDir, notes = [], log = () => {} }) {
  const outDir = createRunDirectory(parentDir);
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const prelude = preludeOf(datasets);
  const manifest = { title: plan.title, generator: 'local-data-viz', datasets: [], views: [], inventory: null };
  const failed = [];
  const notices = [];
  const pageFilters = (id) => (plan.filters ?? []).filter((filter) => filter.dataset === id);

  for (const [from, to] of SITE_FILES) writeNew(path.join(outDir, to), fs.readFileSync(path.join(pluginRoot, from)));

  const usedDatasets = datasets.filter((dataset) => dataset.rows > 0);
  for (const dataset of usedDatasets) {
    const measures = dataset.columns.filter((column) => column.role === 'measure').sort((a, b) => b.interest - a.interest).slice(0, 4);
    const kpis = [];
    const kept = filteredDataset(dataset, pageFilters(dataset.id));
    let keptRows = null;
    if (kept.filtered) {
      try {
        const [[row]] = await queryAll(bin, prelude, [`SELECT count(*) AS n FROM ${fromOf(kept)}`]);
        keptRows = Number(row.n);
        if (keptRows === 0) notices.push(`the filters on ${dataset.id} (${dataset.name}) leave no rows`);
      } catch (error) {
        log(`could not count the rows kept by the filters of ${dataset.name}: ${String(error.message).slice(0, 160)}`);
      }
    }
    if (measures.length > 0 && keptRows !== 0) {
      try {
        const [[row]] = await queryAll(bin, prelude, [`SELECT ${measures.map((column, i) => `${aggSql({ column: column.name, agg: column.agg })} AS m${i}`).join(', ')} FROM ${fromOf(kept)}`]);
        measures.forEach((column, i) => kpis.push({ label: measureLabel({ column: column.name, agg: column.agg }), value: fmtNumber(Number(row[`m${i}`])) }));
      } catch (error) {
        log(`skipped the key numbers of ${dataset.name}: ${String(error.message).slice(0, 160)}`);
      }
    }
    manifest.datasets.push({
      id: dataset.id,
      name: dataset.name,
      rows: dataset.rows,
      files: dataset.files,
      columns: dataset.columns.map(describeColumn),
      quality: dataset.quality,
      kpis,
      filters: pageFilters(dataset.id).map(describeFilter),
      keptRows,
      explorerFilters: [],
      dateRange: dateRange(dataset),
      correlations: dataset.correlations.slice(0, 5),
      explorer: false,
    });
  }

  let done = 0;
  for (const view of plan.views) {
    const dataset = byId.get(view.dataset);
    done += 1;
    log(`chart ${done}/${plan.views.length}: ${titleOfView(view)}`);
    try {
      const filters = [...pageFilters(view.dataset), ...(view.filters ?? [])];
      const source = await withKeptRowStats(bin, prelude, view, filteredDataset(dataset, filters));
      const sql = viewSql(view, source);
      if (sql === null) throw new Error(source.filtered ? 'no rows with a value are left after the filters' : 'the column has no numeric range');
      const [rows] = await queryAll(bin, prelude, [sql]);
      const finished = finishView(view, source, rows);
      writeNew(path.join(outDir, 'data', `${view.id}.js`), jsData(view.id, finished.rows));
      manifest.views.push({ id: view.id, kind: view.kind, dataset: view.dataset, title: titleOfView(view), note: view.note, filters: filters.map(describeFilter), insight: finished.insight, spec: finished.spec, rows: finished.rows.length, truncated: finished.truncated });
    } catch (error) {
      failed.push({ view: view.id, title: titleOfView(view), reason: String(error.message).replace(/^duckdb failed: /, '').slice(0, 300) });
      log(`  skipped ${view.id}: ${failed[failed.length - 1].reason}`);
    }
  }

  let explorers = 0;
  for (const explorer of plan.explorers) {
    const dataset = byId.get(explorer.dataset);
    log(`explorer for ${dataset.name}`);
    try {
      const definition = cubeDefinition(explorer, dataset);
      const groups = cubeGroups(definition);
      const filters = [...pageFilters(explorer.dataset), ...(explorer.filters ?? [])];
      const source = filteredDataset(dataset, filters);
      const results = await queryAll(bin, prelude, groups.map((indexes) => cubeSql(definition, source, indexes)));
      const cube = finishCube(definition, groups, results);
      writeNew(path.join(outDir, 'data', `cube-${explorer.dataset}.js`), jsData(`cube-${explorer.dataset}`, cube));
      const entry = manifest.datasets.find((item) => item.id === explorer.dataset);
      entry.explorer = true;
      entry.explorerFilters = filters.map(describeFilter);
      explorers += 1;
    } catch (error) {
      failed.push({ view: `explorer ${explorer.dataset}`, title: `Explorer for ${dataset.name}`, reason: String(error.message).replace(/^duckdb failed: /, '').slice(0, 300) });
      log(`  skipped the explorer: ${failed[failed.length - 1].reason}`);
    }
  }

  manifest.inventory = {
    folderName: path.basename(scan.root),
    files: scan.files.map((file) => ({ path: file.rel, kind: file.kind, bytes: file.size })),
    skipped: [...skippedFiles, ...scan.skipped].slice(0, 60),
    ignoredByType: scan.ignoredByType,
    notes: [...notes, ...(scan.truncated ? [`Only the first ${scan.files.length} files were read.`] : []), ...(scan.hitDepth ? ['Folders nested deeper than 8 levels were not read.'] : [])],
    failed,
  };
  writeNew(path.join(outDir, 'data', 'manifest.js'), `window.LDV_MANIFEST = ${JSON.stringify(manifest)};\n`);
  writeNew(path.join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeNew(
    path.join(outDir, 'README.txt'),
    [
      `${plan.title}`,
      '',
      'Open index.html in a web browser (double-click it). Nothing else is needed and nothing is sent anywhere.',
      '',
      'index.html     the page: menu on the left, charts on the right',
      'assets/        the page code (it draws the charts itself; no library)',
      'data/          the numbers behind each chart, already summed up; no raw rows',
      'plan.json      the list of charts; edit it and build again to change them',
      '',
      'The page shows the names of the files and columns of the folder it was made from. Check that before sharing it.',
      'Made by the local-data-viz plugin.',
      '',
    ].join('\n'),
  );
  return { outDir, indexFile: path.join(outDir, 'index.html'), views: manifest.views.length, explorers, failed, notices };
}
