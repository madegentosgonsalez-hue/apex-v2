# APEX v3 Research Notes

This folder is for repo-local research tooling and summaries.

Ignored directories:
- `cache/`: provider candle caches used to avoid repeated historical fetches
- `results/`: generated matrix runs and intermediate research outputs

Current best real-15m findings on the Polygon free forex feed, 1-year window:

- Core profile: `balanced`
- Best same-pair volume mode: concurrent research enabled
- Best growth policy so far: `real15m_growth`

Current leadership by pair under `balanced + real15m_growth + concurrent`:

- `GBPJPY`: strongest edge, highest total R, high win rate
- `USDCHF`: strong edge, high win rate, lower volume than GBPJPY
- `EURUSD`: useful volume source, but expectancy is weak and needs better filtering

Current removals:

- `GBPUSD`: disabled
- `USDCAD`: disabled
- `AUDUSD`: disabled
- `USDJPY`: disabled

Current open problems:

- `EURUSD` still adds volume but not enough expectancy
- Claude validation is still too permissive and needs tighter rejection behavior
- The strategy is improved materially, but it has not yet demonstrated the 10% to 15% monthly target on this research set

Important backtest fidelity fixes now implemented in code:

- weekly candles aligned to Monday instead of Unix-epoch week buckets
- H4 replay timestamps use bar-close time rather than bar-open time
- real `M15/M30` aggregation path for Polygon forex data
- optional repo-local historical caching
- optional same-pair concurrent research mode
