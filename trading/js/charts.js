/**
 * Minimal SVG charting. Hand-rolled rather than pulled from a CDN so the app
 * keeps working offline and every mark can be themed from the site's palette.
 *
 * All builders return an <svg> element sized by viewBox, so the caller controls
 * layout with CSS and the chart scales with its container.
 */

const NS = 'http://www.w3.org/2000/svg';
const el = (n, attrs = {}) => {
  const e = document.createElementNS(NS, n);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  return e;
};

const fmtMoney = (v) =>
  (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtPct = (v) => (v * 100).toFixed(1) + '%';

/** Pick ~n round tick values spanning [lo, hi]. */
function ticks(lo, hi, n = 5) {
  if (lo === hi) return [lo];
  const span = hi - lo;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function tooltip() {
  let tip = document.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

function bindHover(svg, points, render) {
  const tip = tooltip();
  svg.addEventListener('mousemove', (ev) => {
    const box = svg.getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
    let best = null, bd = Infinity;
    for (const p of points) {
      const d = Math.abs(p.x - x);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    tip.innerHTML = render(best.d);
    tip.hidden = false;
    tip.style.left = `${ev.clientX + 14}px`;
    tip.style.top = `${ev.clientY - 10}px`;
    svg.querySelectorAll('.hover-dot').forEach((n) => {
      n.setAttribute('cx', best.x);
      n.setAttribute('cy', best.y);
      n.style.opacity = 1;
    });
  });
  svg.addEventListener('mouseleave', () => {
    tip.hidden = true;
    svg.querySelectorAll('.hover-dot').forEach((n) => (n.style.opacity = 0));
  });
}

/**
 * Line / area chart over an ordered series.
 * data: [{ label, value }]  — label is a date string used for the x axis.
 */
export function lineChart(data, opts = {}) {
  const W = 900, H = opts.height || 260;
  const M = { t: 14, r: 56, b: 24, l: 8 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });
  if (!data.length) return svg;

  const vals = data.map((d) => d.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (opts.zeroBase) lo = Math.min(0, lo);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;

  const px = (i) => M.l + (i / Math.max(1, data.length - 1)) * (W - M.l - M.r);
  const py = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);

  // grid + right-hand value axis
  for (const tv of ticks(lo, hi, 4)) {
    const y = py(tv);
    svg.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, class: 'grid' }));
    const lab = el('text', { x: W - M.r + 8, y: y + 3.5, class: 'axis' });
    lab.textContent = opts.percent ? fmtPct(tv) : fmtMoney(tv);
    svg.appendChild(lab);
  }
  if (lo < 0 && hi > 0) {
    const y = py(0);
    svg.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, class: 'zero-line' }));
  }

  const pts = data.map((d, i) => ({ x: px(i), y: py(d.value), d }));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('');

  if (opts.area !== false) {
    const base = py(lo < 0 && hi > 0 ? 0 : lo);
    svg.appendChild(
      el('path', { d: `${line}L${pts.at(-1).x.toFixed(2)},${base}L${pts[0].x.toFixed(2)},${base}Z`, class: `area ${opts.tone || ''}` })
    );
  }
  svg.appendChild(el('path', { d: line, class: `line ${opts.tone || ''}` }));
  svg.appendChild(el('circle', { r: 3.5, class: 'hover-dot', cx: -10, cy: -10 }));

  // sparse x labels
  const step = Math.max(1, Math.floor(data.length / 7));
  for (let i = 0; i < data.length; i += step) {
    const t = el('text', { x: px(i), y: H - 6, class: 'axis mid' });
    t.textContent = opts.xFormat ? opts.xFormat(data[i].label) : data[i].label;
    svg.appendChild(t);
  }

  bindHover(svg, pts, opts.tip || ((d) => `<b>${d.label}</b><br>${opts.percent ? fmtPct(d.value) : fmtMoney(d.value)}`));
  return svg;
}

