// Pure logic, no DuckDB needed: SQL quoting, the DuckDB output parser, the ZIP and Excel readers, the folder scan, the column
// classifier, the plan checker, the recommender and the command-line parser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { compareVersions, ident, lit, parseJsonArrays, pathLit } from '../scripts/lib/duck.mjs';
import { listZip, readEntry } from '../scripts/lib/zip.mjs';
import { dropTitleRows, readXlsx, serialToText, sheetToCsv } from '../scripts/lib/xlsx.mjs';
import { finishView, partlyCovered } from '../scripts/lib/charts.mjs';
import { sniffUtf16, utf8CopyOf, writeUtf8Copy } from '../scripts/lib/encoding.mjs';
import { LIMITS, checkRoot, fingerprint, scanFolder } from '../scripts/lib/scan.mjs';
import { classify, defaultAggregate, missingCode, pickGrain, typeFamily } from '../scripts/lib/profile.mjs';
import { measureLabel, normalizePlan, titleOfView } from '../scripts/lib/plan.mjs';
import { FILTER_LIMITS, describeFilter, filterKind, sourceSql } from '../scripts/lib/filters.mjs';
import { recommendPlan } from '../scripts/lib/recommend.mjs';
import { explainReadError } from '../scripts/lib/datasets.mjs';
import { createRunDirectory, runStamp } from '../scripts/lib/build.mjs';
import { parseArgs } from '../scripts/lib/args.mjs';
import { UserError, draftPlan } from '../scripts/lib/pipeline.mjs';
import { makeXlsx, makeZip } from './helpers/fixtures.mjs';
import { makeTmp } from './helpers/index.mjs';

test('SQL quoting doubles quotes and never leaves a name unquoted', () => {
  assert.equal(ident('plain'), '"plain"');
  assert.equal(ident('a"b'), '"a""b"');
  assert.equal(ident('x"; DROP TABLE t; --'), '"x""; DROP TABLE t; --"');
  assert.equal(lit("it's"), "'it''s'");
  assert.equal(pathLit('C:\\data\\a.csv'), "'C:/data/a.csv'");
  assert.equal(pathLit("/tmp/o'k.csv"), "'/tmp/o''k.csv'");
});

test('DuckDB JSON output: one array per statement, strings with brackets, bare Infinity and NaN', () => {
  assert.deepEqual(parseJsonArrays('[{"a":1}]\n[]\n[{"b":"x, ] [ \\" y"}]\n'), [[{ a: 1 }], [], [{ b: 'x, ] [ " y' }]]);
  assert.deepEqual(parseJsonArrays('[{"a":Infinity,"b":-Infinity,"c":NaN,"d":"Infinity"}]'), [[{ a: null, b: null, c: null, d: 'Infinity' }]]);
  assert.deepEqual(parseJsonArrays(''), []);
  assert.deepEqual(parseJsonArrays('[{"n":[1,2,[3]]}]'), [[{ n: [1, 2, [3]] }]]);
});

test('version comparison', () => {
  assert.equal(compareVersions([1, 5, 6], [1, 0, 0]), 1);
  assert.equal(compareVersions([0, 10, 3], [1, 0, 0]), -1);
  assert.equal(compareVersions([1, 0, 0], [1, 0, 0]), 0);
});

test('ZIP reader: stored and deflated entries, damaged archives, size caps', () => {
  const buffer = makeZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'b.txt', data: 'stored text', stored: true },
    { name: 'dir/c.txt', data: 'x'.repeat(5000) },
  ]);
  const entries = listZip(buffer);
  assert.deepEqual([...entries.keys()].sort(), ['a.txt', 'b.txt', 'dir/c.txt']);
  assert.equal(readEntry(buffer, entries.get('a.txt')).toString(), 'hello');
  assert.equal(readEntry(buffer, entries.get('b.txt')).toString(), 'stored text');
  assert.equal(readEntry(buffer, entries.get('dir/c.txt')).length, 5000);
  assert.throws(() => readEntry(buffer, entries.get('dir/c.txt'), 100), /larger than/);
  assert.throws(() => listZip(Buffer.from('this is not a zip archive at all, just text')), /not a ZIP/);
  assert.throws(() => listZip(buffer.subarray(0, buffer.length - 10)), /not a ZIP/);
});

test('ZIP reader: an entry that inflates to more than it declares is refused (zip bomb)', () => {
  const bomb = Buffer.alloc(6 * 1024 * 1024);
  const archive = makeZip([{ name: 'bomb.xml', data: bomb }]);
  const sizeOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24;
  archive.writeUInt32LE(100, sizeOffset); // the central directory now claims 100 bytes
  const entry = listZip(archive).get('bomb.xml');
  assert.equal(entry.size, 100);
  assert.throws(() => readEntry(archive, entry), /cannot inflate/);
  // and the plain size check catches an honest declaration
  assert.throws(() => readEntry(makeZip([{ name: 'big', data: bomb }]), listZip(makeZip([{ name: 'big', data: bomb }])).get('big'), 1024 * 1024), /larger than/);
});

test('Excel: shared strings, numbers, booleans, dates, hidden sheets, header cleanup', () => {
  const book = makeXlsx([
    {
      name: 'Orders',
      rows: [
        ['Name', 'Qty', 'When', 'Flag', '', 'Name'],
        ['Alice & <Bob>', 3, { date: 45658 }, true, 'x', 'dup'],
        ['Carol', 4.5, { date: 45658.5 }, false, '', ''],
        ['', '', '', '', '', ''],
      ],
    },
    { name: 'Secret', hidden: true, rows: [['a'], [1]] },
    { name: 'Tiny', rows: [['only a header']] },
  ]);
  const result = readXlsx(book);
  assert.equal(result.sheets.length, 1);
  const [sheet] = result.sheets;
  assert.equal(sheet.name, 'Orders');
  assert.deepEqual(sheet.header, ['Name', 'Qty', 'When', 'Flag', 'column_5', 'Name_2']);
  assert.equal(sheet.rows.length, 2);
  assert.deepEqual(sheet.rows[0], ['Alice & <Bob>', '3', '2025-01-01', 'true', 'x', 'dup']);
  assert.deepEqual(sheet.rows[1], ['Carol', '4.5', '2025-01-01 12:00:00', 'false', '', '']);
  assert.deepEqual(result.skipped.map((item) => `${item.sheet}: ${item.reason}`), ['Secret: hidden sheet', 'Tiny: no data rows']);
  assert.equal(sheetToCsv({ header: ['a,b', 'c'], rows: [['x"y', 'line\nbreak']] }), '"a,b",c\n"x""y","line\nbreak"\n');
});

test('Excel: the 1904 date system and times of day', () => {
  assert.equal(serialToText(45658, 'date', false), '2025-01-01');
  assert.equal(serialToText(45658 - 1462, 'date', true), '2025-01-01');
  assert.equal(serialToText(0.75, 'time', false), '18:00:00');
  assert.equal(serialToText(Number.NaN, 'date', false), 'NaN');
  assert.equal(serialToText(1e12, 'date', false), '1000000000000');
});

