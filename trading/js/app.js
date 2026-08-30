/**
 * IBKR trading performance app.
 *
 * Reads the static snapshot in ./data (produced by scripts/build-data.mjs from
 * the IBKR connector) and renders dashboard, journal, positions, analytics and
 * reports entirely client-side. The journal layer lives in localStorage, so
 * notes stay on the machine that wrote them and survive data refreshes.
 */
import * as M from './metrics.js';
import { lineChart, barChart, rankedBars, calendarHeatmap, histogramChart } from './charts.js';

/* ------------------------------------------------------------ formatting */

const money = (v, dp = 2) =>
  (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const money0 = (v) => money(v, 0);
const pct = (v, dp = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : (v * 100).toFixed(dp) + '%');
const num = (v, dp = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(dp));
const signCls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
const dateOf = (iso) => (iso ? iso.slice(0, 10) : '—');
const dtOf = (iso) => (iso ? iso.slice(0, 10) + ' ' + iso.slice(11, 16) : '—');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ----------------------------------------------------------------- state */

const DATA = { meta: null, trips: [], execs: [], positions: null, account: null, perf: null };
const state = {
  view: 'dashboard',
  q: '',
  sym: '',
  strategy: '',
  result: '',
  from: '',
  to: '',
  notesOnly: false,
  sort: { key: 'closed', dir: -1 },
  page: 0,
  pageSize: 100,
};

/* --------------------------------------------------------------- journal */

const JKEY = 'ibkr-journal-v1';
const journal = {
  all: {},
  load() {
    try { this.all = JSON.parse(localStorage.getItem(JKEY) || '{}'); }
    catch { this.all = {}; }
  },
  get(id) { return this.all[id] || { note: '', tags: [], rating: 0 }; },
  set(id, entry) {
    const empty = !entry.note && !entry.tags.length && !entry.rating;
    if (empty) delete this.all[id];
    else this.all[id] = { ...entry, updated: new Date().toISOString() };
    try { localStorage.setItem(JKEY, JSON.stringify(this.all)); return true; }
    catch { return false; }   // private mode / quota — the UI reports this
  },
  has(id) { return !!this.all[id]; },
  count() { return Object.keys(this.all).length; },
};

const PRESET_TAGS = ['A+ setup', 'Followed plan', 'Broke rules', 'Early entry', 'Late entry',
  'Early exit', 'Held too long', 'Sized too big', 'Sized too small', 'Chased', 'Revenge trade',
  'Earnings', 'News driven', 'Technical', 'Hedge', 'Roll', 'Assignment risk'];

/* ------------------------------------------------------------------ load */

async function loadData() {
  const j = async (p) => {
    const r = await fetch(p, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
    return r.json();
  };
  const [meta, rt, pos, acct, perf] = await Promise.all([
    j('data/meta.json'), j('data/roundtrips.json'), j('data/positions.json'),
    j('data/account.json'), j('data/performance.json'),
  ]);
  DATA.meta = meta;
  DATA.trips = rt.trips;
  DATA.stillOpen = rt.stillOpen;
  DATA.positions = pos;
  DATA.account = acct;
  DATA.perf = perf;

  // Executions power the trade log only; fetch them lazily so first paint is fast.
  j('data/executions.json').then((e) => {
    DATA.execs = e.rows.map((r) => Object.fromEntries(e.fields.map((f, i) => [f, r[i]])));
  }).catch(() => {});
}

/* --------------------------------------------------------------- filters */

function filtered() {
  const q = state.q.trim().toLowerCase();
  return DATA.trips.filter((t) => {
    if (state.sym && t.sym !== state.sym) return false;
    if (state.strategy && t.shape.label !== state.strategy) return false;
    if (state.result === 'win' && !(t.pnl > 0)) return false;
    if (state.result === 'loss' && !(t.pnl < 0)) return false;
    if (state.result === 'scratch' && t.pnl !== 0) return false;
    if (state.from && t.closed.slice(0, 10) < state.from) return false;
    if (state.to && t.closed.slice(0, 10) > state.to) return false;
    if (state.notesOnly && !journal.has(t.id)) return false;
    if (q) {
      const hay = `${t.sym} ${t.name} ${t.shape.label} ${journal.get(t.id).note} ${journal.get(t.id).tags.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------- fragments */

const kpi = (k, v, sub, cls = '') =>
  `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;

const panel = (title, bodyHtml, extra = '', flush = false) =>
  `<div class="panel"><h2>${esc(title)}${extra ? `<span>${extra}</span>` : ''}</h2><div class="body${flush ? ' flush' : ''}">${bodyHtml}</div></div>`;

function mountChart(host, svg) {
  host.innerHTML = '';
  host.appendChild(svg);
}

/* ------------------------------------------------------------- dashboard */

function renderDashboard() {
  const root = $('#view-dashboard');
  const trips = DATA.trips;
  const s = M.tradeStats(trips);
  const risk = M.riskMetrics(DATA.perf);
  const acct = DATA.account.summary;
  const structs = DATA.positions.structures;
  const openUpnl = structs.reduce((a, x) => a + x.upnl, 0);
  const openDpnl = structs.reduce((a, x) => a + x.dpnl, 0);

  root.innerHTML = `
    <div class="view-head">
      <h1>Dashboard</h1>
      <span class="label">${esc(DATA.meta.source)} · ${DATA.meta.executions.toLocaleString()} fills · ${dateOf(DATA.meta.firstTrade)} → ${dateOf(DATA.meta.lastTrade)}</span>
    </div>

    <div class="kpis">
      ${kpi('Net liquidation', money0(acct.net_liquidation), `cash ${money0(acct.total_cash_value)} · lev ${acct.leverage}×`)}
      ${kpi('Return (1Y, TWR)', pct(risk.totalReturn), `${risk.measure} · ${risk.tradingDays} sessions`, signCls(risk.totalReturn))}
      ${kpi('Realized P&L', money0(s.net), `${s.n.toLocaleString()} round-trips`, signCls(s.net))}
      ${kpi('Open P&L', money0(openUpnl), `today ${money0(openDpnl)}`, signCls(openUpnl))}
      ${kpi('Win rate', pct(s.winRate), `${s.wins}W / ${s.losses}L`)}
      ${kpi('Profit factor', num(s.profitFactor), `expectancy ${money0(s.expectancy)}`, s.profitFactor >= 1 ? 'up' : 'down')}
      ${kpi('Max drawdown', pct(risk.maxDD), `${M.iso(risk.maxDDPeak || '')} → ${M.iso(risk.maxDDTrough || '')}`, 'down')}
      ${kpi('Sharpe / Sortino', `${num(risk.sharpe)} / ${num(risk.sortino)}`, `vol ${pct(risk.vol, 0)} ann.`)}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      ${panel('Account performance — time-weighted return', `
        <div class="legend label" style="margin-bottom:8px">
          <span><i style="background:var(--blueprint)"></i>Cumulative TWR</span>
          <span class="muted">Deposits and withdrawals excluded — TWR measures the trading, not the funding.</span>
        </div>
        <div id="c-twr"></div>`)}
      ${panel('Account value (NAV)', `
        <div class="legend label" style="margin-bottom:8px">
          <span><i style="background:var(--stamp)"></i>Net liquidation</span>
          <span class="muted">Steps reflect cash movements as well as P&amp;L.</span>
        </div>
        <div id="c-nav"></div>`)}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      ${panel('Cumulative realized P&L', '<div id="c-cum"></div>', '<span class="label">by trade close</span>')}
      ${panel('Monthly realized P&L', '<div id="c-month"></div>')}
    </div>

    <div class="grid" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);margin-bottom:14px">
      ${panel('Daily realized P&L', '<div id="c-cal" style="overflow-x:auto"></div>')}
      ${panel('P&L by underlying', '<div id="c-sym" style="max-height:420px;overflow-y:auto"></div>')}
    </div>

    <div class="grid g2">
      ${panel('Recent closed trades', '<div class="tbl-wrap" id="t-recent"></div>', '', true)}
      ${panel('Open positions', '<div class="tbl-wrap" id="t-open"></div>', `<span class="label">${structs.length} structures</span>`, true)}
    </div>`;

  // charts
  const perfSeries = DATA.perf.series;
  mountChart($('#c-twr', root), lineChart(
    perfSeries.dates.map((d, i) => ({ label: M.iso(d), value: perfSeries.cps[i] })),
    { percent: true, height: 240, xFormat: (d) => d.slice(2, 7) }
  ));
  mountChart($('#c-nav', root), lineChart(
    perfSeries.dates.map((d, i) => ({ label: M.iso(d), value: perfSeries.nav[i] })),
    { height: 240, tone: 'accent', xFormat: (d) => d.slice(2, 7) }
  ));

  const curve = M.equityCurve(trips);
  mountChart($('#c-cum', root), lineChart(
    curve.map((p) => ({ label: dateOf(p.t), value: p.cum })),
    { height: 230, zeroBase: true, xFormat: (d) => d.slice(2, 7),
      tip: (d) => `<b>${d.label}</b><br>cumulative ${money0(d.value)}` }
  ));

  const months = M.monthlyPnl(trips);
  mountChart($('#c-month', root), barChart(
    months.map((m) => ({ label: m.key, value: m.net, n: m.n })),
    { height: 230, xFormat: (k) => k.slice(2),
      tip: (d) => `<b>${d.label}</b><br>${money(d.value)}<br>${d.n} trades` }
  ));

  mountChart($('#c-cal', root), calendarHeatmap(DATA.meta.dailyPnl));

  const bySym = M.breakdown(trips, (t) => t.sym).slice(0, 22);
  mountChart($('#c-sym', root), rankedBars(
    bySym.map((r) => ({ label: r.key, value: r.net, r })),
    { tip: (d) => `<b>${d.label}</b><br>${money(d.value)}<br>${d.r.n} trades · ${pct(d.r.winRate)} win` }
  ));

  // recent trades
  const recent = [...trips].sort((a, b) => b.closed.localeCompare(a.closed)).slice(0, 12);
  $('#t-recent', root).innerHTML = `
    <table><thead><tr>
      <th>Closed</th><th>Symbol</th><th>Strategy</th><th class="num">Held</th><th class="num">P&L</th>
    </tr></thead><tbody>
      ${recent.map((t) => `<tr class="clickable" data-trip="${esc(t.id)}">
        <td class="mono">${dateOf(t.closed)}</td>
        <td class="sym">${esc(t.sym)}</td>
        <td>${esc(t.shape.label)}</td>
        <td class="num">${t.days === null ? '—' : t.days < 1 ? '<1d' : Math.round(t.days) + 'd'}</td>
        <td class="num ${signCls(t.pnl)}">${money(t.pnl)}</td>
      </tr>`).join('')}
    </tbody></table>`;

  // open positions
  const top = [...structs].sort((a, b) => Math.abs(b.upnl) - Math.abs(a.upnl)).slice(0, 12);
  $('#t-open', root).innerHTML = `
    <table><thead><tr>
      <th>Underlying</th><th>Structure</th><th>Expiry</th><th class="num">Value</th><th class="num">Open P&L</th>
    </tr></thead><tbody>
      ${top.map((p) => `<tr>
        <td class="sym">${esc(p.under)}</td>
        <td>${esc(p.struct.label)}${p.struct.lots > 1 ? ` <span class="tag">×${p.struct.lots}</span>` : ''}</td>
        <td class="mono muted">${p.expiry || '—'}</td>
        <td class="num">${money0(p.mv)}</td>
        <td class="num ${signCls(p.upnl)}">${money(p.upnl)}</td>
      </tr>`).join('')}
    </tbody></table>`;

  wireTripRows(root);
}

/* --------------------------------------------------------------- journal */

const SORTS = {
  closed: (t) => t.closed,
  opened: (t) => t.opened || '',
  sym: (t) => t.sym,
  strategy: (t) => t.shape.label,
  qty: (t) => t.qty,
  days: (t) => (t.days ?? -1),
  pnl: (t) => t.pnl,
  comm: (t) => t.comm,
};

function renderJournal() {
  const root = $('#view-journal');
  const syms = [...new Set(DATA.trips.map((t) => t.sym))].sort();
  const strats = [...new Set(DATA.trips.map((t) => t.shape.label))].sort();

  root.innerHTML = `
    <div class="view-head">
      <h1>Trading journal</h1>
      <span class="label" id="j-count"></span>
    </div>

    <div class="filters">
      <input type="search" id="f-q" placeholder="Search symbol, strategy, notes…" value="${esc(state.q)}">
      <select id="f-sym"><option value="">All symbols</option>${syms.map((s) => `<option${s === state.sym ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <select id="f-strategy"><option value="">All strategies</option>${strats.map((s) => `<option${s === state.strategy ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <select id="f-result">
        <option value="">Any result</option>
        <option value="win"${state.result === 'win' ? ' selected' : ''}>Winners</option>
        <option value="loss"${state.result === 'loss' ? ' selected' : ''}>Losers</option>
        <option value="scratch"${state.result === 'scratch' ? ' selected' : ''}>Scratch</option>
      </select>
      <input type="date" id="f-from" value="${state.from}" title="Closed on or after">
      <input type="date" id="f-to" value="${state.to}" title="Closed on or before">
      <label class="label" style="display:flex;align-items:center;gap:5px;cursor:pointer">
        <input type="checkbox" id="f-notes"${state.notesOnly ? ' checked' : ''}> Journalled only
      </label>
      <button class="btn" id="f-reset">Reset</button>
      <span style="flex:1"></span>
      <button class="btn" id="j-export">Export trades CSV</button>
      <button class="btn" id="j-backup">Back up journal</button>
      <button class="btn" id="j-restore">Restore</button>
    </div>

    <div class="kpis" id="j-kpis"></div>
    ${panel('Round-trips', '<div class="tbl-wrap" id="j-table"></div><div class="pager" id="j-pager"></div>', '<span class="label">click a row to journal it</span>', true)}`;

  const bind = (id, ev, fn) => $(id, root).addEventListener(ev, fn);
  bind('#f-q', 'input', (e) => { state.q = e.target.value; state.page = 0; paintJournal(); });
  bind('#f-sym', 'change', (e) => { state.sym = e.target.value; state.page = 0; paintJournal(); });
  bind('#f-strategy', 'change', (e) => { state.strategy = e.target.value; state.page = 0; paintJournal(); });
  bind('#f-result', 'change', (e) => { state.result = e.target.value; state.page = 0; paintJournal(); });
  bind('#f-from', 'change', (e) => { state.from = e.target.value; state.page = 0; paintJournal(); });
  bind('#f-to', 'change', (e) => { state.to = e.target.value; state.page = 0; paintJournal(); });
  bind('#f-notes', 'change', (e) => { state.notesOnly = e.target.checked; state.page = 0; paintJournal(); });
  bind('#f-reset', 'click', () => {
    Object.assign(state, { q: '', sym: '', strategy: '', result: '', from: '', to: '', notesOnly: false, page: 0 });
    renderJournal();
  });
  bind('#j-export', 'click', exportTradesCsv);
  bind('#j-backup', 'click', backupJournal);
  bind('#j-restore', 'click', restoreJournal);

  paintJournal();
}

function paintJournal() {
  const root = $('#view-journal');
  const rows = filtered();
  const s = M.tradeStats(rows);

  $('#j-count', root).textContent =
    `${rows.length.toLocaleString()} of ${DATA.trips.length.toLocaleString()} round-trips · ${journal.count()} journalled`;

  $('#j-kpis', root).innerHTML = [
    kpi('Net P&L', money0(s.net), `${s.n} trades`, signCls(s.net)),
    kpi('Win rate', pct(s.winRate), `${s.wins}W / ${s.losses}L${s.scratches ? ` / ${s.scratches}S` : ''}`),
    kpi('Profit factor', num(s.profitFactor), `${money0(s.grossWin)} vs ${money0(-s.grossLoss)}`),
    kpi('Expectancy', money(s.expectancy), 'per trade', signCls(s.expectancy)),
    kpi('Avg win / loss', `${money0(s.avgWin)} / ${money0(-s.avgLoss)}`, `payoff ${num(s.payoff)}`),
    kpi('Best / worst', `${money0(s.largestWin)} / ${money0(s.largestLoss)}`, `streaks ${s.maxWinStreak}W ${s.maxLossStreak}L`),
    kpi('Avg hold', s.avgHold < 1 ? `${(s.avgHold * 24).toFixed(1)}h` : `${s.avgHold.toFixed(1)}d`, `median ${s.medianHold < 1 ? (s.medianHold * 24).toFixed(1) + 'h' : s.medianHold.toFixed(1) + 'd'}`),
    kpi('Commissions', money0(s.commissions), 'already in P&L'),
  ].join('');

  const sorted = [...rows].sort((a, b) => {
    const f = SORTS[state.sort.key];
    const av = f(a), bv = f(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * state.sort.dir;
  });
  const start = state.page * state.pageSize;
  const page = sorted.slice(start, start + state.pageSize);

  const th = (key, label, cls = '') =>
    `<th class="sortable ${cls}" data-sort="${key}">${label}${state.sort.key === key ? `<span class="arrow">${state.sort.dir > 0 ? '↑' : '↓'}</span>` : ''}</th>`;

  $('#j-table', root).innerHTML = page.length ? `
    <table><thead><tr>
      ${th('closed', 'Closed')}${th('opened', 'Opened')}${th('sym', 'Symbol')}${th('strategy', 'Strategy')}
      ${th('qty', 'Qty', 'num')}${th('days', 'Held', 'num')}
      <th class="num">Entry</th><th class="num">Exit</th>${th('pnl', 'Net P&L', 'num')}${th('comm', 'Comm', 'num')}
      <th>Journal</th>
    </tr></thead><tbody>
      ${page.map((t) => {
        const je = journal.get(t.id);
        return `<tr class="clickable" data-trip="${esc(t.id)}">
          <td class="mono">${dateOf(t.closed)}</td>
          <td class="mono muted">${dateOf(t.opened)}${t.inferredEntry ? '' : ' <span class="tag" title="No matching opening fill in the pulled window">?</span>'}</td>
          <td class="sym">${esc(t.sym)}</td>
          <td>${esc(t.shape.label)}${t.roll ? ' <span class="tag accent">roll</span>' : ''}${t.expired ? ' <span class="tag">expiry</span>' : ''}</td>
          <td class="num">${t.qty}</td>
          <td class="num">${t.days === null ? '—' : t.days < 1 ? '<1d' : Math.round(t.days) + 'd'}</td>
          <td class="num muted">${t.entryCash === null ? '—' : money0(t.entryCash)}</td>
          <td class="num muted">${money0(t.exitCash)}</td>
          <td class="num ${signCls(t.pnl)}">${money(t.pnl)}</td>
          <td class="num muted">${money(t.comm)}</td>
          <td>${je.rating ? `<span class="tag">${'★'.repeat(je.rating)}</span> ` : ''}${je.note ? `<span class="has-note" title="${esc(je.note.slice(0, 140))}">✎</span> ` : ''}${je.tags.slice(0, 2).map((g) => `<span class="tag">${esc(g)}</span>`).join(' ')}</td>
        </tr>`;
      }).join('')}
    </tbody>
    <tfoot><tr>
      <td colspan="8">Page total — ${page.length} of ${rows.length} trades</td>
      <td class="num ${signCls(M.sum(page.map((t) => t.pnl)))}">${money(M.sum(page.map((t) => t.pnl)))}</td>
      <td class="num">${money(M.sum(page.map((t) => t.comm)))}</td><td></td>
    </tr></tfoot></table>` : '<div class="empty">No trades match these filters.</div>';

  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  $('#j-pager', root).innerHTML = pages > 1 ? `
    <button class="btn" id="pg-prev"${state.page === 0 ? ' disabled' : ''}>Prev</button>
    <span>Page ${state.page + 1} / ${pages}</span>
    <button class="btn" id="pg-next"${state.page >= pages - 1 ? ' disabled' : ''}>Next</button>` : '';
  if (pages > 1) {
    $('#pg-prev', root)?.addEventListener('click', () => { state.page--; paintJournal(); });
    $('#pg-next', root)?.addEventListener('click', () => { state.page++; paintJournal(); });
  }

  $$('th.sortable', root).forEach((h) =>
    h.addEventListener('click', () => {
      const k = h.dataset.sort;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: -1 };
      paintJournal();
    })
  );
  wireTripRows(root);
}

/* ---------------------------------------------------------------- drawer */

function wireTripRows(root) {
  $$('tr[data-trip]', root).forEach((tr) =>
    tr.addEventListener('click', () => openTrip(tr.dataset.trip))
  );
}

function openTrip(id) {
  const t = DATA.trips.find((x) => x.id === id);
  if (!t) return;
  const je = journal.get(id);
  const fills = DATA.execs.filter((e) => e.combo === id);

  const drawer = $('#drawer');
  drawer.innerHTML = `
    <header>
      <div>
        <h3>${esc(t.sym)} · ${esc(t.shape.label)}</h3>
        <div class="label">${esc(t.name || '')}</div>
      </div>
      <button class="icon-btn" id="dr-close" aria-label="Close">✕</button>
    </header>
    <div class="body">
      <dl class="kv">
        <dt>Net P&L</dt><dd class="${signCls(t.pnl)}">${money(t.pnl)}</dd>
        <dt>Opened</dt><dd>${dtOf(t.opened)}${t.inferredEntry ? '' : ' <span class="tag warn">unmatched</span>'}</dd>
        <dt>Closed</dt><dd>${dtOf(t.closed)}</dd>
        <dt>Held</dt><dd>${t.days === null ? '—' : t.days < 1 ? `${(t.days * 24).toFixed(1)} h` : `${t.days.toFixed(1)} d`}</dd>
        <dt>Contracts</dt><dd>${t.qty}</dd>
        <dt>Entry cash</dt><dd>${t.entryCash === null ? '—' : money(t.entryCash)}</dd>
        <dt>Exit cash</dt><dd>${money(t.exitCash)}</dd>
        <dt>Commissions</dt><dd>${money(t.comm)}</dd>
        <dt>Security</dt><dd>${esc(t.sec)}${t.roll ? ' · roll' : ''}</dd>
        <dt>Exit</dt><dd>${t.expired ? 'Expiration / assignment' : 'Traded out'}</dd>
      </dl>

      <p class="note" style="margin-top:14px">Net P&amp;L is IBKR's own realized figure and is already net of commissions.${t.inferredEntry ? ' The opening leg is matched first-in-first-out within the underlying.' : ' No opening fill for this exit exists in the pulled window, so entry details are unavailable.'}${t.expired ? ' This position settled at expiry: IBKR books every expiring leg of the underlying at one instant, so all legs settling together are shown as a single outcome.' : ''}</p>

      ${fills.length ? `
      <div style="margin-top:16px">
        <div class="label" style="margin-bottom:6px">${t.expired ? 'Settlement legs' : 'Closing fills'}</div>
        <table class="legs"><thead><tr><th>Side</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th><th class="num">P&L</th></tr></thead><tbody>
          ${fills.map((f) => `<tr>
            <td class="${f.side === 'BUY' ? 'long' : 'short'}">${f.side}</td>
            <td class="num">${f.qty}</td><td class="num">${f.px}</td>
            <td class="num">${money0(f.amt)}</td>
            <td class="num ${signCls(f.pnl)}">${f.pnl ? money(f.pnl) : '—'}</td>
          </tr>`).join('')}
        </tbody></table>
      </div>` : ''}

      <div class="journal-field">
        <label class="label" for="jr-note">Notes — what was the plan, what happened, what to repeat</label>
        <textarea id="jr-note" placeholder="Thesis, entry trigger, management, mistakes…">${esc(je.note)}</textarea>
      </div>

      <div class="journal-field">
        <label class="label">Execution rating</label>
        <div class="rating" id="jr-rating">
          ${[1, 2, 3, 4, 5].map((n) => `<button data-r="${n}" aria-pressed="${je.rating === n}">${n}</button>`).join('')}
          <button data-r="0" aria-pressed="${!je.rating}" title="Clear">–</button>
        </div>
      </div>

      <div class="journal-field">
        <label class="label">Tags</label>
        <div class="chips" id="jr-tags">
          ${PRESET_TAGS.map((g) => `<button class="chip${je.tags.includes(g) ? ' on' : ''}" data-tag="${esc(g)}">${esc(g)}</button>`).join('')}
        </div>
        <input type="text" id="jr-custom" placeholder="custom tags, comma separated" style="margin-top:8px"
          value="${esc(je.tags.filter((g) => !PRESET_TAGS.includes(g)).join(', '))}">
      </div>

      <div style="display:flex;gap:8px;align-items:center;margin-top:16px">
        <button class="btn primary" id="jr-save">Save entry</button>
        <span class="saved-flash" id="jr-flash">saved</span>
      </div>
    </div>`;

  drawer.hidden = false;
  $('#drawer-backdrop').hidden = false;

  let rating = je.rating;
  const tags = new Set(je.tags);

  $('#dr-close', drawer).addEventListener('click', closeDrawer);
  $$('#jr-rating button', drawer).forEach((b) =>
    b.addEventListener('click', () => {
      rating = +b.dataset.r;
      $$('#jr-rating button', drawer).forEach((x) => x.setAttribute('aria-pressed', +x.dataset.r === rating));
    })
  );
  $$('#jr-tags .chip', drawer).forEach((c) =>
    c.addEventListener('click', () => {
      const g = c.dataset.tag;
      tags.has(g) ? tags.delete(g) : tags.add(g);
      c.classList.toggle('on');
    })
  );
  $('#jr-save', drawer).addEventListener('click', () => {
    const custom = $('#jr-custom', drawer).value.split(',').map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...[...tags].filter((g) => PRESET_TAGS.includes(g)), ...custom])];
    const ok = journal.set(id, { note: $('#jr-note', drawer).value.trim(), tags: merged, rating });
    const flash = $('#jr-flash', drawer);
    flash.textContent = ok ? 'saved' : 'could not save — storage blocked';
    flash.classList.toggle('down', !ok);
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 1600);
    if (state.view === 'journal') paintJournal();
  });
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
}

/* ------------------------------------------------------------- positions */

function renderPositions() {
  const root = $('#view-positions');
  const { structures } = DATA.positions;
  const a = DATA.account.summary;
  const upnl = structures.reduce((x, s) => x + s.upnl, 0);
  const dpnl = structures.reduce((x, s) => x + s.dpnl, 0);
  const byKind = M.groupBy(structures, (s) => s.struct.label);
  const kinds = [...byKind.entries()].sort((x, y) => y[1].length - x[1].length);

  root.innerHTML = `
    <div class="view-head">
      <h1>Open positions</h1>
      <span class="label">detected automatically from contract legs · as of ${dateOf(DATA.meta.asOf)}</span>
    </div>

    <div class="kpis">
      ${kpi('Net liquidation', money0(a.net_liquidation))}
      ${kpi('Gross position value', money0(a.gross_position_value), `leverage ${a.leverage}×`)}
      ${kpi('Open P&L', money0(upnl), `today ${money0(dpnl)}`, signCls(upnl))}
      ${kpi('Cash', money0(a.total_cash_value), `available ${money0(a.available_funds)}`)}
      ${kpi('Buying power', money0(a.buying_power))}
      ${kpi('Maint. margin', money0(a.maintenance_margin), `excess liq ${money0(a.excess_liquidity)}`)}
      ${kpi('Structures', String(structures.length), `${structures.reduce((n, s) => n + s.legs.length, 0)} legs`)}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      ${panel('Structure mix', `<div class="tbl-wrap"><table><thead><tr><th>Structure</th><th class="num">Count</th><th class="num">Value</th><th class="num">Open P&L</th></tr></thead><tbody>
        ${kinds.map(([k, v]) => `<tr>
          <td>${esc(k)}</td><td class="num">${v.length}</td>
          <td class="num">${money0(M.sum(v.map((s) => s.mv)))}</td>
          <td class="num ${signCls(M.sum(v.map((s) => s.upnl)))}">${money0(M.sum(v.map((s) => s.upnl)))}</td>
        </tr>`).join('')}
      </tbody></table></div>`, '', true)}
      ${panel('Open P&L by structure', '<div id="c-pos" style="max-height:420px;overflow-y:auto"></div>')}
    </div>

    ${panel('Detected structures', `<div class="tbl-wrap">${structures.map(renderStructure).join('')}</div>`, '<span class="label">legs grouped by underlying and expiry</span>')}`;

  mountChart($('#c-pos', root), rankedBars(
    [...structures].sort((x, y) => Math.abs(y.upnl) - Math.abs(x.upnl)).slice(0, 20)
      .map((s) => ({ label: `${s.under} ${s.struct.label}`.slice(0, 26), value: s.upnl })),
    {}
  ));
}

function renderStructure(s) {
  const legRow = (l) => `<tr>
    <td class="${l.qty > 0 ? 'long' : 'short'}">${l.qty > 0 ? '+' : ''}${l.qty}</td>
    <td>${esc(l.desc)}</td>
    <td class="num">${l.avg ? l.avg.toFixed(2) : '—'}</td>
    <td class="num">${l.px?.toFixed?.(4) ?? '—'}</td>
    <td class="num">${money0(l.mv)}</td>
    <td class="num ${signCls(l.upnl)}">${money0(l.upnl)}</td>
    <td class="num ${signCls(l.dpnl)}">${money0(l.dpnl)}</td>
  </tr>`;

  return `<div style="border:1px solid var(--rule);border-radius:2px;margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;padding:9px 12px;background:var(--paper-2);border-bottom:1px solid var(--rule)">
      <div>
        <span class="sym" style="font-size:0.9rem">${esc(s.under)}</span>
        <span class="tag accent" style="margin-left:7px">${esc(s.struct.label)}</span>
        ${s.struct.lots > 1 ? `<span class="tag">×${s.struct.lots}</span>` : ''}
        ${s.struct.width ? `<span class="tag">${s.struct.width} wide</span>` : ''}
        ${s.expiry ? `<span class="tag">exp ${s.expiry}</span>` : ''}
      </div>
      <div class="mono" style="font-size:0.74rem">
        <span class="muted">value</span> ${money0(s.mv)}
        <span class="muted" style="margin-left:10px">open</span> <span class="${signCls(s.upnl)}">${money(s.upnl)}</span>
        <span class="muted" style="margin-left:10px">today</span> <span class="${signCls(s.dpnl)}">${money(s.dpnl)}</span>
      </div>
    </div>
    <table class="legs"><thead><tr><th>Qty</th><th>Contract</th><th class="num">Avg cost</th><th class="num">Mark</th><th class="num">Value</th><th class="num">Open P&L</th><th class="num">Today</th></tr></thead>
    <tbody>${s.legs.map(legRow).join('')}</tbody></table>
  </div>`;
}

/* ------------------------------------------------------------- analytics */

function renderAnalytics() {
  const root = $('#view-analytics');
  const trips = filtered();
  const s = M.tradeStats(trips);
  const risk = M.riskMetrics(DATA.perf);

  const byStrategy = M.breakdown(trips, (t) => t.shape.label);
  const bySym = M.breakdown(trips, (t) => t.sym);
  const byDow = M.breakdown(trips, (t) => M.WEEKDAYS[new Date(t.closed).getUTCDay()]);
  const byHold = M.breakdown(trips, (t) => M.holdBucket(t.days))
    .sort((a, b) => M.HOLD_ORDER.indexOf(a.key) - M.HOLD_ORDER.indexOf(b.key));
  const byHour = M.breakdown(trips, (t) => String(new Date(t.closed).getUTCHours()).padStart(2, '0') + ':00 UTC')
    .sort((a, b) => a.key.localeCompare(b.key));

  const curve = M.equityCurve(trips);
  const ddAbs = M.maxDrawdownAbs(curve);

  root.innerHTML = `
    <div class="view-head">
      <h1>Advanced analytics</h1>
      <span class="label">${trips.length.toLocaleString()} round-trips in scope${trips.length !== DATA.trips.length ? ' (filters from the journal apply)' : ''}</span>
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      ${panel('Account risk & return (TWR)', `<div class="tbl-wrap"><table><tbody>
        ${[
          ['Total return', pct(risk.totalReturn), signCls(risk.totalReturn)],
          ['CAGR', pct(risk.cagr), signCls(risk.cagr)],
          ['Annualised volatility', pct(risk.vol, 1), ''],
          ['Sharpe ratio', num(risk.sharpe), signCls(risk.sharpe)],
          ['Sortino ratio', num(risk.sortino), signCls(risk.sortino)],
          ['Calmar ratio', num(risk.calmar), signCls(risk.calmar)],
          ['Max drawdown', pct(risk.maxDD), 'down'],
          ['Drawdown window', `${M.iso(risk.maxDDPeak || '')} → ${M.iso(risk.maxDDTrough || '')}`, 'muted'],
          ['Current drawdown', pct(risk.currentDD), signCls(risk.currentDD)],
          ['Best / worst day', `${pct(risk.bestDay)} / ${pct(risk.worstDay)}`, ''],
          ['Positive days', `${risk.positiveDays} / ${risk.tradingDays} (${pct(risk.dayWinRate)})`, ''],
        ].map(([k, v, c]) => `<tr><td>${k}</td><td class="num ${c}">${v}</td></tr>`).join('')}
      </tbody></table></div>`, '<span class="label">account level</span>', true)}

      ${panel('Trade quality', `<div class="tbl-wrap"><table><tbody>
        ${[
          ['Round-trips', s.n.toLocaleString(), ''],
          ['Win rate', `${pct(s.winRate)} (${s.wins}W / ${s.losses}L)`, ''],
          ['Profit factor', num(s.profitFactor), s.profitFactor >= 1 ? 'up' : 'down'],
          ['Expectancy per trade', money(s.expectancy), signCls(s.expectancy)],
          ['Average trade', money(s.avgTrade), signCls(s.avgTrade)],
          ['Median trade', money(s.medianTrade), signCls(s.medianTrade)],
          ['Average win', money(s.avgWin), 'up'],
          ['Average loss', money(-s.avgLoss), 'down'],
          ['Payoff ratio', num(s.payoff), ''],
          ['Largest win / loss', `${money(s.largestWin)} / ${money(s.largestLoss)}`, ''],
          ['Longest win / loss streak', `${s.maxWinStreak} / ${s.maxLossStreak}`, ''],
          ['Best trade share of gross profit', pct(s.topTradeShare), s.topTradeShare > 0.25 ? 'down' : ''],
          ['Realized P&L drawdown', money(ddAbs.depth), 'down'],
          ['Commissions (already in P&L)', money(s.commissions), 'muted'],
        ].map(([k, v, c]) => `<tr><td>${k}</td><td class="num ${c}">${v}</td></tr>`).join('')}
      </tbody></table></div>`, '<span class="label">trade level</span>', true)}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      ${panel('Trade P&L distribution', '<div id="a-hist"></div><p class="note" style="margin-top:8px">Clipped to the middle 98% so the bulk of trades stays legible; the outer bins carry everything beyond.</p>', `<span class="label">p5 ${money0(M.percentile(trips.map((t) => t.pnl), 0.05))} · p95 ${money0(M.percentile(trips.map((t) => t.pnl), 0.95))}</span>`)}
      ${panel('Realized P&L drawdown', '<div id="a-dd"></div>')}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      ${panel('By strategy', breakdownTable(byStrategy), '', true)}
      ${panel('By hold time', breakdownTable(byHold) +
        `<p class="note" style="padding:12px 14px;margin:0">Holding periods pair each exit with an opening fill first-in-first-out within the underlying — the same basis IBKR uses for the realized P&amp;L itself. On names traded continuously this can date an exit to an older entry than the one you had in mind.</p>`, '', true)}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      ${panel('By weekday closed', breakdownTable(byDow), '', true)}
      ${panel('By hour closed', breakdownTable(byHour.slice(0, 14)), '<span class="label">UTC</span>', true)}
    </div>

    ${panel('By underlying', breakdownTable(bySym), `<span class="label">${bySym.length} symbols</span>`, true)}`;

  mountChart($('#a-hist', root), histogramChart(M.histogram(trips.map((t) => t.pnl), 30, 0.01), { height: 210 }));
  mountChart($('#a-dd', root), lineChart(
    curve.map((p) => ({ label: dateOf(p.t), value: p.dd })),
    { height: 210, tone: 'accent', xFormat: (d) => d.slice(2, 7),
      tip: (d) => `<b>${d.label}</b><br>drawdown ${money0(d.value)}` }
  ));
}

function breakdownTable(rows) {
  if (!rows.length) return '<div class="empty">Nothing in scope.</div>';
  const max = Math.max(...rows.map((r) => Math.abs(r.net)), 1);
  return `<div class="tbl-wrap"><table><thead><tr>
    <th>Bucket</th><th class="num">Trades</th><th class="num">Win %</th><th class="num">Net P&L</th>
    <th class="num">Avg</th><th class="num">PF</th><th class="num">Expectancy</th>
  </tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td>${esc(r.key)}</td>
      <td class="num">${r.n}</td>
      <td class="num">${pct(r.winRate, 0)}</td>
      <td class="num bar-cell"><span class="fill ${r.net >= 0 ? 'up' : 'down'}" style="width:${(Math.abs(r.net) / max) * 100}%"></span><span class="${signCls(r.net)}">${money0(r.net)}</span></td>
      <td class="num ${signCls(r.avgTrade)}">${money0(r.avgTrade)}</td>
      <td class="num">${num(r.profitFactor, 2)}</td>
      <td class="num ${signCls(r.expectancy)}">${money0(r.expectancy)}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

/* --------------------------------------------------------------- reports */

function renderReports() {
  const root = $('#view-reports');
  const trips = filtered();

  const monthly = M.monthlyPnl(trips).map((m) => {
    const g = trips.filter((t) => t.closed.slice(0, 7) === m.key);
    return { key: m.key, ...M.tradeStats(g) };
  });
  const bySym = M.breakdown(trips, (t) => t.sym);
  const byStrat = M.breakdown(trips, (t) => t.shape.label);
  const byYear = M.breakdown(trips, (t) => t.closed.slice(0, 4)).sort((a, b) => a.key.localeCompare(b.key));

  let run = 0;
  const monthlyRows = monthly.map((m) => {
    run += m.net;
    return { ...m, run };
  });

  root.innerHTML = `
    <div class="view-head">
      <h1>Advanced reports</h1>
      <span class="label">${trips.length.toLocaleString()} round-trips${trips.length !== DATA.trips.length ? ' (filtered)' : ''} · P&amp;L net of commissions</span>
    </div>

    <div class="filters">
      <button class="btn" data-csv="monthly">Monthly CSV</button>
      <button class="btn" data-csv="symbol">Symbol CSV</button>
      <button class="btn" data-csv="strategy">Strategy CSV</button>
      <button class="btn" data-csv="trades">All trades CSV</button>
      <button class="btn" id="r-print">Print / PDF</button>
    </div>

    ${panel('Year summary', reportTable(byYear, 'Year'), '', true)}
    <div style="height:14px"></div>
    ${panel('Monthly performance', `<div class="tbl-wrap"><table><thead><tr>
      <th>Month</th><th class="num">Trades</th><th class="num">Wins</th><th class="num">Win %</th>
      <th class="num">Net P&L</th><th class="num">Cumulative</th><th class="num">Avg trade</th>
      <th class="num">Best</th><th class="num">Worst</th><th class="num">PF</th>
    </tr></thead><tbody>
      ${monthlyRows.map((m) => `<tr>
        <td class="mono">${m.key}</td>
        <td class="num">${m.n}</td>
        <td class="num">${m.wins}</td>
        <td class="num">${m.n ? pct(m.winRate, 0) : '—'}</td>
        <td class="num ${signCls(m.net)}">${money0(m.net)}</td>
        <td class="num ${signCls(m.run)}">${money0(m.run)}</td>
        <td class="num ${signCls(m.avgTrade)}">${m.n ? money0(m.avgTrade) : '—'}</td>
        <td class="num up">${m.n ? money0(m.largestWin) : '—'}</td>
        <td class="num down">${m.n ? money0(m.largestLoss) : '—'}</td>
        <td class="num">${num(m.profitFactor, 2)}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <td>Total</td>
      <td class="num">${M.sum(monthlyRows.map((m) => m.n))}</td>
      <td class="num">${M.sum(monthlyRows.map((m) => m.wins))}</td>
      <td class="num"></td>
      <td class="num ${signCls(run)}">${money0(run)}</td>
      <td colspan="5"></td>
    </tr></tfoot></table></div>`, '', true)}
    <div style="height:14px"></div>
    ${panel('By underlying', reportTable(bySym, 'Symbol'), '', true)}
    <div style="height:14px"></div>
    ${panel('By strategy', reportTable(byStrat, 'Strategy'), '', true)}`;

  $$('[data-csv]', root).forEach((b) =>
    b.addEventListener('click', () => {
      const which = b.dataset.csv;
      if (which === 'trades') return exportTradesCsv();
      const src = which === 'monthly' ? monthlyRows : which === 'symbol' ? bySym : byStrat;
      const head = which === 'monthly' ? 'month' : which === 'symbol' ? 'symbol' : 'strategy';
      downloadCsv(`ibkr-${which}-report.csv`, [
        [head, 'trades', 'wins', 'losses', 'win_rate', 'net_pnl', 'gross_win', 'gross_loss', 'profit_factor', 'avg_trade', 'expectancy', 'largest_win', 'largest_loss', 'commissions'],
        ...src.map((r) => [r.key, r.n, r.wins, r.losses, r.winRate.toFixed(4), r.net.toFixed(2), r.grossWin.toFixed(2), (-r.grossLoss).toFixed(2), r.profitFactor === null ? '' : r.profitFactor.toFixed(3), r.avgTrade.toFixed(2), r.expectancy.toFixed(2), r.largestWin.toFixed(2), r.largestLoss.toFixed(2), r.commissions.toFixed(2)]),
      ]);
    })
  );
  $('#r-print', root).addEventListener('click', () => window.print());
}

function reportTable(rows, label) {
  if (!rows.length) return '<div class="empty">Nothing in scope.</div>';
  const tot = {
    n: M.sum(rows.map((r) => r.n)),
    wins: M.sum(rows.map((r) => r.wins)),
    net: M.sum(rows.map((r) => r.net)),
    comm: M.sum(rows.map((r) => r.commissions)),
  };
  return `<div class="tbl-wrap"><table><thead><tr>
    <th>${esc(label)}</th><th class="num">Trades</th><th class="num">Wins</th><th class="num">Win %</th>
    <th class="num">Net P&L</th><th class="num">Avg</th><th class="num">Best</th><th class="num">Worst</th>
    <th class="num">PF</th><th class="num">Expectancy</th><th class="num">Comm</th>
  </tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td class="${label === 'Symbol' ? 'sym' : 'mono'}">${esc(r.key)}</td>
      <td class="num">${r.n}</td><td class="num">${r.wins}</td><td class="num">${pct(r.winRate, 0)}</td>
      <td class="num ${signCls(r.net)}">${money0(r.net)}</td>
      <td class="num ${signCls(r.avgTrade)}">${money0(r.avgTrade)}</td>
      <td class="num up">${money0(r.largestWin)}</td>
      <td class="num down">${money0(r.largestLoss)}</td>
      <td class="num">${num(r.profitFactor, 2)}</td>
      <td class="num ${signCls(r.expectancy)}">${money0(r.expectancy)}</td>
      <td class="num muted">${money0(r.commissions)}</td>
    </tr>`).join('')}
  </tbody>
  <tfoot><tr>
    <td>Total</td><td class="num">${tot.n}</td><td class="num">${tot.wins}</td>
    <td class="num">${pct(tot.n ? tot.wins / tot.n : 0, 0)}</td>
    <td class="num ${signCls(tot.net)}">${money0(tot.net)}</td>
    <td colspan="5"></td><td class="num">${money0(tot.comm)}</td>
  </tr></tfoot></table></div>`;
}

/* ---------------------------------------------------------------- export */

function downloadCsv(name, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  downloadBlob(name, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportTradesCsv() {
  const rows = filtered();
  downloadCsv('ibkr-round-trips.csv', [
    ['closed', 'opened', 'symbol', 'name', 'security', 'strategy', 'contracts', 'days_held',
      'entry_cash', 'exit_cash', 'net_pnl', 'commissions', 'roll', 'entry_matched', 'rating', 'tags', 'note'],
    ...rows.map((t) => {
      const j = journal.get(t.id);
      return [t.closed, t.opened || '', t.sym, t.name, t.sec, t.shape.label, t.qty,
        t.days ?? '', t.entryCash ?? '', t.exitCash, t.pnl, t.comm,
        t.roll ? 'yes' : 'no', t.inferredEntry ? 'yes' : 'no',
        j.rating || '', j.tags.join('; '), j.note];
    }),
  ]);
}

function backupJournal() {
  downloadBlob(
    `ibkr-journal-${new Date().toISOString().slice(0, 10)}.json`,
    new Blob([JSON.stringify({ version: 1, exported: new Date().toISOString(), entries: journal.all }, null, 2)],
      { type: 'application/json' })
  );
}

function restoreJournal() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      const entries = parsed.entries || parsed;
      if (typeof entries !== 'object' || Array.isArray(entries)) throw new Error('unrecognised file');
      const before = journal.count();
      journal.all = { ...journal.all, ...entries };
      localStorage.setItem(JKEY, JSON.stringify(journal.all));
      alert(`Journal restored. ${journal.count() - before} new entries merged; ${journal.count()} total.`);
      paintJournal();
    } catch (e) {
      alert(`Could not read that file: ${e.message}`);
    }
  });
  input.click();
}

/* ------------------------------------------------------------------ boot */

const VIEWS = {
  dashboard: renderDashboard,
  journal: renderJournal,
  positions: renderPositions,
  analytics: renderAnalytics,
  reports: renderReports,
};

function show(view) {
  if (!VIEWS[view]) view = 'dashboard';
  state.view = view;
  $$('section.view').forEach((s) => (s.hidden = s.id !== `view-${view}`));
  $$('nav.tabs button').forEach((b) =>
    b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')
  );
  VIEWS[view]();
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0 });
}

function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('ibkr-theme', t);
  $('#theme-btn').textContent = t === 'dark' ? '◐' : t === 'light' ? '○' : '◑';
  $('#theme-btn').title = `Theme: ${t}`;
}

async function boot() {
  journal.load();
  try {
    applyTheme(localStorage.getItem('ibkr-theme') || 'auto');
  } catch { /* storage blocked; the default palette still applies */ }

  try {
    await loadData();
  } catch (e) {
    $('#boot').innerHTML =
      `<div class="empty">Could not load the dataset: ${esc(e.message)}<br><br>
       This page reads JSON from <code>trading/data/</code> over HTTP — open it through a web server
       (or GitHub&nbsp;Pages), not as a <code>file://</code> path.</div>`;
    return;
  }

  $('#boot').remove();
  $('#app').hidden = false;
  $('#stamp').textContent = `data as of ${dateOf(DATA.meta.asOf)}`;

  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
  $('#theme-btn').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const cur = localStorage.getItem('ibkr-theme') || 'auto';
    applyTheme(order[(order.indexOf(cur) + 1) % order.length]);
    show(state.view); // recolour charts under the new palette
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'dashboard'));

  show(location.hash.slice(1) || 'dashboard');
}

boot();
