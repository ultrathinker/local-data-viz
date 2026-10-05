// The page, in a real (headless) browser: it must load from disk under its strict content policy with no errors and no network,
// switch views from the menu, draw charts, resize its menu with the splitter (mouse and keyboard), run the explorer, and show
// hostile names as plain text. Skipped when no Chrome or Edge is available or the Node here has no global WebSocket.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtFolder, duckdb, makeTmp, runViz } from './helpers/index.mjs';
import { makeSampleFolder } from './helpers/fixtures.mjs';
import { Page, findBrowser } from './helpers/browser.mjs';

const duck = await duckdb();
const browserPath = findBrowser();
const skip = duck === null ? 'DuckDB is not installed' : browserPath === null ? 'no Chrome/Edge (or no global WebSocket in this Node)' : false;
const options = { skip, timeout: 180_000 };

let siteCache = null;
function site() {
  if (siteCache === null) {
    const tmp = makeTmp();
    const root = path.join(tmp, 'shop');
    makeSampleFolder(root);
    const built = runViz(['build', root]);
    assert.equal(built.code, 0, built.stderr);
    siteCache = path.join(builtFolder(built.stdout), 'index.html');
  }
  return siteCache;
}

let pageCache = null;
async function page() {
  pageCache ??= await Page.open(browserPath);
  return pageCache;
}

after(async () => {
  if (pageCache !== null) await pageCache.close();
});

const navWidth = (p) => p.evaluate('Math.round(document.getElementById("nav").getBoundingClientRect().width)');
/** How many shapes (bars, dots, cells, lines) the chart on screen has; a bare background has none. */
const chartShapes = (p) => p.evaluate('document.querySelectorAll(".chart svg rect[data-tip], .chart svg path, .chart svg circle, .chart svg rect[fill]").length');
const chartLabels = (p) => p.evaluate('Array.from(document.querySelectorAll(".chart svg text")).map(function (t) { return t.textContent; })');

test('the start page loads from disk with no errors and no network request', options, async () => {
  const p = await page();
  await p.colorScheme('light');
  await p.goto(site(), '#/start');
  await p.waitFor('document.querySelector("main h1") && document.querySelector("main h1").textContent === "shop"');
  assert.equal(await p.evaluate('document.title'), 'shop');
  assert.ok((await p.evaluate('document.querySelectorAll("#nav a").length')) >= 20, 'the menu lists the views');
  assert.equal(await p.evaluate('document.querySelectorAll(".cards .card").length'), 3);
  assert.deepEqual(p.errors, []);
  assert.ok(p.requests.length >= 4, 'the page, its script, its style and its data were loaded');
  assert.ok(p.requests.every((url) => /^(file|data|blob):/.test(url)), `only local requests: ${p.requests.filter((url) => !/^(file|data|blob):/.test(url))}`);
  assert.equal(await p.evaluate('window.isSecureContext !== undefined'), true);
});

test('menu items switch the view and the charts are really drawn', options, async () => {
  const p = await page();
  await p.goto(site(), '#/start');
  await p.waitFor('document.querySelector("#nav a[href=\\"#/view/v1\\"]")');
  await p.evaluate('document.querySelector("#nav a[href=\\"#/view/v1\\"]").click()');
  await p.waitFor('location.hash === "#/view/v1" && document.querySelector("main h2") && document.querySelector(".chart svg")');
  assert.equal(await p.evaluate('document.querySelector("main h2").textContent'), 'Sum of amount per week');
  assert.equal(await p.evaluate('document.querySelector("#nav a[aria-current=page]").getAttribute("href")'), '#/view/v1');
  assert.match(await p.evaluate('document.querySelector(".insight").textContent'), /points from 2024-12-30 to/);
  assert.ok((await chartShapes(p)) >= 5, 'the chart has lines and dots, not only a background');
  assert.equal(await p.evaluate('document.querySelector(".chart svg").getAttribute("role")'), 'img');
  assert.match(await p.evaluate('document.querySelector(".chart svg").getAttribute("aria-label")'), /^Sum of amount per week\. /, 'a screen reader gets the title and the insight');

  // every kind of chart in the sample draws something
  for (const kind of ['bar', 'scatter', 'heatmap']) {
    const id = await p.evaluate(`window.LDV_MANIFEST.views.find(function (v) { return v.kind === "${kind}"; }).id`);
    await p.evaluate(`location.hash = "#/view/${id}"`);
    await p.waitFor(`location.hash === "#/view/${id}" && document.querySelector(".chart svg")`);
    await p.waitFor('(() => { const c = document.querySelector(".chart svg"); return c && c.getBoundingClientRect().width > 0; })()');
    assert.ok((await chartShapes(p)) >= 3, `${kind} chart is drawn`);
  }
  assert.deepEqual(p.errors, []);
  await p.evaluate('location.hash = "#/files"');
  await p.waitFor('document.querySelector("main h2") && document.querySelector("main h2").textContent === "Files"');
  assert.match(await p.evaluate('document.querySelector("main").textContent'), /budget\.xlsx \[Scratch\]: hidden sheet/);
  await p.evaluate('location.hash = "#/nonsense/x"');
  await p.waitFor('document.querySelector("main h1") && document.querySelector("main h1").textContent === "shop"');
});