test('Excel: not a workbook, and a workbook with a broken sheet', () => {
  assert.throws(() => readXlsx(makeZip([{ name: 'hello.txt', data: 'hi' }])), /not an Excel workbook/);
  assert.throws(() => readXlsx(Buffer.from('plain text')), /not a ZIP/);
  const book = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="Gone" sheetId="1" r:id="rId9"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships></Relationships>' },
  ]);
  const result = readXlsx(book);
  assert.equal(result.sheets.length, 0);
  assert.equal(result.skipped[0].reason, 'sheet data not found');
  // inline strings (some writers use them instead of the shared table)
  const inline = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>v &amp; w</t></is></c></row></sheetData></worksheet>' },
  ]);
  assert.deepEqual(readXlsx(inline).sheets[0].rows, [['v & w']]);
});

test('folder scan: sorted, nested, and strict about what it skips', (t) => {
  const root = makeTmp();
  const put = (rel, content = 'a,b\n1,2\n') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  put('b.csv');
  put('a/z.tsv', 'a\tb\n1\t2\n');
  put('a/y.JSON', '[{"a":1}]');
  put('.hidden/c.csv');
  put('node_modules/d.csv');
  put('old-viz/e.csv');
  put('empty.csv', '');
  put('notes.txt', 'text');
  put('noext', 'x');
  put('deep/1/2/3/4/5/6/7/8/9/too-deep.csv');
  let linked = false;
  try {
    fs.symlinkSync(path.join(root, 'b.csv'), path.join(root, 'link.csv'));
    linked = true;
  } catch {
    t.diagnostic('symbolic links cannot be created here; that part of the check is skipped');
  }
  const scan = scanFolder(root);
  assert.deepEqual(scan.files.map((file) => file.rel), ['a/y.JSON', 'a/z.tsv', 'b.csv']);
  assert.deepEqual(scan.files.map((file) => file.kind), ['json', 'csv', 'csv']);
  assert.equal(scan.hitDepth, true);
  assert.deepEqual(scan.ignoredByType, { '.txt': 1, '(no extension)': 1 });
  assert.deepEqual([...scan.ignoredNames].sort(), ['noext', 'notes.txt']);
  const reasons = scan.skipped.map((item) => `${item.file}: ${item.reason}`);
  assert.ok(reasons.some((text) => /empty\.csv: empty file/.test(text)));
  assert.ok(reasons.some((text) => /old-viz: looks like an output folder/.test(text)));
  if (linked) assert.ok(reasons.some((text) => /link\.csv: a link/.test(text)));
  assert.ok(!scan.files.some((file) => /hidden|node_modules|too-deep/.test(file.rel)));
  assert.equal(fingerprint(scan), fingerprint(scanFolder(root)));
  const limited = scanFolder(root, { ...LIMITS, maxFiles: 2 });
  assert.equal(limited.files.length, 2);
  assert.equal(limited.truncated, true);
});

test('the folder check refuses what is not a plain folder', () => {
  const root = makeTmp();
  const file = path.join(root, 'one.csv');
  fs.writeFileSync(file, 'a\n1\n');
  assert.throws(() => checkRoot(''), /give the folder/);
  assert.throws(() => checkRoot('~/data'), /not expanded/);
  assert.throws(() => checkRoot(path.join(root, 'missing')), /does not exist/);
  assert.throws(() => checkRoot(file), /not a folder/);
  assert.throws(() => checkRoot(path.parse(os.tmpdir()).root), /whole drive/);
  assert.equal(checkRoot(root), path.resolve(root));
});

test('column kinds: the rules that decide what a column is for', () => {
  const column = (over) => ({ name: 'x', type: 'VARCHAR', unique: 3, nullPct: 0, min: null, max: null, ...over });
  const role = (over, rows = 100) => classify(column(over), rows).role;
  assert.equal(role({ unique: 4 }), 'dimension');
  assert.equal(role({ unique: 100, name: 'user_id' }), 'id');
  assert.equal(role({ unique: 100, name: 'comment' }), 'text');
  assert.equal(role({ unique: 60 }, 1000), 'dimension_high');
  assert.equal(role({ type: 'DOUBLE', unique: 90 }), 'measure');
  assert.equal(role({ type: 'BIGINT', unique: 100, min: 1, max: 100 }), 'id', 'a run of consecutive numbers is a key');
  assert.equal(role({ type: 'BIGINT', unique: 100, min: 5, max: 9000, name: 'order_id' }), 'id', 'a name that says id is a key');
  assert.equal(role({ type: 'BIGINT', unique: 100, min: 5, max: 9000, name: 'sales' }), 'measure', 'all different but spread out: a measure');
  assert.equal(role({ type: 'BIGINT', unique: 6, name: 'rating' }, 200), 'dimension');
  assert.equal(role({ type: 'BIGINT', unique: 6, name: 'quantity' }, 200), 'measure');
  assert.equal(role({ type: 'INTEGER', unique: 6, name: 'order_year', min: 2019, max: 2024 }), 'dimension');
  assert.equal(role({ type: 'DATE', unique: 50 }), 'temporal');
  assert.equal(role({ type: 'TIMESTAMP WITH TIME ZONE', unique: 50 }), 'temporal');
  assert.equal(role({ type: 'BOOLEAN', unique: 2 }), 'dimension');
  assert.equal(role({ type: 'UUID', unique: 100 }), 'id');
  assert.equal(role({ type: 'STRUCT(a INTEGER)', unique: 50 }), 'complex');
  assert.equal(role({ type: 'INTEGER[]', unique: 50 }), 'complex');
  assert.equal(role({ type: 'VARCHAR[]', unique: 50 }), 'complex');
  assert.equal(role({ unique: 1 }), 'constant');
  assert.equal(role({ nullPct: 100, unique: 0 }), 'empty');
  assert.equal(typeFamily('DECIMAL(18,3)'), 'numeric');
  assert.equal(typeFamily('TIME'), 'complex');
  assert.equal(typeFamily('JSON'), 'complex');
});

test('default aggregation: add up amounts and counts, average prices and rates', () => {
  for (const name of ['amount', 'Total Revenue', 'quantity', 'clicks', 'planned']) assert.equal(defaultAggregate(name), 'sum', name);
  for (const name of ['unit_price', 'discount', 'avg_score', 'conversion_rate', 'age', 'temperature']) assert.equal(defaultAggregate(name), 'avg', name);
  assert.equal(defaultAggregate('something else'), 'avg');
  for (const name of ['rain_mm', 'precipitation', 'snowfall_cm', 'Rain', 'tickets']) assert.equal(defaultAggregate(name), 'sum', name);
  for (const name of ['train_speed', 'terrain', 'pain_score']) assert.equal(defaultAggregate(name), 'avg', name);
  for (const name of ['kwh', 'energy_kwh', 'Consumption']) assert.equal(defaultAggregate(name), 'sum', name);
  for (const name of ['length_of_stay_hours', 'wait_minutes', 'speed_kmh', 'voltage']) assert.equal(defaultAggregate(name), 'avg', name);
  assert.equal(defaultAggregate('hours_worked'), 'sum', 'hours that add up are still added');
});

