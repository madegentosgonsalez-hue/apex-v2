'use strict';

function parseUtc(value) {
  if (!value) return null;
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  return new Date(`${normalized}Z`);
}

function simulatePortfolio(results, options = {}) {
  const {
    startingBalance = 1000,
    maxConcurrentTrades = 5,
    maxEntriesPerPair = 2,
    executionDragR = 0,
  } = options;

  const tierRiskPct = { SILVER: 0.5, GOLD: 0.75, DIAMOND: 1.0 };
  const trades = results.flatMap((row) =>
    (row.tradeLog || []).map((trade, index) => ({
      id: `${row.symbol}-${index}`,
      symbol: row.symbol,
      date: trade.date,
      exitTime: trade.exitTime,
      entryAt: parseUtc(trade.date),
      exitAt: parseUtc(trade.exitTime),
      tier: trade.tier,
      pnlR: Number(trade.pnlR || 0),
      outcome: trade.outcome,
      session: trade.session,
      entryType: trade.entryType,
      direction: trade.direction,
    }))
  )
    .filter((trade) => trade.entryAt && trade.exitAt && trade.exitAt >= trade.entryAt)
    .sort((a, b) => a.entryAt - b.entryAt || a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol));

  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdownPct = 0;
  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  const timeline = [];
  const skipped = [];
  const openTrades = [];

  for (const trade of trades) {
    while (openTrades.length && openTrades[0].exitAt <= trade.entryAt) openTrades.shift();

    const openForPair = openTrades.filter((row) => row.symbol === trade.symbol).length;
    if (openTrades.length >= maxConcurrentTrades) {
      skipped.push({ symbol: trade.symbol, date: trade.date, tier: trade.tier, reason: `max ${maxConcurrentTrades} open trades` });
      continue;
    }
    if (openForPair >= maxEntriesPerPair) {
      skipped.push({ symbol: trade.symbol, date: trade.date, tier: trade.tier, reason: `max ${maxEntriesPerPair} entries for ${trade.symbol}` });
      continue;
    }

    const riskPct = tierRiskPct[trade.tier] || 0;
    const riskAmount = balance * (riskPct / 100);
    const effectiveR = Number((trade.pnlR - executionDragR).toFixed(2));
    const pnl = riskAmount * effectiveR;
    balance += pnl;

    if (trade.outcome === 'WIN') wins++;
    else if (trade.outcome === 'LOSS') losses++;
    else breakevens++;

    if (balance > peak) peak = balance;
    const drawdownPct = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;

    timeline.push({
      ...trade,
      riskPct,
      riskAmount: Number(riskAmount.toFixed(2)),
      effectiveR,
      pnl: Number(pnl.toFixed(2)),
      balance: Number(balance.toFixed(2)),
      concurrentOpenBefore: openTrades.length,
      drawdownPct: Number(drawdownPct.toFixed(2)),
    });

    openTrades.push({ symbol: trade.symbol, exitAt: trade.exitAt });
    openTrades.sort((a, b) => a.exitAt - b.exitAt);
  }

  return {
    startingBalance,
    endingBalance: Number(balance.toFixed(2)),
    netProfit: Number((balance - startingBalance).toFixed(2)),
    totalReturnPct: Number((((balance / startingBalance) - 1) * 100).toFixed(2)),
    tradesTaken: timeline.length,
    tradesSkipped: skipped.length,
    wins,
    losses,
    breakevens,
    winRate: timeline.length ? Number((wins / timeline.length * 100).toFixed(1)) : 0,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    maxConcurrentTrades,
    maxEntriesPerPair,
    executionDragR,
    timeline,
    skipped,
  };
}

module.exports = { simulatePortfolio };
