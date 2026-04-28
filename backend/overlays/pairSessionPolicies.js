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
};

function getPairPolicy(name = 'none') {
  return POLICIES[name] || POLICIES.none;
}

module.exports = {
  POLICIES,
  getPairPolicy,
};