test('a code for "missing" (-999, 9999) far from the rest is recognised; real extremes are not', () => {
  assert.equal(missingCode({ min: -999, max: 41, median: 15, mean: -4 }), -999);
  assert.equal(missingCode({ min: -9999, max: 41, median: 0, mean: -300 }), -9999);
  assert.equal(missingCode({ min: 0, max: 9999, median: 12, mean: 40 }), 9999);
  assert.equal(missingCode({ min: -5, max: 41, median: 15, mean: 14 }), null);
  assert.equal(missingCode({ min: -999, max: 41, median: -600, mean: -500 }), null, 'most values are around -999: it is the data');
  assert.equal(missingCode({ min: 0, max: 999, median: 700, mean: 650 }), null);
});

test('date grain follows the range and the spacing of the dates', () => {
  assert.equal(pickGrain('2025-01-01', '2025-01-20'), 'day');
  assert.equal(pickGrain('2025-01-01', '2025-06-28', 'DATE', 155), 'week');
  assert.equal(pickGrain('2025-01-01', '2025-06-01', 'DATE', 6), 'month');
  assert.equal(pickGrain('2020-01-01', '2024-12-31', 'DATE', 5), 'year');
  assert.equal(pickGrain('2024-01-01', '2024-12-31', 'DATE', 5), 'quarter');
  assert.equal(pickGrain('2025-01-01 00:00:00', '2025-01-02 12:00:00', 'TIMESTAMP', 100), 'hour');
  assert.equal(pickGrain('2000-01-01', '2020-01-01', 'DATE', 7000), 'year');
  assert.equal(pickGrain('2015-01-01', '2020-01-01', 'DATE', 1800), 'month');
  assert.equal(pickGrain('not a date', '2025-01-01'), 'day');
});

const column = (over) => ({ nullPct: 0, unique: 5, min: null, max: null, mean: null, ...over });
function profiled() {
  return [
    {
      id: 'ds1',
      name: 'orders',
      rows: 500,
      files: ['orders.csv'],
      correlations: [{ a: 'amount', b: 'qty', r: 0.8 }],
      quality: [],
      columns: [
        column({ name: 'when', type: 'DATE', role: 'temporal', grain: 'week', unique: 120 }),
        column({ name: 'Region', type: 'VARCHAR', role: 'dimension', unique: 4 }),
        column({ name: 'product', type: 'VARCHAR', role: 'dimension', unique: 7 }),
        column({ name: 'city', type: 'VARCHAR', role: 'dimension_high', unique: 80 }),
        column({ name: 'amount', type: 'DOUBLE', role: 'measure', agg: 'sum', interest: 1.2, unique: 300 }),
        column({ name: 'qty', type: 'BIGINT', role: 'measure', agg: 'sum', interest: 0.7, unique: 9 }),
        column({ name: 'price', type: 'DOUBLE', role: 'measure', agg: 'avg', interest: 0.4, unique: 200 }),
        column({ name: 'note', type: 'VARCHAR', role: 'text', unique: 400 }),
      ],
    },
  ];
}

test('plan check: accepts a good plan, canonicalises names, and reports every problem at once', () => {
  const good = normalizePlan(
    {
      version: 1,
      title: 'T\u0007itle\nwith controls',
      views: [
        { kind: 'line', dataset: 'ds1', x: 'WHEN', measure: { column: 'AMOUNT', agg: 'sum' }, split: 'region', id: 'Bad ID!' },
        { kind: 'bar', dataset: 'ds1', x: 'city', limit: 500 },
        { kind: 'hist', dataset: 'ds1', column: 'price', bins: 1 },
        { kind: 'corr', dataset: 'ds1', columns: ['amount', 'qty', 'price'] },
      ],
      explorers: [{ dataset: 'ds1', dimensions: ['when', 'region'], measures: [{ column: 'amount', agg: 'sum' }] }],
    },
    profiled(),
  );
  assert.equal(good.title, 'T itle with controls');
  assert.equal(good.views[0].x, 'when');
  assert.equal(good.views[0].measure.column, 'amount');
  assert.equal(good.views[0].split, 'Region');
  assert.equal(good.views[0].id, 'v1');
  assert.equal(good.views[0].grain, 'week');
  assert.deepEqual(good.views[1].measure, { agg: 'count' });
  assert.equal(good.views[1].limit, 30);
  assert.equal(good.views[2].bins, 5);

  const problems = (plan) => {
    try {
      normalizePlan(plan, profiled());
    } catch (error) {
      return error.message;
    }
    return '';
  };
  const bad = problems({
    version: 2,
    views: [
      { kind: 'pie', dataset: 'ds1' },
      { kind: 'bar', dataset: 'ds9', x: 'region' },
      { kind: 'bar', dataset: 'ds1', x: 'amount' },
      { kind: 'bar', dataset: 'ds1', x: 'nope' },
      { kind: 'line', dataset: 'ds1', x: 'region', measure: { column: 'amount', agg: 'sum' } },
      { kind: 'line', dataset: 'ds1', x: 'when', measure: { column: 'region', agg: 'sum' } },
      { kind: 'line', dataset: 'ds1', x: 'when', measure: { column: 'amount', agg: 'stddev' } },
      { kind: 'scatter', dataset: 'ds1', x: 'amount', y: 'region' },
      { kind: 'corr', dataset: 'ds1', columns: ['amount', 'qty'] },
    ],
    explorers: [{ dataset: 'ds1', dimensions: [], measures: [] }],
  });
  for (const expected of ['version: must be 1', 'kind must be one of', 'unknown dataset "ds9"', 'is a measure column', 'is not a column of ds1', 'is a dimension column', 'agg must be one of', 'needs 3 to 8', 'needs at least one dimension']) {
    assert.ok(bad.includes(expected), `the message mentions "${expected}":\n${bad}`);
  }
  assert.match(problems(null), /must be a JSON object/);
  assert.match(problems({ version: 1, views: 'x' }), /views: must be a list/);
  assert.equal(problems({ version: 1, views: [] }), '', 'an empty plan is allowed');
  const many = { version: 1, views: Array.from({ length: 41 }, () => ({ kind: 'hist', dataset: 'ds1', column: 'price' })) };
  assert.match(problems(many), /at most 40 views/);
  const ids = normalizePlan({ version: 1, views: [{ kind: 'hist', dataset: 'ds1', column: 'price', id: 'same' }, { kind: 'hist', dataset: 'ds1', column: 'qty', id: 'same' }] }, profiled());
  assert.notEqual(ids.views[0].id, ids.views[1].id);
});

