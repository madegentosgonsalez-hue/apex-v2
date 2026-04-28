// ═══════════════════════════════════════════════════════════════════════════
// LEARNING ENGINE — Weekly AI Review + Pattern Discovery
// This is what makes APEX smarter over time.
// Every Sunday 22:00 UTC it studies all trades and finds hidden patterns.
// ═══════════════════════════════════════════════════════════════════════════

class LearningEngine {
  constructor({ aiAnalyst, db, notifier }) {
    this.ai       = aiAnalyst;
    this.db       = db;
    this.notifier = notifier;
  }

  // ── WEEKLY REVIEW ──────────────────────────────────────────────────────────
  // Called every Sunday 22:00 UTC by cron
  async runWeeklyReview() {
    console.log('\n[Learning] ═══ Weekly Review Starting ═══');

    try {
      // 1. Gather all performance data
      const perfData = await this._gatherPerformanceData();

      if (perfData.totalTrades < 5) {
        console.log('[Learning] Not enough trades yet (min 5). Skipping AI analysis.');
        return;
      }

      // 2. Calculate pattern stats ourselves (no AI needed for raw numbers)
      const patterns = this._analyzePatterns(perfData);

      // 3. Ask AI to interpret and find non-obvious insights
      const aiInsights = await this._getAIInsights(perfData, patterns);

      // 4. Store insights in DB for dashboard display
      await this.db.setConfig('latest_learning_insights', {
        generatedAt:   new Date().toISOString(),
        weekNumber:    this._weekNumber(),
        patterns,
        aiInsights,
        summary:       perfData.summary,
      });

      // 5. Send weekly Telegram report
      await this._sendWeeklyReport(perfData, patterns, aiInsights);

      console.log('[Learning] ✅ Weekly review complete');
      console.log(`[Learning] Trades analyzed: ${perfData.totalTrades}`);
      console.log(`[Learning] Win rate: ${perfData.summary.winRate}%`);
      console.log(`[Learning] Net R: ${perfData.summary.netR}R`);

    } catch (err) {
      console.error('[Learning] Review error:', err.message);
    }
  }

  // ── GATHER PERFORMANCE DATA ────────────────────────────────────────────────
  async _gatherPerformanceData() {
    // Get last 7 days of closed trades
    const weekSignals = await this.db.getSignalHistory({ limit: 200, offset: 0 });
    const lastWeek    = new Date(Date.now() - 7 * 86400000);
    const trades      = weekSignals.filter(s =>
      s.outcome && ['WIN','LOSS','BREAKEVEN'].includes(s.outcome) &&
      new Date(s.created_at) > lastWeek
    );

    // All-time for cumulative metrics
    const allTime = await this.db.getPerformanceStats({ days: 180 });

    const wins   = trades.filter(s => s.outcome === 'WIN').length;
    const losses = trades.filter(s => s.outcome === 'LOSS').length;
    const netR   = trades.reduce((a, s) => a + (parseFloat(s.pnl_r) || 0), 0);

    // Group by entry type
    const byType = {};
    trades.forEach(s => {
      const t = s.entry_type || 'UNKNOWN';
      if (!byType[t]) byType[t] = { wins: 0, losses: 0, r: 0, count: 0 };
      byType[t].count++;
      byType[t].r += parseFloat(s.pnl_r) || 0;
      if (s.outcome === 'WIN')  byType[t].wins++;
      if (s.outcome === 'LOSS') byType[t].losses++;
    });

    // Group by session
    const bySession = {};
    trades.forEach(s => {
      const sess = s.session || 'UNKNOWN';
      if (!bySession[sess]) bySession[sess] = { wins: 0, losses: 0, r: 0, count: 0 };
      bySession[sess].count++;
      bySession[sess].r += parseFloat(s.pnl_r) || 0;
      if (s.outcome === 'WIN')  bySession[sess].wins++;
      if (s.outcome === 'LOSS') bySession[sess].losses++;
    });

    // Group by regime
    const byRegime = {};
    trades.forEach(s => {
      const reg = s.regime || 'UNKNOWN';
      if (!byRegime[reg]) byRegime[reg] = { wins: 0, losses: 0, r: 0, count: 0 };
      byRegime[reg].count++;
      byRegime[reg].r += parseFloat(s.pnl_r) || 0;
      if (s.outcome === 'WIN')  byRegime[reg].wins++;
      if (s.outcome === 'LOSS') byRegime[reg].losses++;
    });

    // Group by pair
    const byPair = {};
    trades.forEach(s => {
      if (!byPair[s.symbol]) byPair[s.symbol] = { wins: 0, losses: 0, r: 0, count: 0 };
      byPair[s.symbol].count++;
      byPair[s.symbol].r += parseFloat(s.pnl_r) || 0;
      if (s.outcome === 'WIN')  byPair[s.symbol].wins++;
      if (s.outcome === 'LOSS') byPair[s.symbol].losses++;
    });

    // AI accuracy — compare AI conviction to outcome
    const aiAccuracy = this._calculateAIAccuracy(trades);

    // Confluence factor correlation
    const factorCorrelation = this._factorCorrelation(trades);

    return {
      trades,
      totalTrades:       trades.length,
      byType, bySession, byRegime, byPair,
      aiAccuracy,
      factorCorrelation,
      allTimeStats:      allTime,
      summary: {
        wins, losses,
        winRate:  trades.length > 0 ? parseFloat((wins / trades.length * 100).toFixed(1)) : 0,
        netR:     parseFloat(netR.toFixed(2)),
        avgR:     trades.length > 0 ? parseFloat((netR / trades.length).toFixed(2)) : 0,
        bestTrade: trades.reduce((best, s) => parseFloat(s.pnl_r) > parseFloat(best?.pnl_r || -99) ? s : best, null),
        worstTrade: trades.reduce((worst, s) => parseFloat(s.pnl_r) < parseFloat(worst?.pnl_r || 99) ? s : worst, null),
      },
    };
  }

