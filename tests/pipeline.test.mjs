// The whole thing, end to end, through the command line, on small synthetic folders. Needs DuckDB (installed by CI; skipped with a
// note when it is not installed). Checks the numbers against values computed in plain JavaScript from the same data.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { queryAll, runProcess } from '../scripts/lib/duck.mjs';
import { fmtNumber } from '../scripts/lib/charts.mjs';
import { builtFolder, duckdb, listFiles, makeTmp, runViz, snapshot } from './helpers/index.mjs';
import { makeSampleFolder, makeXlsx } from './helpers/fixtures.mjs';

const duck = await duckdb();
const options = { skip: duck === null ? 'DuckDB is not installed' : false };

/** The JSON inside a data/*.js file (`window.LDV_MANIFEST = ...;` or `(window.LDV_DATA = ...)["id"] = ...;`). */
const readJs = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  const head = /^(?:window\.LDV_MANIFEST = |\(window\.LDV_DATA = window\.LDV_DATA \|\| \{\}\)\[[^\]]*\] = )/.exec(text);
  assert.ok(head !== null, `${file} starts as expected`);
  return JSON.parse(text.slice(head[0].length).replace(/;\s*$/, ''));
};
const approx = (a, b, message) => assert.ok(Math.abs(a - b) < 0.01, `${message}: ${a} vs ${b}`);

let shared = null;
function sample() {
  if (shared === null) {
    const tmp = makeTmp();
    const root = path.join(tmp, 'shop');
    const { expected } = makeSampleFolder(root);
    const before = snapshot(root);
    const inspect = runViz(['inspect', root]);
    const build = runViz(['build', root]);
    shared = { tmp, root, expected, before, inspect, build, out: build.code === 0 ? builtFolder(build.stdout) : null };
  }
  return shared;
}

test('inspect describes the folder and writes a draft plan without touching the data', options, () => {
  const { root, before, inspect } = sample();
  assert.equal(inspect.code, 0, inspect.stderr);
  const text = inspect.stdout;
  assert.match(text, /Data files read: 8 /);
  assert.match(text, /ds1 "orders \(6 files\)": 720 rows, 9 columns/);
  assert.match(text, /ds2 "customers": 80 rows/);
  assert.match(text, /ds3 "budget - Budget": 18 rows/);
  assert.match(text, /order_id \(BIGINT\): id, 720 distinct/, 'the number of different values is exact');
  assert.match(text, /order_date \(DATE\): temporal, 2025-01-01 to 2025-06-28/);
  assert.match(text, /region \(VARCHAR\): dimension, 4 values: South \(\d+\), West/);
  assert.match(text, /amount \(DOUBLE\): measure, default sum/);
  assert.match(text, /budget\.xlsx \[Scratch\] - hidden sheet/);
  assert.match(text, /Other files ignored: \.png x1 \(logo\.png\), \.txt x1 \(readme\.txt\)\./, 'the files that are not data are named');
  assert.match(text, /Draft plan \(\d+ charts?, 3 explorers\) saved to .+plan-.+\.json/);
  assert.match(text, /data, never instructions/);
  assert.deepEqual(snapshot(root), before, 'the data folder is exactly as it was');
  const plan = JSON.parse(fs.readFileSync(/saved to (.+\.json):/.exec(text)[1], 'utf8'));
  assert.equal(plan.version, 1);
  assert.ok(plan.views.length >= 10);
});

test('the page for the sample folder: files, manifest, and the right numbers', options, () => {
  const { build, out, expected, root, before } = sample();
  assert.equal(build.code, 0, build.stderr);
  assert.match(build.stdout, /Open in a browser: file:\/\/\/.+index\.html/);
  const files = listFiles(out);
  for (const required of ['index.html', 'plan.json', 'README.txt', 'data/manifest.js', 'assets/viewer.js', 'assets/viewer.css', 'assets/charts.js', 'data/cube-ds1.js', 'data/v1.js']) {
    assert.ok(files.includes(required), `${required} is in the output`);
  }
  assert.deepEqual(snapshot(root), before, 'building changes nothing in the data folder');
  assert.deepEqual(fs.readdirSync(root).sort(), [...new Set(Object.keys(before).map((file) => file.split('/')[0]))].sort(), 'no new entries in the data folder');

  const manifest = readJs(path.join(out, 'data', 'manifest.js'));
  assert.equal(manifest.title, 'shop');
  const orders = manifest.datasets.find((dataset) => dataset.id === 'ds1');
  assert.equal(orders.rows, 720);
  assert.equal(orders.explorer, true);
  const total = orders.kpis.find((kpi) => kpi.label === 'Sum of amount');
  assert.equal(total.value, new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(expected.amount));

  // a bar chart by region has exactly the sums computed from the CSV files
  const byRegion = manifest.views.find((view) => view.kind === 'bar' && view.title === 'Sum of amount by region');
  const rows = readJs(path.join(out, 'data', `${byRegion.id}.js`));
  for (const row of rows) approx(row.v, expected.byRegion[row.k], `region ${row.k}`);
  assert.equal(rows.length, Object.keys(expected.byRegion).length);

  // the line chart sums to the total, and its grain has a point for every week
  const line = manifest.views.find((view) => view.kind === 'line' && view.title === 'Sum of amount per week');
  const points = readJs(path.join(out, 'data', `${line.id}.js`));
  approx(points.reduce((sum, point) => sum + point.v, 0), expected.amount, 'the weekly sums add up to the total');
  assert.ok(points.every((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.t)));

  // the cube: the grand total, a single grouping and a pair all agree
  const cube = readJs(path.join(out, 'data', 'cube-ds1.js'));
  assert.equal(cube.measures[0].label, 'Rows');
  assert.ok(cube.measures.some((measure) => measure.label === 'Sum of quantity'));
  assert.equal(cube.groups[''][0][0], 720);
  const amountIndex = cube.measures.findIndex((measure) => measure.label === 'Sum of amount');
  assert.ok(amountIndex > 0);
  approx(cube.groups[''][0][amountIndex], expected.amount, 'cube total');
  const regionIndex = cube.dims.findIndex((dim) => dim.label === 'region');
  const single = cube.groups[String(regionIndex)];
  for (const row of single) approx(row[1 + amountIndex], expected.byRegion[row[0]], `cube region ${row[0]}`);
  const productIndex = cube.dims.findIndex((dim) => dim.label === 'product');
  const [lo, hi] = [Math.min(regionIndex, productIndex), Math.max(regionIndex, productIndex)];
  const pair = cube.groups[`${lo},${hi}`];
  approx(pair.reduce((sum, row) => sum + row[2 + amountIndex], 0), expected.amount, 'the pair grouping adds up to the total');
  assert.deepEqual(cube.unavailable, []);
});