test('a plan field the check does not know is an error, never ignored in silence', () => {
  const problems = (plan, data = profiled()) => {
    try {
      normalizePlan(plan, data);
    } catch (error) {
      return error.message;
    }
    return '';
  };
  const bar = (extra) => ({ version: 1, views: [{ kind: 'bar', dataset: 'ds1', x: 'Region', ...extra }] });
  assert.match(problems(bar({ filter: "Region = 'N'" })), /views\[0\]: unknown field "filter": rows are filtered with "filters", a list such as/);
  assert.match(problems(bar({ where: 'x' })), /unknown field "where": rows are filtered with "filters"/);
  assert.match(problems(bar({ mesure: { agg: 'count' } })), /views\[0\]: unknown field "mesure" \(did you mean "measure"\?\); allowed here: id, kind, dataset, title, note, filters, x, measure, split, limit/);
  assert.match(problems({ version: 1, views: [{ kind: 'hist', dataset: 'ds1', column: 'price', limit: 5 }] }), /unknown field "limit"/, 'a field that belongs to another chart kind');
  assert.match(problems({ version: 1, colour: 'x', views: [] }), /plan: unknown field "colour"/);
  assert.match(problems(bar({ measure: { column: 'amount', agg: 'sum', where: 1 } })), /views\[0\]\.measure: unknown field "where"/);
  assert.match(problems({ version: 1, views: [], explorers: [{ dataset: 'ds1', dimensions: ['Region'], measures: [], title: 'x' }] }), /explorers\[0\]: unknown field "title"/);
  assert.match(problems(bar({ ['x'.repeat(80)]: 1 })), /unknown field "x{40}"/, 'a long odd name is cut');
  assert.equal(problems(bar({ title: 'ok', note: 'fine', id: 'mine', limit: 5, split: 'product' })), '', 'every documented field is accepted');
  assert.doesNotThrow(() => normalizePlan(recommendPlan(profiled()), profiled()), 'the draft uses only known fields');
});

test('filters in the plan: every kind of column, every operator, and every mistake named', () => {
  const data = profiled();
  data[0].columns.push(column({ name: 'rating', type: 'BIGINT', role: 'dimension', numeric: true, unique: 5 }), column({ name: 'tags', type: 'VARCHAR[]', role: 'complex' }));
  const check = (filters, extra = {}) => normalizePlan({ version: 1, views: [{ kind: 'bar', dataset: 'ds1', x: 'Region', filters }], ...extra }, data);
  const problems = (filters, extra) => {
    try {
      check(filters, extra);
    } catch (error) {
      return error.message;
    }
    return '';
  };
  const good = check([
    { column: 'REGION', op: '=', value: 'North' },
    { column: 'region', op: '!=', value: 7 },
    { column: 'amount', op: '>=', value: '10.5' },
    { column: 'amount', op: 'between', value: 1, to: 20 },
    { column: 'rating', op: 'in', values: [4, '5'] },
    { column: 'when', op: 'between', value: '2025-01-01', to: '2025-03-31 23:59' },
    { column: 'when', op: 'last', n: 3, unit: 'month' },
    { column: 'city', op: 'contains', value: 'osl' },
  ]).views[0].filters;
  assert.deepEqual(good[0], { column: 'Region', op: '=', value: 'North' }, 'the column name is made canonical');
  assert.deepEqual(good[1], { column: 'Region', op: '!=', value: '7' }, 'a number given for a text column is compared as text');
  assert.deepEqual(good[2], { column: 'amount', op: '>=', value: 10.5 }, 'a number written as text is read as a number');
  assert.deepEqual(good[4], { column: 'rating', op: 'in', values: [4, 5] }, 'a numeric category can be filtered as a number');
  assert.deepEqual(good[5], { column: 'when', op: 'between', value: '2025-01-01', to: '2025-03-31 23:59:00' });
  assert.deepEqual(good[6], { column: 'when', op: 'last', n: 3, unit: 'month' });
  assert.deepEqual(check([{ column: 'amount', op: 'is_null' }, { column: 'amount', op: 'not_null' }]).views[0].filters.map((filter) => filter.op), ['is_null', 'not_null']);
  assert.deepEqual(check([]).views[0].filters, []);

  const badFilters = [
    { column: 'nope', op: '=', value: 1 },
    { column: 'Region', op: '<', value: 'M' },
    { column: 'Region', op: 'last', n: 1, unit: 'day' },
    { column: 'amount', op: 'last', n: 1, unit: 'day' },
    { column: 'amount', op: 'contains', value: '1' },
    { column: 'when', op: '>', value: 'last week' },
    { column: 'when', op: '>', value: '2025-13-40' },
    { column: 'amount', op: '>', value: 'abc' },
    { column: 'amount', op: 'between', value: 9, to: 2 },
    { column: 'Region', op: 'in', values: [] },
    { column: 'Region', op: 'in', values: ['a', { x: 1 }] },
    { column: 'when', op: 'last', n: 0, unit: 'month' },
    { column: 'when', op: 'last', n: 2, unit: 'fortnight' },
    { column: 'tags', op: 'is_null' },
    { column: 'Region', op: 'matches', value: 'x' },
    { column: 'Region', op: '=', value: 'N', sql: '1=1' },
    'Region = N',
  ];
  // a list holds at most 8 filters, so the mistakes are checked in lists of 8
  const bad = [0, 8, 16].map((from) => problems(badFilters.slice(from, from + 8))).join('\n');
  for (const expected of [
    'is not a column of ds1',
    'op "<" needs a number or date column; "Region" is text',
    'op "last" needs a date column; "Region" is text',
    'op "last" needs a date column; "amount" is a number',
    'op "contains" needs a text column; "amount" is a number',
    'value must be a date as "2025-01-31"',
    'value must be a number for the column "amount"',
    '"value" must not be greater than "to"',
    '"values" must be a non-empty list',
    'every item of "values" must be a text for the column "Region"',
    '"n" must be a whole number from 1 to 1000',
    '"unit" must be one of day, week, month, quarter, year',
    'holds nested data and cannot be filtered',
    'op must be one of =, !=, <',
    'unknown field "sql"; allowed here: column, op, value, values, to, n, unit',
    'must be an object such as',
  ]) assert.ok(bad.includes(expected), `the message mentions "${expected}":\n${bad}`);
  assert.equal((bad.match(/value must be a date as/g) ?? []).length, 2, 'both a word and an impossible date are refused');
  assert.match(problems(Array.from({ length: FILTER_LIMITS.perList + 1 }, () => ({ column: 'Region', op: '=', value: 'a' }))), /at most 8 filters/);
  assert.match(problems('Region = N'), /must be a list of filters/);

  const page = normalizePlan({ version: 1, filters: [{ dataset: 'ds1', column: 'Region', op: 'in', values: ['North', 'South'] }], views: [], explorers: [{ dataset: 'ds1', dimensions: ['Region'], measures: [], filters: [{ column: 'amount', op: '>', value: 0 }] }] }, data);
  assert.deepEqual(page.filters, [{ column: 'Region', op: 'in', values: ['North', 'South'], dataset: 'ds1' }]);
  assert.deepEqual(page.explorers[0].filters, [{ column: 'amount', op: '>', value: 0 }]);
  const pageBad = problems([], { filters: [{ column: 'Region', op: '=', value: 'a' }, { dataset: 'ds9', column: 'Region', op: '=', value: 'a' }, 'x', { dataset: 'ds1', column: 'Region', op: '=', value: 'a', extra: 1 }] });
  assert.match(pageBad, /filters\[0\]: "dataset" must name a dataset \(have: ds1\)/);
  assert.match(pageBad, /filters\[1\]: "dataset" must name a dataset/);
  assert.match(pageBad, /filters\[3\]: unknown field "extra"; allowed here: dataset, column, op/);
  assert.match(problems([], { filters: 'x' }), /filters: must be a list of filters, each with a "dataset"/);
  assert.equal(filterKind({ role: 'temporal' }), 'time');
  assert.equal(filterKind({ role: 'dimension', numeric: true }), 'number');
  assert.equal(filterKind({ role: 'dimension' }), 'text');
});

