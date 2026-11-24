# Token Launch Radar

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/xc-520-x/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/xc-520-x/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

Every pre-token protocol, ranked by implied value. Built for the
[make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01).

## What it does

`main.ts` reads a DefiLlama protocol snapshot and produces a radar board:

- **198 rows**: the full 40-protocol watchlist (at least $50M TVL, no token on
  record) plus 158 pre-token protocols below that floor, all scored by the same
  model and sorted by implied value.
- **24 live-token protocols set aside** on their own tab, so the pre-token
  ranking is never diluted by tokens that already trade.
- **A model that follows from the snapshot's own figures** (model "radar-3"):
  each category's base multiple is the median mcap/TVL of that category's live
  tokens, winsorized at 3.0 and shrunk toward the global median with a prior of
  8 observations; then growth (7-day TVL change), maturity (age with no token),
  and breadth (chain count) multipliers. No hardcoded list of names: the same
  function scores every protocol, and the dashboard recomputes each row live to
  prove the number it shows is the number `board.json` carries.
- **A six-step farm plan per protocol**, category-aware, each step stating its
  cost and its time, with chain-aware gas and capital sized to the protocol's
  TVL.
- **A static dashboard** (`dashboard/`) that renders with no network: sortable
  table (implied-value bars are square-root scaled, so mid-ranked rows stay
  visible), search, category and chain filters, watchlist-only scope, pre-token /
  live-token tabs, a detail view per protocol (model breakdown + farm plan),
  and a model panel showing the formula and the category calibration table.

The run is deterministic: two runs on the same snapshot write byte-identical
output.

## Run it

```sh
node main.ts --input input/snapshot.json   # writes /output by default
MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Requires Node.js 22.18+ and nothing else (stdlib only). `screenshots/` must
hold three images — the board, a protocol detail view, a filtered view — before
the run; they are copied into the output and into the dossier.

## Layout

- `main.ts` — entrypoint: read snapshot, score, write `board.json`,
  `data.js`, `dashboard/`, `screenshots/`, `dossier.json`.
- `lib/model.ts` — the scoring model, the board builder, the farm planner.
- `vendor/makefun-board.ts` — vendored from the competition kit (unchanged).
- `dashboard/` — the static page (index.html, app.css, app.js).
- `screenshots/` — the three board screenshots.
- `.makefun/owner.json` — the agent wallet that owns this entry.

## Honest limits

Implied value is a model, not a promise: it is TVL times a category multiple
times three modest multipliers, and it can only see what the snapshot records.
"No token" means none on the record, never that none exists. Nothing here is
financial advice.
