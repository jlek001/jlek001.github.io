/**
 * Trade performance analytics.
 *
 * Everything here is derived from two sources, kept deliberately separate:
 *  - Round-trips (from IBKR's per-fill realized P&L). Exact money, already net
 *    of commissions. Drives win rate, profit factor, expectancy and friends.
 *  - The account NAV / time-weighted-return series from IBKR. Drives return,
 *    volatility, Sharpe, Sortino and drawdown, because those must not be
 *    distorted by the deposits and withdrawals visible in the raw NAV.
 */

const TRADING_DAYS = 252;

export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : 0);

export function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
}

export function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

export function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/* ------------------------------------------------------------ trade stats */

/** Core trade-level statistics over a set of round-trips. */
export function tradeStats(trips) {
  const pnl = trips.map((t) => t.pnl);
  const wins = pnl.filter((p) => p > 0);
  const losses = pnl.filter((p) => p < 0);
  const scratches = pnl.filter((p) => p === 0);

  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const net = sum(pnl);
  const decided = wins.length + losses.length;

  const avgWin = mean(wins);
  const avgLoss = Math.abs(mean(losses));
  const winRate = decided ? wins.length / decided : 0;

  // Streaks run in close-time order.
  const ordered = [...trips].sort((a, b) => a.closed.localeCompare(b.closed));
  let curW = 0, curL = 0, maxW = 0, maxL = 0;
  for (const t of ordered) {
    if (t.pnl > 0) { curW++; curL = 0; maxW = Math.max(maxW, curW); }
    else if (t.pnl < 0) { curL++; curW = 0; maxL = Math.max(maxL, curL); }
  }

  const holds = trips.map((t) => t.days).filter((d) => d !== null && d !== undefined);

  return {
    n: trips.length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    winRate,
    net,
    grossWin,
    grossLoss,
    // A book with no losing trade has undefined profit factor, not infinity.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWin,
    avgLoss,
    payoff: avgLoss > 0 ? avgWin / avgLoss : null,
    // Expectancy per trade in currency: what one more trade is worth on average.
    expectancy: decided ? winRate * avgWin - (1 - winRate) * avgLoss : 0,
    avgTrade: mean(pnl),
    medianTrade: median(pnl),
    largestWin: wins.length ? Math.max(...wins) : 0,
    largestLoss: losses.length ? Math.min(...losses) : 0,
    maxWinStreak: maxW,
    maxLossStreak: maxL,
    commissions: sum(trips.map((t) => t.comm || 0)),
    avgHold: mean(holds),
    medianHold: median(holds),
    // Share of total profit contributed by the single best trade: a
    // concentration check on whether the edge is broad or one lucky fill.
    topTradeShare: grossWin > 0 && wins.length ? Math.max(...wins) / grossWin : 0,
  };
}

/** Cumulative realized-P&L curve, one point per closed trade. */
export function equityCurve(trips) {
  const ordered = [...trips].sort((a, b) => a.closed.localeCompare(b.closed));
  let cum = 0, peak = 0;
  return ordered.map((t) => {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    return { t: t.closed, pnl: t.pnl, cum, dd: cum - peak, sym: t.sym };
  });
}

/** Largest peak-to-trough fall of a cumulative currency curve. */
export function maxDrawdownAbs(curve) {
  let peak = -Infinity, worst = 0, at = null, from = null, peakAt = null;
  for (const p of curve) {
    if (p.cum > peak) { peak = p.cum; peakAt = p.t; }
    const dd = p.cum - peak;
    if (dd < worst) { worst = dd; at = p.t; from = peakAt; }
  }
  return { depth: worst, troughAt: at, peakAt: from };
}

/* -------------------------------------------------------- account returns
 * Built from IBKR's time-weighted cumulative return (cps), so deposits and
 * withdrawals -- of which this account has several large ones -- do not read
 * as performance.
 */

/** Convert the cumulative TWR series into daily returns. */
export function dailyReturns(perf) {
  const { cps } = perf.series;
  const out = [];
  for (let i = 1; i < cps.length; i++) {
    // cps are cumulative fractions from a fixed base, so step returns compound.
    const prev = 1 + cps[i - 1];
    if (prev === 0) { out.push(0); continue; }
    out.push((1 + cps[i]) / prev - 1);
  }
  return out;
}

