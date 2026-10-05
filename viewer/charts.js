// The charts of the page, drawn as plain SVG (no chart library). A chart is a small spec made by the build (a type and axis titles, as
// text) plus the rows of its data file. Nothing is built from strings as HTML: every label goes in with textContent, so a strange
// column name or value is only ever shown as text. Colours are read from the page's theme when a chart is drawn and written into the
// SVG itself, so the same SVG can be saved as a file or a PNG and looks the same there.
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var PALETTE = ['#4c78a8', '#f58518', '#54a24b', '#e45756', '#72b7b2', '#eeca3b', '#b279a2', '#ff9da6', '#9d755d', '#bab0ac'];
  var FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var FONT = '12px ' + FONT_FAMILY;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAY = 86400000;
  var uid = 0;
  var SEP = String.fromCharCode(0);

  var measureContext = document.createElement('canvas').getContext('2d');
  function textWidth(text, font) {
    measureContext.font = font || FONT;
    return measureContext.measureText(String(text)).width;
  }
  function ellipsize(text, maxPx, font) {
    text = String(text);
    if (textWidth(text, font) <= maxPx) return text;
    var lo = 0;
    var hi = text.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (textWidth(text.slice(0, mid) + '...', font) <= maxPx) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + '...';
  }

  var numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  var compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  function fmt(value) {
    return value === null || value === undefined || !isFinite(value) ? '' : numberFormat.format(value);
  }
  function fmtShort(value) {
    return Math.abs(value) >= 10000 ? compactFormat.format(value) : fmt(value);
  }
  /* An axis label: as few digits as the tick step needs, compact for big numbers. */
  function fmtTick(value, step, compact) {
    if (compact) return compactFormat.format(value);
    var decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log(step) / Math.LN10 - 1e-9));
    return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  }
  /* A number inside a heatmap cell: three significant digits, with k, M, G for big ones. */
  function fmtCell(value) {
    var abs = Math.abs(value);
    if (abs >= 1e9) return trim(value / 1e9) + 'G';
    if (abs >= 1e6) return trim(value / 1e6) + 'M';
    if (abs >= 1e3) return trim(value / 1e3) + 'k';
    return trim(value);
  }
  function trim(value) {
    var text = Number(value.toPrecision(3)).toString();
    return text;
  }

  /* ---------- little SVG helpers ---------- */
  function node(tag, attrs, text) {
    var element = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (name) {
      var value = attrs[name];
      if (value === null || value === undefined) return;
      element.setAttribute(name, String(value));
    });
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  function add(parent, tag, attrs, text) {
    var child = node(tag, attrs, text);
    parent.appendChild(child);
    return child;
  }

  function theme() {
    var style = getComputedStyle(document.documentElement);
    function read(name, fallback) {
      var value = style.getPropertyValue(name).trim();
      return value || fallback;
    }
    return { fg: read('--fg', '#1b1f24'), muted: read('--muted', '#5d6671'), grid: read('--grid', '#e5e8ec'), bg: read('--card', '#ffffff'), accent: read('--accent', '#2563eb') };
  }

  /* ---------- scales and ticks ---------- */
  function linear(d0, d1, r0, r1) {
    var span = d1 - d0;
    return function (value) { return span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0); };
  }
  function niceStep(range, target) {
    var raw = range / Math.max(1, target);
    var power = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / power;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * power;
  }
  function clean(value) { return Number(value.toPrecision(12)); }
  /* A rounded domain that holds [lo, hi], with its ticks. */
  function niceDomain(lo, hi, target) {
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    var step = niceStep(hi - lo, target);
    var from = clean(Math.floor(lo / step) * step);
    var to = clean(Math.ceil(hi / step) * step);
    var ticks = [];
    for (var v = from; v <= to + step * 1e-9; v = clean(v + step)) ticks.push(clean(v));
    return { lo: from, hi: to, step: step, ticks: ticks, compact: Math.max(Math.abs(from), Math.abs(to)) >= 10000 };
  }
  /* The range as it is, with rounded ticks inside it (for numbers that need not start at zero, such as a scatter plot). */
  function looseDomain(lo, hi, target) {
    var nice = niceDomain(lo, hi, target);
    return { lo: lo, hi: hi, step: nice.step, ticks: nice.ticks.filter(function (t) { return t >= lo - 1e-9 && t <= hi + 1e-9; }), compact: nice.compact };
  }

  /* Time: UTC calendar ticks at a spacing that gives about `target` labels. */
  var TIME_STEPS = [
    { unit: 'hour', n: 1 }, { unit: 'hour', n: 3 }, { unit: 'hour', n: 6 }, { unit: 'hour', n: 12 },
    { unit: 'day', n: 1 }, { unit: 'day', n: 2 }, { unit: 'day', n: 7 }, { unit: 'day', n: 14 },
    { unit: 'month', n: 1 }, { unit: 'month', n: 3 }, { unit: 'month', n: 6 },
    { unit: 'year', n: 1 }, { unit: 'year', n: 2 }, { unit: 'year', n: 5 }, { unit: 'year', n: 10 }, { unit: 'year', n: 20 }, { unit: 'year', n: 50 }, { unit: 'year', n: 100 }
  ];
  var UNIT_MS = { hour: 3600000, day: DAY, month: 30.4375 * DAY, year: 365.25 * DAY };
  function alignDown(ms, step) {
    var d = new Date(ms);
    if (step.unit === 'hour') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(d.getUTCHours() / step.n) * step.n);
    if (step.unit === 'day') {
      if (step.n === 7) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      if (step.n === 1) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY)) % step.n) * DAY;
    }
    if (step.unit === 'month') return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / step.n) * step.n, 1);
    return Date.UTC(Math.floor(d.getUTCFullYear() / step.n) * step.n, 0, 1);
  }
  function advance(ms, step) {
    var d = new Date(ms);
    if (step.unit === 'hour') return ms + step.n * 3600000;
    if (step.unit === 'day') return ms + step.n * DAY;
    if (step.unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step.n, 1);
    return Date.UTC(d.getUTCFullYear() + step.n, 0, 1);
  }
  function timeTicks(lo, hi, target) {
    var span = Math.max(hi - lo, 1);
    var chosen = TIME_STEPS[TIME_STEPS.length - 1];
    for (var i = 0; i < TIME_STEPS.length; i += 1) {
      if (span / (UNIT_MS[TIME_STEPS[i].unit] * TIME_STEPS[i].n) <= target) { chosen = TIME_STEPS[i]; break; }
    }
    var ticks = [];
    var t = alignDown(lo, chosen);
    if (t < lo) t = advance(t, chosen);
    var guard = 0;
    while (t <= hi && guard < 400) {
      ticks.push(t);
      t = advance(t, chosen);
      guard += 1;
    }
    return { ticks: ticks, step: chosen };
  }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function fmtTime(ms, grain, step) {
    var d = new Date(ms);
    var day = pad2(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()];
    var year = d.getUTCFullYear();
    var unit = step ? step.unit : grain;
    if (unit === 'year') return String(year);
    if (unit === 'month' || unit === 'quarter') return MONTHS[d.getUTCMonth()] + ' ' + year;
    if (unit === 'hour') return day + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    return day + ' ' + year;
  }
  function parseTime(text) {
    var ms = Date.parse(String(text).length === 10 ? text + 'T00:00:00Z' : String(text).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(text)) ? '' : 'Z'));
    return isFinite(ms) ? ms : null;
  }

  /* ---------- the canvas of one chart: size, background, legend, axes ---------- */
  function Frame(container, width, height, colors, label) {
    this.colors = colors;
    this.width = width;
    this.height = height;
    this.svg = node('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': label || 'Chart', 'font-family': FONT_FAMILY, 'font-size': 12 });
    add(this.svg, 'rect', { x: 0, y: 0, width: width, height: height, fill: colors.bg });
    this.container = container;
  }
  Frame.prototype.text = function (x, y, text, options) {
    options = options || {};
    var attrs = { x: x, y: y, fill: options.fill || this.colors.fg, 'text-anchor': options.anchor || 'start', 'font-size': options.size || 12 };
    if (options.weight) attrs['font-weight'] = options.weight;
    if (options.rotate) attrs.transform = 'rotate(' + options.rotate + ' ' + x + ' ' + y + ')';
    if (options.dominant) attrs['dominant-baseline'] = options.dominant;
    return add(this.svg, 'text', attrs, text);
  };
  Frame.prototype.line = function (x1, y1, x2, y2, color, extra) {
    return add(this.svg, 'line', Object.assign({ x1: x1, y1: y1, x2: x2, y2: y2, stroke: color }, extra || {}));
  };
  /* A row of legend entries (colour swatch and name) at the top, wrapping; returns the height it needs. */
  Frame.prototype.legend = function (title, names, colorOf) {
    if (!names.length) return 0;
    var x = 12;
    var y = 14;
    var right = this.width - 12;
    if (title) {
      this.text(x, y, title + ':', { fill: this.colors.muted });
      x += textWidth(title + ':') + 10;
    }
    for (var i = 0; i < names.length; i += 1) {
      var shown = ellipsize(names[i], 200);
      var need = 16 + textWidth(shown) + 16;
      if (x + need > right && x > 14) { x = 12; y += 18; }
      add(this.svg, 'rect', { x: x, y: y - 10, width: 11, height: 11, rx: 2, fill: colorOf(i) });
      this.text(x + 16, y, shown);
      x += need;
    }
    return y + 12;
  };
  Frame.prototype.title = function (side, text, plot) {
    if (!text) return;
    if (side === 'x') this.text((plot.left + plot.right) / 2, this.height - 8, text, { anchor: 'middle', fill: this.colors.muted, weight: 600 });
    else this.text(14, (plot.top + plot.bottom) / 2, text, { anchor: 'middle', fill: this.colors.muted, weight: 600, rotate: -90 });
  };

  /* Horizontal value axis (numbers) along the bottom of the plot. */
  function axisBottomLinear(frame, plot, scale, domain, grid) {
    var last = -Infinity;
    domain.ticks.forEach(function (tick) {
      var x = scale(tick);
      if (grid) frame.line(x, plot.top, x, plot.bottom, frame.colors.grid);
      var label = fmtTick(tick, domain.step, domain.compact);
      var w = textWidth(label);
      frame.line(x, plot.bottom, x, plot.bottom + 4, frame.colors.muted);
      if (x - w / 2 > last + 6) {
        frame.text(x, plot.bottom + 17, label, { anchor: 'middle' });
        last = x + w / 2;
      }
    });
    frame.line(plot.left, plot.bottom, plot.right, plot.bottom, frame.colors.muted);
  }
  function axisLeftLinear(frame, plot, scale, domain) {
    domain.ticks.forEach(function (tick) {
      var y = scale(tick);
      frame.line(plot.left, y, plot.right, y, frame.colors.grid);
      frame.line(plot.left - 4, y, plot.left, y, frame.colors.muted);
      frame.text(plot.left - 8, y + 4, fmtTick(tick, domain.step, domain.compact), { anchor: 'end' });
    });
    frame.line(plot.left, plot.top, plot.left, plot.bottom, frame.colors.muted);
  }
  function leftMargin(domain) {
    var widest = 0;
    domain.ticks.forEach(function (tick) { widest = Math.max(widest, textWidth(fmtTick(tick, domain.step, domain.compact))); });
    return Math.ceil(widest) + 34;
  }

  /* ---------- tooltips ---------- */
  function Tip(container) {
    this.element = document.createElement('div');
    this.element.className = 'ldv-tip';
    this.element.hidden = true;
    container.appendChild(this.element);
    this.container = container;
  }
  Tip.prototype.show = function (text, event) {
    this.element.textContent = text;
    this.element.hidden = false;
    var box = this.container.getBoundingClientRect();
    var x = event.clientX - box.left + 14;
    var y = event.clientY - box.top + 14;
    var w = this.element.offsetWidth;
    var h = this.element.offsetHeight;
    if (x + w > box.width - 4) x = Math.max(4, event.clientX - box.left - w - 14);
    if (y + h > box.height - 4) y = Math.max(4, event.clientY - box.top - h - 14);
    this.element.style.left = Math.round(x) + 'px';
    this.element.style.top = Math.round(y) + 'px';
  };
  Tip.prototype.hide = function () { this.element.hidden = true; };
  /* Any element with a data-tip attribute shows its text while the pointer is over it. */
  function wireTips(svg, tip) {
    function find(target) {
      while (target && target !== svg) {
        if (target.getAttribute && target.hasAttribute('data-tip')) return target;
        target = target.parentNode;
      }
      return null;
    }
    svg.addEventListener('mousemove', function (event) {
      var hit = find(event.target);
      if (hit) tip.show(hit.getAttribute('data-tip'), event);
      else if (!svg.hasAttribute('data-hover')) tip.hide();
    });
    svg.addEventListener('mouseleave', function () { tip.hide(); });
  }
  function tipped(element, text) {
    element.setAttribute('data-tip', text);
    return element;
  }

  /* ---------- helpers on data ---------- */
  function groupsOf(rows, field) {
    var seen = {};
    var names = [];
    rows.forEach(function (row) {
      var name = String(row[field]);
      if (!seen[name]) { seen[name] = true; names.push(name); }
    });
    names.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    return names;
  }
  function colorFor(index) { return PALETTE[index % PALETTE.length]; }
  function extent(values) {
    var lo = Infinity;
    var hi = -Infinity;
    values.forEach(function (v) { if (v !== null && v !== undefined && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } });
    return { lo: lo, hi: hi };
  }
  function lerpColor(a, b, t) {
    function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
    var x = hex(a);
    var y = hex(b);
    var out = x.map(function (v, i) { return Math.round(v + (y[i] - v) * t); });
    return '#' + out.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('');
  }
  function rampColor(stops, t) {
    t = Math.max(0, Math.min(1, t));
    var scaled = t * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(scaled));
    return lerpColor(stops[i], stops[i + 1], scaled - i);
  }
  function luminance(color) {
    var r = parseInt(color.slice(1, 3), 16);
    var g = parseInt(color.slice(3, 5), 16);
    var b = parseInt(color.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  var BLUES = ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'];
  var DIVERGING = ['#d95f02', '#fdd0a2', '#f7f7f7', '#c6dbef', '#2171b5'];

  /* A vertical colour bar with its lowest and highest number, at the right of the plot. */
  function colorBar(frame, x, top, height, stops, loText, hiText) {
    uid += 1;
    var id = 'ldv-grad-' + uid;
    var defs = add(frame.svg, 'defs');
    var gradient = add(defs, 'linearGradient', { id: id, x1: 0, y1: 1, x2: 0, y2: 0 });
    stops.forEach(function (color, i) { add(gradient, 'stop', { offset: (i / (stops.length - 1)) * 100 + '%', 'stop-color': color }); });
    add(frame.svg, 'rect', { x: x, y: top, width: 12, height: height, fill: 'url(#' + id + ')', stroke: frame.colors.grid });
    frame.text(x + 18, top + 9, hiText, { size: 11, fill: frame.colors.muted });
    frame.text(x + 18, top + height, loText, { size: 11, fill: frame.colors.muted });
  }

  /* ---------- the chart types ---------- */
  var types = {};

  types.line = function (frame, spec, rows, width, tip) {
    var colors = frame.colors;
    var names = spec.colorTitle ? groupsOf(rows, 'g') : [''];
    var legendHeight = spec.colorTitle ? frame.legend(spec.colorTitle, names, colorFor) : 0;
    var series = names.map(function () { return []; });
    var index = {};
    names.forEach(function (name, i) { index[name] = i; });
    var xs = {};
    rows.forEach(function (row) {
      var ms = parseTime(row.t);
      if (ms === null) return;
      var si = spec.colorTitle ? index[String(row.g)] : 0;
      var value = row.v === null || row.v === undefined || !isFinite(row.v) ? null : Number(row.v);
      series[si].push({ ms: ms, v: value, t: row.t });
      xs[ms] = true;
    });
    var all = [];
    series.forEach(function (list) { list.forEach(function (p) { all.push(p.v); }); });
    var range = extent(all);
    var times = Object.keys(xs).map(Number).sort(function (a, b) { return a - b; });
    var lo = range.lo === Infinity ? 0 : range.lo;
    var hi = range.hi === -Infinity ? 1 : range.hi;
    if (lo >= 0 && lo <= hi * 0.6) lo = 0;
    var yDomain = niceDomain(lo, hi, 6);
    var plot = { left: leftMargin(yDomain), right: width - 18, top: Math.max(14, legendHeight + 8), bottom: frame.height - 48 };
    var y = linear(yDomain.lo, yDomain.hi, plot.bottom, plot.top);
    var t0 = times.length ? times[0] : 0;
    var t1 = times.length ? times[times.length - 1] : DAY;
    if (t0 === t1) { t0 -= DAY; t1 += DAY; }
    var x = linear(t0, t1, plot.left + 6, plot.right - 6);
    axisLeftLinear(frame, plot, y, yDomain);
    var ticks = timeTicks(t0, t1, Math.max(2, Math.floor((plot.right - plot.left) / 110)));
    var lastEdge = -Infinity;
    ticks.ticks.forEach(function (ms) {
      var px = x(ms);
      var label = fmtTime(ms, spec.grain, ticks.step);
      var w = textWidth(label);
      frame.line(px, plot.bottom, px, plot.bottom + 4, colors.muted);
      if (px - w / 2 > lastEdge + 8 && px + w / 2 < width) { frame.text(px, plot.bottom + 17, label, { anchor: 'middle' }); lastEdge = px + w / 2; }
    });
    frame.line(plot.left, plot.bottom, plot.right, plot.bottom, colors.muted);
    frame.title('x', spec.xTitle, plot);
    frame.title('y', spec.yTitle, plot);

    var dots = rows.length <= 80;
    series.forEach(function (list, i) {
      var color = colorFor(i);
      var d = '';
      var open = false;
      list.forEach(function (p) {
        if (p.v === null) { open = false; return; }
        d += (open ? 'L' : 'M') + x(p.ms).toFixed(1) + ' ' + y(p.v).toFixed(1);
        open = true;
      });
      if (d) add(frame.svg, 'path', { d: d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' });
      if (dots) list.forEach(function (p) { if (p.v !== null) add(frame.svg, 'circle', { cx: x(p.ms), cy: y(p.v), r: 3, fill: color }); });
    });

    // while the pointer is over the plot: a guide at the nearest date, and every series' value there
    var guide = add(frame.svg, 'line', { x1: 0, y1: plot.top, x2: 0, y2: plot.bottom, stroke: colors.muted, 'stroke-dasharray': '3 3', visibility: 'hidden', 'pointer-events': 'none' });
    var marks = series.map(function (_, i) { return add(frame.svg, 'circle', { r: 4, fill: colorFor(i), stroke: colors.bg, 'stroke-width': 1.5, visibility: 'hidden', 'pointer-events': 'none' }); });
    var maps = series.map(function (list) { var m = {}; list.forEach(function (p) { m[p.ms] = p; }); return m; });
    var overlay = add(frame.svg, 'rect', { x: plot.left, y: plot.top, width: plot.right - plot.left, height: plot.bottom - plot.top, fill: 'transparent' });
    frame.svg.setAttribute('data-hover', '1');
    overlay.addEventListener('mousemove', function (event) {
      if (!times.length) return;
      var box = frame.svg.getBoundingClientRect();
      var px = ((event.clientX - box.left) / box.width) * frame.width;
      var best = times[0];
      var bestDistance = Infinity;
      times.forEach(function (ms) { var dist = Math.abs(x(ms) - px); if (dist < bestDistance) { bestDistance = dist; best = ms; } });
      guide.setAttribute('x1', x(best));
      guide.setAttribute('x2', x(best));
      guide.setAttribute('visibility', 'visible');
      var lines = [fmtTime(best, spec.grain)];
      names.forEach(function (name, i) {
        var p = maps[i][best];
        if (p && p.v !== null) {
          marks[i].setAttribute('cx', x(best));
          marks[i].setAttribute('cy', y(p.v));
          marks[i].setAttribute('visibility', 'visible');
          lines.push((spec.colorTitle ? name + ': ' : '') + fmt(p.v));
        } else marks[i].setAttribute('visibility', 'hidden');
      });
      tip.show(lines.join('\n'), event);
    });
    overlay.addEventListener('mouseleave', function () {
      guide.setAttribute('visibility', 'hidden');
      marks.forEach(function (m) { m.setAttribute('visibility', 'hidden'); });
      tip.hide();
    });
  };

  types.bar = function (frame, spec, rows, width, tip) {
    var colors = frame.colors;
    var split = !!spec.colorTitle;
    var names = split ? groupsOf(rows, 'g') : [''];
    var legendHeight = split ? frame.legend(spec.colorTitle, names, colorFor) : 0;
    var byKey = {};
    var keys = [];
    rows.forEach(function (row) {
      var key = String(row.k);
      if (!byKey[key]) { byKey[key] = { key: key, parts: [], total: 0 }; keys.push(key); }
      var value = row.v === null || row.v === undefined || !isFinite(row.v) ? 0 : Number(row.v);
      byKey[key].parts.push({ g: split ? String(row.g) : '', v: value });
      byKey[key].total += value;
    });
    keys.sort(function (a, b) { return byKey[b].total - byKey[a].total || (a < b ? -1 : a > b ? 1 : 0); });
    var maxPositive = 0;
    var maxNegative = 0;
    keys.forEach(function (key) {
      var pos = 0;
      var neg = 0;
      byKey[key].parts.forEach(function (p) { if (p.v >= 0) pos += p.v; else neg += p.v; });
      maxPositive = Math.max(maxPositive, pos);
      maxNegative = Math.min(maxNegative, neg);
    });
    var domain = niceDomain(maxNegative, maxPositive === 0 && maxNegative === 0 ? 1 : maxPositive, 6);
    var labelWidth = 0;
    keys.forEach(function (key) { labelWidth = Math.max(labelWidth, textWidth(ellipsize(key, 240))); });
    var plot = { left: Math.ceil(labelWidth) + 40, right: width - 56, top: Math.max(8, legendHeight + 6), bottom: frame.height - 48 };
    var x = linear(domain.lo, domain.hi, plot.left, plot.right);
    var step = Math.min(26, (plot.bottom - plot.top) / Math.max(1, keys.length));
    var barHeight = Math.max(2, Math.min(20, step - 6));
    axisBottomLinear(frame, plot, x, domain, true);
    frame.title('x', spec.xTitle, plot);
    frame.title('y', spec.yTitle, plot);
    keys.forEach(function (key, i) {
      var cy = plot.top + step * i + step / 2;
      frame.text(plot.left - 8, cy + 4, ellipsize(key, 240), { anchor: 'end' });
      var pos = 0;
      var neg = 0;
      byKey[key].parts.forEach(function (part) {
        var from = part.v >= 0 ? pos : neg;
        var to = from + part.v;
        if (part.v >= 0) pos = to; else neg = to;
        var left = x(Math.min(from, to));
        var rect = add(frame.svg, 'rect', { x: left, y: cy - barHeight / 2, width: Math.max(0.5, Math.abs(x(to) - x(from))), height: barHeight, fill: split ? colorFor(names.indexOf(part.g)) : colors.accent });
        tipped(rect, key + (split ? '\n' + part.g : '') + '\n' + fmt(part.v));
      });
      if (!split) frame.text(x(Math.max(0, byKey[key].total)) + 5, cy + 4, fmtShort(byKey[key].total), { size: 11, fill: colors.muted });
    });
    frame.line(x(0), plot.top, x(0), plot.bottom, colors.muted);
  };

  types.hist = function (frame, spec, rows, width, tip) {
    var colors = frame.colors;
    var bins = rows.filter(function (row) { return row.a !== null && row.b !== null; });
    var lo = bins.length ? Math.min.apply(null, bins.map(function (b) { return b.a; })) : 0;
    var hi = bins.length ? Math.max.apply(null, bins.map(function (b) { return b.b; })) : 1;
    var top = bins.length ? Math.max.apply(null, bins.map(function (b) { return b.v; })) : 1;
    var yDomain = niceDomain(0, top, 6);
    var xDomain = niceDomain(lo, hi, Math.max(3, Math.floor((width - 120) / 90)));
    var plot = { left: leftMargin(yDomain), right: width - 18, top: 14, bottom: frame.height - 48 };
    var x = linear(Math.min(xDomain.lo, lo), Math.max(xDomain.hi, hi), plot.left + 4, plot.right - 4);
    var y = linear(yDomain.lo, yDomain.hi, plot.bottom, plot.top);
    axisLeftLinear(frame, plot, y, yDomain);
    axisBottomLinear(frame, plot, x, { ticks: xDomain.ticks.filter(function (t) { return t >= lo - 1e-9 && t <= hi + 1e-9; }), step: xDomain.step, compact: xDomain.compact }, false);
    frame.title('x', spec.xTitle, plot);
    frame.title('y', spec.yTitle, plot);
    bins.forEach(function (bin) {
      var left = x(bin.a);
      var w = Math.max(1, x(bin.b) - left - 1);
      var rect = add(frame.svg, 'rect', { x: left + 0.5, y: y(bin.v), width: w, height: Math.max(0, plot.bottom - y(bin.v)), fill: colors.accent });
      tipped(rect, fmt(bin.a) + ' to ' + fmt(bin.b) + '\n' + fmt(bin.v) + (bin.v === 1 ? ' row' : ' rows'));
    });
  };

  types.scatter = function (frame, spec, rows, width, tip) {
    var colors = frame.colors;
    var color = !!spec.colorTitle;
    var names = color ? groupsOf(rows, 'g') : [''];
    var legendHeight = color ? frame.legend(spec.colorTitle, names, colorFor) : 0;
    var xr = extent(rows.map(function (r) { return r.x; }));
    var yr = extent(rows.map(function (r) { return r.y; }));
    function padded(range) {
      var span = range.hi - range.lo || Math.abs(range.hi) || 1;
      return { lo: range.lo - span * 0.03, hi: range.hi + span * 0.03 };
    }
    var xp = padded(xr.lo === Infinity ? { lo: 0, hi: 1 } : xr);
    var yp = padded(yr.lo === Infinity ? { lo: 0, hi: 1 } : yr);
    var xDomain = looseDomain(xp.lo, xp.hi, Math.max(3, Math.floor((width - 120) / 90)));
    var yDomain = looseDomain(yp.lo, yp.hi, 6);
    var plot = { left: leftMargin(yDomain), right: width - 18, top: Math.max(14, legendHeight + 8), bottom: frame.height - 48 };
    var x = linear(xDomain.lo, xDomain.hi, plot.left, plot.right);
    var y = linear(yDomain.lo, yDomain.hi, plot.bottom, plot.top);
    axisLeftLinear(frame, plot, y, yDomain);
    axisBottomLinear(frame, plot, x, xDomain, true);
    frame.title('x', spec.xTitle, plot);
    frame.title('y', spec.yTitle, plot);
    rows.forEach(function (row) {
      if (row.x === null || row.y === null) return;
      var fill = color ? colorFor(names.indexOf(String(row.g))) : colors.accent;
      var dot = add(frame.svg, 'circle', { cx: x(row.x), cy: y(row.y), r: 3.4, fill: fill, 'fill-opacity': 0.55 });
      tipped(dot, (color ? row.g + '\n' : '') + spec.xTitle + ': ' + fmt(row.x) + '\n' + spec.yTitle + ': ' + fmt(row.y));
    });
  };

  function categoricalSort(list) { return list.slice().sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; }); }

  types.heatmap = function (frame, spec, rows, width, tip) {
    var colors = frame.colors;
    var xs = categoricalSort(groupsOf(rows, 'kx'));
    var ys = categoricalSort(groupsOf(rows, 'ky'));
    var cells = {};
    rows.forEach(function (row) { cells[row.kx + SEP + row.ky] = row.v; });
    var range = extent(rows.map(function (r) { return r.v; }));
    var yLabelWidth = 0;
    ys.forEach(function (name) { yLabelWidth = Math.max(yLabelWidth, textWidth(ellipsize(name, 200))); });
    var xLabelWidth = 0;
    xs.forEach(function (name) { xLabelWidth = Math.max(xLabelWidth, textWidth(ellipsize(name, 160))); });
    var rotate = xs.length * 40 > width - yLabelWidth - 120;
    var bottomRoom = rotate ? Math.ceil(xLabelWidth * 0.6) + 40 : 56;
    var plot = { left: Math.ceil(yLabelWidth) + 44, right: width - 120, top: 24, bottom: frame.height - bottomRoom };
    var cw = (plot.right - plot.left) / Math.max(1, xs.length);
    var ch = (plot.bottom - plot.top) / Math.max(1, ys.length);
    var labelled = xs.length * ys.length <= 100;
    ys.forEach(function (name, j) {
      frame.text(plot.left - 8, plot.top + ch * j + ch / 2 + 4, ellipsize(name, 200), { anchor: 'end' });
    });
    xs.forEach(function (name, i) {
      var cx = plot.left + cw * i + cw / 2;
      if (rotate) frame.text(cx + 4, plot.bottom + 12, ellipsize(name, 160), { anchor: 'end', rotate: -35 });
      else frame.text(cx, plot.bottom + 16, ellipsize(name, Math.max(30, cw - 4)), { anchor: 'middle' });
    });
    xs.forEach(function (xn, i) {
      ys.forEach(function (yn, j) {
        var value = cells[xn + SEP + yn];
        if (value === undefined || value === null || !isFinite(value)) return;
        var t = range.hi === range.lo ? 0.5 : (value - range.lo) / (range.hi - range.lo);
        var fill = rampColor(BLUES, t);
        var rect = add(frame.svg, 'rect', { x: plot.left + cw * i + 0.5, y: plot.top + ch * j + 0.5, width: Math.max(1, cw - 1), height: Math.max(1, ch - 1), fill: fill });
        tipped(rect, xn + ' / ' + yn + '\n' + fmt(value));
        if (labelled && cw > 24 && ch > 14) frame.text(plot.left + cw * i + cw / 2, plot.top + ch * j + ch / 2 + 4, fmtCell(value), { anchor: 'middle', size: 11, fill: luminance(fill) < 0.55 ? '#ffffff' : '#111111' }).setAttribute('pointer-events', 'none');
      });
    });
    frame.title('x', spec.xTitle, { left: plot.left, right: plot.right, top: plot.top, bottom: plot.bottom });
    frame.title('y', spec.yTitle, plot);
    if (range.lo !== Infinity) colorBar(frame, plot.right + 14, plot.top, Math.min(140, plot.bottom - plot.top), BLUES, fmtCell(range.lo), fmtCell(range.hi));
    if (spec.valueTitle) frame.text(plot.right + 14, plot.top - 8, ellipsize(spec.valueTitle, 100), { size: 11, fill: colors.muted });
  };

  types.corr = function (frame, spec, rows, width, tip) {
    var colors = frame.colors;
    var names = [];
    rows.forEach(function (row) { if (names.indexOf(row.a) < 0) names.push(row.a); });
    var cells = {};
    rows.forEach(function (row) { cells[row.a + SEP + row.b] = row.r; });
    var labelWidth = 0;
    names.forEach(function (name) { labelWidth = Math.max(labelWidth, textWidth(ellipsize(name, 160))); });
    var plot = { left: Math.ceil(labelWidth) + 14, right: width - 120, top: 24, bottom: frame.height - Math.ceil(labelWidth * 0.6) - 28 };
    var cw = (plot.right - plot.left) / Math.max(1, names.length);
    var ch = (plot.bottom - plot.top) / Math.max(1, names.length);
    names.forEach(function (name, i) {
      frame.text(plot.left - 8, plot.top + ch * i + ch / 2 + 4, ellipsize(name, 160), { anchor: 'end' });
      frame.text(plot.left + cw * i + cw / 2 + 4, plot.bottom + 12, ellipsize(name, 160), { anchor: 'end', rotate: -35 });
    });
    names.forEach(function (rowName, j) {
      names.forEach(function (colName, i) {
        var value = cells[colName + SEP + rowName];
        if (value === undefined || value === null || !isFinite(value)) return;
        var fill = rampColor(DIVERGING, (value + 1) / 2);
        var rect = add(frame.svg, 'rect', { x: plot.left + cw * i + 0.5, y: plot.top + ch * j + 0.5, width: Math.max(1, cw - 1), height: Math.max(1, ch - 1), fill: fill });
        tipped(rect, colName + ' and ' + rowName + '\n' + value.toFixed(2));
        frame.text(plot.left + cw * i + cw / 2, plot.top + ch * j + ch / 2 + 4, value.toFixed(2), { anchor: 'middle', size: 12, fill: luminance(fill) < 0.55 ? '#ffffff' : '#111111' }).setAttribute('pointer-events', 'none');
      });
    });
    colorBar(frame, plot.right + 14, plot.top, Math.min(140, plot.bottom - plot.top), DIVERGING, '-1', '1');
    frame.text(plot.right + 14, plot.top - 8, 'Correlation', { size: 11, fill: colors.muted });
  };

  /* ---------- sizes ---------- */
  function heightFor(spec, rows, width) {
    if (spec.type === 'bar') {
      var keys = {};
      rows.forEach(function (row) { keys[row.k] = true; });
      return Math.max(160, Object.keys(keys).length * 26 + 64 + (spec.colorTitle ? 40 : 0));
    }
    if (spec.type === 'heatmap') {
      var ys = {};
      rows.forEach(function (row) { ys[row.ky] = true; });
      return Math.max(300, Object.keys(ys).length * 28 + 110);
    }
    if (spec.type === 'corr') {
      var names = {};
      rows.forEach(function (row) { names[row.a] = true; });
      var n = Object.keys(names).length;
      return Math.max(280, Math.min(Math.round((width - 100) * 0.9), n * 64) + 90);
    }
    return 360;
  }

  /* ---------- draw, resize, export ---------- */
  function serialize(svg) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
  }
  function toPng(svg, scale) {
    return new Promise(function (resolve, reject) {
      var width = Number(svg.getAttribute('width'));
      var height = Number(svg.getAttribute('height'));
      var image = new Image();
      image.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        var context = canvas.getContext('2d');
        context.scale(scale, scale);
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('the browser could not make the image')); }, 'image/png');
      };
      image.onerror = function () { reject(new Error('the browser could not draw the chart as an image')); };
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialize(svg));
    });
  }

  /**
   * Draw `spec` and `rows` into `container`. Returns { redraw, destroy, svgText(), png() }. The chart redraws itself when the
   * container changes width (the splitter, a window resize).
   */
  function draw(container, spec, rows, options) {
    options = options || {};
    var handle = { svg: null };
    var tip = null;
    var drawnWidth = 0;
    var observer = null;
    function render() {
      var width = Math.max(320, Math.floor(container.clientWidth - 26));
      drawnWidth = width;
      Array.prototype.slice.call(container.querySelectorAll('svg, .ldv-tip')).forEach(function (child) { container.removeChild(child); });
      var colors = theme();
      var height = heightFor(spec, rows, width);
      var frame = new Frame(container, width, height, colors, options.label);
      container.appendChild(frame.svg);
      tip = new Tip(container);
      wireTips(frame.svg, tip);
      var painter = types[spec.type];
      if (!painter) throw new Error('unknown chart type');
      painter(frame, spec, rows, width, tip);
      handle.svg = frame.svg;
    }
    container.classList.add('ldv-chart');
    render();
    if (typeof ResizeObserver !== 'undefined') {
      var pending = false;
      observer = new ResizeObserver(function () {
        if (pending) return;
        pending = true;
        global.requestAnimationFrame(function () {
          pending = false;
          if (Math.abs(Math.floor(container.clientWidth - 26) - drawnWidth) > 2 && container.isConnected) render();
        });
      });
      observer.observe(container);
    }
    handle.destroy = function () { if (observer) observer.disconnect(); observer = null; };
    handle.svgText = function () { return serialize(handle.svg); };
    handle.png = function () { return toPng(handle.svg, 2); };
    return handle;
  }

  global.LDVCharts = { draw: draw, fmtTime: fmtTime, timeTicks: timeTicks, niceDomain: niceDomain, parseTime: parseTime, fmtCell: fmtCell, fmtTick: fmtTick, ellipsize: ellipsize };
})(window);