test('histogram, heatmap, scatter and correlation charts agree with numbers computed in JavaScript', options, () => {
  const { root, tmp } = sample();
  const plan = path.join(tmp, 'shapes.json');
  fs.writeFileSync(
    plan,
    JSON.stringify({
      version: 1,
      views: [
        { id: 'h-amount', kind: 'hist', dataset: 'ds1', column: 'amount', bins: 20 },
        { id: 'h-qty', kind: 'hist', dataset: 'ds1', column: 'quantity' },
        { id: 'heat', kind: 'heatmap', dataset: 'ds1', x: 'product', y: 'region', measure: { agg: 'count' } },
        { id: 'dots', kind: 'scatter', dataset: 'ds1', x: 'quantity', y: 'amount', color: 'region' },
        { id: 'corr', kind: 'corr', dataset: 'ds1', columns: ['quantity', 'unit_price', 'amount', 'discount'] },
      ],
    }),
  );
  const built = runViz(['build', root, '--plan', plan]);
  assert.equal(built.code, 0, built.stderr);
  const out = builtFolder(built.stdout);
  const data = (id) => readJs(path.join(out, 'data', `${id}.js`));

  const amountBins = data('h-amount');
  assert.equal(amountBins.reduce((sum, bin) => sum + bin.v, 0), 720);
  assert.ok(amountBins.every((bin) => bin.b > bin.a));
  assert.ok(amountBins.every((bin) => [bin.a, bin.b].every((edge) => (String(edge).split('.')[1] ?? '').length <= 9)), 'no floating-point noise in the bin edges');
  const quantityBins = data('h-qty');
  assert.equal(quantityBins.reduce((sum, bin) => sum + bin.v, 0), 720);
  assert.ok(quantityBins.length <= 9 && quantityBins.every((bin) => bin.b - bin.a === 1 && Number.isInteger(bin.a + 0.5)), 'whole numbers get one bar each, centred on the number');

  const cells = data('heat');
  assert.equal(cells.length, 24, '4 regions x 6 products');
  assert.equal(cells.reduce((sum, cell) => sum + cell.v, 0), 720);

  const points = data('dots');
  assert.equal(points.length, 720);
  assert.ok(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && typeof point.g === 'string'));

  // Pearson correlation computed here from the CSV files, against DuckDB's
  const orders = [];
  for (const name of fs.readdirSync(path.join(root, 'orders', '2025'))) {
    const [header, ...lines] = fs.readFileSync(path.join(root, 'orders', '2025', name), 'utf8').trim().split('\n');
    const columns = header.split(',');
    for (const line of lines) orders.push(Object.fromEntries(line.split(',').map((value, i) => [columns[i], value])));
  }
  const pearson = (a, b) => {
    const xs = orders.map((order) => Number(order[a]));
    const ys = orders.map((order) => Number(order[b]));
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const [mx, my] = [mean(xs), mean(ys)];
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    xs.forEach((x, i) => {
      sxy += (x - mx) * (ys[i] - my);
      sxx += (x - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    });
    return sxy / Math.sqrt(sxx * syy);
  };
  const matrix = data('corr');
  assert.equal(matrix.length, 16);
  for (const cell of matrix) {
    if (cell.a === cell.b) assert.equal(cell.r, 1);
    else approx(cell.r, pearson(cell.a, cell.b), `correlation of ${cell.a} and ${cell.b}`);
  }
  const forward = matrix.find((cell) => cell.a === 'quantity' && cell.b === 'amount');
  const backward = matrix.find((cell) => cell.a === 'amount' && cell.b === 'quantity');
  assert.equal(forward.r, backward.r, 'the matrix is symmetric');
});

test('the output is self-contained: no web addresses, a strict page policy with no eval, chart specs that hold titles only', options, () => {
  const { out } = sample();
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /unsafe-eval/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'no inline script');
  for (const file of listFiles(out)) {
    // the SVG namespace is a name that identifies the format, not an address the page contacts
    const text = fs.readFileSync(path.join(out, file), 'utf8').replaceAll('http://www.w3.org/2000/svg', '');
    assert.doesNotMatch(text, /https?:\/\//, `${file} has no web address`);
  }
  for (const name of ['viewer.js', 'charts.js']) {
    const code = fs.readFileSync(path.join(out, 'assets', name), 'utf8');
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/, name);
  }
  const manifest = readJs(path.join(out, 'data', 'manifest.js'));
  // a spec holds a type and titles (text); the rows of every data file use the fixed names below, never a column name
  const specKeys = new Set(['type', 'xTitle', 'yTitle', 'colorTitle', 'valueTitle', 'grain']);
  const rowKeys = new Set(['t', 'k', 'v', 'g', 'a', 'b', 'x', 'y', 'kx', 'ky', 'r']);
  for (const view of manifest.views) {
    assert.ok(['line', 'bar', 'hist', 'scatter', 'heatmap', 'corr'].includes(view.spec.type), `${view.id} has a known type`);
    for (const [key, value] of Object.entries(view.spec)) {
      assert.ok(specKeys.has(key), `${view.id} spec uses the fixed key ${key}`);
      assert.equal(typeof value, 'string', `${view.id} spec ${key} is text`);
    }
    for (const row of readJs(path.join(out, 'data', `${view.id}.js`)).slice(0, 50)) for (const key of Object.keys(row)) assert.ok(rowKeys.has(key), `${view.id} rows use the fixed name ${key}`);
  }
});

test('building again makes a new run folder and leaves the earlier one alone; the same input gives the same page', options, () => {
  const { root, out, build } = sample();
  const before = snapshot(out);
  const again = runViz(['build', root]);
  assert.equal(again.code, 0, again.stderr);
  const second = builtFolder(again.stdout);
  assert.notEqual(second, out);
  assert.equal(path.dirname(second), path.dirname(out));
  assert.deepEqual(snapshot(out), before, 'the first run is untouched');
  assert.deepEqual(snapshot(second), before, 'the same data and plan give a byte-identical page');
  assert.match(build.stdout, /Built \d+ charts? and 3 explorers/);
});