test('filters become one SQL condition with every value quoted, and are described in plain words', () => {
  const dataset = { id: 'ds1', columns: [{ name: 'Region', role: 'dimension' }, { name: 'we"ird', role: 'dimension' }, { name: 'amount', role: 'measure', numeric: true }, { name: 'when', role: 'temporal' }] };
  const find = (data, name) => data.columns.find((item) => item.name === name) ?? null;
  assert.equal(sourceSql(dataset, [], find), '"ds1"');
  const sql = (filter) => sourceSql(dataset, [filter], find);
  assert.equal(sql({ column: 'Region', op: '=', value: "x'; DROP TABLE t; --" }), `(SELECT * FROM "ds1" WHERE CAST("Region" AS VARCHAR) = 'x''; DROP TABLE t; --')`, 'a value can never leave its quotes');
  assert.equal(sql({ column: 'we"ird', op: 'is_null' }), '(SELECT * FROM "ds1" WHERE "we""ird" IS NULL)', 'a column name is quoted too');
  assert.equal(sql({ column: 'amount', op: 'between', value: 1.5, to: 20 }), '(SELECT * FROM "ds1" WHERE CAST("amount" AS DOUBLE) BETWEEN CAST(1.5 AS DOUBLE) AND CAST(20 AS DOUBLE))');
  assert.match(sql({ column: 'Region', op: '!=', value: 'a' }), /\("Region" IS NULL OR CAST\("Region" AS VARCHAR\) <> 'a'\)/, 'rows with a missing value are kept by "is not"');
  assert.match(sql({ column: 'Region', op: 'not_in', values: ['a', "b'c"] }), /\("Region" IS NULL OR CAST\("Region" AS VARCHAR\) NOT IN \('a', 'b''c'\)\)/, 'rows with a missing value are kept by "is none of"');
  assert.match(sql({ column: 'Region', op: 'contains', value: '100%_' }), /contains\(lower\(CAST\("Region" AS VARCHAR\)\), lower\('100%_'\)\)/, 'no wildcard characters: a plain search');
  assert.match(sql({ column: 'when', op: '>=', value: '2025-02-01' }), /CAST\("when" AS TIMESTAMP\) >= CAST\('2025-02-01' AS TIMESTAMP\)/);
  assert.match(sql({ column: 'when', op: 'last', n: 3, unit: 'month' }), /> \(SELECT max\(CAST\("when" AS TIMESTAMP\)\) FROM "ds1"\) - INTERVAL 3 MONTH/);
  assert.throws(() => sql({ column: 'when', op: 'last', n: '3; DROP', unit: 'month' }), /bad "last" filter/, 'even a filter that skipped the check cannot carry text into the interval');
  assert.throws(() => sql({ column: 'when', op: 'last', n: 3, unit: 'month; --' }), /bad "last" filter/);
  assert.throws(() => sql({ column: 'Region', op: 'regexp', value: 'x' }), /unknown filter op/);
  assert.equal(sourceSql(dataset, [{ column: 'Region', op: '=', value: 'a' }, { column: 'amount', op: '>', value: 0 }], find), `(SELECT * FROM "ds1" WHERE CAST("Region" AS VARCHAR) = 'a' AND CAST("amount" AS DOUBLE) > CAST(0 AS DOUBLE))`, 'filters are all required (AND)');

  assert.equal(describeFilter({ column: 'department', op: '=', value: 'emergency' }), 'department = emergency');
  assert.equal(describeFilter({ column: 'department', op: '!=', value: 'emergency' }), 'department is not emergency');
  assert.equal(describeFilter({ column: 'age', op: '>=', value: 60 }), 'age >= 60');
  assert.equal(describeFilter({ column: 'when', op: 'last', n: 3, unit: 'month' }), 'when: the last 3 months of the data');
  assert.equal(describeFilter({ column: 'when', op: 'last', n: 1, unit: 'week' }), 'when: the last 1 week of the data');
  assert.equal(describeFilter({ column: 'when', op: 'between', value: '2025-01-01', to: '2025-03-31' }), 'when from 2025-01-01 to 2025-03-31');
  assert.equal(describeFilter({ column: 'city', op: 'in', values: ['A', 'B'] }), 'city is one of A, B');
  assert.equal(describeFilter({ column: 'city', op: 'not_in', values: Array.from({ length: 12 }, (_, i) => `c${i}`) }), 'city is none of c0, c1, c2, c3, c4, c5, c6, c7, ... (12)');
  assert.equal(describeFilter({ column: 'city', op: 'contains', value: 'osl' }), 'city contains "osl"');
  assert.equal(describeFilter({ column: 'city', op: 'is_null' }), 'city is missing');
});

test('a numeric column that was listed as a category can still be summed, averaged and plotted; a text one cannot', () => {
  const data = profiled();
  data[0].columns.push(column({ name: 'rating', type: 'BIGINT', role: 'dimension', numeric: true, unique: 5 }));
  const plan = normalizePlan(
    {
      version: 1,
      views: [
        { kind: 'bar', dataset: 'ds1', x: 'Region', measure: { column: 'rating', agg: 'avg' } },
        { kind: 'scatter', dataset: 'ds1', x: 'rating', y: 'amount' },
        { kind: 'hist', dataset: 'ds1', column: 'rating' },
        { kind: 'corr', dataset: 'ds1', columns: ['rating', 'amount', 'qty'] },
      ],
    },
    data,
  );
  assert.equal(plan.views.length, 4);
  assert.throws(() => normalizePlan({ version: 1, views: [{ kind: 'bar', dataset: 'ds1', x: 'Region', measure: { column: 'product', agg: 'sum' } }] }, data), /"product" is a dimension column/);
  assert.doesNotThrow(() => normalizePlan({ version: 1, views: [{ kind: 'bar', dataset: 'ds1', x: 'Region', measure: { column: 'product', agg: 'count_distinct' } }] }, data), 'distinct values can be counted for any column');
});