export function riskMetrics(perf, riskFreeAnnual = 0) {
  const { dates, cps, nav } = perf.series;
  const rets = dailyReturns(perf);
  const n = rets.length;

  const totalReturn = cps.at(-1);
  const days = (Date.parse(iso(dates.at(-1))) - Date.parse(iso(dates[0]))) / 86400000;
  const years = days / 365.25;
  const cagr = years > 0 && 1 + totalReturn > 0 ? (1 + totalReturn) ** (1 / years) - 1 : null;

  const vol = stdev(rets) * Math.sqrt(TRADING_DAYS);
  const rfDaily = riskFreeAnnual / TRADING_DAYS;
  const excess = rets.map((r) => r - rfDaily);
  const sharpe = stdev(rets) > 0 ? (mean(excess) / stdev(rets)) * Math.sqrt(TRADING_DAYS) : null;

  // Sortino punishes only downside dispersion.
  const downside = rets.filter((r) => r < rfDaily).map((r) => r - rfDaily);
  const dd = downside.length ? Math.sqrt(sum(downside.map((d) => d * d)) / n) : 0;
  const sortino = dd > 0 ? (mean(excess) / dd) * Math.sqrt(TRADING_DAYS) : null;

  // Drawdown on the TWR growth curve.
  const growth = cps.map((c) => 1 + c);
  let peak = -Infinity, maxDD = 0, troughAt = null, peakAt = null, atPeak = null;
  let curDD = 0;
  for (let i = 0; i < growth.length; i++) {
    if (growth[i] > peak) { peak = growth[i]; atPeak = dates[i]; }
    const d = growth[i] / peak - 1;
    if (d < maxDD) { maxDD = d; troughAt = dates[i]; peakAt = atPeak; }
    curDD = d;
  }

  const posDays = rets.filter((r) => r > 0).length;

  return {
    totalReturn,
    cagr,
    vol,
    sharpe,
    sortino,
    maxDD,
    maxDDPeak: peakAt,
    maxDDTrough: troughAt,
    currentDD: curDD,
    calmar: cagr !== null && maxDD < 0 ? cagr / Math.abs(maxDD) : null,
    bestDay: n ? Math.max(...rets) : 0,
    worstDay: n ? Math.min(...rets) : 0,
    positiveDays: posDays,
    tradingDays: n,
    dayWinRate: n ? posDays / n : 0,
    navStart: nav[0],
    navEnd: nav.at(-1),
    measure: perf.portfolio_measure,
  };
}

/** "20260830" -> "2026-08-30" */
export const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/* -------------------------------------------------------------- grouping */

export function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

/** Group round-trips and compute full stats per bucket, richest first. */
export function breakdown(trips, keyFn, sortBy = 'net') {
  const rows = [];
  for (const [key, group] of groupBy(trips, keyFn)) {
    rows.push({ key, n: group.length, ...tradeStats(group), trips: group });
  }
  rows.sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0));
  return rows;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const holdBucket = (d) => {
  if (d === null || d === undefined) return 'Unknown';
  if (d < 1) return 'Intraday';
  if (d < 2) return '1 day';
  if (d < 5) return '2–4 days';
  if (d < 10) return '5–9 days';
  if (d < 21) return '10–20 days';
  if (d < 63) return '21–62 days';
  return '63+ days';
};

export const HOLD_ORDER = ['Intraday', '1 day', '2–4 days', '5–9 days', '10–20 days', '21–62 days', '63+ days', 'Unknown'];

/**
 * Bucket values into a histogram.
 *
 * `clip` trims the domain to a central percentile band before binning and
 * folds everything beyond it into the end bins. Without it a single -$37k
 * expiry flattens 1,300 ordinary trades into one indistinguishable column.
 */
export function histogram(values, bins = 24, clip = 0) {
  if (!values.length) return [];
  let lo = Math.min(...values), hi = Math.max(...values);
  if (clip > 0) {
    lo = percentile(values, clip);
    hi = percentile(values, 1 - clip);
  }
  if (lo === hi) { lo = Math.min(...values); hi = Math.max(...values); }
  if (lo === hi) return [{ from: lo, to: hi, n: values.length }];

  const w = (hi - lo) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, n: 0 }));
  let under = 0, over = 0;
  for (const v of values) {
    if (v < lo) { out[0].n++; under++; continue; }
    if (v > hi) { out[bins - 1].n++; over++; continue; }
    out[Math.min(bins - 1, Math.floor((v - lo) / w))].n++;
  }
  if (under) out[0].clippedLow = under;
  if (over) out[bins - 1].clippedHigh = over;
  return out;
}

/** Monthly realized P&L, contiguous across months with no trades. */
export function monthlyPnl(trips) {
  const m = groupBy(trips, (t) => t.closed.slice(0, 7));
  const keys = [...m.keys()].sort();
  if (!keys.length) return [];
  const out = [];
  const [y0, m0] = keys[0].split('-').map(Number);
  const [y1, m1] = keys.at(-1).split('-').map(Number);
  for (let y = y0, mo = m0; y < y1 || (y === y1 && mo <= m1); mo === 12 ? (mo = 1, y++) : mo++) {
    const k = `${y}-${String(mo).padStart(2, '0')}`;
    const g = m.get(k) || [];
    out.push({ key: k, n: g.length, net: sum(g.map((t) => t.pnl)), wins: g.filter((t) => t.pnl > 0).length });
  }
  return out;
}
