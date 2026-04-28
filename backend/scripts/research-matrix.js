'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const Backtester = require('../backtest');
const DataService = require('../services/dataService');
const AIAnalyst = require('../engines/aiAnalyst');
const { getPairPolicy } = require('../overlays/pairSessionPolicies');
const { getStrategyProfile } = require('../overlays/strategyProfiles');

const data = new DataService({
  taapiKey: process.env.TAAPI_API_KEY,
  twelveDataKey: process.env.TWELVE_DATA_API_KEY,
  polygonKey: process.env.POLYGON_API_KEY,
  marketDataProvider: process.env.MARKET_DATA_PROVIDER,
});

const parseList = (value, fallback) => {
  const parts = String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length ? parts : fallback;
};

const yearsBack = Number(process.env.RESEARCH_YEARS_BACK || 1);
const pairs = parseList(process.env.RESEARCH_PAIRS, ['EURUSD', 'GBPUSD', 'USDCHF', 'GBPJPY']);
const profiles = parseList(process.env.RESEARCH_PROFILES, ['blueprint', 'balanced', 'v2_relaxed', 'fast_bias', 'anchor_turbo']);
const policies = parseList(process.env.RESEARCH_POLICIES, ['none', 'quality_prune']);
const syntheticIntermarket = /^(1|true|yes)$/i.test(String(process.env.RESEARCH_SYNTHETIC_INTERMARKET || 'false'));
const allowConcurrentTrades = /^(1|true|yes)$/i.test(String(process.env.RESEARCH_ALLOW_CONCURRENT || 'false'));
const useAI = /^(1|true|yes)$/i.test(String(process.env.RESEARCH_USE_AI || 'false'));

async function fetchContextSeries(symbols, backtester) {
  const context = {};
  for (const symbol of symbols) {
    console.log(`[Research] Context fetch ${symbol}...`);
    context[symbol] = await backtester._fetchH1(symbol, yearsBack);
  }
  return context;
}

function slimReport(report) {
  return {
    summary: report.summary,
    best: report.best,
    byEntryType: report.byEntryType,
    byTier: report.byTier,
    bySession: report.bySession,
    byMonth: report.byMonth,
    skipCounts: report.skipCounts,
  };
}

async function main() {
  const provider = String(process.env.MARKET_DATA_PROVIDER || 'auto').toLowerCase();
  console.log(`[Research] Provider=${provider} Years=${yearsBack} Pairs=${pairs.join(',')} Profiles=${profiles.join(',')} Policies=${policies.join(',')}`);

  const bundleBuilder = new Backtester({ dataService: data });
  const contextSymbols = syntheticIntermarket ? [...new Set(pairs)] : [];
  const contextSeries = syntheticIntermarket ? await fetchContextSeries(contextSymbols, bundleBuilder) : null;

  const bundles = new Map();
  for (const symbol of pairs) {
    console.log(`[Research] Building bundle for ${symbol}...`);
    const bundle = await bundleBuilder._buildSeriesBundle(symbol, yearsBack);
    bundles.set(symbol, bundle);
  }

  const results = [];
  for (const profileName of profiles) {
    const strategyProfile = getStrategyProfile(profileName);
    for (const policyName of policies) {
      const pairPolicy = getPairPolicy(policyName);
      console.log(`[Research] Running profile=${profileName} policy=${policyName}...`);

      const backtester = new Backtester({
        dataService: data,
        aiAnalyst: useAI ? new AIAnalyst({ apiKey: process.env.ANTHROPIC_API_KEY }) : null,
        pairPolicy,
        strategyProfile,
        contextSeries,
        researchOptions: {
          syntheticIntermarket,
          allowConcurrentTrades,
        },
      });

      for (const symbol of pairs) {
        const report = await backtester.runBacktest(symbol, yearsBack, null, null, bundles.get(symbol));
        results.push({
          provider,
          symbol,
          yearsBack,
          profile: profileName,
          policy: policyName,
          syntheticIntermarket,
          allowConcurrentTrades,
          report: slimReport(report),
        });
      }
    }
  }

  const outputDir = path.join(__dirname, '..', 'research', 'results');
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `matrix-${stamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    provider,
    yearsBack,
    pairs,
    profiles,
    policies,
    syntheticIntermarket,
    allowConcurrentTrades,
    useAI,
    results,
  }, null, 2));

  const leaderboard = results
    .map((row) => ({
      symbol: row.symbol,
      profile: row.profile,
      policy: row.policy,
      trades: row.report.summary.totalTrades,
      signalsPerMonth: row.report.summary.avgSignalsPerMonth,
      winRate: row.report.summary.winRate,
      totalR: row.report.summary.totalR,
    }))
    .sort((a, b) => b.totalR - a.totalR || b.winRate - a.winRate);

  console.log(JSON.stringify({ outputPath, top: leaderboard.slice(0, 12) }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
