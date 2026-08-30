/**
 * Build the static dataset consumed by the /trading app.
 *
 * Inputs (raw/, pulled from the IBKR connector):
 *   trades-*.json   executions from get_account_trades
 *   positions.json  open positions from get_account_positions
 *   account.json    get_account_summary + get_account_balances
 *   performance.json get_pa_performance_all_periods (NAV + TWR series)
 *
 * Output: trading/data/*.json
 *
 * Notes on IBKR semantics that drive this file:
 *  - `realized_pnl` on a fill is NET of commissions: IBKR carries a
 *    commission-inclusive average cost, which is why both average_price and
 *    realized_pnl come back with sub-cent fractions. Commissions are therefore
 *    reported separately for information only and never subtracted again.
 *  - The trade feed identifies the underlying (`symbol`) but not the option
 *    contract, so strike/expiry/right are unavailable for closed trades. The
 *    first two dot-segments of `trade_id` are the execution batch and DO group
 *    the legs of a combo, which is what spread detection keys on.
 *  - Open positions DO carry a full contract description, so live structures
 *    are classified exactly (vertical, condor, calendar, covered call, ...).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';

const OUT = 'trading/data';
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

/* ------------------------------------------------------------------ load */

function loadExecutions() {
  const byId = new Map();
  for (const f of readdirSync('raw').filter((f) => /^trades-.*\.json$/.test(f) && f !== 'trades-merged.json')) {
    for (const t of JSON.parse(readFileSync(`raw/${f}`, 'utf8')).trades) byId.set(t.trade_id, t);
  }
  return [...byId.values()].sort(
    (a, b) => a.trade_time.localeCompare(b.trade_time) || a.trade_id.localeCompare(b.trade_id)
  );
}

/* --------------------------------------------------- combo (spread) groups */

// The execution-batch prefix of trade_id groups the legs IBKR filled together.
//
// Expiration and assignment records are the exception: IBKR books them as
// "CRS:<n>" with no batch prefix, so every leg of an expiring spread would
// otherwise look like its own trade -- an expiring SPX vertical showing up as
// a +$49k trade next to a -$59k one instead of a single -$9k outcome. They
// settle together at one instant per underlying, so that is the grouping.
const isSettlement = (t) => t.trade_id.startsWith('CRS:');
const comboKey = (t) =>
  isSettlement(t) ? `CRS|${t.symbol}|${t.trade_time}` : t.trade_id.split('.').slice(0, 2).join('.');

/** Shape label for a combo we only know at underlying level (closed trades). */
function classifyComboShape(legs) {
  const buys = legs.filter((l) => l.side === 'BUY');
  const sells = legs.filter((l) => l.side === 'SELL');
  const n = legs.length;
  const isOpt = legs.every((l) => l.sec_type === 'OPT');

  if (!isOpt) {
    if (legs.every((l) => l.sec_type === 'CASH')) return { code: 'fx', label: 'FX Conversion', legs: n };
    if (legs.some((l) => l.sec_type === 'OPT')) return { code: 'combo_stk_opt', label: 'Stock + Option', legs: n };
    return { code: 'stock', label: 'Stock', legs: n };
  }
  if (n === 1) return { code: 'single', label: 'Single Option', legs: 1 };
  if (!buys.length || !sells.length) return { code: 'same_side', label: `${n}-Leg Same-Side`, legs: n };

  const qb = buys.reduce((a, l) => a + l.size, 0);
  const qs = sells.reduce((a, l) => a + l.size, 0);

  if (n === 2) {
    return qb === qs
      ? { code: 'vertical', label: 'Vertical Spread', legs: 2 }
      : { code: 'ratio', label: 'Ratio Spread', legs: 2 };
  }
  if (n === 3) return { code: 'three_leg', label: '3-Leg Spread', legs: 3 };
  if (n === 4 && buys.length === 2 && sells.length === 2 && qb === qs)
    return { code: 'four_leg', label: '4-Leg Spread', legs: 4 };
  return { code: 'multi', label: `${n}-Leg Spread`, legs: n };
}

