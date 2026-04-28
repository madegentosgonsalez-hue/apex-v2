## APEX v3 Rebuild Plan

### Purpose

APEX v3 is the clean rebuild of APEX using:

- the blueprint as the source of strategy truth
- apex-v2 as the research and evidence branch
- only proven infrastructure improvements from v2

### Core Principles

1. The blueprint defines the strategy doctrine.
2. v2 backtests inform overlays, not the base strategy.
3. AI is a judge and filter, not the hidden strategy.
4. Pair and session policies must be optional overlays.
5. Backtests must be able to isolate:
   - pure blueprint
   - blueprint plus AI
   - blueprint plus policy
   - blueprint plus AI plus policy

### Layer Model

#### 1. Core Strategy

Owned by blueprint-first files:

- `backend/engines/brain1-signal.js`
- `backend/engines/brain23.js`
- `backend/engines/learningEngine.js`
- `backend/utils/constants.js`

This layer defines:

- bias
- setup types
- confluence
- tier doctrine
- exits

#### 2. Selection Layer

This layer must be optional and measurable.

Examples:

- Claude validation
- pair restrictions
- session restrictions
- historical-performance filters

This layer must never silently rewrite the core doctrine.

#### 3. Execution and Runtime

Operational files:

- `backend/server.js`
- notifications
- database
- deployment config
- dashboard
- `backend/backtest.js`

### Keep From v2

- `backend/backtest.js`
  Ported as the v3 replay engine foundation.
- `backend/services/dataService.js`
  Ported for safer Twelve Data usage and local indicator calculation.
- deployment/runtime improvements where they do not alter strategy doctrine.

### Revert To Blueprint

- Brain1 bias philosophy
- original Type C doctrine
- locked AI judge role
- canonical tier and risk doctrine

### Milestones

#### Milestone 1

Pure blueprint strategy running inside v3:

- Brain1/2/3 intact
- server boots
- data service works
- baseline scans work

#### Milestone 2

Pure blueprint backtesting:

- no pair policy
- no AI overlay required
- 2-year replay baseline established

#### Milestone 3

AI as an optional overlay:

- strict validator mode only
- no hidden strategy drift

#### Milestone 4

Policy overlay tests:

- pair restrictions
- session rules
- optional pair-specific tuning

#### Milestone 5

Promotion criteria:

- keep only overlays that improve expectancy and consistency
- reject any overlay that improves volume by damaging quality too much

### Current Status

- v3 scaffold created from the blueprint
- v2 data service ported into v3
- v2 backtest engine ported into v3
- backtest cleaned so it defaults to a pure blueprint baseline and accepts overlays later

### Next Recommended Work

1. Verify v3 boots with the blueprint strategy files intact.
2. Wire `server.js` to expose a clean backtest route for v3.
3. Run the first pure blueprint 2-year baseline.
4. Only after that, reintroduce Claude as an overlay.