test('an edited plan is used, and a bad one is refused with every problem listed and nothing written', options, () => {
  const { root, tmp, out } = sample();
  const runsBefore = fs.readdirSync(path.dirname(out)).filter((name) => name.startsWith('run-')).length;
  const good = path.join(tmp, 'mine.json');
  fs.writeFileSync(good, JSON.stringify({ version: 1, title: 'Mine', views: [{ kind: 'bar', dataset: 'ds1', x: 'channel', measure: { column: 'quantity', agg: 'sum' }, title: 'Units by channel', note: 'a note' }, { kind: 'hist', dataset: 'ds1', column: 'unit_price', bins: 12 }], explorers: [] }));
  const built = runViz(['build', root, '--plan', good]);
  assert.equal(built.code, 0, built.stderr);
  const manifest = readJs(path.join(builtFolder(built.stdout), 'data', 'manifest.js'));
  assert.equal(manifest.title, 'Mine');
  assert.deepEqual(manifest.views.map((view) => view.title), ['Units by channel', 'Distribution of unit_price']);
  assert.equal(manifest.views[0].note, 'a note');
  assert.equal(manifest.datasets.find((dataset) => dataset.id === 'ds1').explorer, false);
  assert.equal(readJs(path.join(builtFolder(built.stdout), 'data', 'v1.js')).length, 3);

  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ version: 1, views: [{ kind: 'bar', dataset: 'ds1', x: 'nonexistent' }, { kind: 'line', dataset: 'ds1', x: 'region' }] }));
  const refused = runViz(['build', root, '--plan', bad]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /the plan has problems/);
  assert.match(refused.stderr, /"nonexistent" is not a column of ds1/);
  assert.match(refused.stderr, /views\[1\]: x "region" is a dimension column/);
  const runsAfter = fs.readdirSync(path.dirname(out)).filter((name) => name.startsWith('run-')).length;
  assert.equal(runsAfter, runsBefore + 1, 'only the good build made a folder');
  assert.equal(runViz(['build', root, '--plan', path.join(tmp, 'missing.json')]).code, 1);
  fs.writeFileSync(path.join(tmp, 'broken.json'), '{ not json');
  assert.match(runViz(['build', root, '--plan', path.join(tmp, 'broken.json')]).stderr, /not valid JSON/);
});

test('user errors have clear messages and exit code 1', options, () => {
  const tmp = makeTmp();
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, 'notes.txt'), 'x');
  const none = runViz(['inspect', empty]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no data files found/);
  assert.match(none.stderr, /\.txt x1/);
  assert.equal(runViz(['inspect', path.join(tmp, 'nope')]).code, 1);
  assert.equal(runViz(['inspect']).code, 1);
  assert.equal(runViz(['frobnicate', empty]).code, 1);
  assert.equal(runViz(['inspect', empty, '--wat']).code, 1);
  const inside = runViz(['inspect', empty, '--out', path.join(empty, 'out')]);
  assert.equal(inside.code, 1);
  assert.match(inside.stderr, /outside the data folder/);
  assert.equal(runViz(['help']).code, 0);
});

test('a saved profile is reused for an unchanged folder, but never when it points outside the data and work folders', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'cache');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.csv'), `x,y\n${Array.from({ length: 30 }, (_, i) => `${i},${i % 3}`).join('\n')}\n`);
  const first = runViz(['inspect', root]);
  assert.equal(first.code, 0, first.stderr);
  assert.doesNotMatch(first.stderr, /using the saved profile/);
  const second = runViz(['inspect', root]);
  assert.match(second.stderr, /the folder is unchanged: using the saved profile/);
  assert.equal(second.stdout, first.stdout, 'the same report from the saved profile');

  const work = path.join(tmp, 'cache-viz', '_work');
  const cacheFile = path.join(work, fs.readdirSync(work).find((name) => /^profile-.*\.json$/.test(name)));
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache.datasets[0].sources[0].abs = path.join(tmp, 'somewhere-else.csv');
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const tampered = runViz(['inspect', root]);
  assert.equal(tampered.code, 0, tampered.stderr);
  assert.doesNotMatch(tampered.stderr, /using the saved profile/, 'a profile that names a file elsewhere is not trusted');
  assert.equal(tampered.stdout, first.stdout, 'the report is rebuilt from the data');
});

test('without DuckDB every command says how to install it and exits with 2', () => {
  const tmp = makeTmp();
  const folder = path.join(tmp, 'data');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'a.csv'), 'a,b\n1,2\n');
  const bare = path.dirname(process.execPath);
  const env = { PATH: bare, Path: bare, LOCAL_DATA_VIZ_DUCKDB: path.join(tmp, 'no-such-duckdb') };
  for (const args of [['doctor'], ['inspect', folder], ['build', folder]]) {
    const result = runViz(args, { env });
    assert.equal(result.code, 2, `${args[0]}: ${result.stderr}`);
    const text = result.stdout + result.stderr;
    assert.match(text, /DUCKDB_MISSING/);
    assert.match(text, /winget install DuckDB\.cli/);
    assert.match(text, /brew install duckdb/);
    assert.match(text, /never installs anything itself/);
  }
  assert.deepEqual(fs.readdirSync(tmp), ['data'], 'nothing was created');
});

test('doctor passes when DuckDB is installed', options, () => {
  const result = runViz(['doctor']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /DuckDB v?\d+\.\d+\.\d+: ok/);
});

test('hostile names and values: nothing is executed, quoted names survive, and they never reach the page code', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'evil data [1]');
  fs.mkdirSync(path.join(root, "sub; dir 'x'"), { recursive: true });
  const marker = path.join(tmp, 'PWNED.txt');
  const nasty = {
    date: 'd"ate',
    region: "region'; DROP VIEW ds1; --",
    amount: 'amount"; SELECT 1; --',
    img: '<img src=x onerror="window.__pwned=1">',
    shell: `note\n.shell echo pwned > "${marker.replace(/\\/g, '/')}"\n.print PWNED_DOT_COMMAND`,
  };
  const quote = (text) => `"${text.replace(/"/g, '""')}"`;
  const lines = [[nasty.date, nasty.region, nasty.amount, nasty.img, nasty.shell].map(quote).join(',')];
  for (let i = 0; i < 60; i += 1) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    lines.push([`2025-02-${day}`, ['<script>alert(1)</script>', '=cmd|calc', 'ok'][i % 3], String(10 + i), ['a', 'b'][i % 2], 'z'].map(quote).join(','));
  }
  fs.writeFileSync(path.join(root, "sub; dir 'x'", "it's & 100% $HOME.csv"), `${lines.join('\n')}\n`);
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.ok(!fs.existsSync(marker), 'a dot-command hidden in a column name was not executed');
  assert.ok(!/^PWNED_DOT_COMMAND/m.test(inspect.stdout), 'the report has no line made of data');
  assert.ok(!/^\s*\./m.test(inspect.stdout), 'no report line starts with a dot');
  const build = runViz(['build', root]);
  assert.equal(build.code, 0, build.stdout + build.stderr);
  assert.ok(!fs.existsSync(marker));
  const out = builtFolder(build.stdout);
  const manifest = readJs(path.join(out, 'data', 'manifest.js'));
  const names = manifest.datasets[0].columns.map((column) => column.name);
  assert.ok(names.includes(nasty.region) && names.includes(nasty.amount) && names.includes(nasty.date) && names.includes(nasty.shell), 'names are kept exactly as they are');
  assert.ok(manifest.views.length >= 1);
  for (const file of ['index.html', 'assets/viewer.js', 'assets/viewer.css']) {
    const text = fs.readFileSync(path.join(out, file), 'utf8');
    assert.ok(!text.includes('DROP VIEW') && !text.includes('window.__pwned'), `${file} has no data in it`);
  }
  const cube = readJs(path.join(out, 'data', 'cube-ds1.js'));
  assert.ok(cube.groups[''][0][0] === 60);
});