test('the draft plan names every chart, and does not chart categories that are single rows', () => {
  const draft = draftPlan(profiled(), 'demo');
  assert.ok(draft.views.length > 0 && draft.views.every((view) => typeof view.title === 'string' && view.title.length > 3));
  assert.equal(draft.views[0].title, 'Sum of amount per week');
  assert.doesNotThrow(() => normalizePlan(draft, profiled()), 'a draft with titles still passes the check');
  const small = profiled();
  small[0].rows = 12;
  small[0].columns = [
    column({ name: 'teacher', type: 'VARCHAR', role: 'dimension', unique: 12 }),
    column({ name: 'subject', type: 'VARCHAR', role: 'dimension', unique: 4 }),
    column({ name: 'years', type: 'DOUBLE', role: 'measure', agg: 'avg', interest: 0.5, unique: 9 }),
  ];
  small[0].correlations = [];
  const bars = recommendPlan(small).views.filter((view) => view.kind === 'bar').map((view) => view.x);
  assert.deepEqual(bars, ['subject'], 'one bar per teacher would be twelve bars of one row each');
});

test('the reason a file cannot be read is explained and cut at a word', () => {
  const dialects = ['Delimiter Candidates: \',\', \'|\', \';\'', 'Quote/Escape Candidates: [(\'"\',\'"\'),(\'\',\'\')]', 'Comment Candidates: #, (empty)', 'Possible fixes: ...'];
  const sniff = explainReadError(`duckdb failed: Invalid Input Error: Error when sniffing file "". It was not possible to automatically detect the CSV parsing dialect The search space used was: ${dialects.join(' ')}`);
  assert.match(sniff, /^cannot be read as a CSV table \(the file looks binary or damaged\)\. DuckDB said: Invalid Input Error/);
  assert.ok(sniff.length <= 330);
  assert.match(sniff, /\.\.\.$/);
  assert.doesNotMatch(sniff, /Quote\/Esc\.\.\.$/, 'not cut in the middle of a word');
  assert.match(explainReadError('duckdb failed: Invalid Input Error: Invalid unicode (byte sequence mismatch) detected'), /^is not valid UTF-8 text/);
  assert.equal(explainReadError('duckdb failed: something short'), 'something short');
  assert.ok(explainReadError(`duckdb failed: ${'word '.repeat(200)}`).length <= 404);
});

test('titles and labels read as plain English', () => {
  assert.equal(measureLabel({ agg: 'count' }), 'Rows');
  assert.equal(measureLabel({ column: 'amount', agg: 'sum' }), 'Sum of amount');
  assert.equal(measureLabel({ column: 'price', agg: 'avg' }), 'Average of price');
  assert.equal(titleOfView({ kind: 'line', grain: 'month', measure: { column: 'amount', agg: 'sum' }, split: 'region' }), 'Sum of amount per month, by region');
  assert.equal(titleOfView({ kind: 'scatter', x: 'a', y: 'b' }), 'b vs a');
  assert.equal(titleOfView({ kind: 'bar', title: 'Mine', x: 'a', measure: { agg: 'count' } }), 'Mine');
});

test('the recommender draws what the columns call for, and its draft always passes the plan check', () => {
  const plan = recommendPlan(profiled(), { title: 'Demo' });
  const kinds = plan.views.map((view) => view.kind);
  assert.equal(kinds[0], 'line');
  assert.ok(kinds.includes('bar') && kinds.includes('scatter') && kinds.includes('heatmap') && kinds.includes('corr') && kinds.includes('hist'));
  assert.ok(plan.views.length <= 10);
  const bar = plan.views.find((view) => view.kind === 'bar');
  assert.deepEqual(bar.measure, { column: 'amount', agg: 'sum' });
  const scatter = plan.views.find((view) => view.kind === 'scatter');
  assert.deepEqual([scatter.x, scatter.y], ['amount', 'qty']);
  // the time column first, then the categories closest to six values (7 beats 4)
  assert.deepEqual(plan.explorers[0].dimensions.slice(0, 3), ['when', 'product', 'Region']);
  assert.doesNotThrow(() => normalizePlan(plan, profiled()));
  assert.deepEqual(recommendPlan(profiled()), recommendPlan(profiled()), 'the draft is deterministic');
  const empty = profiled();
  empty[0].rows = 0;
  assert.deepEqual(recommendPlan(empty).views, []);
  const idsOnly = profiled();
  idsOnly[0].columns = [column({ name: 'id', role: 'id' }), column({ name: 'note', role: 'text' })];
  idsOnly[0].correlations = [];
  const none = recommendPlan(idsOnly);
  assert.deepEqual([none.views, none.explorers], [[], []]);
});

test('the draft starts a time chart at the start time, counts events, leaves tiny tables alone and keeps histograms for real samples', () => {
  const events = profiled();
  events[0].correlations = [];
  events[0].columns = [
    column({ name: 'end_time', type: 'TIMESTAMP', role: 'temporal', grain: 'day', unique: 400 }),
    column({ name: 'start_time', type: 'TIMESTAMP', role: 'temporal', grain: 'day', unique: 400 }),
    column({ name: 'member', type: 'VARCHAR', role: 'dimension', unique: 2 }),
    column({ name: 'distance_km', type: 'DOUBLE', role: 'measure', agg: 'avg', interest: 1, unique: 300 }),
  ];
  const lines = recommendPlan(events).views.filter((view) => view.kind === 'line');
  assert.ok(lines.length >= 2 && lines.every((view) => view.x === 'start_time'), 'the end time is not the axis');
  assert.deepEqual(lines[0].measure, { agg: 'count' }, 'trips per period come first when nothing is added up');
  const sales = profiled();
  sales[0].columns[0] = column({ name: 'when', type: 'TIMESTAMP', role: 'temporal', grain: 'week', unique: 120 });
  assert.deepEqual(recommendPlan(sales).views[0].measure, { column: 'amount', agg: 'sum' }, 'with an amount to add up, no row count first');
  const daily = profiled();
  daily[0].columns = [column({ name: 'day', type: 'DATE', role: 'temporal', grain: 'month', unique: 300 }), column({ name: 'temp_c', type: 'DOUBLE', role: 'measure', agg: 'avg', interest: 1, unique: 200 })];
  daily[0].correlations = [];
  assert.deepEqual(recommendPlan(daily).views[0].measure, { column: 'temp_c', agg: 'avg' }, 'dates without a time of day are not events');

  const readme = profiled();
  readme[0].rows = 2;
  readme[0].correlations = [];
  readme[0].columns = [column({ name: 'Library Management System Data Export', type: 'VARCHAR', role: 'dimension', unique: 2 })];
  assert.deepEqual(recommendPlan(readme).views, [], 'a two-row sheet gets no bar chart of its own title');
  assert.deepEqual(recommendPlan(readme).explorers, []);
  const branches = profiled();
  branches[0].rows = 6;
  branches[0].correlations = [];
  branches[0].columns = [column({ name: 'branch', type: 'VARCHAR', role: 'dimension', unique: 6 }), column({ name: 'square_meters', type: 'DOUBLE', role: 'measure', agg: 'avg', interest: 1, unique: 6 })];
  assert.equal(recommendPlan(branches).views.some((view) => view.kind === 'hist'), false, 'no histogram of six values');
  branches[0].rows = 25;
  assert.equal(recommendPlan(branches).views.some((view) => view.kind === 'hist'), true);
});