function buildCombos(execs) {
  const groups = new Map();
  for (const t of execs) {
    const k = comboKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  const combos = [];
  for (const [id, legs] of groups) {
    legs.sort((a, b) => a.trade_id.localeCompare(b.trade_id));
    const realizing = legs.filter((l) => l.realized_pnl !== 0);
    // no realized P&L on any leg => this batch only opened exposure.
    // every leg realizing => it only closed exposure. mixed => a roll.
    const kind = realizing.length === 0 ? 'open' : realizing.length === legs.length ? 'close' : 'roll';

    const settled = legs.every(isSettlement);
    const shape = settled
      ? { code: 'expiration', label: 'Expiration / Assignment', legs: legs.length }
      : classifyComboShape(legs);
    const pnl = legs.reduce((a, l) => a + l.realized_pnl, 0);
    const comm = legs.reduce((a, l) => a + l.commission, 0);
    // Signed cash: SELL brings premium in, BUY pays it out.
    const cash = legs.reduce((a, l) => a + (l.side === 'SELL' ? l.net_amount : -l.net_amount), 0);
    const qty = legs.reduce((a, l) => a + l.size, 0);

    combos.push({
      id,
      sym: legs[0].symbol,
      name: legs.find((l) => l.company_name)?.company_name || '',
      sec: legs[0].sec_type,
      t: legs[0].trade_time,
      kind,
      settled,
      shape,
      pnl,
      comm,
      cash,
      qty,
      legs: legs.map((l) => ({
        side: l.side,
        size: l.size,
        px: l.price,
        amt: l.net_amount,
        comm: r4(l.commission),
        pnl: r2(l.realized_pnl),
        ex: l.exchange || '',
        ot: l.order_type || '',
      })),
    });
  }
  combos.sort((a, b) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id));
  return combos;
}

/* ------------------------------------------------------- round-trip pairing
 * P&L is IBKR's own realized figure (exact). The ENTRY paired to each exit is
 * inferred: FIFO within an underlying, preferring an opening combo of the same
 * shape so a vertical closes against a vertical rather than a stray single.
 */
function buildRoundTrips(combos) {
  const openQ = new Map(); // symbol -> [open combo, ...] oldest first
  const trips = [];

  const push = (c) => {
    if (!openQ.has(c.sym)) openQ.set(c.sym, []);
    openQ.get(c.sym).push(c);
  };

  const take = (sym, shapeCode) => {
    const q = openQ.get(sym);
    if (!q || !q.length) return null;
    let i = q.findIndex((c) => c.shape.code === shapeCode);
    if (i === -1) i = q.findIndex((c) => c.shape.legs === 1) !== -1 ? 0 : 0; // fall back to oldest
    return q.splice(i, 1)[0];
  };

  for (const c of combos) {
    if (c.kind === 'open') {
      push(c);
      continue;
    }
    const entry = take(c.sym, c.shape.code);
    const held =
      entry ? Math.max(0, (Date.parse(c.t) - Date.parse(entry.t)) / 86400000) : null;

    trips.push({
      id: c.id,
      sym: c.sym,
      name: c.name || entry?.name || '',
      sec: c.sec,
      shape: entry ? entry.shape : c.shape,
      opened: entry ? entry.t : null,
      closed: c.t,
      days: held === null ? null : r2(held),
      qty: c.qty,
      entryCash: entry ? r2(entry.cash) : null,
      exitCash: r2(c.cash),
      pnl: r2(c.pnl),
      comm: r4(c.comm + (entry ? entry.comm : 0)),
      inferredEntry: !!entry,
      // a roll closes one exposure and opens another in the same batch
      roll: c.kind === 'roll',
      // closed by expiry/assignment rather than by a discretionary exit
      expired: !!c.settled,
    });

    // the opening half of a roll becomes new exposure
    if (c.kind === 'roll') push({ ...c, kind: 'open' });
  }

  const stillOpen = [];
  for (const [sym, q] of openQ) for (const c of q) stillOpen.push({ sym, id: c.id, t: c.t, shape: c.shape, cash: r2(c.cash) });
  return { trips, stillOpen };
}