/** Vertical bars, coloured by sign. data: [{ label, value }] */
export function barChart(data, opts = {}) {
  const W = 900, H = opts.height || 220;
  const M = { t: 14, r: 56, b: 30, l: 8 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });
  if (!data.length) return svg;

  const vals = data.map((d) => d.value);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (lo === hi) hi = lo + 1;
  const pad = (hi - lo) * 0.1;
  lo -= pad; hi += pad;

  const bw = (W - M.l - M.r) / data.length;
  const py = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);

  for (const tv of ticks(lo, hi, 4)) {
    const y = py(tv);
    svg.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, class: 'grid' }));
    const lab = el('text', { x: W - M.r + 8, y: y + 3.5, class: 'axis' });
    lab.textContent = opts.percent ? fmtPct(tv) : fmtMoney(tv);
    svg.appendChild(lab);
  }
  const zeroY = py(0);
  svg.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: zeroY, y2: zeroY, class: 'zero-line' }));

  const tip = tooltip();
  data.forEach((d, i) => {
    const x = M.l + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const y = d.value >= 0 ? py(d.value) : zeroY;
    const h = Math.max(1, Math.abs(py(d.value) - zeroY));
    const rect = el('rect', { x, y, width: w, height: h, class: `bar ${d.value >= 0 ? 'up' : 'down'}`, rx: 1 });
    rect.addEventListener('mousemove', (ev) => {
      tip.innerHTML = opts.tip ? opts.tip(d) : `<b>${d.label}</b><br>${fmtMoney(d.value)}`;
      tip.hidden = false;
      tip.style.left = `${ev.clientX + 14}px`;
      tip.style.top = `${ev.clientY - 10}px`;
    });
    rect.addEventListener('mouseleave', () => (tip.hidden = true));
    svg.appendChild(rect);
  });

  const step = Math.max(1, Math.ceil(data.length / 14));
  data.forEach((d, i) => {
    if (i % step) return;
    const t = el('text', { x: M.l + i * bw + bw / 2, y: H - 8, class: 'axis mid' });
    t.textContent = opts.xFormat ? opts.xFormat(d.label) : d.label;
    svg.appendChild(t);
  });
  return svg;
}

