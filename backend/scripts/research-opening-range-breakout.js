'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const DataService = require('../services/dataService');
const { OpeningRangeBreakoutEngine } = require('../research/openingRangeBreakoutEngine');
const { getPairPolicy } = require('../overlays/pairSessionPolicies');
const { getStrategyProfile } = require('../overlays/strategyProfiles');
const { simulatePortfolio } = require('../research/portfolioSimulator');

const list = (value, fallback) => {
  const parts = String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)] : fallback;
};

const providerForSymbol = (symbol) => (symbol === 'XAUUSD' ? 'twelve' : 'polygon');

function buildDataService(provider) {
  return new DataService({
    taapiKey: process.env.TAAPI_API_KEY,
    twelveDataKey: process.env.TWELVE_DATA_API_KEY,
    polygonKey: process.env.POLYGON_API_KEY,
    marketDataProvider: provider,
  });
}

async function main() {
  const yearsBack = Number(process.env.RESEARCH_YEARS_BACK || 2);
  const pairs = list(process.env.RESEARCH_PAIRS, ['EURUSD', 'GBPUSD', 'USDCHF', 'GBPJPY', 'XAUUSD']);
  const profileName = process.env.RESEARCH_PROFILE || 'v2_relaxed';
  const policyName = process.env.RESEARCH_POLICY || 'orb_v1';
  const maxConcurrentTrades = Number(process.env.RESEARCH_MAX_CONCURRENT_TRADES || 5);
  const maxEntriesPerPair = Number(process.env.RESEARCH_MAX_ENTRIES_PER_PAIR || 2);
  const executionDragR = Number(process.env.RESEARCH_EXECUTION_DRAG_R || 0.08);
  const strategyProfile = getStrategyProfile(profileName);
  const pairPolicy = getPairPolicy(policyName);

  const results = [];
  for (const symbol of pairs) {
    const provider = providerForSymbol(symbol);
    process.env.MARKET_DATA_PROVIDER = provider;
    const engine = new OpeningRangeBreakoutEngine({
      dataService: buildDataService(provider),
      strategyProfile,
      pairPolicy,
      researchOptions: {
        allowConcurrentTrades: true,
        syntheticIntermarket: /^(1|true|yes)$/i.test(String(process.env.RESEARCH_SYNTHETIC_INTERMARKET || 'false')),
        orbRangeMinutes: Number(process.env.RESEARCH_ORB_RANGE_MINUTES || 60),
        orbMaxEntryMinutes: Number(process.env.RESEARCH_ORB_MAX_ENTRY_MINUTES || 180),
        orbTimeStopHours: Number(process.env.RESEARCH_ORB_TIME_STOP_HOURS || 12),
        orbCooldownBars: Number(process.env.RESEARCH_ORB_COOLDOWN_BARS || 24),
        orbMinRangeAtr: Number(process.env.RESEARCH_ORB_MIN_RANGE_ATR || 0.4),
        orbMaxRangeAtr: Number(process.env.RESEARCH_ORB_MAX_RANGE_ATR || 1.8),
        scalpTimeStopHours: Number(process.env.RESEARCH_ORB_TIME_STOP_HOURS || 12),
        scalpMaxHoldBars: Number(process.env.RESEARCH_ORB_MAX_HOLD_BARS || 48),
        scalpMinR: Number(process.env.RESEARCH_ORB_MIN_R || 2.0),
      },
    });
    console.log(`[ORB Research] Running ${symbol} via ${provider}...`);
    results.push(await engine.runOrbBacktest(symbol, yearsBack));
  }

  const trades = results.flatMap((row) => row.tradeLog || []);
  const wins = trades.filter((t) => Number(t.pnlR) > 0);
  const totalR = trades.reduce((sum, t) => sum + Number(t.pnlR || 0), 0);
  const portfolio = {
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? Number((wins.length / trades.length * 100).toFixed(1)) : 0,
    totalR: Number(totalR.toFixed(2)),
    signalsPerMonth: Number((trades.length / Math.max(yearsBack * 12, 1)).toFixed(2)),
  };

  const constrainedPortfolio = simulatePortfolio(results, {
    startingBalance: Number(process.env.RESEARCH_STARTING_BALANCE || 1000),
    maxConcurrentTrades,
    maxEntriesPerPair,
    executionDragR,
  });

  const output = {
    generatedAt: new Date().toISOString(),
    engine: 'opening_range_breakout_v1',
    yearsBack,
    profile: profileName,
    policy: policyName,
    pairs,
    maxConcurrentTrades,
    maxEntriesPerPair,
    executionDragR,
    portfolio,
    constrainedPortfolio,
    results,
  };

  const outDir = path.join(__dirname, '..', 'research', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `opening-range-breakout-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(JSON.stringify({
    outputPath,
    portfolio,
    constrainedPortfolio: { ...constrainedPortfolio, timeline: undefined, skipped: undefined },
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