test('command line parsing', () => {
  assert.deepEqual(parseArgs(['build', 'dir', '--plan', 'p.json', '--no-values', '--max-files=7', '--out', 'o']), {
    positional: ['build', 'dir'],
    options: { plan: 'p.json', noValues: true, maxFiles: 7, out: 'o' },
  });
  assert.throws(() => parseArgs(['--wat']), UserError);
  assert.throws(() => parseArgs(['inspect', 'd', '--out']), /needs a value/);
  assert.throws(() => parseArgs(['inspect', 'd', '--out', '--no-values']), /needs a value/);
  assert.throws(() => parseArgs(['inspect', 'd', '--max-files', 'abc']), /whole number/);
  assert.throws(() => parseArgs(['inspect', 'd', '--max-files', '0']), /whole number/);
});

test('a run folder is always new: the same name is never reused', () => {
  const parent = path.join(makeTmp(), 'out');
  const first = createRunDirectory(parent, '20260101-000000');
  fs.writeFileSync(path.join(first, 'marker.txt'), 'earlier build');
  const second = createRunDirectory(parent, '20260101-000000');
  const third = createRunDirectory(parent, '20260101-000000');
  assert.deepEqual([path.basename(first), path.basename(second), path.basename(third)], ['run-20260101-000000', 'run-20260101-000000-2', 'run-20260101-000000-3']);
  assert.equal(fs.readFileSync(path.join(first, 'marker.txt'), 'utf8'), 'earlier build');
  assert.deepEqual(fs.readdirSync(second), []);
  assert.match(runStamp(new Date(2026, 9, 5, 13, 7, 9)), /^20261005-130709$/);
});

test('Excel: a title row above the table is skipped, a real header row is not', () => {
  const titled = readXlsx(
    makeXlsx([
      {
        name: 'Report',
        rows: [
          ['Acme Corp - Customer Survey, 2025', '', '', ''],
          ['Name', 'Qty', 'City', 'Flag'],
          ['a', 1, 'Oslo', true],
          ['b', 2, 'Rome', false],
        ],
      },
    ]),
  );
  assert.deepEqual(titled.sheets[0].header, ['Name', 'Qty', 'City', 'Flag']);
  assert.equal(titled.sheets[0].titleRows, 1);
  assert.equal(titled.sheets[0].rows.length, 2);
  const plain = readXlsx(makeXlsx([{ name: 'S', rows: [['Name', 'Qty', 'City'], ['a', 1, 'Oslo']] }]));
  assert.equal(plain.sheets[0].titleRows, 0);
  assert.deepEqual(plain.sheets[0].header, ['Name', 'Qty', 'City']);
  const narrow = readXlsx(makeXlsx([{ name: 'S', rows: [['Only'], ['a'], ['b']] }]));
  assert.deepEqual(narrow.sheets[0].header, ['Only'], 'a one-column sheet keeps its header');
  const rows = [['t'], ['x', 'y', 'z']];
  assert.equal(dropTitleRows(rows, 3), 0, 'too few rows to be sure: nothing is dropped');
});

test('the help flag and the web-address check', () => {
  assert.deepEqual(parseArgs(['--help']), { positional: ['help'], options: {} });
  assert.deepEqual(parseArgs(['inspect', '-h']), { positional: ['help'], options: {} });
  assert.throws(() => checkRoot('https://example.com/data.csv'), /web address.*download the data into a folder/);
  assert.throws(() => checkRoot('ftp://host/x'), /web address/);
  assert.throws(() => checkRoot('www.example.com/data'), /web address/);
});

test('insights of split charts: sums add up, averages are never added, and a cut-down split is said', () => {
  const dataset = { id: 'ds1', columns: [{ name: 'store', unique: 20, role: 'dimension' }, { name: 'when', role: 'temporal' }] };
  const rows = [
    { t: '2025-01-01', g: 'A', v: 10 },
    { t: '2025-01-01', g: 'B', v: 30 },
    { t: '2025-02-01', g: 'A', v: 20 },
    { t: '2025-02-01', g: 'B', v: 20 },
  ];
  const line = { id: 'v1', kind: 'line', dataset: 'ds1', x: 'when', grain: 'month', split: 'store' };
  const average = finishView({ ...line, measure: { column: 'x', agg: 'avg' } }, dataset, rows).insight;
  assert.match(average, /Highest: 30 \(B\) on 2025-01-01/);
  assert.match(average, /Lowest: 10 \(A\) on 2025-01-01/);
  assert.doesNotMatch(average, /\b40\b/, 'the averages of two groups are not added');
  assert.match(average, /Only the 8 largest of about 20 groups are drawn\./);
  const sum = finishView({ ...line, measure: { column: 'x', agg: 'sum' } }, dataset, rows).insight;
  assert.match(sum, /Highest \(all groups together\): 40 on 2025-01-01/);
  assert.match(sum, /Largest group: B \(63% of the total\)/);
  const bars = rows.map((row) => ({ k: row.t, g: row.g, v: row.v }));
  const bar = { id: 'v2', kind: 'bar', dataset: 'ds1', x: 'when', split: 'store', limit: 10 };
  assert.match(finishView({ ...bar, measure: { column: 'x', agg: 'max' } }, { ...dataset, columns: [...dataset.columns] }, bars).insight, /Highest: 2025-01-01 \/ B with 30\./);
  const uneven = bars.map((row) => (row.k === '2025-02-01' && row.g === 'B' ? { ...row, v: 10 } : row));
  assert.match(finishView({ ...bar, measure: { column: 'x', agg: 'sum' } }, dataset, uneven).insight, /^2025-01-01 is highest with 40/);
  const single = finishView({ id: 'v3', kind: 'line', dataset: 'ds1', x: 'when', grain: 'month', measure: { column: 'x', agg: 'avg' } }, dataset, rows.filter((row) => row.g === 'A').map(({ t, v }) => ({ t, v }))).insight;
  assert.match(single, /Highest: 20 on 2025-02-01/, 'without a split an average is one series and is read as it is');
});