/** Horizontal ranked bars — used for per-symbol and per-strategy P&L. */
export function rankedBars(rows, opts = {}) {
  const rowH = 26;
  const W = 900, H = Math.max(60, rows.length * rowH + 16);
  const M = { l: 150, r: 90 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart ranked' });
  if (!rows.length) return svg;

  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const mid = M.l + (W - M.l - M.r) / 2;
  const half = (W - M.l - M.r) / 2;

  svg.appendChild(el('line', { x1: mid, x2: mid, y1: 4, y2: H - 8, class: 'zero-line' }));

  const tip = tooltip();
  rows.forEach((r, i) => {
    const y = 8 + i * rowH;
    const w = (Math.abs(r.value) / max) * half;
    const x = r.value >= 0 ? mid : mid - w;

    const label = el('text', { x: M.l - 10, y: y + rowH / 2 + 1, class: 'axis end' });
    label.textContent = r.label;
    svg.appendChild(label);

    const rect = el('rect', { x, y: y + 3, width: Math.max(1, w), height: rowH - 12, rx: 1, class: `bar ${r.value >= 0 ? 'up' : 'down'}` });
    rect.addEventListener('mousemove', (ev) => {
      tip.innerHTML = opts.tip ? opts.tip(r) : `<b>${r.label}</b><br>${fmtMoney(r.value)}`;
      tip.hidden = false;
      tip.style.left = `${ev.clientX + 14}px`;
      tip.style.top = `${ev.clientY - 10}px`;
    });
    rect.addEventListener('mouseleave', () => (tip.hidden = true));
    svg.appendChild(rect);

    const val = el('text', { x: W - M.r + 8, y: y + rowH / 2 + 1, class: `axis ${r.value >= 0 ? 'up' : 'down'}` });
    val.textContent = fmtMoney(r.value);
    svg.appendChild(val);
  });
  return svg;
}

/** Calendar heatmap of daily P&L, one column per week. */
export function calendarHeatmap(daily, opts = {}) {
  const map = new Map(daily.map((d) => [d[0], d[1]]));
  const days = daily.map((d) => d[0]).sort();
  if (!days.length) return el('svg');

  const start = new Date(days[0] + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = new Date(days.at(-1) + 'T00:00:00Z');

  const cells = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    cells.push({ key, dow: d.getUTCDay(), v: map.get(key) });
  }
  const weeks = Math.ceil(cells.length / 7);
  const S = 13, G = 2;
  const W = weeks * (S + G) + 40, H = 7 * (S + G) + 24;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart heatmap' });

  const mags = daily.map((d) => Math.abs(d[1])).filter((v) => v > 0).sort((a, b) => a - b);
  const cap = mags.length ? mags[Math.floor(mags.length * 0.9)] : 1;

  const tip = tooltip();
  cells.forEach((c, i) => {
    const wk = Math.floor(i / 7);
    const x = 32 + wk * (S + G);
    const y = 16 + c.dow * (S + G);
    let cls = 'empty';
    if (c.v !== undefined) {
      const mag = Math.min(1, Math.abs(c.v) / cap);
      const lvl = c.v === 0 ? 0 : Math.max(1, Math.ceil(mag * 4));
      cls = c.v >= 0 ? `up l${lvl}` : `down l${lvl}`;
    }
    const rect = el('rect', { x, y, width: S, height: S, rx: 2, class: `cell ${cls}` });
    if (c.v !== undefined) {
      rect.addEventListener('mousemove', (ev) => {
        tip.innerHTML = `<b>${c.key}</b><br>${fmtMoney(c.v)}`;
        tip.hidden = false;
        tip.style.left = `${ev.clientX + 14}px`;
        tip.style.top = `${ev.clientY - 10}px`;
      });
      rect.addEventListener('mouseleave', () => (tip.hidden = true));
    }
    svg.appendChild(rect);
  });

  ['Mon', 'Wed', 'Fri'].forEach((lab, k) => {
    const t = el('text', { x: 26, y: 16 + (k * 2 + 1) * (S + G) + S - 3, class: 'axis end tiny' });
    t.textContent = lab;
    svg.appendChild(t);
  });

  let lastMonth = '';
  cells.forEach((c, i) => {
    if (i % 7) return;
    const m = c.key.slice(0, 7);
    if (m === lastMonth) return;
    lastMonth = m;
    const t = el('text', { x: 32 + Math.floor(i / 7) * (S + G), y: 10, class: 'axis tiny' });
    t.textContent = new Date(c.key + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    svg.appendChild(t);
  });
  return svg;
}

/** P&L distribution histogram, split at zero. */
export function histogramChart(bins, opts = {}) {
  const W = 900, H = opts.height || 200;
  const M = { t: 12, r: 8, b: 28, l: 8 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });
  if (!bins.length) return svg;

  const maxN = Math.max(...bins.map((b) => b.n), 1);
  const bw = (W - M.l - M.r) / bins.length;
  const tip = tooltip();

  bins.forEach((b, i) => {
    const h = (b.n / maxN) * (H - M.t - M.b);
    const x = M.l + i * bw + bw * 0.1;
    const rect = el('rect', {
      x, y: H - M.b - h, width: bw * 0.8, height: Math.max(b.n ? 1 : 0, h), rx: 1,
      class: `bar ${b.to <= 0 ? 'down' : 'up'}`,
    });
    rect.addEventListener('mousemove', (ev) => {
      const extra = b.clippedLow ? `<br>includes ${b.clippedLow} below range`
        : b.clippedHigh ? `<br>includes ${b.clippedHigh} above range` : '';
      tip.innerHTML = `<b>${fmtMoney(b.from)} → ${fmtMoney(b.to)}</b><br>${b.n} trade${b.n === 1 ? '' : 's'}${extra}`;
      tip.hidden = false;
      tip.style.left = `${ev.clientX + 14}px`;
      tip.style.top = `${ev.clientY - 10}px`;
    });
    rect.addEventListener('mouseleave', () => (tip.hidden = true));
    svg.appendChild(rect);
  });

  const zi = bins.findIndex((b) => b.to > 0);
  if (zi > 0) {
    const x = M.l + zi * bw;
    svg.appendChild(el('line', { x1: x, x2: x, y1: M.t, y2: H - M.b, class: 'zero-line' }));
  }
  [0, Math.floor(bins.length / 2), bins.length - 1].forEach((i) => {
    const t = el('text', { x: M.l + i * bw + bw / 2, y: H - 8, class: 'axis mid' });
    t.textContent = fmtMoney(bins[i].from);
    svg.appendChild(t);
  });
  return svg;
}
