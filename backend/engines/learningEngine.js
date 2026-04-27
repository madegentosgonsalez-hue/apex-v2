'use strict';
// Learning Engine — runs every Monday 16:00 Sydney time
// Analyzes last 7 days of closed trades, generates insights, waits for user approval.
//
// LOCKED RULES:
// - Never auto-apply changes
// - Never change core rules (tiers, confluence min, position sizing)
// - Can only suggest: conviction thresholds, pair focus, session preferences

class LearningEngine {
  constructor({ db }) {
    this.db = db;
  }

  // Main entry point — called by cron every Monday
  async analyze() {
    console.log('[Learning] Starting weekly analysis...');

    const trades = await this._getRecentTrades(7);
    if (trades.length === 0) {
      console.log('[Learning] No trades in last 7 days — skipping');
      return null;
    }

    const patterns   = this._analyzePatterns(trades);
    const insights   = this._generateInsights(patterns);
    const suggested  = this._suggestChanges(patterns);

    const record = {
      analysis_date:    new Date().toISOString(),
      total_trades:     trades.length,
      patterns,
      insights,
      suggested_changes: suggested,
      user_approval:    null,
    };

    await this._storeResults(patterns, insights, suggested);
    console.log(`[Learning] Done — ${trades.length} trades analyzed, ${insights.length} insights`);
    return record;
  }

  // ── DATA ──────────────────────────────────────────────────────────────────

  async _getRecentTrades(days) {
    try {
      const r = await this.db.query(
        `SELECT t.*, s.tier, s.entry_type, s.confluence_score,
                s.symbol, s.direction,
                EXTRACT(HOUR FROM t.entry_time AT TIME ZONE 'Australia/Sydney') as sydney_hour
         FROM trades t
         JOIN signals s ON t.signal_id = s.id
         WHERE t.closed_at >= NOW() - INTERVAL '${days} days'
           AND t.outcome IS NOT NULL
         ORDER BY t.closed_at DESC`
      );
      return r.rows || [];
    } catch {
      return [];
    }
  }

  // ── ANALYSIS ──────────────────────────────────────────────────────────────

  _analyzePatterns(trades) {
    return {
      byPair:      this._groupWinRate(trades, t => t.symbol),
      byEntryType: this._groupWinRate(trades, t => t.entry_type),
      bySession:   this._groupWinRate(trades, t => this._toSession(t.sydney_hour)),
      byTier:      this._groupWinRate(trades, t => t.tier),
      byConfluence:this._groupWinRate(trades, t => `${t.confluence_score}/6`),
      avgR:        this._avgR(trades),
      totalTrades: trades.length,
      wins:        trades.filter(t => t.outcome === 'WIN').length,
    };
  }

  _groupWinRate(trades, keyFn) {
    const groups = {};
    for (const t of trades) {
      const k = keyFn(t) || 'UNKNOWN';
      if (!groups[k]) groups[k] = { total: 0, wins: 0, r: 0 };
      groups[k].total++;
      if (t.outcome === 'WIN') groups[k].wins++;
      groups[k].r += parseFloat(t.pnl_r || 0);
    }
    const result = {};
    for (const [k, v] of Object.entries(groups)) {
      result[k] = {
        total:   v.total,
        wins:    v.wins,
        winRate: v.total > 0 ? Math.round((v.wins / v.total) * 100) : 0,
        avgR:    v.total > 0 ? parseFloat((v.r / v.total).toFixed(2)) : 0,
      };
    }
    return result;
  }

  _avgR(trades) {
    if (!trades.length) return 0;
    const total = trades.reduce((s, t) => s + parseFloat(t.pnl_r || 0), 0);
    return parseFloat((total / trades.length).toFixed(2));
  }

  _toSession(sydneyHour) {
    const h = parseInt(sydneyHour || 0);
    if (h >= 17 && h < 22) return 'LONDON';
    if (h >= 22 || h < 1)  return 'OVERLAP';
    if (h >= 1  && h < 7)  return 'NEW_YORK';
    return 'ASIAN';
  }

  // ── INSIGHTS ──────────────────────────────────────────────────────────────

