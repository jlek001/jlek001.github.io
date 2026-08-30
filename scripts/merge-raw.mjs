import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const files = readdirSync('raw').filter(f => f.startsWith('trades-'));
const byId = new Map();
for (const f of files) {
  const { trades } = JSON.parse(readFileSync(`raw/${f}`, 'utf8'));
  for (const t of trades) byId.set(t.trade_id, t);
}
const all = [...byId.values()].sort((a, b) => a.trade_time.localeCompare(b.trade_time));
writeFileSync('raw/trades-merged.json', JSON.stringify({ trades: all }));
console.log(`files=${files.length} merged=${all.length} unique`);
console.log(`range ${all[0].trade_time} .. ${all.at(-1).trade_time}`);