test('a text column of dates is read as dates; a broken file is skipped; Parquet, JSON lines and a header-only file work', options, async () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'mixed');
  fs.mkdirSync(root);
  // dates as text with one bad value: DuckDB reads the column as text, the plugin converts it
  const rows = ['stamp,city,sales'];
  for (let i = 0; i < 120; i += 1) rows.push(`${i === 7 ? 'n/a' : `2025-03-${String(1 + (i % 28)).padStart(2, '0')}T10:${String(i % 60).padStart(2, '0')}:00Z`},${['Oslo', 'Rome', 'Kyiv'][i % 3]},${i * 3 + 1}`);
  fs.writeFileSync(path.join(root, 'events.csv'), `${rows.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'garbage.csv'), Buffer.from([0, 255, 254, 1, 2, 3, 0, 0, 34, 34, 34]));
  fs.writeFileSync(path.join(root, 'headers-only.csv'), 'a,b,c\n');
  fs.writeFileSync(path.join(root, 'lines.jsonl'), Array.from({ length: 30 }, (_, i) => JSON.stringify({ kind: ['x', 'y'][i % 2], score: i * 1.5, nested: { a: i } })).join('\n'));
  const parquet = path.join(root, 'pq.parquet').replace(/\\/g, '/');
  const made = await runProcess(duck.bin, ['-bail'], { input: `COPY (SELECT range AS n, 'g' || (range % 3) AS grp, range * 2.5 AS val FROM range(50)) TO '${parquet}' (FORMAT PARQUET);` });
  assert.equal(made.code, 0, made.stderr);

  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /stamp \(TIMESTAMP\): temporal, 2025-03-01 to 2025-03-28.*\(read from text\)/);
  assert.match(inspect.stdout, /sales \(BIGINT\): measure, default sum/);
  assert.match(inspect.stdout, /Skipped: garbage\.csv - no data rows/);
  assert.match(inspect.stdout, /Skipped: headers-only\.csv - no data rows/);
  assert.doesNotMatch(inspect.stdout, /ds4 /, 'empty files are not datasets');
  assert.match(inspect.stdout, /nested\.a \(BIGINT\)/, 'the field of a nested object is a column of its own');
  assert.match(inspect.stdout, /pq\.parquet/);
  const build = runViz(['build', root]);
  assert.equal(build.code, 0, build.stderr);
  const manifest = readJs(path.join(builtFolder(build.stdout), 'data', 'manifest.js'));
  assert.ok(manifest.datasets.some((dataset) => dataset.files.includes('pq.parquet') && dataset.rows === 50));
  assert.ok(manifest.datasets.every((dataset) => dataset.rows > 0), 'the header-only file is not a dataset');
});

/** Text from code points written in hex (so this file stays plain ASCII): word('41 42') is 'AB'. */
const word = (hexes) => hexes.split(' ').map((hex) => String.fromCodePoint(parseInt(hex, 16))).join('');

test('Cyrillic paths and names, a semicolon file with decimal commas, dd.mm.yyyy dates and a byte order mark', options, () => {
  const tmp = makeTmp();
  const folder = `${word('414 430 43d 456')} ${word('43c 430 433 430 437 438 43d 443')} (2025) [${word('43a 43e 43f 456 44f')}]`;
  const root = path.join(tmp, folder);
  const sub = path.join(root, `${word('41f 440 43e 434 430 436 456')} 2025`);
  fs.mkdirSync(sub, { recursive: true });
  const names = { date: word('414 430 442 430'), region: word('420 435 433 456 43e 43d'), amount: word('421 443 43c 430'), qty: word('41a 456 43b 44c 43a 456 441 442 44c') };
  const regions = [word('41a 438 457 432'), word('41b 44c 432 456 432'), word('41e 434 435 441 430'), word('425 430 440 43a 456 432')];
  const rows = [`${names.date};${names.region};${names.amount};${names.qty}`];
  let expectedTotal = 0;
  const expectedByRegion = {};
  for (let i = 0; i < 120; i += 1) {
    const amount = 100 + ((i * 37) % 900) + (i % 7) / 10;
    expectedTotal += amount;
    expectedByRegion[regions[i % 4]] = (expectedByRegion[regions[i % 4]] ?? 0) + amount;
    rows.push(`${String(1 + (i % 28)).padStart(2, '0')}.${String(1 + (i % 6)).padStart(2, '0')}.2025;${regions[i % 4]};${amount.toFixed(1).replace('.', ',')};${1 + (i % 9)}`);
  }
  const file = `${word('437 430 43c 43e 432 43b 435 43d 43d 44f')}.csv`;
  fs.writeFileSync(path.join(sub, file), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${rows.join('\r\n')}\r\n`, 'utf8')]));
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.ok(inspect.stdout.includes(`${names.date} (DATE): temporal, 2025-01-01 to 2025-06-28`));
  assert.ok(inspect.stdout.includes(`${names.amount} (DOUBLE): measure, default`), 'decimal commas are read as numbers');
  assert.ok(inspect.stdout.includes(`${names.qty} (BIGINT): dimension (numeric: can also be summed or averaged)`));
  const plan = path.join(tmp, 'plan.json');
  fs.writeFileSync(
    plan,
    JSON.stringify({
      version: 1,
      views: [
        { id: 'by-region', kind: 'bar', dataset: 'ds1', x: names.region, measure: { column: names.amount, agg: 'sum' } },
        { id: 'qty', kind: 'bar', dataset: 'ds1', x: names.region, measure: { column: names.qty, agg: 'sum' } },
      ],
    }),
  );
  const build = runViz(['build', root, '--plan', plan]);
  assert.equal(build.code, 0, build.stdout + build.stderr);
  const out = builtFolder(build.stdout);
  const byRegion = readJs(path.join(out, 'data', 'by-region.js'));
  assert.equal(byRegion.length, 4);
  for (const row of byRegion) approx(row.v, expectedByRegion[row.k], `total for ${row.k}`);
  approx(byRegion.reduce((sum, row) => sum + row.v, 0), expectedTotal, 'all regions');
  assert.match(build.stdout, /Open in a browser: file:\/\/\/.+%/, 'the link is percent-encoded');
});