  _generateInsights(patterns) {
    const insights = [];

    // Best/worst pair
    const pairs = Object.entries(patterns.byPair).sort((a, b) => b[1].winRate - a[1].winRate);
    if (pairs.length > 0) {
      const [best, bv] = pairs[0];
      insights.push(`${best}: ${bv.winRate}% WR (${bv.total} trades) — best performer`);
      if (pairs.length > 1) {
        const [worst, wv] = pairs[pairs.length - 1];
        insights.push(`${worst}: ${wv.winRate}% WR (${wv.total} trades) — worst performer`);
      }
    }

    // Entry types
    const entries = Object.entries(patterns.byEntryType).sort((a, b) => b[1].winRate - a[1].winRate);
    if (entries.length > 0) {
      const [bestE, bev] = entries[0];
      if (entries.length > 1) {
        const [worstE, wev] = entries[entries.length - 1];
        insights.push(`${bestE}: ${bev.winRate}% WR vs ${worstE}: ${wev.winRate}% WR — focus on ${bestE}`);
      }
    }

    // Sessions
    const sessions = Object.entries(patterns.bySession).sort((a, b) => b[1].winRate - a[1].winRate);
    if (sessions.length > 1) {
      const [bestS, bsv] = sessions[0];
      const [worstS, wsv] = sessions[sessions.length - 1];
      insights.push(`${bestS} session: ${bsv.winRate}% WR vs ${worstS}: ${wsv.winRate}% WR`);
    }

    // Tiers
    const silver = patterns.byTier['SILVER'];
    if (silver && silver.total >= 5 && silver.winRate < 50) {
      insights.push(`SILVER tier: ${silver.winRate}% WR — consider raising conviction threshold`);
    }

    // Confluence levels
    const conf6 = patterns.byConfluence['6/6'];
    const conf4 = patterns.byConfluence['4/6'];
    if (conf6 && conf4) {
      insights.push(`Confluence 6/6: ${conf6.winRate}% WR | 4/6: ${conf4.winRate}% WR`);
    }

    // Overall
    const wr = patterns.totalTrades > 0
      ? Math.round((patterns.wins / patterns.totalTrades) * 100)
      : 0;
    insights.push(`Overall: ${wr}% WR | Avg R: ${patterns.avgR}R | ${patterns.totalTrades} trades`);

    return insights;
  }

  // ── SUGGESTIONS (can only suggest — user must approve) ────────────────────

  _suggestChanges(patterns) {
    const suggestions = [];

    const silver = patterns.byTier['SILVER'];
    if (silver && silver.total >= 5 && silver.winRate < 48) {
      suggestions.push({
        type:       'CONVICTION_THRESHOLD',
        tier:       'SILVER',
        current:    65,
        suggested:  70,
        reason:     `SILVER at ${silver.winRate}% WR (${silver.total} trades) — low confidence`,
        confidence: silver.total >= 10 ? 'HIGH' : 'MEDIUM',
      });
    }

    const pairs = Object.entries(patterns.byPair).sort((a, b) => b[1].winRate - a[1].winRate);
    const topPair = pairs[0];
    if (topPair && topPair[1].winRate > 70 && topPair[1].total >= 5) {
      suggestions.push({
        type:       'PAIR_FOCUS',
        pair:       topPair[0],
        winRate:    topPair[1].winRate,
        reason:     `${topPair[0]} has ${topPair[1].winRate}% WR — consider prioritising`,
        confidence: topPair[1].total >= 10 ? 'HIGH' : 'MEDIUM',
      });
    }

    const sessions = Object.entries(patterns.bySession).sort((a, b) => a[1].winRate - b[1].winRate);
    const worstSession = sessions[0];
    if (worstSession && worstSession[1].winRate < 40 && worstSession[1].total >= 5) {
      suggestions.push({
        type:       'SESSION_PREFERENCE',
        session:    worstSession[0],
        winRate:    worstSession[1].winRate,
        reason:     `${worstSession[0]} session: ${worstSession[1].winRate}% WR — consider avoiding`,
        confidence: worstSession[1].total >= 10 ? 'HIGH' : 'MEDIUM',
      });
    }

    return suggestions;
  }

  // ── STORE ─────────────────────────────────────────────────────────────────

  async _storeResults(patterns, insights, suggested) {
    for (const [pair, stats] of Object.entries(patterns.byPair)) {
      try {
        const bestEntry   = this._bestKey(patterns.byEntryType);
        const bestSession = this._bestKey(patterns.bySession);

        await this.db.query(
          `INSERT INTO learning_patterns
             (analysis_date, pair, win_rate_pct, total_trades, avg_r_earned,
              best_entry_type, best_session, insights, suggested_changes)
           VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            pair,
            stats.winRate,
            stats.total,
            stats.avgR,
            bestEntry,
            bestSession,
            JSON.stringify(insights),
            JSON.stringify(suggested),
          ]
        );
      } catch (err) {
        console.error('[Learning] Store error:', err.message);
      }
    }
  }

  _bestKey(obj) {
    const entries = Object.entries(obj).sort((a, b) => b[1].winRate - a[1].winRate);
    return entries[0]?.[0] || null;
  }

  // Fetch last stored learning results for the API
  async getLastResults() {
    try {
      const r = await this.db.query(
        `SELECT * FROM learning_patterns ORDER BY analysis_date DESC LIMIT 20`
      );
      return r.rows || [];
    } catch {
      return [];
    }
  }

  // Apply user-approved suggestion
  async applyApproval(patternId, approved) {
    await this.db.query(
      `UPDATE learning_patterns SET user_approval = $1, applied_at = NOW() WHERE id = $2`,
      [approved, patternId]
    );
  }
}

module.exports = LearningEngine;