const viewIdOf = (p, kind, nth = 0) => p.evaluate(`window.LDV_MANIFEST.views.filter(function (v) { return v.kind === "${kind}"; })[${nth}].id`);
async function openView(p, id) {
  await p.evaluate(`location.hash = "#/view/${id}"`);
  await p.waitFor(`location.hash === "#/view/${id}" && document.querySelector(".chart svg") && document.querySelector(".chart svg").getBoundingClientRect().width > 0`);
}
const centerOf = (p, selector) =>
  p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

test('every kind of chart is drawn with its axis titles, labels and marks', options, async () => {
  const p = await page();
  await p.colorScheme('light');
  await p.goto(site(), '#/start');
  await p.waitFor('window.LDV_MANIFEST');

  await openView(p, await viewIdOf(p, 'line'));
  let labels = await chartLabels(p);
  assert.ok(labels.includes('order_date') && labels.includes('Sum of amount'), `both axis titles: ${labels}`);
  assert.ok(labels.some((text) => /^(Jan|Feb|Mar|Apr|May|Jun) 2025$/.test(text)), 'month labels on the time axis');
  assert.ok(labels.includes('0') && labels.some((text) => /K$/.test(text)), 'one number format on the value axis: 0, 10K, 20K');
  assert.equal(await p.evaluate('document.querySelectorAll(".chart svg path").length'), 1, 'one line');

  await openView(p, await viewIdOf(p, 'line', 1));
  await openView(p, await viewIdOf(p, 'bar'));
  labels = await chartLabels(p);
  for (const name of ['Chair', 'Desk', 'Lamp', 'Shelf', 'Sofa', 'Table']) assert.ok(labels.includes(name), `the bar of ${name} is labelled`);
  assert.equal(await p.evaluate('document.querySelectorAll(".chart svg rect[data-tip]").length'), 6, 'one bar per product');
  assert.ok(labels.includes('product') && labels.includes('Sum of amount'));

  await openView(p, await viewIdOf(p, 'scatter'));
  assert.ok((await p.evaluate('document.querySelectorAll(".chart svg circle").length')) > 100, 'a dot per point');
  assert.ok((await chartLabels(p)).includes('product:'), 'the colour legend has its title');
  await openView(p, await viewIdOf(p, 'heatmap'));
  labels = await chartLabels(p);
  assert.equal(await p.evaluate('document.querySelectorAll(".chart svg rect[data-tip]").length'), 24, 'four regions by six products');
  assert.ok(labels.includes('North') && labels.includes('Lamp'), 'rows and columns are labelled');
  assert.ok(labels.filter((text) => /^\d+(\.\d+)?k$/.test(text)).length >= 24, 'every cell shows its number');
  await openView(p, await viewIdOf(p, 'corr'));
  labels = await chartLabels(p);
  assert.ok(labels.includes('amount') && labels.includes('unit_price'));
  assert.equal(labels.filter((text) => text === '1.00').length, 4, 'ones on the diagonal');
  await openView(p, await viewIdOf(p, 'hist'));
  labels = await chartLabels(p);
  assert.ok(labels.includes('Rows') && labels.includes('lifetime_value'));
  const bars = await p.evaluate('document.querySelectorAll(".chart svg rect[data-tip]").length');
  assert.ok(bars >= 10, `bins are drawn (${bars})`);
  assert.deepEqual(p.errors, []);
});