  // ── PATTERN ANALYSIS ───────────────────────────────────────────────────────
  _analyzePatterns(data) {
    const patterns = [];

    // ── Pattern 1: Best entry type this week ──
    const typeRanking = Object.entries(data.byType)
      .filter(([,v]) => v.count >= 2)
      .map(([type, v]) => ({
        type,
        winRate: v.count > 0 ? parseFloat((v.wins / v.count * 100).toFixed(1)) : 0,
        netR:    parseFloat(v.r.toFixed(2)),
        count:   v.count,
      }))
      .sort((a, b) => b.winRate - a.winRate);

    if (typeRanking.length > 0) {
      patterns.push({
        category: 'ENTRY_TYPE',
        finding:  `Best: ${typeRanking[0].type} (${typeRanking[0].winRate}% WR, ${typeRanking[0].count} trades)`,
        action:   typeRanking[0].winRate >= 70 ? 'INCREASE_PRIORITY' :
                  typeRanking[0].winRate < 45  ? 'REDUCE_PRIORITY'   : 'MAINTAIN',
        data:     typeRanking,
      });
    }

    // ── Pattern 2: Best session ──
    const sessionRanking = Object.entries(data.bySession)
      .filter(([,v]) => v.count >= 2)
      .map(([session, v]) => ({
        session,
        winRate: v.count > 0 ? parseFloat((v.wins / v.count * 100).toFixed(1)) : 0,
        netR:    parseFloat(v.r.toFixed(2)),
        count:   v.count,
      }))
      .sort((a, b) => b.winRate - a.winRate);

    if (sessionRanking.length > 0) {
      patterns.push({
        category: 'SESSION',
        finding:  `Best: ${sessionRanking[0].session} (${sessionRanking[0].winRate}% WR)`,
        action:   sessionRanking[sessionRanking.length-1]?.winRate < 40 ? 'AVOID_WEAK_SESSION' : 'MAINTAIN',
        data:     sessionRanking,
      });
    }

    // ── Pattern 3: Regime performance ──
    const regimeRanking = Object.entries(data.byRegime)
      .filter(([,v]) => v.count >= 2)
      .map(([regime, v]) => ({
        regime,
        winRate: v.count > 0 ? parseFloat((v.wins / v.count * 100).toFixed(1)) : 0,
        netR:    parseFloat(v.r.toFixed(2)),
        count:   v.count,
      }))
      .sort((a, b) => b.winRate - a.winRate);

    if (regimeRanking.length > 0) {
      patterns.push({
        category: 'REGIME',
        finding:  `Best: ${regimeRanking[0].regime} (${regimeRanking[0].winRate}% WR)`,
        action:   'WEIGHT_BY_REGIME',
        data:     regimeRanking,
      });
    }

    // ── Pattern 4: AI conviction accuracy ──
    if (data.aiAccuracy.sampleSize >= 5) {
      const accPct = parseFloat(data.aiAccuracy.accuracy.toFixed(1));
      patterns.push({
        category: 'AI_ACCURACY',
        finding:  `AI conviction aligned with outcome ${accPct}% of the time`,
        action:   accPct < 55 ? 'RECALIBRATE_AI_THRESHOLD' :
                  accPct > 75 ? 'AI_WELL_CALIBRATED'       : 'MONITOR',
        data:     data.aiAccuracy,
      });
    }

    // ── Pattern 5: Confluence factor that predicts wins most ──
    if (data.factorCorrelation.length > 0) {
      const topFactor = data.factorCorrelation[0];
      patterns.push({
        category: 'CONFLUENCE_FACTOR',
        finding:  `Strongest predictor: ${topFactor.factor} (${topFactor.winRateWhenPresent}% WR when present)`,
        action:   'WEIGHT_FACTOR',
        data:     data.factorCorrelation,
      });
    }

    return patterns;
  }