/* -------------------------------------- open-position structure detection */

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "META Oct02'26 470 PUT @AMEX" / "TSLL1 BASKET Jan15'27 4.7 PUT" / "COIN" */
function parseContract(desc) {
  const m = desc.match(/^(\S+)(?:\s+BASKET)?\s+([A-Z][a-z]{2})(\d{2})'(\d{2})\s+([\d.]+)\s+(CALL|PUT)(?:\s+@(\S+))?$/);
  if (!m) return { under: desc.split(/\s+/)[0], kind: 'STK' };
  const [, under, mon, dd, yy, strike, right, ex] = m;
  const expiry = new Date(Date.UTC(2000 + +yy, MON[mon], +dd));
  return {
    under,
    kind: 'OPT',
    right,
    strike: +strike,
    expiry: expiry.toISOString().slice(0, 10),
    exch: ex || '',
  };
}

/* Automatic spread detection over the live book.
 *
 * A book like this one stacks several independent spreads on the same
 * underlying and expiry, so naming the whole pile "Custom 8-Leg" hides the
 * structures the trader actually put on. Legs are therefore decomposed:
 * genuine four-leg irons are recognised first, then each right is paired
 * long-against-short into the verticals that compose it.
 */

const RIGHT_WORD = (r) => (r === 'CALL' ? 'Call' : 'Put');
const sumQty = (ls) => ls.reduce((a, l) => a + l.qty, 0);

/** Is this leg set a 1 / -2 / 1 butterfly (in any multiple)? */
function isButterfly(legs) {
  if (legs.length !== 3) return false;
  const s = [...legs].sort((a, b) => a.strike - b.strike);
  const [lo, mid, hi] = s;
  return (
    lo.qty > 0 && hi.qty > 0 && mid.qty < 0 &&
    lo.qty === hi.qty && mid.qty === -2 * lo.qty &&
    Math.abs(mid.strike - lo.strike) === Math.abs(hi.strike - mid.strike)
  );
}

/** Split a signed leg into |qty| single-contract units, pro-rating its money
 *  so that decomposing a 4-lot into four spreads does not quadruple its value. */
const toUnits = (legs) =>
  legs.flatMap((l) => {
    const n = Math.abs(l.qty);
    return Array.from({ length: n }, () => ({
      ...l,
      qty: Math.sign(l.qty),
      mv: l.mv / n,
      upnl: l.upnl / n,
      dpnl: l.dpnl / n,
    }));
  });

/** Pair long units against short units by strike order -> vertical spreads. */
function pairVerticals(legs) {
  const units = toUnits(legs);
  const longs = units.filter((u) => u.qty > 0).sort((a, b) => a.strike - b.strike);
  const shorts = units.filter((u) => u.qty < 0).sort((a, b) => a.strike - b.strike);
  const pairs = [];
  while (longs.length && shorts.length) pairs.push([longs.shift(), shorts.shift()]);
  return { pairs, leftover: [...longs, ...shorts] };
}

/** Merge single-contract units that came from the same contract back together. */
function recombine(units) {
  const m = new Map();
  for (const u of units) {
    const k = u.cid;
    if (!m.has(k)) m.set(k, { ...u, qty: 0, mv: 0, upnl: 0, dpnl: 0 });
    const a = m.get(k);
    a.qty += u.qty;
    a.mv += u.mv;
    a.upnl += u.upnl;
    a.dpnl += u.dpnl;
  }
  return [...m.values()].map((l) => ({ ...l, mv: r2(l.mv), upnl: r2(l.upnl), dpnl: r2(l.dpnl) }));
}

function verticalLabel(long, short) {
  const right = RIGHT_WORD(long.right);
  // Long the lower strike is bullish in calls, bearish in puts.
  const bull = long.right === 'CALL' ? long.strike < short.strike : long.strike > short.strike;
  return {
    code: 'vertical',
    label: `${bull ? 'Bull' : 'Bear'} ${right} Spread`,
    width: Math.abs(long.strike - short.strike),
    credit: long.right === 'CALL' ? long.strike > short.strike : long.strike < short.strike,
  };
}

/**
 * Decompose one (underlying, expiry) option set into named structures.
 * Returns an array of { struct, legs }.
 */
function decomposeExpiry(opts) {
  const calls = opts.filter((o) => o.right === 'CALL');
  const puts = opts.filter((o) => o.right === 'PUT');
  const out = [];

  // Iron condor / iron butterfly: one long + one short on each side.
  if (opts.length === 4 && calls.length === 2 && puts.length === 2) {
    const cL = calls.find((o) => o.qty > 0), cS = calls.find((o) => o.qty < 0);
    const pL = puts.find((o) => o.qty > 0), pS = puts.find((o) => o.qty < 0);
    if (cL && cS && pL && pS && cS.strike > pS.strike) {
      return [{
        struct: cS.strike === pS.strike
          ? { code: 'iron_butterfly', label: 'Iron Butterfly' }
          : { code: 'iron_condor', label: 'Iron Condor', width: Math.abs(cS.strike - pS.strike) },
        legs: opts,
      }];
    }
  }

  // Straddle / strangle / synthetic: a single call against a single put.
  if (opts.length === 2 && calls.length === 1 && puts.length === 1) {
    const [c, p] = [calls[0], puts[0]];
    if (Math.sign(c.qty) === Math.sign(p.qty)) {
      const dir = c.qty > 0 ? 'Long' : 'Short';
      return [{
        struct: c.strike === p.strike
          ? { code: 'straddle', label: `${dir} Straddle` }
          : { code: 'strangle', label: `${dir} Strangle` },
        legs: opts,
      }];
    }
    return [{
      struct: c.strike === p.strike
        ? { code: 'synthetic', label: c.qty > 0 ? 'Synthetic Long' : 'Synthetic Short' }
        : { code: 'risk_reversal', label: 'Risk Reversal' },
      legs: opts,
    }];
  }

  for (const side of [calls, puts]) {
    if (!side.length) continue;
    const right = RIGHT_WORD(side[0].right);

    if (side.length === 1) {
      const o = side[0];
      out.push({ struct: { code: 'single', label: `${o.qty > 0 ? 'Long' : 'Short'} ${right}` }, legs: side });
      continue;
    }
    if (isButterfly(side)) {
      out.push({ struct: { code: 'butterfly', label: `${right} Butterfly` }, legs: side });
      continue;
    }

    const longQty = sumQty(side.filter((o) => o.qty > 0));
    const shortQty = -sumQty(side.filter((o) => o.qty < 0));

    if (longQty === 0 || shortQty === 0) {
      // all one way: a plain long or short book of that right
      const dir = longQty > 0 ? 'Long' : 'Short';
      out.push({ struct: { code: 'single', label: `${dir} ${right}s`, legs: side.length }, legs: side });
      continue;
    }

    // Four contracts of one 300/310 put spread is one position held four
    // times over, not four positions -- merge identical pairs back together.
    const { pairs, leftover } = pairVerticals(side);
    const merged = new Map();
    for (const [long, short] of pairs) {
      const k = `${long.cid}|${short.cid}`;
      if (!merged.has(k)) merged.set(k, { long, short, units: [], lots: 0 });
      const m = merged.get(k);
      m.units.push(long, short);
      m.lots += 1;
    }
    for (const m of merged.values()) {
      out.push({ struct: { ...verticalLabel(m.long, m.short), lots: m.lots }, legs: recombine(m.units) });
    }
    if (leftover.length) {
      const rest = recombine(leftover);
      const dir = sumQty(rest) > 0 ? 'Long' : 'Short';
      out.push({
        struct: pairs.length
          ? { code: 'ratio', label: `${right} Ratio (extra ${dir.toLowerCase()})` }
          : { code: 'single', label: `${dir} ${right}` },
        legs: rest,
      });
    }
  }
  return out;
}

/** Stock plus one or two option legs: covered call, protective put, collar. */
function stockStructure(stock, opts) {
  if (!opts.length) return { code: 'stock', label: 'Stock Position' };
  const calls = opts.filter((o) => o.right === 'CALL');
  const puts = opts.filter((o) => o.right === 'PUT');
  if (opts.length === 1) {
    const o = opts[0];
    if (o.right === 'CALL' && o.qty < 0) return { code: 'covered_call', label: 'Covered Call' };
    if (o.right === 'PUT' && o.qty > 0) return { code: 'protective_put', label: 'Protective Put' };
  }
  if (opts.length === 2 && calls.length === 1 && puts.length === 1 && calls[0].qty < 0 && puts[0].qty > 0)
    return { code: 'collar', label: 'Collar' };
  return { code: 'stock_combo', label: 'Stock + Options' };
}

function buildPositionStructures(positions) {
  const live = positions.filter((p) => p.position !== 0);
  const byUnder = new Map();

  for (const p of live) {
    const c = parseContract(p.contract_description);
    const leg = {
      desc: p.contract_description,
      cid: p.contract_id,
      qty: p.position,
      right: c.right || null,
      strike: c.strike ?? null,
      expiry: c.expiry || null,
      kind: c.kind,
      px: p.market_price,
      mv: r2(p.market_value),
      avg: p.average_price,
      upnl: r2(p.unrealized_pnl),
      dpnl: r2(p.daily_pnl),
    };
    if (!byUnder.has(c.under)) byUnder.set(c.under, []);
    byUnder.get(c.under).push(leg);
  }

  const structures = [];
  const add = (under, struct, legs, expiry) =>
    structures.push({
      under,
      struct,
      expiry: expiry ?? (legs.find((l) => l.expiry)?.expiry || null),
      legs,
      mv: r2(legs.reduce((a, l) => a + l.mv, 0)),
      upnl: r2(legs.reduce((a, l) => a + l.upnl, 0)),
      dpnl: r2(legs.reduce((a, l) => a + l.dpnl, 0)),
      cost: r2(legs.reduce((a, l) => a + l.avg * Math.abs(l.qty) * (l.kind === 'OPT' ? 100 : 1) * Math.sign(l.qty), 0)),
    });

  for (const [under, legs] of byUnder) {
    const stock = legs.find((l) => l.kind === 'STK') || null;
    const opts = legs.filter((l) => l.kind === 'OPT');

    const byExp = new Map();
    for (const o of opts) {
      if (!byExp.has(o.expiry)) byExp.set(o.expiry, []);
      byExp.get(o.expiry).push(o);
    }

    // The stock attaches to the nearest expiry that carries a covered-call or
    // protective-put shaped leg set; everything else stands on its own.
    let stockUsed = false;
    for (const expiry of [...byExp.keys()].sort()) {
      const group = byExp.get(expiry).sort(
        (a, b) => (a.right || '').localeCompare(b.right || '') || a.strike - b.strike
      );
      if (!stockUsed && stock) {
        const s = stockStructure(stock, group);
        if (s.code === 'covered_call' || s.code === 'protective_put' || s.code === 'collar') {
          stockUsed = true;
          add(under, s, [stock, ...group], expiry);
          continue;
        }
      }
      for (const d of decomposeExpiry(group)) add(under, d.struct, d.legs, expiry);
    }
    if (stock && !stockUsed) add(under, { code: 'stock', label: 'Stock Position' }, [stock], null);
  }

  structures.sort((a, b) => Math.abs(b.mv) - Math.abs(a.mv));
  return structures;
}


/* ------------------------------------------------------------ aggregation */

function dailyPnl(trips) {
  const m = new Map();
  for (const t of trips) {
    const d = t.closed.slice(0, 10);
    m.set(d, (m.get(d) || 0) + t.pnl);
  }
  return [...m.entries()].sort().map(([d, v]) => [d, r2(v)]);
}

/* ------------------------------------------------------------------ build */

const execs = loadExecutions();
const combos = buildCombos(execs);
const { trips, stillOpen } = buildRoundTrips(combos);
const positionsRaw = JSON.parse(readFileSync('raw/positions.json', 'utf8')).positions;
const structures = buildPositionStructures(positionsRaw);
const account = JSON.parse(readFileSync('raw/account.json', 'utf8'));
const performance = JSON.parse(readFileSync('raw/performance.json', 'utf8'));

mkdirSync(OUT, { recursive: true });

writeFileSync(
  `${OUT}/executions.json`,
  JSON.stringify({
    fields: ['id', 'sym', 'name', 'sec', 'side', 'qty', 'px', 'comm', 'amt', 'pnl', 't', 'ord', 'exch', 'otype', 'combo'],
    rows: execs.map((t) => [
      t.trade_id,
      t.symbol,
      t.company_name || '',
      t.sec_type,
      t.side,
      t.size,
      t.price,
      r4(t.commission),
      t.net_amount,
      r2(t.realized_pnl),
      t.trade_time,
      t.order_id,
      t.exchange || '',
      t.order_type || '',
      comboKey(t),
    ]),
  })
);

writeFileSync(`${OUT}/roundtrips.json`, JSON.stringify({ trips, stillOpen }));
writeFileSync(`${OUT}/positions.json`, JSON.stringify({ structures, raw: positionsRaw }));
writeFileSync(`${OUT}/account.json`, JSON.stringify(account));
writeFileSync(`${OUT}/performance.json`, JSON.stringify(performance));

const totalPnl = trips.reduce((a, t) => a + t.pnl, 0);
const totalComm = execs.reduce((a, t) => a + t.commission, 0);
writeFileSync(
  `${OUT}/meta.json`,
  JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Interactive Brokers (IBKR connector)',
    asOf: account.as_of,
    executions: execs.length,
    combos: combos.length,
    roundTrips: trips.length,
    openStructures: structures.length,
    symbols: [...new Set(execs.map((e) => e.symbol))].sort(),
    firstTrade: execs[0].trade_time,
    lastTrade: execs.at(-1).trade_time,
    totalRealizedPnl: r2(totalPnl),
    totalCommissions: r2(totalComm),
    pnlIsNetOfCommissions: true,
    dailyPnl: dailyPnl(trips),
  })
);

console.log(`executions      ${execs.length}`);
console.log(`combo groups    ${combos.length}  (open/close/roll)`);
console.log(`round-trips     ${trips.length}   matched entry: ${trips.filter((t) => t.inferredEntry).length}`);
console.log(`open structures ${structures.length}`);
console.log(`realized P&L    ${r2(totalPnl)}   commissions ${r2(totalComm)}`);
console.log(`unpaired opens  ${stillOpen.length}`);