test('header lines repeated inside a CSV are removed from a copy, said in the report, and the original is untouched', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'joined');
  fs.mkdirSync(root);
  const lines = ['id,region,amount'];
  for (let i = 1; i <= 40; i += 1) {
    lines.push(`${i},${['N', 'S', 'E'][i % 3]},${i * 7 + 3}`);
    if (i === 14 || i === 29) lines.push('id,region,amount');
  }
  const file = path.join(root, 'data.csv');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const before = snapshot(root);
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /ds1 "data": 40 rows, 3 columns/);
  assert.match(inspect.stdout, /amount \(BIGINT\): measure, default sum/, 'the number column is a number again');
  assert.match(inspect.stdout, /Note: data\.csv - removed 2 repeated header lines; a cleaned copy in the work folder is read, the original is untouched/);
  assert.deepEqual(snapshot(root), before, 'the data folder is exactly as it was');
  const clean = path.join(tmp, 'joined-viz', '_work', 'clean');
  assert.equal(fs.readdirSync(clean).length, 1);
  assert.equal(fs.readFileSync(path.join(clean, fs.readdirSync(clean)[0]), 'utf8').split('\n').filter((line) => line === 'id,region,amount').length, 1, 'the copy has the header once');
  const build = runViz(['build', root]);
  assert.equal(build.code, 0, build.stderr);
  const manifest = readJs(path.join(builtFolder(build.stdout), 'data', 'manifest.js'));
  assert.ok(manifest.inventory.notes.some((note) => /data\.csv: removed 2 repeated header lines/.test(note)));
  const quiet = path.join(tmp, 'plain');
  fs.mkdirSync(quiet);
  fs.writeFileSync(path.join(quiet, 'ok.csv'), `id,region,amount\n${Array.from({ length: 30 }, (_, i) => `${i},N,${i * 7 + 3}`).join('\n')}\n`);
  assert.doesNotMatch(runViz(['inspect', quiet]).stdout, /Note:/, 'no note when nothing was changed');
});

test('comment lines before the header do not hide repeated header lines; a Total row at the end is flagged', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'trial');
  fs.mkdirSync(root);
  const lines = ['# Study ABC-102', '# Sponsor: Example Pharma', '# Exported 2024-03-01', 'id,region,amount'];
  for (let i = 1; i <= 40; i += 1) {
    lines.push(`P${i},${['N', 'S', 'E'][i % 3]},${i * 7 + 3}`);
    if (i === 14 || i === 29) lines.push('id,region,amount');
  }
  lines.push('Total,All,9999');
  fs.writeFileSync(path.join(root, 'trial.csv'), `${lines.join('\n')}\n`);
  const before = snapshot(root);
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /ds1 "trial": 41 rows, 3 columns/, '40 people and the Total line, no header lines');
  assert.match(inspect.stdout, /Note: trial\.csv - removed 2 repeated header lines/);
  assert.match(inspect.stdout, /Note: trial\.csv - the last line starts with "Total": it looks like a summary row and is counted as data/);
  assert.match(inspect.stdout, /amount \(BIGINT\): measure/, 'the number column is a number again');
  assert.deepEqual(snapshot(root), before, 'the data folder is exactly as it was');
  const clean = path.join(tmp, 'trial-viz', '_work', 'clean');
  const copy = fs.readFileSync(path.join(clean, fs.readdirSync(clean)[0]), 'utf8').split('\n');
  assert.equal(copy.filter((line) => line === 'id,region,amount').length, 1, 'the copy has the header once');
  assert.equal(copy.filter((line) => line.startsWith('# ')).length, 3, 'the comment lines are kept as they were');
});

test('a code for "missing" in a number column is reported (the value only when values may be shown)', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'sensors');
  fs.mkdirSync(root);
  const lines = ['day,temp_c,rain_mm'];
  for (let i = 0; i < 60; i += 1) lines.push(`2024-03-${String((i % 28) + 1).padStart(2, '0')},${i % 7 === 0 ? -999 : 8 + (i % 13)},${(i % 5) * 0.4}`);
  fs.writeFileSync(path.join(root, 'weather.csv'), `${lines.join('\n')}\n`);
  const shown = runViz(['inspect', root]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /quality: temp_c: contains the value -999, which looks like a code for "missing"; it is counted as a real number/);
  assert.match(shown.stdout, /rain_mm \(DOUBLE\): measure, default sum/, 'rain adds up');
  const hidden = runViz(['inspect', root, '--no-values']);
  assert.equal(hidden.code, 0, hidden.stderr);
  assert.match(hidden.stdout, /quality: temp_c: contains an extreme value that looks like a code for "missing"/);
  assert.doesNotMatch(hidden.stdout, /-999/, 'no value reaches the structure-only report');
});

test('CSV files saved as UTF-16 (little or big endian, with or without a mark) are read next to UTF-8 ones; the originals stay untouched', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'mixed-encodings');
  fs.mkdirSync(root);
  const header = 'date,region,units';
  const rows = (offset) => Array.from({ length: 10 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')},${['North', 'South', '\u0412\u0441\u0442\u043e\u043a'][i % 3]},${i * 7 + offset}`);
  const text = (offset) => `${[header, ...rows(offset)].join('\r\n')}\r\n`;
  fs.writeFileSync(path.join(root, 'a_utf8.csv'), text(1));
  fs.writeFileSync(path.join(root, 'b_le_bom.csv'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text(11), 'utf16le')]));
  fs.writeFileSync(path.join(root, 'c_be_bom.csv'), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text(21), 'utf16le').swap16()]));
  fs.writeFileSync(path.join(root, 'd_le_nomark.csv'), Buffer.from(text(31), 'utf16le'));
  const before = snapshot(root);
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.doesNotMatch(inspect.stdout, /Skipped:/);
  assert.match(inspect.stdout, /ds1 "a_utf8 and 3 similar": 40 rows, 3 columns, from 4 files/);
  assert.match(inspect.stdout, /Note: b_le_bom\.csv - saved as UTF-16 \(little-endian\); a UTF-8 copy in the work folder is read, the original is untouched/);
  assert.match(inspect.stdout, /Note: c_be_bom\.csv - saved as UTF-16 \(big-endian\)/);
  assert.match(inspect.stdout, /Note: d_le_nomark\.csv - saved as UTF-16 \(little-endian\)/);
  assert.match(inspect.stdout, /units \(BIGINT\): measure, default sum, min 1, max 94/);
  assert.match(inspect.stdout, /region \(VARCHAR\): dimension, 3 values:.*\u0412\u0441\u0442\u043e\u043a \(\d+\)/, 'the Cyrillic name arrives whole');
  assert.deepEqual(snapshot(root), before, 'the data folder is exactly as it was');
  const build = runViz(['build', root]);
  assert.equal(build.code, 0, build.stderr);
  assert.doesNotMatch(build.stdout, /NOT READ/);
});