  // ── AI INSIGHTS ───────────────────────────────────────────────────────────
  async _getAIInsights(perfData, patterns) {
    if (this.ai.mockMode) {
      return [
        'Mock mode — set ANTHROPIC_API_KEY to enable real weekly AI analysis',
        'Real insights will identify non-obvious patterns from your trade history',
        'After 25+ trades, AI will find correlations you cannot see manually',
      ];
    }

    // Build concise input for AI — only numbers, no free text
    const input = {
      week_summary: {
        total_trades:  perfData.totalTrades,
        win_rate:      perfData.summary.winRate,
        net_r:         perfData.summary.netR,
        avg_r:         perfData.summary.avgR,
      },
      by_entry_type: Object.fromEntries(
        Object.entries(perfData.byType).map(([k,v]) => [k, {
          count:    v.count,
          win_rate: v.count > 0 ? parseFloat((v.wins/v.count*100).toFixed(1)) : 0,
          net_r:    parseFloat(v.r.toFixed(2)),
        }])
      ),
      by_session: Object.fromEntries(
        Object.entries(perfData.bySession).map(([k,v]) => [k, {
          count:    v.count,
          win_rate: v.count > 0 ? parseFloat((v.wins/v.count*100).toFixed(1)) : 0,
        }])
      ),
      by_regime: Object.fromEntries(
        Object.entries(perfData.byRegime).map(([k,v]) => [k, {
          count:    v.count,
          win_rate: v.count > 0 ? parseFloat((v.wins/v.count*100).toFixed(1)) : 0,
        }])
      ),
      ai_accuracy:        perfData.aiAccuracy,
      patterns_detected:  patterns.map(p => ({ category: p.category, finding: p.finding, action: p.action })),
    };

    try {
      const insights = await this.ai.weeklyReview(input);
      if (Array.isArray(insights)) return insights;
      if (insights?.insights) return insights.insights;
      return [JSON.stringify(insights)];
    } catch (err) {
      console.error('[Learning] AI insights error:', err.message);
      return ['AI analysis unavailable this week'];
    }
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────

  _calculateAIAccuracy(trades) {
    // High conviction (>75%) should correlate with wins
    // Low conviction (65-75%) may have more losses — that's expected
    const highConv = trades.filter(s => s.ai_conviction >= 75);
    if (highConv.length === 0) return { accuracy: 0, sampleSize: 0 };

    const highConvWins = highConv.filter(s => s.outcome === 'WIN').length;
    return {
      accuracy:         parseFloat((highConvWins / highConv.length * 100).toFixed(1)),
      sampleSize:       highConv.length,
      highConvWinRate:  parseFloat((highConvWins / highConv.length * 100).toFixed(1)),
      avgConviction:    parseFloat((highConv.reduce((a,s) => a + (s.ai_conviction||0), 0) / highConv.length).toFixed(1)),
    };
  }

  _factorCorrelation(trades) {
    const factors = ['htf_trend_aligned','key_level_present','volume_confirmed','rsi_momentum_aligned','candle_pattern_found','intermarket_aligned'];

    return factors.map(factor => {
      const withFactor    = trades.filter(s => s[factor] === true);
      const withoutFactor = trades.filter(s => s[factor] === false);
      const wrWith    = withFactor.length > 0    ? withFactor.filter(s => s.outcome==='WIN').length / withFactor.length * 100 : 0;
      const wrWithout = withoutFactor.length > 0 ? withoutFactor.filter(s => s.outcome==='WIN').length / withoutFactor.length * 100 : 0;

      return {
        factor,
        winRateWhenPresent: parseFloat(wrWith.toFixed(1)),
        winRateWhenAbsent:  parseFloat(wrWithout.toFixed(1)),
        liftFromFactor:     parseFloat((wrWith - wrWithout).toFixed(1)),
        sampleSize:         withFactor.length,
      };
    }).sort((a, b) => b.liftFromFactor - a.liftFromFactor);
  }

  // ── WEEKLY REPORT ─────────────────────────────────────────────────────────
  async _sendWeeklyReport(perfData, patterns, aiInsights) {
    if (!this.notifier) return;

    const s    = perfData.summary;
    const emoji = s.winRate >= 65 ? '🟢' : s.winRate >= 55 ? '🟡' : '🔴';
    const trend = s.netR > 0 ? '📈' : '📉';

    const topPattern = patterns[0];

    const msg = `📊 <b>APEX — WEEKLY LEARNING REPORT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
Week ${this._weekNumber()} · ${new Date().toDateString()}
━━━━━━━━━━━━━━━━━━━━━━━━━
${emoji} Win Rate   : ${s.winRate}%  (${s.wins}W / ${s.losses}L)
${trend} Net R      : ${s.netR > 0 ? '+' : ''}${s.netR}R
📐 Avg R/Trade : ${s.avgR > 0 ? '+' : ''}${s.avgR}R
📦 Trades      : ${s.wins + s.losses}
━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 <b>KEY PATTERN THIS WEEK:</b>
${topPattern ? topPattern.finding : 'Insufficient data'}
Action: ${topPattern ? topPattern.action : 'Collect more trades'}
━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 <b>AI INSIGHTS:</b>
${(aiInsights || []).slice(0, 3).map(i => `• ${i}`).join('\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━
<i>System is learning. More trades = sharper edge.</i>`;

    await this.notifier.send(msg, 'WEEKLY_REVIEW');
  }

  _weekNumber() {
    const d   = new Date();
    const jan = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d - jan) / 86400000 + jan.getDay() + 1) / 7);
  }
}

module.exports = LearningEngine;
