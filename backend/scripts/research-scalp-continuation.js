'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const DataService = require('../services/dataService');
const { ScalpContinuationEngine } = require('../research/scalpContinuationEngine');
const { getPairPolicy } = require('../overlays/pairSessionPolicies');
const { getStrategyProfile } = require('../overlays/strategyProfiles');
const { simulatePortfolio } = require('../research/portfolioSimulator');

const parseList = (value, fallback) => String(value || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)
  .concat([])
  .filter((v, i, arr) => arr.indexOf(v) === i)
  || fallback;

function list(value, fallback) {
  const parsed = parseList(value, fallback);
  return parsed.length ? parsed : fallback;
}

const polygonData = new DataService({
  taapiKey: process.env.TAAPI_API_KEY,
  twelveDataKey: process.env.TWELVE_DATA_API_KEY,
  polygonKey: process.env.POLYGON_API_KEY,
  marketDataProvider: 'polygon',
});

async function main() {
  const yearsBack = Number(process.env.RESEARCH_YEARS_BACK || 2);
  const pairs = list(process.env.RESEARCH_PAIRS, ['EURUSD', 'USDCHF', 'GBPJPY', 'EURJPY']);
  const profileName = process.env.RESEARCH_PROFILE || 'v2_relaxed';
  const policyName = process.env.RESEARCH_POLICY || 'scalp_v1';
  const strategyProfile = getStrategyProfile(profileName);
  const pairPolicy = getPairPolicy(policyName);
  const maxConcurrentTrades = Number(process.env.RESEARCH_MAX_CONCURRENT_TRADES || 5);
  const maxEntriesPerPair = Number(process.env.RESEARCH_MAX_ENTRIES_PER_PAIR || 2);
  const executionDragR = Number(process.env.RESEARCH_EXECUTION_DRAG_R || 0.08);

  process.env.MARKET_DATA_PROVIDER = 'polygon';

  const engine = new ScalpContinuationEngine({
    dataService: polygonData,
    strategyProfile,
    pairPolicy,
    researchOptions: {
      allowConcurrentTrades: true,
      syntheticIntermarket: /^(1|true|yes)$/i.test(String(process.env.RESEARCH_SYNTHETIC_INTERMARKET || 'false')),
      scalpTimeStopHours: Number(process.env.RESEARCH_SCALP_TIME_STOP_HOURS || 10),
      scalpMaxHoldBars: Number(process.env.RESEARCH_SCALP_MAX_HOLD_BARS || 96),
      scalpCooldownBars: Number(process.env.RESEARCH_SCALP_COOLDOWN_BARS || 8),
      scalpMinR: Number(process.env.RESEARCH_SCALP_MIN_R || 1.5),
    },
  });

  const results = [];
  for (const symbol of pairs) {
    console.log(`[Scalp Research] Running ${symbol}...`);
    results.push(await engine.runScalpBacktest(symbol, yearsBack));
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
    maxConcurrentTrades,
    maxEntriesPerPair,
    executionDragR,
  });

  const output = {
    generatedAt: new Date().toISOString(),
    engine: 'scalp_continuation_v1',
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
  const outputPath = path.join(outDir, `scalp-continuation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(JSON.stringify({
    outputPath,
    portfolio,
    constrainedPortfolio: {
      ...constrainedPortfolio,
      timeline: undefined,
      skipped: undefined,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