test('UTF-16 is recognised by its byte order mark or its zero bytes, and a UTF-8 copy keeps every character', () => {
  const le = (text, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
  const be = (text, bom = true) => Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), Buffer.from(text, 'utf16le').swap16()]);
  const sample = 'id,city\n1,Oslo\n2,Kyiv\n';
  assert.equal(sniffUtf16(le(sample)), 'utf-16le');
  assert.equal(sniffUtf16(be(sample)), 'utf-16be');
  assert.equal(sniffUtf16(le(sample, false)), 'utf-16le', 'no mark: ASCII letters are followed by a zero byte');
  assert.equal(sniffUtf16(be(sample, false)), 'utf-16be');
  assert.equal(sniffUtf16(Buffer.from(sample, 'utf8')), null);
  assert.equal(sniffUtf16(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from(sample)])), null, 'UTF-8 with a mark');
  assert.equal(sniffUtf16(Buffer.from([0xff, 0xfe, 0, 0, 1, 0, 0, 0])), null, 'UTF-32 is not UTF-16');
  assert.equal(sniffUtf16(Buffer.alloc(0)), null);

  const tmp = makeTmp();
  // one lone ASCII character first, so that the one-megabyte reading step ends between the two halves of an emoji (a surrogate pair)
  const text = `a${'\u{1F600}'.repeat(300000)}`;
  const source = path.join(tmp, 'big.csv');
  fs.writeFileSync(source, be(text, false));
  const copy = path.join(tmp, 'big-utf8.csv');
  writeUtf8Copy(source, 'utf-16be', copy);
  assert.equal(fs.readFileSync(copy, 'utf8'), text, 'nothing lost or garbled across the reading steps');
  fs.writeFileSync(path.join(tmp, 'le.csv'), le(`${sample}\u0416\n`));
  const made = utf8CopyOf(path.join(tmp, 'le.csv'), 'utf-16le', path.join(tmp, 'work'), 'le');
  assert.equal(fs.readFileSync(made, 'utf8'), `${sample}\u0416\n`, 'the byte order mark is dropped');
  assert.equal(utf8CopyOf(path.join(tmp, 'le.csv'), 'utf-16le', path.join(tmp, 'work'), 'le'), made, 'made once, reused');
  // a copy that was cut short (no .done marker) is never trusted and never replaced: the next name is used
  fs.writeFileSync(path.join(tmp, 'work', 'cut.csv'), 'id,ci');
  const other = utf8CopyOf(path.join(tmp, 'le.csv'), 'utf-16le', path.join(tmp, 'work'), 'cut');
  assert.equal(path.basename(other), 'cut-2.csv');
  assert.equal(fs.readFileSync(path.join(tmp, 'work', 'cut.csv'), 'utf8'), 'id,ci', 'the unfinished copy is left alone');
});

test('first-to-last change is only stated for whole periods of amounts that add up, from a positive start', () => {
  const dataset = (min, max) => ({ id: 'ds1', columns: [{ name: 'when', role: 'temporal', min, max }] });
  const view = (grain, agg = 'sum') => ({ id: 'v1', kind: 'line', dataset: 'ds1', x: 'when', grain, measure: { column: 'x', agg } });
  const months = [{ t: '2025-01-01', v: 100 }, { t: '2025-02-01', v: 90 }, { t: '2025-03-01', v: 120 }];
  const whole = finishView(view('month'), dataset('2025-01-01', '2025-03-31'), months).insight;
  assert.match(whole, /The last point is 20% above the first\./);
  assert.match(finishView(view('month'), dataset('2025-01-01 00:03:12', '2025-03-31 23:58:00'), months).insight, /20% above/, 'a time of day does not make the day incomplete');
  const early = finishView(view('month'), dataset('2025-01-03', '2025-03-31'), months).insight;
  assert.match(early, /only partly covered, so no change from first to last is given/);
  assert.doesNotMatch(early, /%/);
  assert.match(finishView(view('month'), dataset('2025-01-01', '2025-03-25'), months).insight, /only partly covered/);
  const weeks = [{ t: '2024-12-30', v: 5 }, { t: '2025-01-06', v: 9 }];
  assert.match(finishView(view('week'), dataset('2025-01-01', '2025-01-12'), weeks).insight, /only partly covered/, 'the first week starts on a Monday before the data does');
  assert.match(finishView(view('week'), dataset('2024-12-30', '2025-01-12'), weeks).insight, /80% above/);
  const days = [{ t: '2025-01-03', v: 5 }, { t: '2025-01-04', v: 9 }];
  assert.match(finishView(view('day'), dataset('2025-01-03', '2025-01-04'), days).insight, /80% above/, 'a day is never half a period');
  const negative = [{ t: '2025-01-01', v: -3.4 }, { t: '2025-02-01', v: 2.13 }];
  const average = finishView(view('month', 'avg'), dataset('2025-01-01', '2025-02-28'), negative).insight;
  assert.match(average, /The first point is -3\.4, the last is 2\.13\./);
  assert.doesNotMatch(average, /%/, 'no percentage for averages');
  assert.doesNotMatch(finishView(view('month'), dataset('2025-01-01', '2025-02-28'), negative).insight, /%/, 'no percentage from a negative start');
  assert.equal(partlyCovered('quarter', { min: '2025-01-01', max: '2025-09-30' }, '2025-01-01', '2025-07-01'), false);
  assert.equal(partlyCovered('quarter', { min: '2025-01-01', max: '2025-09-29' }, '2025-01-01', '2025-07-01'), true);
  assert.equal(partlyCovered('year', { min: '2024-02-01', max: '2025-12-31' }, '2024-01-01', '2025-01-01'), true);
  assert.equal(partlyCovered('year', { min: '2024-01-01', max: '2025-12-31' }, '2024-01-01', '2025-01-01'), false);
  assert.equal(partlyCovered('month', null, '2025-01-01', '2025-02-01'), false, 'no information: no claim');
});

test('bar insights: missing values are named on their own, equal bars are not ranked, a handful of points says nothing', () => {
  const dataset = { id: 'ds1', columns: [{ name: 'note', unique: 3, role: 'dimension' }, { name: 'a', role: 'measure' }, { name: 'b', role: 'measure' }] };
  const bar = { id: 'v1', kind: 'bar', dataset: 'ds1', x: 'note', measure: { agg: 'count' }, limit: 10 };
  const withEmpty = finishView(bar, dataset, [{ k: '(empty)', v: 3258 }, { k: 'call back', v: 400 }, { k: 'refund', v: 100 }]).insight;
  assert.match(withEmpty, /^call back is highest with 400/);
  assert.match(withEmpty, /Lowest shown: refund with 100\./);
  assert.match(withEmpty, /Missing values: 3,258\./);
  assert.doesNotMatch(withEmpty, /\(empty\) is highest/);
  assert.equal(finishView(bar, dataset, [{ k: 'Culture', v: 5 }, { k: 'Workload', v: 5 }, { k: 'Pay', v: 5 }]).insight, 'All 3 shown are equal (5).');
  assert.match(finishView(bar, dataset, [{ k: '(empty)', v: 7 }]).insight, /^Missing values: 7\.$/);
  const scatter = { id: 'v2', kind: 'scatter', dataset: 'ds1', x: 'a', y: 'b' };
  assert.match(finishView(scatter, dataset, [{ x: 1, y: 3 }, { x: 2, y: 1 }, { x: 3, y: 4 }, { x: 4, y: 2 }]).insight, /^Only 4 points: too few to say whether the two are related\.$/);
  const many = Array.from({ length: 12 }, (_, i) => ({ x: i, y: i * 2 + (i % 3) }));
  assert.match(finishView(scatter, dataset, many).insight, /^Correlation 0\.9\d: a strong positive relationship\. 12 points/);
});

test('zlib is the only decompressor in play (nothing else is imported by the readers)', () => {
  const source = fs.readFileSync(new URL('../scripts/lib/zip.mjs', import.meta.url), 'utf8');
  assert.ok(typeof zlib.inflateRawSync === 'function');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]), ['node:zlib']);
});
