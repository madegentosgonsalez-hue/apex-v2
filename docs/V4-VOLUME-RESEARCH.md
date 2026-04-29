# V4 Volume Research

The goal of V4 research is to increase trade count without corrupting the core APEX blueprint strategy.

## What Was Built

Research-only engine: `SCALP_CONTINUATION`

Files:

- `backend/research/scalpContinuationEngine.js`
- `backend/scripts/research-scalp-continuation.js`
- Policy overlays: `scalp_v1`, `scalp_v2`

The module keeps the original higher-timeframe logic as the anchor:

- Weekly/Daily/H4/H2 bias must agree enough for Brain1 to choose direction.
- M15/M30 must align with the same direction.
- Entry trigger is either M15 EMA continuation or M15 liquidity-sweep continuation.
- Exit model is faster than core swing mode: 50% at 1R, remaining 50% at 1.6R, breakeven after TP1, 12-hour time stop.

## Test Results

### `scalp_v1`

Result: rejected.

| Metric | Result |
| --- | ---: |
| Trades | 291 |
| Signals/month | 12.13 |
| Win rate | 47.1% |
| Total R | -20.02R |
| Portfolio return | -30.62% |
| Max drawdown | 32.74% |

Finding: volume increased, but expectancy was negative. `USDCHF London` and `GBPJPY Asian` were toxic for this scalp idea.

### `scalp_v2`

Result: research candidate only.

| Metric | Result |
| --- | ---: |
| Trades | 108 |
| Signals/month | 4.50 |
| Win rate | 65.7% |
| Total R | +36.15R |
| Portfolio return | +25.59% |
| Max drawdown | 6.40% |

Useful pockets:

- `EURJPY` Asian
- `EURUSD` overlap
- `GBPJPY` New York ranging conditions

Rejected pockets:

- `USDCHF` scalp continuation
- `GBPJPY` Asian scalp continuation
- Broad weak-trend scalp continuation

## Core + Scalp Blend

Core candidate: `audit_focus_v5`

Scalp candidate: `scalp_v2`

Combined raw result:

| Metric | Result |
| --- | ---: |
| Raw trades | 282 |
| Raw signals/month | 11.75 |
| Raw win rate | 68.4% |
| Raw total R | +230.99R |

Constrained portfolio with real tier risk, 5 max open trades, 2 max entries per pair, and 0.12R execution drag:

| Metric | Result |
| --- | ---: |
| Ending balance from $1,000 | $1,761 |
| Return | +76.13% over 2 years |
| Trades taken | 159 |
| Win rate | 65.4% |
| Max drawdown | 6.63% |

Aggressive 5 entries per pair:

| Metric | Result |
| --- | ---: |
| Ending balance from $1,000 | $2,309 |
| Return | +130.86% over 2 years |
| Trades taken | 213 |
| Win rate | 64.8% |
| Max drawdown | 10.98% |

## Verdict

The new module improves volume and keeps quality when filtered, but the combined system still does not honestly reach 15-20 signals/month or 10-15% monthly growth at the intended risk. The next improvement must come from a genuinely different edge, not more duplicate entries from the same trade idea.

Recommended next research:

- Add a separate range-reversion module for low-ADX markets.
- Add a news/session volatility breakout module for London and NY opens.
- Walk-forward test all modules separately before live promotion.
