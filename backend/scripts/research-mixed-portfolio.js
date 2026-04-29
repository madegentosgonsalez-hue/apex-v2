'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const Backtester = require('../backtest');
const DataService = require('../services/dataService');
const { getPairPolicy } = require('../overlays/pairSessionPolicies');
const { getStrategyProfile } = require('../overlays/strategyProfiles');

const polygonData = new DataService({
  taapiKey: process.env.TAAPI_API_KEY,
  twelveDataKey: process.env.TWELVE_DATA_API_KEY,
  polygonKey: process.env.POLYGON_API_KEY,
  marketDataProvider: 'polygon',
});

const twelveData = new DataService({
  taapiKey: process.env.TAAPI_API_KEY,
  twelveDataKey: process.env.TWELVE_DATA_API_KEY,
  polygonKey: process.env.POLYGON_API_KEY,
  marketDataProvider: 'twelve',
});

const parseList = (value, fallback) => {
  const parts = String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length ? parts : fallback;
};

const providerForSymbol = (symbol) => (symbol === 'XAUUSD' ? 'twelve' : 'polygon');
const dataForProvider = (provider) => (provider === 'twelve' ? twelveData : polygonData);

async function main() {
  const yearsBack = Number(process.env.RESEARCH_YEARS_BACK || 1);
  const pairs = parseList(process.env.RESEARCH_PAIRS, ['EURUSD', 'USDCHF', 'GBPJPY', 'XAUUSD']);
  const profileName = process.env.RESEARCH_PROFILE || 'balanced';
  const policyName = process.env.RESEARCH_POLICY || 'mixed_growth_v1';
  const allowConcurrentTrades = /^(1|true|yes)$/i.test(String(process.env.RESEARCH_ALLOW_CONCURRENT || 'true'));
  const syntheticIntermarket = /^(1|true|yes)$/i.test(String(process.env.RESEARCH_SYNTHETIC_INTERMARKET || 'false'));

  const strategyProfile = getStrategyProfile(profileName);
  const pairPolicy = getPairPolicy(policyName);

  const bundles = new Map();
  for (const symbol of pairs) {
    const provider = providerForSymbol(symbol);
    process.env.MARKET_DATA_PROVIDER = provider;
    const builder = new Backtester({
      dataService: dataForProvider(provider),
      strategyProfile,
      pairPolicy,
      researchOptions: { allowConcurrentTrades, syntheticIntermarket },
    });
    console.log(`[Mixed Research] Building ${symbol} bundle via ${provider}...`);
    bundles.set(symbol, await builder._buildSeriesBundle(symbol, yearsBack));
  }

  const results = [];
  for (const symbol of pairs) {
    const provider = providerForSymbol(symbol);
    process.env.MARKET_DATA_PROVIDER = provider;
    const bt = new Backtester({
      dataService: dataForProvider(provider),
      strategyProfile,
      pairPolicy,
      researchOptions: { allowConcurrentTrades, syntheticIntermarket },
    });
    const report = await bt.runBacktest(symbol, yearsBack, null, null, bundles.get(symbol));
    results.push({
      symbol,
      provider,
      summary: report.summary,
      bySession: report.bySession,
      skipCounts: report.skipCounts,
    });
  }

  const portfolio = results.reduce((acc, row) => {
    acc.trades += row.summary.totalTrades;
    acc.totalR += row.summary.totalR;
    acc.signalsPerMonth += row.summary.avgSignalsPerMonth;
    return acc;
  }, { trades: 0, totalR: 0, signalsPerMonth: 0 });

  const outputDir = path.join(__dirname, '..', 'research', 'results');
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `mixed-portfolio-${stamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    yearsBack,
    profile: profileName,
    policy: policyName,
    allowConcurrentTrades,
    syntheticIntermarket,
    pairs,
    results,
    portfolio,
  }, null, 2));

  console.log(JSON.stringify({ outputPath, portfolio, results }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
