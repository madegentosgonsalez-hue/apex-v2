'use strict';

const PROFILES = {
  blueprint: {
    name: 'blueprint',
    weeklySwings: 5,
    dailySwings: 4,
    h4Swings: 3,
    h2Swings: 3,
    allowDailyNeutralPullback: false,
    typeCAdxMin: 20,
  },
  balanced: {
    name: 'balanced',
    weeklySwings: 3,
    dailySwings: 2,
    h4Swings: 2,
    h2Swings: 2,
    allowDailyNeutralPullback: true,
    typeCAdxMin: 18,
  },
  v2_relaxed: {
    name: 'v2_relaxed',
    weeklySwings: 2,
    dailySwings: 2,
    h4Swings: 2,
    h2Swings: 2,
    allowDailyNeutralPullback: true,
    typeCAdxMin: 15,
  },
  fast_bias: {
    name: 'fast_bias',
    weeklySwings: 2,
    dailySwings: 1,
    h4Swings: 2,
    h2Swings: 1,
    allowDailyNeutralPullback: true,
    typeCAdxMin: 12,
  },
  anchor_turbo: {
    name: 'anchor_turbo',
    weeklySwings: 1,
    dailySwings: 1,
    h4Swings: 1,
    h2Swings: 1,
    allowDailyNeutralPullback: true,
    typeCAdxMin: 10,
  },
};

function getStrategyProfile(name = 'blueprint') {
  return PROFILES[name] || PROFILES.blueprint;
}

module.exports = {
  PROFILES,
  getStrategyProfile,
};
