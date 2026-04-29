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
const tierRiskPct = { SILVER: 1.0, GOLD: 1.5, DIAMOND: 2.0 };

async function main() {
  const yearsBack = Number(process.env.RESEARCH_YEARS_BACK || 1);
  const pairs = parseList(process.env.RESEARCH_PAIRS, ['EURUSD', 'USDCHF', 'GBPJPY', 'XAUUSD']);
  const profileName = process.env.RESEARCH_PROFILE || 'balanced';
  const policyName = process.env.RESEARCH_POLICY || 'mixed_growth_v1';
  const allowConcurrentTrades = /^(1|true|yes)$/i.test(String(process.env.RESEARCH_ALLOW_CONCURRENT || 'true'));
  const syntheticIntermarket = /^(1|true|yes)$/i.test(String(process.env.RESEARCH_SYNTHETIC_INTERMARKET || 'false'));
  const h4ScanWindowMinutes = Number(process.env.RESEARCH_H4_SCAN_WINDOW_MINUTES || 30);

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
      researchOptions: { allowConcurrentTrades, syntheticIntermarket, h4ScanWindowMinutes },
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
      researchOptions: { allowConcurrentTrades, syntheticIntermarket, h4ScanWindowMinutes },
    });
    const report = await bt.runBacktest(symbol, yearsBack, null, null, bundles.get(symbol));
    results.push({
      symbol,
      provider,
      summary: report.summary,
      byEntryType: report.byEntryType,
      byTier: report.byTier,
      bySession: report.bySession,
      byMonth: report.byMonth,
      byHourUTC: report.byHourUTC,
      byLevelType: report.byLevelType,
      byConfluence: report.byConfluence,
      byDirection: report.byDirection,
      byRegime: report.byRegime,
      byExitReason: report.byExitReason,
      byAdxBucket: report.byAdxBucket,
      bySessionHour: report.bySessionHour,
      byLevelDirection: report.byLevelDirection,
      tradeLog: report.tradeLog,
      skipCounts: report.skipCounts,
    });
  }

  const portfolio = results.reduce((acc, row) => {
    acc.trades += row.summary.totalTrades;
    acc.wins += row.summary.winsCount;
    acc.losses += row.summary.lossCount;
    acc.totalR += row.summary.totalR;
    acc.signalsPerMonth += row.summary.avgSignalsPerMonth;
    for (const [tier, stats] of Object.entries(row.byTier || {})) {
      acc.byTier[tier] = acc.byTier[tier] || { trades: 0, wins: 0, totalR: 0 };
      acc.byTier[tier].trades += stats.trades;
      acc.byTier[tier].wins += stats.wins;
      acc.byTier[tier].totalR += stats.totalR;
      acc.simpleGrowthPct += stats.totalR * (tierRiskPct[tier] || 0);
    }
    return acc;
  }, { trades: 0, wins: 0, losses: 0, totalR: 0, signalsPerMonth: 0, simpleGrowthPct: 0, byTier: {} });
  portfolio.totalR = Number(portfolio.totalR.toFixed(2));
  portfolio.signalsPerMonth = Number(portfolio.signalsPerMonth.toFixed(2));
  portfolio.winRate = portfolio.trades ? Number((portfolio.wins / portfolio.trades * 100).toFixed(1)) : 0;
  portfolio.simpleGrowthPct = Number(portfolio.simpleGrowthPct.toFixed(2));
  portfolio.simpleGrowthPctPerMonth = Number((portfolio.simpleGrowthPct / Math.max(yearsBack * 12, 1)).toFixed(2));
  portfolio.byTier = Object.fromEntries(Object.entries(portfolio.byTier).map(([tier, stats]) => [tier, {
    trades: stats.trades,
    wins: stats.wins,
    winRate: stats.trades ? Number((stats.wins / stats.trades * 100).toFixed(1)) : 0,
    totalR: Number(stats.totalR.toFixed(2)),
  }]));

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
    h4ScanWindowMinutes,
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
