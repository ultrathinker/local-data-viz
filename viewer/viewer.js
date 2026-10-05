// The page: a menu on the left, a splitter you can drag, and the charts on the right.
// Everything shown comes from data/manifest.js and data/*.js next to this page. No network, and no HTML is ever built from
// strings: text from the data is only put in with textContent, so a strange file name or column name cannot do anything.
(function () {
  'use strict';

  var manifest = window.LDV_MANIFEST;
  var app = document.getElementById('app');
  var nav = document.getElementById('nav');
  var main = document.getElementById('main');
  var splitter = document.getElementById('splitter');

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  if (!manifest || typeof window.LDVCharts === 'undefined') {
    main.textContent = 'This page could not load its data or its chart library. Keep the whole folder together (index.html, assets, data) and open index.html from it.';
    return;
  }
  document.title = manifest.title;

  var numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  function fmt(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'number' ? numberFormat.format(value) : String(value);
  }
  function datasetById(id) {
    return manifest.datasets.filter(function (d) { return d.id === id; })[0];
  }
  function viewById(id) {
    return manifest.views.filter(function (v) { return v.id === id; })[0];
  }

  /* ---------- splitter ---------- */
  var DEFAULT_NAV = 300;
  var MIN_NAV = 180;
  var STORE_KEY = 'local-data-viz.nav-width';
  function maxNav() { return Math.max(MIN_NAV, Math.round(window.innerWidth * 0.6)); }
  function setNav(px, save) {
    var width = Math.min(maxNav(), Math.max(MIN_NAV, Math.round(px)));
    app.style.setProperty('--nav-width', width + 'px');
    splitter.setAttribute('aria-valuemin', String(MIN_NAV));
    splitter.setAttribute('aria-valuemax', String(maxNav()));
    splitter.setAttribute('aria-valuenow', String(width));
    if (save) {
      try { window.localStorage.setItem(STORE_KEY, String(width)); } catch (e) { /* storage may be blocked: the width just is not remembered */ }
    }
    scheduleResize();
    return width;
  }
  var resizePending = false;
  function scheduleResize() {
    if (resizePending) return;
    resizePending = true;
    window.requestAnimationFrame(function () {
      resizePending = false;
      window.dispatchEvent(new Event('resize'));
    });
  }
  var stored = null;
  try { stored = Number(window.localStorage.getItem(STORE_KEY)); } catch (e) { stored = null; }
  setNav(stored && isFinite(stored) ? stored : DEFAULT_NAV, false);

  var dragging = false;
  function onMove(event) {
    if (dragging) setNav(event.clientX - app.getBoundingClientRect().left, false);
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', endDrag, true);
    document.removeEventListener('pointercancel', endDrag, true);
    setNav(Number(splitter.getAttribute('aria-valuenow')), true);
  }
  splitter.addEventListener('pointerdown', function (event) {
    dragging = true;
    try { splitter.setPointerCapture(event.pointerId); } catch (e) { /* the document listeners below still follow the pointer */ }
    document.body.classList.add('dragging');
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
    event.preventDefault();
  });
  splitter.addEventListener('dblclick', function () { setNav(DEFAULT_NAV, true); });
  splitter.addEventListener('keydown', function (event) {
    var now = Number(splitter.getAttribute('aria-valuenow'));
    var step = event.shiftKey ? 80 : 20;
    var target = null;
    if (event.key === 'ArrowLeft') target = now - step;
    else if (event.key === 'ArrowRight') target = now + step;
    else if (event.key === 'Home') target = MIN_NAV;
    else if (event.key === 'End') target = maxNav();
    if (target === null) return;
    event.preventDefault();
    setNav(target, true);
  });
  window.addEventListener('resize', function () {
    if (!dragging) setNav(Number(splitter.getAttribute('aria-valuenow')), false);
  });

  /* ---------- data files ---------- */
  window.LDV_DATA = window.LDV_DATA || {};
  function loadData(id) {
    if (window.LDV_DATA[id]) return Promise.resolve(window.LDV_DATA[id]);
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'data/' + encodeURIComponent(id) + '.js';
      script.onload = function () {
        if (window.LDV_DATA[id]) resolve(window.LDV_DATA[id]);
        else reject(new Error('the data file for ' + id + ' is empty'));
      };
      script.onerror = function () { reject(new Error('could not load data/' + id + '.js')); };
      document.head.appendChild(script);
    });
  }

  /* ---------- charts ---------- */
  var current = null;
  var token = 0;
  /* Draws one chart (see charts.js) and remembers it, so the next screen can let go of it. */
  function drawChart(container, spec, values, label) {
    if (current) current.destroy();
    current = window.LDVCharts.draw(container, spec, values, { label: label });
    return current;
  }
  function saveBlob(name, blob) {
    var url = URL.createObjectURL(blob);
    var anchor = el('a', { href: url, download: name });
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  /* Two buttons that save the chart on screen as an SVG file or a PNG picture. */
  function chartActions(name, container) {
    function handle() { return container.__chart || null; }
    return el('p', { class: 'chart-actions' }, [
      el('button', { class: 'button', type: 'button', text: 'Save as image (PNG)', onclick: function () {
        var chart = handle();
        if (chart) chart.png().then(function (blob) { saveBlob(name + '.png', blob); }).catch(function (error) { container.appendChild(el('p', { class: 'muted', text: String(error.message) })); });
      } }),
      el('button', { class: 'button', type: 'button', text: 'Save as SVG', onclick: function () {
        var chart = handle();
        if (chart) saveBlob(name + '.svg', new Blob([chart.svgText()], { type: 'image/svg+xml' }));
      } })
    ]);
  }
  function fileName(text) {
    return String(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chart';
  }

  /* ---------- pieces ---------- */
  function kpiBox(label, value) {
    return el('div', { class: 'kpi' }, [el('div', { class: 'value', text: value }), el('div', { class: 'label', text: label })]);
  }
  function table(headers, rows, numericFrom, numericTo) {
    function numeric(i) { return numericFrom !== undefined && i >= numericFrom && (numericTo === undefined || i <= numericTo); }
    var head = el('tr', {}, headers.map(function (h, i) { return el('th', { class: numeric(i) ? 'num' : '', text: h }); }));
    var body = rows.map(function (row) {
      return el('tr', {}, row.map(function (cell, i) { return el('td', { class: numeric(i) ? 'num' : '', text: cell }); }));
    });
    return el('div', { class: 'table-wrap' }, [el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)])]);
  }
  function link(href, text) { return el('a', { href: href, text: text }); }
  /* "120 of 4,000" when the page's filters keep only some of a dataset's rows. */
  function isKept(d) { return d.keptRows !== null && d.keptRows !== undefined; }
  function rowsText(d) { return isKept(d) ? fmt(d.keptRows) + ' of ' + fmt(d.rows) : fmt(d.rows); }
  /* The rows a chart, an explorer or a whole dataset is limited to, said in words (the plan's filters). */
  function filtersLine(list) {
    if (!list || !list.length) return null;
    return el('p', { class: 'filters' }, [el('strong', { text: 'Only rows where: ' }), list.join('; ')]);
  }
  function csvCell(value) {
    var text = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  function downloadCsv(name, header, rows) {
    var lines = [header.map(csvCell).join(',')].concat(rows.map(function (row) { return row.map(csvCell).join(','); }));
    var url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n'], { type: 'text/csv' }));
    var anchor = el('a', { href: url, download: name });
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------- screens ---------- */
  function renderStart() {
    var inv = manifest.inventory;
    var cards = manifest.datasets.map(function (d) {
      var firstViews = manifest.views.filter(function (v) { return v.dataset === d.id; }).slice(0, 3);
      return el('div', { class: 'card' }, [
        el('h3', { text: d.name }),
        el('p', { class: 'muted', text: rowsText(d) + ' rows, ' + d.columns.length + ' columns, ' + d.files.length + (d.files.length === 1 ? ' file' : ' files') }),
        filtersLine(d.filters),
        d.dateRange ? el('p', { class: 'muted', text: d.dateRange.column + ': ' + d.dateRange.from + ' to ' + d.dateRange.to }) : null,
        el('div', { class: 'links' }, [link('#/overview/' + d.id, 'Overview')].concat(firstViews.map(function (v) { return link('#/view/' + v.id, v.title); })).concat(d.explorer ? [link('#/explorer/' + d.id, 'Explorer')] : []))
      ]);
    });
    var summary = manifest.datasets.length + (manifest.datasets.length === 1 ? ' dataset' : ' datasets') + ', ' +
      manifest.views.length + (manifest.views.length === 1 ? ' chart' : ' charts') + ', from the folder "' + inv.folderName + '". ';
    return [
      el('h1', { text: manifest.title }),
      el('p', { class: 'muted', text: summary + 'Pick a view in the menu. Drag the bar between the menu and this area to change the menu width.' }),
      el('div', { class: 'cards' }, cards),
      inv.failed.length ? el('div', { class: 'notice', text: inv.failed.length + ' chart(s) could not be built; see Files.' }) : null
    ];
  }

  function renderOverview(id) {
    var d = datasetById(id);
    var header = ['Column', 'Type', 'Kind', 'Missing %', 'Distinct', 'Min', 'Max', 'Mean', 'Common values'];
    var KIND_NAME = { dimension_high: 'category (many)', dimension: 'category', measure: 'number', temporal: 'date/time' };
    function bound(c, value) {
      if (c.role !== 'measure' && c.role !== 'temporal') return '';
      if (value === null || value === undefined) return '';
      return typeof value === 'number' ? fmt(value) : String(value).slice(0, 10);
    }
    function common(c) {
      return (c.top || []).slice(0, 5).map(function (t) { return t.value + ' (' + fmt(t.count) + ')'; }).join(', ');
    }
    var rows = d.columns.map(function (c) {
      return [c.name, c.type, KIND_NAME[c.role] || c.role, fmt(c.nullPct), fmt(c.unique), bound(c, c.min), bound(c, c.max), c.role === 'measure' ? fmt(c.mean) : '', common(c)];
    });
    var views = manifest.views.filter(function (v) { return v.dataset === id; });
    return [
      el('h2', { text: d.name + ': overview' }),
      el('p', { class: 'muted', text: 'Read from ' + d.files.length + (d.files.length === 1 ? ' file' : ' files') + '.' }),
      filtersLine(d.filters),
      el('div', { class: 'kpis' }, [kpiBox(isKept(d) ? 'Rows kept' : 'Rows', rowsText(d)), kpiBox('Columns', fmt(d.columns.length))].concat(d.dateRange ? [kpiBox(d.dateRange.column, d.dateRange.from + ' to ' + d.dateRange.to)] : []).concat(d.kpis.map(function (k) { return kpiBox(k.label, k.value); }))),
      d.quality.length ? el('div', { class: 'notice' }, [el('strong', { text: 'Worth knowing' }), el('ul', { class: 'plain' }, d.quality.map(function (q) { return el('li', { text: q }); }))]) : null,
      el('h3', { text: 'Columns' }),
      table(header, rows, 3, 7),
      d.correlations.length ? el('h3', { text: 'Strongest relationships between numbers' }) : null,
      d.correlations.length ? el('ul', { class: 'plain' }, d.correlations.map(function (p) { return el('li', { text: p.a + ' and ' + p.b + ': ' + p.r.toFixed(2) }); })) : null,
      views.length ? el('h3', { text: 'Charts' }) : null,
      views.length ? el('ul', { class: 'plain' }, views.map(function (v) { return el('li', {}, [link('#/view/' + v.id, v.title)]); })) : null
    ];
  }

  function renderView(id, myToken) {
    var v = viewById(id);
    var container = el('div', { class: 'chart' }, [el('p', { class: 'muted', text: 'Loading the chart...' })]);
    loadData(id).then(function (rows) {
      if (myToken !== token) return;
      container.textContent = '';
      container.__chart = drawChart(container, v.spec, rows, v.title + '. ' + v.insight);
    }).catch(function (error) {
      if (myToken === token) container.textContent = String(error.message);
    });
    return [
      el('h2', { text: v.title }),
      el('p', { class: 'insight', text: v.insight }),
      filtersLine(v.filters),
      v.note ? el('p', { class: 'muted', text: v.note }) : null,
      container,
      chartActions(fileName(v.title), container),
      el('p', { class: 'muted', text: fmt(v.rows) + (v.rows === 1 ? ' row' : ' rows') + ' drawn.' })
    ];
  }

  var explorerState = {};
  function cubeRows(cube, by, split, m) {
    if (split < 0) {
      var one = cube.groups[String(by)];
      return one ? one.map(function (r) { return { k: r[0], v: r[1 + m] }; }) : null;
    }
    var lo = Math.min(by, split);
    var hi = Math.max(by, split);
    var pair = cube.groups[lo + ',' + hi];
    if (!pair) return null;
    return pair.map(function (r) {
      return by === lo ? { k: r[0], g: r[1], v: r[2 + m] } : { k: r[1], g: r[0], v: r[2 + m] };
    });
  }
  /* The chart spec (see charts.js) for the explorer's current choice: a line over time, or bars for a category. */
  function explorerSpec(dim, dimLabel, splitLabel, measureLabel, hasSplit) {
    var spec = dim.kind === 'time' ? { type: 'line', xTitle: dimLabel, yTitle: measureLabel, grain: dim.grain } : { type: 'bar', yTitle: dimLabel, xTitle: measureLabel };
    if (hasSplit) spec.colorTitle = splitLabel;
    return spec;
  }
  /* The explorer's rows are { k, v, g }; a line chart wants the time under t. */
  function explorerRows(dim, rows) {
    return dim.kind === 'time' ? rows.map(function (r) { return r.g === undefined ? { t: r.k, v: r.v } : { t: r.k, v: r.v, g: r.g }; }) : rows;
  }

  function renderExplorer(id, myToken) {
    var d = datasetById(id);
    var body = el('div', {}, [el('p', { class: 'muted', text: 'Loading...' })]);
    loadData('cube-' + id).then(function (cube) {
      if (myToken !== token) return;
      var state = explorerState[id];
      if (!state) {
        state = explorerState[id] = { measure: cube.measures.length > 1 ? 1 : 0, by: 0, split: -1 };
      }
      function option(value, text, selected) { return el('option', { value: String(value), text: text, selected: selected }); }
      function draw() {
        if (myToken !== token) return;
        var dim = cube.dims[state.by];
        var rows = cubeRows(cube, state.by, state.split, state.measure);
        result.textContent = '';
        if (rows === null) {
          result.appendChild(el('div', { class: 'notice', text: 'This combination has too many groups to pre-compute. Pick a different split.' }));
          return;
        }
        var measure = cube.measures[state.measure];
        var splitLabel = state.split >= 0 ? cube.dims[state.split].label : '';
        if (dim.kind === 'time') rows = rows.filter(function (r) { return r.k !== '(empty)'; });
        var note = '';
        if (dim.kind !== 'time') {
          var totals = {};
          rows.forEach(function (r) { totals[r.k] = (totals[r.k] || 0) + (r.v || 0); });
          var keys = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
          if (keys.length > 30) {
            var keep = {};
            keys.slice(0, 30).forEach(function (k) { keep[k] = true; });
            rows = rows.filter(function (r) { return keep[r.k]; });
            note = 'Showing the top 30 of ' + keys.length + ' values.';
          }
        }
        var chart = el('div', { class: 'chart' });
        result.appendChild(chart);
        result.appendChild(chartActions(fileName(measure.label + ' by ' + dim.label), chart));
        if (note) result.appendChild(el('p', { class: 'muted', text: note }));
        try {
          chart.__chart = drawChart(chart, explorerSpec(dim, dim.label + (dim.grain ? ' (' + dim.grain + ')' : ''), splitLabel, measure.label, state.split >= 0), explorerRows(dim, rows), measure.label + ' by ' + dim.label + (splitLabel ? ' and ' + splitLabel : ''));
        } catch (error) {
          chart.textContent = String(error.message);
        }
        var header = [dim.label].concat(state.split >= 0 ? [splitLabel] : []).concat([measure.label]);
        var sorted = rows.slice().sort(dim.kind === 'time' ? function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; } : function (a, b) { return (b.v || 0) - (a.v || 0); });
        var tableRows = sorted.map(function (r) { return [r.k].concat(state.split >= 0 ? [r.g] : []).concat([r.v]); });
        result.appendChild(el('h3', { text: 'Numbers' }));
        result.appendChild(el('p', {}, [el('button', { class: 'button', type: 'button', text: 'Download as CSV', onclick: function () { downloadCsv('explorer.csv', header, tableRows); } })]));
        result.appendChild(table(header, tableRows.slice(0, 200).map(function (row) { return row.map(fmt); }), header.length - 1));
        if (tableRows.length > 200) result.appendChild(el('p', { class: 'muted', text: 'The first 200 of ' + tableRows.length + ' rows are shown; the CSV has all of them.' }));
      }
      function select(label, options, onchange) {
        return el('label', {}, [label, el('select', { onchange: onchange }, options)]);
      }
      var result = el('div', {});
      var controls = el('div', { class: 'controls' }, [
        select('Measure', cube.measures.map(function (m, i) { return option(i, m.label, i === state.measure); }), function (e) { state.measure = Number(e.target.value); draw(); }),
        select('Group by', cube.dims.map(function (dim, i) { return option(i, dim.label, i === state.by); }), function (e) {
          state.by = Number(e.target.value);
          if (state.split === state.by) state.split = -1;
          render();
        }),
        select('Split by', [option(-1, 'Nothing', state.split < 0)].concat(cube.dims.map(function (dim, i) { return i === state.by ? null : option(i, dim.label, i === state.split); })), function (e) { state.split = Number(e.target.value); draw(); })
      ]);
      body.textContent = '';
      body.appendChild(controls);
      body.appendChild(result);
      draw();
    }).catch(function (error) {
      if (myToken === token) body.textContent = String(error.message);
    });
    return [
      el('h2', { text: d.name + ': explorer' }),
      el('p', { class: 'insight', text: 'Pick a measure and a column to group by; add a second column to split. The numbers were summed up ahead of time, so this is instant. Only single columns and pairs of columns are available.' }),
      filtersLine(d.explorerFilters),
      body
    ];
  }

  function renderFiles() {
    var inv = manifest.inventory;
    var types = Object.keys(inv.ignoredByType);
    return [
      el('h2', { text: 'Files' }),
      el('p', { class: 'muted', text: inv.files.length + ' data files were read from "' + inv.folderName + '".' }),
      inv.notes.length ? el('div', { class: 'notice' }, inv.notes.map(function (n) { return el('p', { text: n }); })) : null,
      inv.failed.length ? el('h3', { text: 'Not built' }) : null,
      inv.failed.length ? el('ul', { class: 'plain' }, inv.failed.map(function (f) { return el('li', { text: f.title + ': ' + f.reason }); })) : null,
      table(['File', 'Kind', 'Size (KB)'], inv.files.map(function (f) { return [f.path, f.kind, fmt(Math.max(1, Math.round(f.bytes / 1024)))]; }), 2),
      inv.skipped.length ? el('h3', { text: 'Skipped' }) : null,
      inv.skipped.length ? el('ul', { class: 'plain' }, inv.skipped.map(function (s) { return el('li', { text: s.file + ': ' + s.reason }); })) : null,
      types.length ? el('h3', { text: 'Other files, not read' }) : null,
      types.length ? el('p', { class: 'muted', text: types.map(function (t) { return t + ' x' + inv.ignoredByType[t]; }).join(', ') }) : null
    ];
  }

  /* ---------- menu and routing ---------- */
  var KIND_TAG = { line: 'line', bar: 'bar', hist: 'hist', scatter: 'scatter', heatmap: 'map', corr: 'corr' };
  function buildNav() {
    nav.textContent = '';
    nav.appendChild(el('div', { class: 'brand', text: manifest.title }));
    nav.appendChild(link('#/start', 'Start'));
    manifest.datasets.forEach(function (d) {
      nav.appendChild(el('div', { class: 'group', text: d.name }));
      var sub = el('div', { class: 'sub' });
      sub.appendChild(link('#/overview/' + d.id, 'Overview'));
      manifest.views.filter(function (v) { return v.dataset === d.id; }).forEach(function (v) {
        sub.appendChild(el('a', { href: '#/view/' + v.id }, [el('span', { class: 'tag', text: KIND_TAG[v.kind] }), v.title]));
      });
      if (d.explorer) sub.appendChild(link('#/explorer/' + d.id, 'Explorer'));
      nav.appendChild(sub);
    });
    nav.appendChild(el('div', { class: 'group', text: 'About' }));
    nav.appendChild(el('div', { class: 'sub' }, [link('#/files', 'Files')]));
  }

  function parseRoute() {
    var parts = (location.hash || '#/start').replace(/^#\/?/, '').split('/').map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return ''; }
    });
    return { name: parts[0] || 'start', id: parts[1] || '' };
  }

  function render() {
    token += 1;
    var myToken = token;
    if (current) { current.destroy(); current = null; }
    var route = parseRoute();
    var content;
    var hash = '#/start';
    if (route.name === 'overview' && datasetById(route.id)) { content = renderOverview(route.id); hash = '#/overview/' + route.id; }
    else if (route.name === 'view' && viewById(route.id)) { content = renderView(route.id, myToken); hash = '#/view/' + route.id; }
    else if (route.name === 'explorer' && datasetById(route.id) && datasetById(route.id).explorer) { content = renderExplorer(route.id, myToken); hash = '#/explorer/' + route.id; }
    else if (route.name === 'files') { content = renderFiles(); hash = '#/files'; }
    else content = renderStart();
    main.textContent = '';
    content.forEach(function (node) { if (node) main.appendChild(node); });
    Array.prototype.forEach.call(nav.querySelectorAll('a'), function (a) {
      if (a.getAttribute('href') === hash) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    main.scrollTop = 0;
  }

  buildNav();
  window.addEventListener('hashchange', function () { render(); main.focus({ preventScroll: true }); });
  if (window.matchMedia) {
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    if (query.addEventListener) query.addEventListener('change', render);
  }
  render();
})();
