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

Mixed-provider update:

- `XAUUSD` restored through Twelve Data
- `XAUUSD` performs much better in `NEW_YORK/OVERLAP` only than full-session trading
- current mixed basket candidate:
  - `GBPJPY`
  - `USDCHF`
  - `XAUUSD` (`NEW_YORK/OVERLAP`)
  - `EURUSD` (`NEW_YORK/OVERLAP`)

Current mixed-basket 1-year result:

- approximately `56.48R`
- approximately `5.0` signals/month
- best contributors remain `GBPJPY`, `USDCHF`, and `XAUUSD`
- `EURUSD` is still the weakest active contributor, but improves when London is removed

2-year mixed-basket progress:

- `mixed_growth_v3`:
  - approximately `77.35R`
  - approximately `11.97` signals/month
  - higher-volume candidate

- `mixed_growth_v4`:
  - approximately `79.47R`
  - approximately `8.25` signals/month
  - approximately `48.5%` overall win rate
  - higher-quality candidate

Key 2-year findings:

- `GBPJPY` improves when reduced to `TYPE_B` only
- `EURJPY` becomes useful when kept to `TYPE_B` and `GOLD`
- `USDCHF` improves materially at `GOLD+`
- `XAUUSD` remains strongest in `NEW_YORK/OVERLAP` with `TYPE_A/TYPE_B`
- `EURUSD` is still the weakest active component and remains the main candidate for future refinement or removal

Current removals:

- `GBPUSD`: disabled
- `USDCAD`: disabled
- `AUDUSD`: disabled
- `USDJPY`: disabled

Current open problems:

- `EURUSD` still adds volume but not enough expectancy
- Claude validation is still too permissive and needs tighter rejection behavior
- The strategy is improved materially, but it has not yet demonstrated the 10% to 15% monthly target on this research set

Target-growth update:

- `target_growth_v1`:
  - profile: `v2_relaxed`
  - mixed providers: Polygon forex + Twelve Data XAUUSD
  - pair-specific H4 scan windows
  - monthly module guards for weak drawdown pockets
  - approximately `15.12` signals/month
  - approximately `188.21R`
  - approximately `10.16%` simple monthly growth using blueprint tier risks

- `target_growth_v2`:
  - same rules as v1, but `GBPJPY` gets a wider 90-minute post-H4 window
  - approximately `17.12` signals/month
  - approximately `205.18R`
  - approximately `10.87%` simple monthly growth using blueprint tier risks
  - best current candidate for the signal-volume goal

Current target gap:

- Signal goal `15-20/month`: reached by `target_growth_v1` and `target_growth_v2`
- Profit goal `13-18%/month`: not reached yet under current blueprint risk
- The remaining gap needs either stronger expectancy, more high-quality XAUUSD data, or an explicit risk-model decision after validation.

Important backtest fidelity fixes now implemented in code:

- weekly candles aligned to Monday instead of Unix-epoch week buckets
- H4 replay timestamps use bar-close time rather than bar-open time
- real `M15/M30` aggregation path for Polygon forex data
- optional repo-local historical caching
- optional same-pair concurrent research mode
- optional pair-specific post-H4 scan windows
- optional forward-only monthly pair/module drawdown guard