test('the build says which files were left out; the report explains numbers written as text and long tails of columns', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'text-numbers');
  fs.mkdirSync(root);
  const lines = ['id,when,amount,fee_pct,score,note,' + Array.from({ length: 33 }, (_, i) => `q${i + 1}`).join(',')];
  for (let i = 0; i < 60; i += 1) {
    const answers = Array.from({ length: 33 }, (_, j) => (j === 0 && i % 3 === 0 ? '' : String(1 + ((i + j) % 5))));
    lines.push([`r${i}`, `2025-02-${String((i % 28) + 1).padStart(2, '0')}`, `"${(1000 + i * 37.5).toLocaleString('en-US', { minimumFractionDigits: 2 })}"`, `${5 * (i % 4)}%`, i % 10 === 0 ? 'N/A' : String(10 + (i % 7)), i % 2 === 0 ? 'a' : 'b', ...answers].join(','));
  }
  fs.writeFileSync(path.join(root, 'survey.csv'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'broken.csv'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x00, 0x00, 0x7f, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]));
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /quality: amount: the values look like numbers written with symbols or separators \(for example "[\d,]+\.\d\d"\), so the column is read as text and cannot be summed or averaged; take the symbols out of the file/);
  assert.match(inspect.stdout, /quality: fee_pct: the values look like numbers written with symbols or separators \(for example "\d+%"\)/);
  assert.match(inspect.stdout, /quality: score: most values are numbers but some are text \(for example "N\/A"\), so the column is read as text/);
  assert.match(inspect.stdout, /quality: q1: 33\.33% of the values are missing/, 'a third missing is worth saying');
  assert.match(inspect.stdout, /quality: \d+ more category columns are listed without their values \(the report shows the values of the first 30\)/);
  const hidden = runViz(['inspect', root, '--no-values']);
  assert.equal(hidden.code, 0, hidden.stderr);
  assert.match(hidden.stdout, /quality: amount: the values look like numbers written with symbols or separators \(a currency or percent sign, or thousands separators\)/);
  assert.match(hidden.stdout, /quality: score: most values are numbers but some are text, so the column is read as text/);
  assert.doesNotMatch(hidden.stdout, /N\/A/, 'no example value in the structure-only report');
  const build = runViz(['build', root]);
  assert.equal(build.code, 0, build.stderr);
  assert.match(build.stdout, /NOT READ \(1 file, so the page leaves out their data\): broken\.csv - /);
});

