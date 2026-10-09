# Trading performance app (IBKR)

A static, client-side dashboard over an Interactive Brokers account: performance
metrics, a trading journal, advanced reports and analytics, and automatic
options spread detection.

Hosted privately as a Claude artifact: https://claude.ai/artifact/CqZvzoCBxjJnKBhB9kurEP
(readable only by its owner unless shared from the artifact's Share menu).
The same files also run standalone from `/trading/` on any static server.

## Cloud hosting

The repository is public, so the artifact — not GitHub Pages — is where the
numbers live. `node scripts/build-artifact.mjs` bundles the app into
`dist/artifact/` (one inlined page plus `data/*.json`); publishing that to the
artifact URL updates it. Journal notes are stored in the artifact's cloud
database (`journal` collection) and follow the account across browsers; CSV and
journal exports go through the artifact's file-save capability.


## How the data gets here

GitHub Pages serves static files only, and a browser cannot talk to IBKR
directly. So the flow is a **snapshot pipeline**, not a live connection:

```
IBKR connector (MCP)  →  raw/*.json  →  node scripts/build-data.mjs  →  trading/data/*.json  →  the app
```

`raw/` holds verbatim connector responses. `scripts/build-data.mjs` normalises
them, detects spreads, pairs round-trips, and writes the files the app fetches.

### Refreshing

Ask Claude (with the IBKR connector enabled) to refresh, or do it by hand:

1. Pull fresh responses and save them into `raw/`:

   | Tool | Save as |
   |---|---|
   | `get_account_trades` (`YEAR_TO_DATE`, plus older quarters as needed) | `raw/trades-<period>.json` |
   | `get_account_positions` | `raw/positions.json` |
   | `get_account_summary` + `get_account_balances` | `raw/account.json` |
   | `get_pa_performance_all_periods` | `raw/performance.json` |

   Any number of `trades-*.json` files can coexist — overlapping windows are
   deduplicated by `trade_id`, so pulling several periods is safe and is how
   history beyond the connector's per-call window is accumulated.

2. Rebuild and commit:

   ```sh
   node scripts/build-data.mjs
   git add raw trading/data && git commit -m "Refresh IBKR data"
   ```

`get_account_trades` reaches back at most four completed quarters, so **the
`raw/` files are the only long-term archive of older trades** — add to them,
never replace the set wholesale.

## Reading the numbers

**P&L is IBKR's own realized figure and is already net of commissions.** IBKR
carries a commission-inclusive average cost, which is why `average_price` and
`realized_pnl` come back with sub-cent fractions. Commissions are shown
separately for information and are never subtracted a second time.

**Returns use time-weighted return (TWR), not the raw NAV.** This account had
several large cash movements (notably May and June 2026); TWR measures the
trading rather than the funding. The NAV chart is shown alongside so the cash
movements stay visible.

**Round-trips are exact in P&L, inferred in pairing.** The trade feed names the
underlying but not the option contract, so which opening fill an exit belongs to
is matched first-in-first-out within the underlying — the same basis IBKR uses
to compute the realized P&L itself. Money is therefore exact; entry dates and
holding periods on continuously-traded names may date an exit to an older entry
than intended. Exits with no matching opening fill in the archive are flagged.

**Expirations are grouped per underlying per instant.** IBKR books expiry and
assignment as `CRS:` records with no batch id, one per leg. Left alone, an
expiring vertical reads as a +$49k trade beside a −$59k one instead of a single
−$9k outcome, so all legs settling together on one underlying are treated as one
event and tagged `expiry`.

## Spread detection

Two tiers, because the two data sources carry different detail:

- **Open positions** carry full contract descriptions (`META Oct02'26 470 PUT`),
  so live structures are classified exactly: verticals (bull/bear, call/put),
  iron condors and butterflies, butterflies, condors, straddles, strangles,
  calendars, diagonals, synthetics, risk reversals, ratios, covered calls,
  protective puts and collars. A stack of legs on one underlying and expiry is
  decomposed into the individual spreads that compose it rather than being
  lumped together, and identical spreads held several times over are merged with
  a lot count.
- **Closed trades** have no contract detail, so combos are recognised from the
  execution batch shared by their legs and classified by shape — vertical,
  ratio, 3-leg, 4-leg, single.

## Journal

Notes, tags and execution ratings are stored in `localStorage` under
`ibkr-journal-v1`, keyed by round-trip id. They stay on the machine that wrote
them and are never committed. Journal ids survive data refreshes, so re-running
the pipeline keeps existing entries attached. **Back up** and **Restore** in the
journal toolbar export and merge a JSON file — use them before clearing browser
data or when moving between machines.

## Layout

```
trading/
  index.html          app shell
  css/app.css         styling, light and dark
  js/app.js           views, filters, journal, export
  js/metrics.js       trade statistics and risk metrics
  js/charts.js        SVG charts (no external dependencies)
  data/               generated — do not edit by hand
raw/                  verbatim IBKR connector responses (the archive)
scripts/build-data.mjs
```

## Local development

The app fetches JSON over HTTP, so it needs a server — `file://` will not work:

```sh
python3 -m http.server 8765
# then open http://127.0.0.1:8765/trading/
```
