# April 2026 Strategy Audit

This audit was run after correcting the research simulator and live tier risk to the intended system risk:

- `DIAMOND`: 1.0%
- `GOLD`: 0.75%
- `SILVER`: 0.5%

## Main Finding

The current APEX strategy has real edge, but the edge is concentrated and sparse. The older high-volume policy reached the 15-20 raw signal/month target, but much of that volume came from weak regimes and clustered duplicate entries. After risk correction, it does not support a responsible 10-15% monthly expectation.

## Best Current Research Candidate

Policy: `audit_focus_v5`

Assumptions:

- Data window: April 2024 to April 2026
- Pairs: `EURUSD, USDCHF, GBPJPY, EURJPY, XAUUSD`
- Max open trades: 5
- Max entries per pair: 5
- Time stop: 72 hours if trade has not reached at least 0.5R
- Execution drag: 0.15R per trade

Results:

| Metric | Result |
| --- | ---: |
| Raw trades | 174 |
| Raw signals/month | 7.24 |
| Raw win rate | 70.1% |
| Raw total R | +194.84R |
| Portfolio start | $1,000 |
| Portfolio end | $1,985 |
| Portfolio return | +98.5% over 2 years |
| Portfolio trades taken | 128 |
| Portfolio win rate | 64.8% |
| Max drawdown | 10.39% |

## What Improved

- Live policy gates now match backtest policy gates more closely.
- `minTier`, regime, level, direction, hour, and ADX policy filters are enforced in live mode.
- `audit_focus_v5` avoids the worst `EURJPY` Asian high-ADX trend traps while keeping the better setups.
- Research risk now matches live tier risk instead of accidentally doubling returns.

## Current Verdict

`audit_focus_v5` is the safer demo-testing candidate. It is not a proven 10-15% monthly system. To target that return honestly, APEX needs either a new independent edge, a higher-frequency sub-strategy, or intentionally higher risk with larger drawdowns.