test('filters keep only the asked rows in charts, explorers and key numbers, with numbers that match a recomputation', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'ward-visits');
  fs.mkdirSync(root);
  const departments = ['emergency', 'cardiology', 'maternity', 'orthopedics'];
  const rows = [];
  const lines = ['visit_id,visit_date,department,patient,cost'];
  for (let i = 0; i < 360; i += 1) {
    const date = new Date(Date.UTC(2025, 0, 1 + i));
    const day = date.toISOString().slice(0, 10);
    const department = departments[i % 4];
    const patient = i % 9 === 0 ? 'Smith, Ann' : i % 7 === 0 ? 'Jones, Bo' : `Person ${i % 40}`;
    const cost = i % 11 === 0 ? null : Math.round((50 + ((i * 37) % 400)) * 100) / 100;
    rows.push({ day, department, patient, cost });
    lines.push(`${1000 + i},${day},${department},"${patient}",${cost === null ? '' : cost}`);
  }
  fs.writeFileSync(path.join(root, 'visits.csv'), `${lines.join('\n')}\n`);
  const before = snapshot(root);
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  const last = rows[rows.length - 1].day;
  const cut = new Date(Date.UTC(2025, 0, 1 + 359));
  cut.setUTCMonth(cut.getUTCMonth() - 3);
  const cutDay = cut.toISOString().slice(0, 10);
  const total = (list) => Math.round(list.reduce((sum, row) => sum + (row.cost ?? 0), 0) * 100) / 100;
  const emergency = rows.filter((row) => row.department === 'emergency');
  const recentEmergency = emergency.filter((row) => row.day > cutDay);
  assert.ok(recentEmergency.length > 5 && recentEmergency.length < emergency.length, 'the test data makes the two filters differ');

  const plan = {
    version: 1,
    title: 'Emergency ward, last 3 months',
    filters: [{ dataset: 'ds1', column: 'department', op: 'in', values: ['emergency', 'cardiology'] }],
    views: [
      { id: 'by-department', kind: 'bar', dataset: 'ds1', x: 'department', measure: { column: 'cost', agg: 'sum' } },
      { id: 'recent', kind: 'bar', dataset: 'ds1', x: 'department', measure: { column: 'cost', agg: 'sum' }, filters: [{ column: 'visit_date', op: 'last', n: 3, unit: 'month' }, { column: 'department', op: '=', value: 'emergency' }] },
      { id: 'weekly', kind: 'line', dataset: 'ds1', x: 'visit_date', grain: 'month', measure: { column: 'cost', agg: 'sum' }, filters: [{ column: 'visit_date', op: '>=', value: '2025-03-10' }] },
      { id: 'cut-end', kind: 'line', dataset: 'ds1', x: 'visit_date', grain: 'month', measure: { column: 'cost', agg: 'sum' }, filters: [{ column: 'visit_date', op: 'between', value: '2025-03-01', to: '2025-06-15' }] },
      { id: 'costs', kind: 'hist', dataset: 'ds1', column: 'cost', bins: 10, filters: [{ column: 'cost', op: '>=', value: 300 }] },
      { id: 'names', kind: 'bar', dataset: 'ds1', x: 'patient', measure: { agg: 'count' }, filters: [{ column: 'patient', op: 'contains', value: 'SMITH' }] },
      { id: 'missing', kind: 'bar', dataset: 'ds1', x: 'department', measure: { agg: 'count' }, filters: [{ column: 'cost', op: 'is_null' }] },
      { id: 'others', kind: 'bar', dataset: 'ds1', x: 'department', measure: { agg: 'count' }, filters: [{ column: 'department', op: 'not_in', values: ['emergency'] }] },
    ],
    explorers: [{ dataset: 'ds1', dimensions: ['department', 'visit_date'], measures: [{ column: 'cost', agg: 'sum' }], filters: [{ column: 'cost', op: '>', value: 100 }] }],
  };
  const planFile = path.join(tmp, 'plan-filters.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const build = runViz(['build', root, '--plan', planFile]);
  assert.equal(build.code, 0, build.stderr);
  assert.doesNotMatch(build.stdout, /NOT BUILT/);
  const out = builtFolder(build.stdout);
  const data = (id) => readJs(path.join(out, 'data', `${id}.js`));
  const manifest = readJs(path.join(out, 'data', 'manifest.js'));
  const byKey = (list) => Object.fromEntries(list.map((row) => [row.k, row.v]));

  const page = [...emergency, ...rows.filter((row) => row.department === 'cardiology')];
  const all = byKey(data('by-department'));
  assert.deepEqual(Object.keys(all).sort(), ['cardiology', 'emergency'], 'the page filter applies to a view without filters of its own');
  approx(all.emergency, total(emergency), 'emergency total');
  approx(all.cardiology, total(rows.filter((row) => row.department === 'cardiology')), 'cardiology total');
  const recent = byKey(data('recent'));
  assert.deepEqual(Object.keys(recent), ['emergency'], 'page and view filters both apply');
  approx(recent.emergency, total(recentEmergency), 'the last three months of emergency');
  const months = byKey(data('weekly').map((row) => ({ k: row.t.slice(0, 7), v: row.v })));
  assert.equal(Object.keys(months)[0], '2025-03', 'the line starts where the date filter says');
  approx(months['2025-04'], total(page.filter((row) => row.day.startsWith('2025-04'))), 'a whole month inside the filter');
  approx(months['2025-03'], total(page.filter((row) => row.day >= '2025-03-10' && row.day.startsWith('2025-03'))), 'the first month counts only the kept days');
  const expensive = page.filter((row) => row.cost !== null && row.cost >= 300);
  const bins = data('costs');
  assert.equal(bins.reduce((sum, bin) => sum + bin.v, 0), expensive.length, 'the histogram counts the kept rows only');
  assert.ok(bins[0].a >= 300 - 1e-6 && bins[bins.length - 1].b <= Math.max(...expensive.map((row) => row.cost)) + 1e-6, 'its bins span the kept rows, not all rows');
  const smith = byKey(data('names'));
  assert.deepEqual(Object.keys(smith), ['Smith, Ann'], 'contains ignores the case');
  assert.equal(smith['Smith, Ann'], page.filter((row) => row.patient === 'Smith, Ann').length);
  const missing = byKey(data('missing'));
  assert.equal(missing.emergency + missing.cardiology, page.filter((row) => row.cost === null).length);
  assert.deepEqual(Object.keys(byKey(data('others'))), ['cardiology'], 'is none of');

  const view = (id) => manifest.views.find((item) => item.id === id);
  assert.deepEqual(view('by-department').filters, ['department is one of emergency, cardiology']);
  assert.deepEqual(view('recent').filters, ['department is one of emergency, cardiology', 'visit_date: the last 3 months of the data', 'department = emergency']);
  assert.match(view('weekly').insight, /only partly covered, so no change from first to last is given/, 'the first month is cut by the filter: the statement about first and last says so');
  assert.doesNotMatch(view('weekly').insight, /%/);
  assert.match(view('cut-end').insight, /only partly covered/, 'the last month is cut by the filter, not by the data');
  assert.doesNotMatch(view('recent').insight, /Top \d+ of about/, 'no distinct-value count of the whole table');
  const dataset = manifest.datasets[0];
  assert.deepEqual(dataset.filters, ['department is one of emergency, cardiology']);
  assert.equal(dataset.keptRows, page.length);
  assert.equal(dataset.rows, 360);
  assert.deepEqual(dataset.explorerFilters, ['department is one of emergency, cardiology', 'cost > 100']);
  assert.equal(dataset.kpis.find((kpi) => /cost/.test(kpi.label)).value, fmtNumber(total(page)), 'the key numbers count the kept rows');
  const cube = data('cube-ds1');
  const keptByCost = page.filter((row) => row.cost !== null && row.cost > 100);
  assert.equal(cube.groups[''][0][0], keptByCost.length, 'the explorer total counts the rows kept by page and explorer filters');
  assert.equal(new Set(cube.groups['0'].map((row) => row[0])).size, 2);
  assert.deepEqual(snapshot(root), before, 'the data folder is untouched');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'plan.json'), 'utf8')).filters, [{ column: 'department', op: 'in', values: ['emergency', 'cardiology'], dataset: 'ds1' }]);

  const none = path.join(tmp, 'plan-none.json');
  fs.writeFileSync(none, JSON.stringify({ version: 1, filters: [{ dataset: 'ds1', column: 'department', op: '=', value: 'dentistry' }], views: [{ kind: 'bar', dataset: 'ds1', x: 'department' }, { kind: 'hist', dataset: 'ds1', column: 'cost' }] }));
  const empty = runViz(['build', root, '--plan', none]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /NOTE: the filters on ds1 \(visits\) leave no rows/);
  assert.match(empty.stdout, /NOT BUILT: .*no rows with a value are left after the filters/);

  const badPlan = path.join(tmp, 'plan-bad.json');
  fs.writeFileSync(badPlan, JSON.stringify({ version: 1, views: [{ kind: 'bar', dataset: 'ds1', x: 'department', filters: [{ column: 'department', op: '<', value: 'a' }, { column: 'visit_date', op: '>', value: 'yesterday' }] }] }));
  const refused = runViz(['build', root, '--plan', badPlan]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /views\[0\]\.filters\[0\]: op "<" needs a number or date column; "department" is text/);
  assert.match(refused.stderr, /views\[0\]\.filters\[1\]: value must be a date as "2025-01-31"/);
  assert.equal(last, '2025-12-26');
});

test('an Excel sheet with a title row above the table: the title is skipped and reported', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'titled');
  fs.mkdirSync(root);
  const rows = [['Acme Corp - Customer Survey, 2025', '', '', ''], ['', '', '', ''], ['name', 'city', 'score', 'visits']];
  for (let i = 0; i < 30; i += 1) rows.push([`person ${i}`, ['Oslo', 'Rome', 'Kyiv'][i % 3], i * 3 + 1, 5 + (i % 4)]);
  fs.writeFileSync(path.join(root, 'survey.xlsx'), makeXlsx([{ name: 'with title', rows }]));
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /Note: survey\.xlsx \[with title\] - skipped 1 title row above the header/);
  assert.match(inspect.stdout, /city \(VARCHAR\): dimension, 3 values/);
  assert.match(inspect.stdout, /score \(BIGINT\): measure/);
  assert.doesNotMatch(inspect.stdout, /column_2/);
});

