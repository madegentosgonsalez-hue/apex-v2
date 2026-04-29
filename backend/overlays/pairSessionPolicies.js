'use strict';

const POLICIES = {
  none: {},
  winner_focus: {
    AUDUSD: { sessions: ['OVERLAP'], minTier: 'DIAMOND' },
    EURJPY: { sessions: ['OVERLAP'], minTier: 'DIAMOND' },
    GBPUSD: { sessions: ['LONDON', 'NEW_YORK', 'OVERLAP'], minTier: 'DIAMOND' },
    USDCAD: { sessions: ['NEW_YORK', 'OVERLAP'], minTier: 'DIAMOND' },
    GBPJPY: { sessions: ['NEW_YORK', 'OVERLAP'], minTier: 'GOLD' },
  },
  selective_pairs: {
    AUDUSD: { sessions: ['OVERLAP'], minTier: 'DIAMOND' },
    EURJPY: { sessions: ['OVERLAP'], minTier: 'DIAMOND' },
    GBPUSD: { sessions: ['LONDON', 'NEW_YORK', 'OVERLAP'], minTier: 'DIAMOND' },
    USDCAD: { sessions: ['NEW_YORK', 'OVERLAP'], minTier: 'DIAMOND' },
  },
  prune_losers: {
    EURJPY: { sessions: ['OVERLAP'], minTier: 'DIAMOND' },
    USDCAD: { sessions: ['NEW_YORK', 'OVERLAP'], minTier: 'DIAMOND' },
  },
  quality_prune: {
    EURJPY: { sessions: ['OVERLAP'], minTier: 'DIAMOND' },
    USDCAD: { sessions: ['NEW_YORK', 'OVERLAP'], minTier: 'DIAMOND' },
    AUDUSD: { sessions: ['ASIAN', 'OVERLAP'], minTier: 'GOLD' },
    USDCHF: { sessions: ['LONDON', 'OVERLAP'], minTier: 'GOLD' },
  },
  real15m_focus: {
    GBPUSD: { disabled: true },
    USDCAD: { disabled: true },
    AUDUSD: { disabled: true },
    USDJPY: { disabled: true },
    EURUSD: { sessions: ['LONDON', 'NEW_YORK', 'OVERLAP'], minTier: 'GOLD' },
    USDCHF: { sessions: ['LONDON', 'OVERLAP'], minTier: 'GOLD' },
    GBPJPY: { sessions: ['NEW_YORK', 'OVERLAP'], minTier: 'GOLD' },
    EURJPY: { sessions: ['OVERLAP'], minTier: 'GOLD' },
  },
  real15m_growth: {
    GBPUSD: { disabled: true },
    USDCAD: { disabled: true },
    AUDUSD: { disabled: true },
    USDJPY: { disabled: true },
    EURJPY: { sessions: ['OVERLAP'] },
  },
  mixed_growth_v1: {
    GBPUSD: { disabled: true },
    USDCAD: { disabled: true },
    AUDUSD: { disabled: true },
    USDJPY: { disabled: true },
    EURJPY: { disabled: true },
    EURUSD: { sessions: ['NEW_YORK', 'OVERLAP'] },
    XAUUSD: { sessions: ['NEW_YORK', 'OVERLAP'] },
  },
};

function getPairPolicy(name = 'none') {
  return POLICIES[name] || POLICIES.none;
}

module.exports = {
  POLICIES,
  getPairPolicy,
};
