'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const DataService = require('../services/dataService');
const { RangeReversionEngine } = require('../research/scalpContinuationEngine');
const { getPairPolicy } = require('../overlays/pairSessionPolicies');
const { getStrategyProfile } = require('../overlays/strategyProfiles');
const { simulatePortfolio } = require('../research/portfolioSimulator');

const list = (value, fallback) => {
  const parts = String(value || '').split(',').map(v => v.trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)] : fallback;
};

async function main() {
  const yearsBack = Number(process.env.RESEARCH_YEARS_BACK || 2);
  const pairs = list(process.env.RESEARCH_PAIRS, ['EURUSD', 'USDCHF', 'GBPJPY', 'EURJPY']);
  const profileName = process.env.RESEARCH_PROFILE || 'v2_relaxed';
  const policyName = process.env.RESEARCH_POLICY || 'range_v1';

  process.env.MARKET_DATA_PROVIDER = 'polygon';
  const dataService = new DataService({
    taapiKey: process.env.TAAPI_API_KEY,
    twelveDataKey: process.env.TWELVE_DATA_API_KEY,
    polygonKey: process.env.POLYGON_API_KEY,
    marketDataProvider: 'polygon',
  });

  const engine = new RangeReversionEngine({
    dataService,
    strategyProfile: getStrategyProfile(profileName),
    pairPolicy: getPairPolicy(policyName),
    researchOptions: {
      allowConcurrentTrades: true,
      rangeCooldownBars: Number(process.env.RESEARCH_RANGE_COOLDOWN_BARS || 6),
      rangeMaxHoldBars: Number(process.env.RESEARCH_RANGE_MAX_HOLD_BARS || 64),
      rangeMinR: Number(process.env.RESEARCH_RANGE_MIN_R || 1.5),
      scalpTimeStopHours: Number(process.env.RESEARCH_RANGE_TIME_STOP_HOURS || 12),
      scalpMinR: Number(process.env.RESEARCH_RANGE_MIN_R || 1.5),
    },
  });

  const results = [];
  for (const symbol of pairs) {
    console.log(`[Range Research] Running ${symbol}...`);
    results.push(await engine.runRangeBacktest(symbol, yearsBack));
  }

  const trades = results.flatMap(row => row.tradeLog || []);
  const wins = trades.filter(t => Number(t.pnlR) > 0);
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
    maxConcurrentTrades: Number(process.env.RESEARCH_MAX_CONCURRENT_TRADES || 5),
    maxEntriesPerPair: Number(process.env.RESEARCH_MAX_ENTRIES_PER_PAIR || 2),
    executionDragR: Number(process.env.RESEARCH_EXECUTION_DRAG_R || 0.08),
  });

  const output = {
    generatedAt: new Date().toISOString(),
    engine: 'range_reversion_v1',
    yearsBack,
    profile: profileName,
    policy: policyName,
    pairs,
    portfolio,
    constrainedPortfolio,
    results,
  };

  const outDir = path.join(__dirname, '..', 'research', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `range-reversion-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
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