test('--no-values shows structure only: no value, range, average or correlation reaches the report', options, () => {
  const { root } = sample();
  const plain = runViz(['inspect', root]).stdout;
  assert.match(plain, /min 20\.25/, 'sanity: the normal report does show ranges');
  const hidden = runViz(['inspect', root, '--no-values']);
  assert.equal(hidden.code, 0, hidden.stderr);
  const text = hidden.stdout;
  assert.match(text, /Mode: --no-values\. Only names, types, kinds and counts are shown/);
  assert.match(text, /amount \(DOUBLE\): measure, default sum\n/);
  assert.match(text, /region \(VARCHAR\): dimension, 4 values\n/);
  assert.match(text, /order_date \(DATE\): temporal, default grain week\n/);
  assert.doesNotMatch(text, /\bmin\b|\bmax\b|\bmean\b|strongest correlations|2025-01-01|South|West|Chair|Sofa|online|phone/);
  assert.match(text, /Draft plan \(\d+ charts?/, 'the draft plan is still there');
  assert.match(runViz(['--help']).stdout, /--no-values {3}structure only/);
  assert.equal(runViz(['--help']).code, 0);
  assert.equal(runViz(['inspect', root, '-h']).code, 0);
});

test('nested objects in JSON lines become columns (user.country) that can be charted', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'events');
  fs.mkdirSync(root);
  const countries = ['NL', 'DE', 'UA', 'PL'];
  const expected = {};
  const lines = [];
  for (let i = 0; i < 120; i += 1) {
    const country = countries[(i * 7) % 4];
    expected[country] = (expected[country] ?? 0) + 1;
    lines.push(JSON.stringify({ at: `2025-03-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`, user: { id: `u${i % 40}`, country, device: i % 3 === 0 ? 'phone' : 'laptop' }, page: { path: `/p${i % 5}` }, tags: ['a', 'b'], ms: 100 + i * 3 }));
  }
  fs.writeFileSync(path.join(root, 'events.jsonl'), `${lines.join('\n')}\n`);
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /user\.country \(VARCHAR\): dimension, 4 values/);
  assert.match(inspect.stdout, /user\.device \(VARCHAR\): dimension, 2 values/);
  assert.match(inspect.stdout, /page\.path \(VARCHAR\): dimension, 5 values/);
  assert.match(inspect.stdout, /tags \(VARCHAR\[\]\): complex/, 'arrays stay as they are');
  assert.doesNotMatch(inspect.stdout, /: complex[^\n]*\n[^\n]*STRUCT/);
  const plan = path.join(tmp, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ version: 1, views: [{ id: 'by-country', kind: 'bar', dataset: 'ds1', x: 'user.country', measure: { agg: 'count' } }, { id: 'ms-by-device', kind: 'bar', dataset: 'ds1', x: 'user.device', measure: { column: 'ms', agg: 'avg' } }] }));
  const build = runViz(['build', root, '--plan', plan]);
  assert.equal(build.code, 0, build.stdout + build.stderr);
  const rows = readJs(path.join(builtFolder(build.stdout), 'data', 'by-country.js'));
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.v, expected[row.k], `events from ${row.k}`);
});

test('counts of different values are exact, and a file that cannot be read says why, in full words', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'exact');
  fs.mkdirSync(root);
  const lines = ['student,class,score'];
  for (let i = 0; i < 540; i += 1) lines.push(`s${String(i % 30).padStart(2, '0')},${['6A', '6B', '7A', '7B', '8A', '8B'][i % 6]},${1 + (i % 6)}`);
  fs.writeFileSync(path.join(root, 'grades.csv'), `${lines.join('\n')}\n`);
  const bytes = Buffer.alloc(900);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 131 + 7) % 256;
  fs.writeFileSync(path.join(root, 'broken.csv'), bytes);
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /student \(VARCHAR\): dimension_high, 30 values/);
  assert.match(inspect.stdout, /class \(VARCHAR\): dimension, 6 values/);
  assert.doesNotMatch(inspect.stdout, /about \d+ values/, 'nothing is estimated on a small table');
  const skipped = /^Skipped: broken\.csv - (.+)$/m.exec(inspect.stdout);
  assert.ok(skipped !== null, inspect.stdout);
  assert.match(skipped[1], /^cannot be read as a CSV table \(the file looks binary or damaged\)\. DuckDB said: /);
  assert.ok(skipped[1].length > 80 && !/\w$/.test(skipped[1].replace(/\.\.\.$/, '').slice(-1)) || skipped[1].endsWith('...') || skipped[1].length < 450, 'the reason is cut at a word or whole');
});

test('a web address instead of a folder is explained, not turned into a path', options, () => {
  const result = runViz(['inspect', 'https://example.com/data.csv']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is a web address\. This plugin reads a folder on this computer: download the data into a folder/);
  assert.doesNotMatch(result.stderr, /does not exist/);
});

test('the report says when folders were too deep to read', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'deep');
  let directory = root;
  for (let level = 0; level < 10; level += 1) {
    directory = path.join(directory, `level${level}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `file${level}.csv`), `a,b\n${Array.from({ length: 25 }, (_, i) => `${i},${i % 4}`).join('\n')}\n`);
  }
  const inspect = runViz(['inspect', root]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /NOTE: folders nested deeper than 8 levels were not read\./);
  assert.match(inspect.stdout, /level0\/level1/, 'the files inside the limit were read');
  assert.doesNotMatch(inspect.stdout, /level9/);
});

test('a folder whose tables are all empty is refused with a clear message', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'hollow');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'only-header.csv'), 'a,b,c\n');
  const build = runViz(['build', root]);
  assert.equal(build.code, 1, build.stdout + build.stderr);
  assert.match(build.stderr, /no file has any data rows/);
  assert.ok(!fs.existsSync(path.join(tmp, 'hollow-viz')), 'nothing was created');
});

test('a hundred thousand rows are profiled and charted in reasonable time', options, () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'big');
  fs.mkdirSync(root);
  const lines = ['ts,country,device,revenue,items'];
  let seed = 99;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 100_000; i += 1) {
    const day = new Date(Date.UTC(2023, 0, 1) + Math.floor(next() * 700) * 86400000).toISOString().slice(0, 10);
    lines.push(`${day},${['US', 'DE', 'FR', 'UA', 'JP', 'BR'][Math.floor(next() * 6)]},${['mobile', 'desktop', 'tablet'][Math.floor(next() * 3)]},${(next() * 500).toFixed(2)},${1 + Math.floor(next() * 9)}`);
  }
  fs.writeFileSync(path.join(root, 'events.csv'), `${lines.join('\n')}\n`);
  const started = Date.now();
  const build = runViz(['build', root]);
  assert.equal(build.code, 0, build.stderr);
  const seconds = (Date.now() - started) / 1000;
  assert.ok(seconds < 90, `took ${seconds}s`);
  const manifest = readJs(path.join(builtFolder(build.stdout), 'data', 'manifest.js'));
  assert.equal(manifest.datasets[0].rows, 100_000);
  const size = Object.keys(snapshot(builtFolder(build.stdout))).filter((file) => file.startsWith('data/')).reduce((sum, file) => sum + fs.statSync(path.join(builtFolder(build.stdout), file)).size, 0);
  assert.ok(size < 2 * 1024 * 1024, `the data files stay small (${size} bytes): the page holds summaries, not rows`);
});

test('DuckDB runs with automatic extension downloads switched off', options, async () => {
  const [[row]] = await queryAll(duck.bin, '', [`SELECT current_setting('autoinstall_known_extensions') AS a, current_setting('autoload_known_extensions') AS b`]);
  assert.deepEqual([row.a, row.b], [false, false]);
});
