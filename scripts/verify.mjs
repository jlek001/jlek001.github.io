/** Cross-checks the generated dataset against the raw IBKR responses. */
import { readFileSync, readdirSync } from 'node:fs';

const raw = [];
const seen = new Set();
for (const f of readdirSync('raw').filter((f) => /^trades-.*\.json$/.test(f)))
  for (const t of JSON.parse(readFileSync(`raw/${f}`, 'utf8')).trades)
    if (!seen.has(t.trade_id)) { seen.add(t.trade_id); raw.push(t); }

const { trips } = JSON.parse(readFileSync('trading/data/roundtrips.json', 'utf8'));
const pos = JSON.parse(readFileSync('trading/data/positions.json', 'utf8'));
const meta = JSON.parse(readFileSync('trading/data/meta.json', 'utf8'));
const execs = JSON.parse(readFileSync('trading/data/executions.json', 'utf8'));
const perf = JSON.parse(readFileSync('trading/data/performance.json', 'utf8'));

let fails = 0;
const near = (a, b, tol, label) => {
  const ok = Math.abs(a - b) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${a.toFixed(2)} vs ${b.toFixed(2)} (Δ ${(a - b).toFixed(2)})`);
};
const eq = (a, b, label) => {
  const ok = a === b;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${a} vs ${b}`);
};

console.log('— totals —');
eq(execs.rows.length, raw.length, 'execution count');
near(trips.reduce((a, t) => a + t.pnl, 0), raw.reduce((a, t) => a + t.realized_pnl, 0), 1, 'realized P&L, round-trips vs fills');
near(meta.totalCommissions, raw.reduce((a, t) => a + t.commission, 0), 0.05, 'commissions');
near(meta.dailyPnl.reduce((a, d) => a + d[1], 0), trips.reduce((a, t) => a + t.pnl, 0), 1, 'daily P&L series vs round-trips');

console.log('\n— per symbol (top 8 by |P&L|) —');
const bySymRaw = new Map(), bySymTrip = new Map();
for (const t of raw) bySymRaw.set(t.symbol, (bySymRaw.get(t.symbol) || 0) + t.realized_pnl);
for (const t of trips) bySymTrip.set(t.sym, (bySymTrip.get(t.sym) || 0) + t.pnl);
[...bySymRaw.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8)
  .forEach(([s, v]) => near(bySymTrip.get(s) || 0, v, 1, `  ${s}`));

console.log('\n— positions —');
const live = pos.raw.filter((p) => p.position !== 0);
near(pos.structures.reduce((a, s) => a + s.mv, 0), live.reduce((a, p) => a + p.market_value, 0), 0.5, 'structure market value conserved');
near(pos.structures.reduce((a, s) => a + s.upnl, 0), live.reduce((a, p) => a + p.unrealized_pnl, 0), 0.5, 'structure unrealized P&L conserved');
eq(pos.structures.every((s) => s.legs.length > 0), true, 'no empty structures');

console.log('\n— performance series —');
const S = perf.series;
eq(S.dates.length === S.cps.length && S.cps.length === S.nav.length, true, 'parallel arrays aligned');
eq([...S.dates].sort().join() === S.dates.join(), true, 'dates ascending');

console.log('\n— round-trip integrity —');
eq(trips.every((t) => t.closed && typeof t.pnl === 'number'), true, 'every trip has close time and P&L');
eq(trips.filter((t) => t.opened && t.opened > t.closed).length, 0, 'no entry after its exit');
const orphan = trips.filter((t) => !t.inferredEntry).length;
console.log(`INFO  round-trips with no matched entry: ${orphan} of ${trips.length} (${(orphan / trips.length * 100).toFixed(1)}%)`);
console.log(`INFO  closed by expiry/assignment: ${trips.filter((t) => t.expired).length}`);

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