test('hovering a mark shows its numbers in a tip, and a line chart follows the pointer', options, async () => {
  const p = await page();
  await p.resize(1400, 900);
  await openView(p, await viewIdOf(p, 'bar'));
  const bar = await centerOf(p, '.chart svg rect[data-tip]');
  await p.hover(bar.x, bar.y);
  await p.waitFor('document.querySelector(".ldv-tip") && !document.querySelector(".ldv-tip").hidden');
  const tip = await p.evaluate('document.querySelector(".ldv-tip").textContent');
  assert.match(tip, /^Desk\n/, 'the first bar is the one with the most');
  assert.match(tip, /79,6\d\d/, 'its number');
  await p.hover(5, 5);
  await p.waitFor('document.querySelector(".ldv-tip").hidden');

  await openView(p, await viewIdOf(p, 'line', 1));
  const box = await p.evaluate('(() => { const r = document.querySelector(".chart svg rect[fill=transparent]").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()');
  await p.hover(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitFor('!document.querySelector(".ldv-tip").hidden');
  const lineTip = await p.evaluate('document.querySelector(".ldv-tip").textContent');
  assert.match(lineTip, /^\d\d [A-Z][a-z]{2} 2025\n/, 'the date of the nearest point');
  assert.ok(lineTip.split('\n').length >= 2, 'and the value of every line there');
  assert.equal(await p.evaluate('Array.from(document.querySelectorAll(".chart svg line[stroke-dasharray]")).filter(function (l) { return l.getAttribute("visibility") === "visible"; }).length'), 1, 'a guide line');
  await p.hover(5, 5);
});

test('a chart can be saved as an SVG file or a PNG picture, and both look like the chart on screen', options, async () => {
  const p = await page();
  await p.colorScheme('light');
  await openView(p, await viewIdOf(p, 'bar'));
  await p.evaluate('(() => { window.__blobs = []; var original = URL.createObjectURL; URL.createObjectURL = function (blob) { window.__blobs.push(blob); return original.call(URL, blob); }; })()');
  const click = (text) => p.evaluate(`Array.from(document.querySelectorAll("main button")).find(function (b) { return b.textContent === ${JSON.stringify(text)}; }).click()`);
  await click('Save as SVG');
  const svgText = await p.evaluate('window.__blobs[0].text()');
  assert.match(svgText, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(await p.evaluate(`(() => { const doc = new DOMParser().parseFromString(${JSON.stringify(svgText)}, "image/svg+xml"); return doc.querySelector("parsererror") === null && doc.querySelectorAll("rect[data-tip]").length; })()`), 6, 'a valid SVG document with the six bars');
  assert.ok(!/var\(--/.test(svgText), 'colours are written out, so the file looks right anywhere');
  await click('Save as image (PNG)');
  await p.waitFor('window.__blobs.length === 2');
  const png = await p.evaluate('window.__blobs[1].arrayBuffer().then(function (b) { var a = Array.from(new Uint8Array(b).slice(0, 8)); return { type: window.__blobs[1].type, size: b.byteLength, head: a }; })');
  assert.equal(png.type, 'image/png');
  assert.deepEqual(png.head, [137, 80, 78, 71, 13, 10, 26, 10], 'a PNG file');
  assert.ok(png.size > 3000, `the picture has content (${png.size} bytes)`);
  assert.deepEqual(p.errors, []);
});

test('the colours follow the light and dark theme, and the chart is redrawn when the window narrows', options, async () => {
  const p = await page();
  await p.resize(1400, 900);
  await p.colorScheme('light');
  await p.goto(site(), '#/view/v1');
  await p.waitFor('document.querySelector(".chart svg")');
  const fill = () => p.evaluate('document.querySelector(".chart svg text").getAttribute("fill")');
  const background = () => p.evaluate('document.querySelector(".chart svg rect").getAttribute("fill")');
  const lightText = await fill();
  const lightBackground = await background();
  await p.colorScheme('dark');
  await p.goto(site(), '#/view/v1');
  // the page redraws when the colour scheme changes, a moment after it loads, so wait for the new colours rather than read them at once
  await p.waitFor(`document.querySelector(".chart svg text").getAttribute("fill") !== ${JSON.stringify(lightText)} && document.querySelector(".chart svg rect").getAttribute("fill") !== ${JSON.stringify(lightBackground)}`);
  assert.notEqual(await fill(), lightText, 'the text colour changed');
  assert.notEqual(await background(), lightBackground, 'the background changed');
  await p.colorScheme('light');
  await p.goto(site(), '#/view/v1');
  await p.waitFor('document.querySelector(".chart svg")');
  const wide = await p.evaluate('Math.round(document.querySelector(".chart svg").getBoundingClientRect().width)');
  await p.resize(700, 900);
  await p.waitFor(`Math.round(document.querySelector(".chart svg").getBoundingClientRect().width) < ${wide - 100}`);
  assert.ok(await p.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll');
  await p.resize(1400, 900);
});

test('filters are said on the page: above each chart, in the overview and in the explorer', options, async () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'shop');
  makeSampleFolder(root);
  const plan = {
    version: 1,
    title: 'North only',
    filters: [{ dataset: 'ds1', column: 'region', op: 'in', values: ['North', 'South'] }],
    views: [
      { id: 'a', kind: 'bar', dataset: 'ds1', x: 'product', measure: { column: 'amount', agg: 'sum' } },
      { id: 'b', kind: 'bar', dataset: 'ds1', x: 'product', measure: { column: 'amount', agg: 'sum' }, filters: [{ column: 'quantity', op: '>=', value: 5 }] },
      { id: 'c', kind: 'bar', dataset: 'ds2', x: 'segment' },
    ],
    explorers: [{ dataset: 'ds1', dimensions: ['product', 'channel'], measures: [{ column: 'amount', agg: 'sum' }], filters: [{ column: 'discount', op: '<', value: 0.2 }] }],
  };
  fs.writeFileSync(path.join(tmp, 'plan.json'), JSON.stringify(plan));
  const built = runViz(['build', root, '--plan', path.join(tmp, 'plan.json')]);
  assert.equal(built.code, 0, built.stderr);
  const index = path.join(builtFolder(built.stdout), 'index.html');
  const p = await page();
  await p.colorScheme('light');
  await p.goto(index, '#/view/a');
  await p.waitFor('document.querySelector(".chart svg")');
  assert.equal(await p.evaluate('document.querySelector(".filters").textContent'), 'Only rows where: region is one of North, South');
  assert.equal(await p.evaluate('document.querySelectorAll(".chart svg rect[data-tip]").length'), 6);
  await p.goto(index, '#/view/b');
  await p.waitFor('document.querySelector(".chart svg")');
  assert.equal(await p.evaluate('document.querySelector(".filters").textContent'), 'Only rows where: region is one of North, South; quantity >= 5');
  await p.goto(index, '#/view/c');
  await p.waitFor('document.querySelector(".chart svg")');
  assert.equal(await p.evaluate('document.querySelector(".filters")'), null, 'a dataset without filters says nothing');
  await p.goto(index, '#/overview/ds1');
  await p.waitFor('document.querySelector(".kpis")');
  assert.match(await p.evaluate('document.querySelector(".kpis").textContent'), /\d+ of 720Rows kept/);
  assert.match(await p.evaluate('document.querySelector(".filters").textContent'), /region is one of North, South/);
  await p.goto(index, '#/explorer/ds1');
  await p.waitFor('document.querySelector(".chart svg")');
  assert.equal(await p.evaluate('document.querySelector(".filters").textContent'), 'Only rows where: region is one of North, South; discount < 0.2');
  assert.deepEqual(p.errors, []);
});

test('the splitter changes the menu width with the mouse and the keyboard, within limits, and the chart follows', options, async () => {
  const p = await page();
  await p.resize(1400, 900);
  await p.goto(site(), '#/view/v1');
  await p.waitFor('document.querySelector(".chart svg") && document.querySelector(".chart svg").getBoundingClientRect().width > 0');
  assert.equal(await navWidth(p), 300);
  const chartWidth = () => p.evaluate('Math.round(document.querySelector(".chart svg").getBoundingClientRect().width)');
  const wide = await chartWidth();

  const box = await p.evaluate('(() => { const r = document.getElementById("splitter").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await p.drag(box.x, box.y, 500, box.y);
  assert.equal(await navWidth(p), 500, 'the menu is as wide as the pointer');
  assert.equal(await p.evaluate('document.getElementById("splitter").getAttribute("aria-valuenow")'), '500');
  await p.waitFor(`(() => { const c = document.querySelector(".chart svg"); return c && Math.round(c.getBoundingClientRect().width) < ${wide - 150}; })()`);
  assert.ok((await chartWidth()) < wide - 150, 'the chart got narrower');

  const box2 = await p.evaluate('(() => { const r = document.getElementById("splitter").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await p.drag(box2.x, box2.y, 5, box2.y);
  assert.equal(await navWidth(p), 180, 'not narrower than the minimum');
  const box3 = await p.evaluate('(() => { const r = document.getElementById("splitter").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await p.drag(box3.x, box3.y, 1390, box3.y);
  assert.equal(await navWidth(p), 840, 'not wider than 60% of the window');

  await p.evaluate('document.getElementById("splitter").focus()');
  await p.key('ArrowLeft', 'ArrowLeft', 37);
  assert.equal(await navWidth(p), 820);
  await p.key('Home', 'Home', 36);
  assert.equal(await navWidth(p), 180);
  await p.key('ArrowRight', 'ArrowRight', 39);
  assert.equal(await navWidth(p), 200);

  // the width is remembered when the browser allows storage
  if (await p.evaluate('(() => { try { localStorage.setItem("t", "1"); return true; } catch (e) { return false; } })()')) {
    await p.goto(site(), '#/start');
    assert.equal(await navWidth(p), 200, 'the width survives a reload');
  }
  await p.evaluate('document.getElementById("splitter").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
  assert.equal(await navWidth(p), 300, 'a double click resets it');
  assert.deepEqual(p.errors, []);
});

test('the explorer groups and splits the pre-computed numbers', options, async () => {
  const p = await page();
  await p.goto(site(), '#/explorer/ds1');
  await p.waitFor('document.querySelectorAll("main select").length === 3 && document.querySelector(".chart svg")');
  const labels = await p.evaluate('Array.from(document.querySelectorAll("main label")).map(function (l) { return l.firstChild.textContent; })');
  assert.deepEqual(labels, ['Measure', 'Group by', 'Split by']);
  assert.equal(await p.evaluate('document.querySelector("main table th").textContent'), 'order_date');

  const choose = (index, text) =>
    p.evaluate(`(() => { const s = document.querySelectorAll("main select")[${index}]; const o = Array.from(s.options).find(function (x) { return x.textContent === ${JSON.stringify(text)}; }); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await choose(1, 'region');
  await p.waitFor('document.querySelector("main table th") && document.querySelector("main table th").textContent === "region"');
  await p.waitFor('document.querySelectorAll("main tbody tr").length === 4');
  const rows = await p.evaluate('Array.from(document.querySelectorAll("main tbody tr")).map(function (tr) { return tr.children[0].textContent; })');
  assert.deepEqual([...rows].sort(), ['East', 'North', 'South', 'West']);
  await choose(2, 'product');
  await p.waitFor('document.querySelectorAll("main thead th").length === 3');
  assert.equal(await p.evaluate('document.querySelectorAll("main tbody tr").length'), 24);
  assert.ok((await chartShapes(p)) >= 3);
  await choose(0, 'Rows');
  await p.waitFor('document.querySelectorAll("main thead th")[2].textContent === "Rows"');
  const total = await p.evaluate('Array.from(document.querySelectorAll("main tbody tr")).reduce(function (sum, tr) { return sum + Number(tr.children[2].textContent.replace(/,/g, "")); }, 0)');
  assert.equal(total, 720, 'the rows add up to the row count');
  assert.ok(await p.evaluate('Array.from(document.querySelectorAll("main button")).some(function (b) { return b.textContent === "Download as CSV"; })'));
  assert.deepEqual(p.errors, []);
});

test('dark mode, a narrow window, and no sideways scrolling', options, async () => {
  const p = await page();
  await p.colorScheme('dark');
  await p.goto(site(), '#/start');
  const dark = await p.evaluate('getComputedStyle(document.body).backgroundColor');
  await p.colorScheme('light');
  await p.goto(site(), '#/start');
  const light = await p.evaluate('getComputedStyle(document.body).backgroundColor');
  assert.notEqual(dark, light);
  assert.equal(light, 'rgb(255, 255, 255)');
  await p.resize(520, 800);
  await p.goto(site(), '#/view/v1');
  await p.waitFor('document.querySelector(".chart svg") && document.querySelector(".chart svg").getBoundingClientRect().width > 0');
  assert.equal(await p.evaluate('getComputedStyle(document.getElementById("splitter")).display'), 'none');
  assert.ok(await p.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll');
  const nav = await p.evaluate('(() => { const n = document.getElementById("nav").getBoundingClientRect(); const m = document.getElementById("main").getBoundingClientRect(); return { navBottom: n.bottom, mainTop: m.top }; })()');
  assert.ok(nav.mainTop >= nav.navBottom - 1, 'the menu sits above the page on a narrow screen');
  await p.resize(1400, 900);
});

test('hostile names and values are shown as plain text and run nothing', options, async () => {
  const tmp = makeTmp();
  const root = path.join(tmp, 'evil');
  fs.mkdirSync(root);
  const img = '<img src=x onerror="window.__pwned=1">';
  const quote = (text) => `"${text.replace(/"/g, '""')}"`;
  const lines = [['when', img, 'amount', '<b>bold</b> city'].map(quote).join(',')];
  for (let i = 0; i < 60; i += 1) lines.push([`2025-02-${String(1 + (i % 28)).padStart(2, '0')}`, ['<script>window.__pwned=2</script>', '=cmd|calc', '@SUM(1)'][i % 3], String(10 + i), ['<i>x</i>', 'y'][i % 2]].map(quote).join(','));
  fs.writeFileSync(path.join(root, '<img src=x onerror=window.__pwned=3>.csv'.replace(/[<>"]/g, '_')), `${lines.join('\n')}\n`);
  const built = runViz(['build', root]);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  const index = path.join(builtFolder(built.stdout), 'index.html');
  const p = await page();
  await p.colorScheme('light');
  await p.goto(index, '#/overview/ds1');
  await p.waitFor('document.querySelector("main table")');
  assert.equal(await p.evaluate('document.querySelectorAll("main img, main script, main b, main i").length'), 0, 'no element was made from the data');
  assert.equal(await p.evaluate('typeof window.__pwned'), 'undefined');
  assert.match(await p.evaluate('document.querySelector("main table").textContent'), /<img src=x onerror="window\.__pwned=1">/);
  const views = await p.evaluate('window.LDV_MANIFEST.views.map(function (v) { return v.id; })');
  for (const id of views.slice(0, 4)) {
    await p.evaluate(`location.hash = "#/view/${id}"`);
    await p.waitFor(`location.hash === "#/view/${id}" && (document.querySelector(".chart svg") || /\\S/.test(document.querySelector(".chart") ? document.querySelector(".chart").textContent : ""))`);
  }
  const seen = [];
  for (const id of views.slice(0, 6)) {
    await p.evaluate(`location.hash = "#/view/${id}"`);
    await p.waitFor(`location.hash === "#/view/${id}" && document.querySelector(".chart svg")`);
    assert.equal(await p.evaluate('document.querySelectorAll(".chart svg img, .chart svg script, .chart svg foreignObject, .chart svg [onerror]").length'), 0, 'no element was made from the data inside a chart');
    seen.push(...(await chartLabels(p)));
  }
  assert.ok(seen.some((text) => /<img src=x onerror/.test(text) || /<script>window/.test(text)), 'hostile names and values are drawn as plain text');
  await p.goto(index, '#/explorer/ds1');
  await p.waitFor('document.querySelector("main select")');
  assert.equal(await p.evaluate('typeof window.__pwned'), 'undefined');

  // the CSV download neutralises cells that a spreadsheet would run as formulas
  const choose = `(() => { const s = document.querySelectorAll("main select")[1]; const o = Array.from(s.options).find(function (x) { return x.textContent === ${JSON.stringify(img)}; }); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`;
  await p.evaluate(choose);
  await p.waitFor('document.querySelectorAll("main tbody tr").length === 3');
  await p.evaluate('(() => { window.__blobs = []; var original = URL.createObjectURL; URL.createObjectURL = function (blob) { window.__blobs.push(blob); return original.call(URL, blob); }; })()');
  await p.evaluate('Array.from(document.querySelectorAll("main button")).find(function (b) { return b.textContent === "Download as CSV"; }).click()');
  const csv = await p.evaluate('window.__blobs[0].text()');
  assert.ok(csv.includes("'=cmd|calc") && csv.includes("'@SUM(1)"), `formula-like cells are prefixed: ${csv}`);
  assert.ok(!/(^|,)=cmd/m.test(csv) && !/(^|,)@SUM/m.test(csv));
  assert.deepEqual(p.errors, []);
});
