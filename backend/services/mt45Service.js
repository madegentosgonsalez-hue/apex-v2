'use strict';
// MT4/MT5 integration via MetaApi.cloud
// MetaApi provides a unified REST+WebSocket API for both MT4 and MT5.
//
// Setup:
// 1. Create account at metaapi.cloud (free tier works)
// 2. Add your MT4/MT5 broker account in MetaApi dashboard
// 3. Copy your MetaApi token + the account ID MetaApi assigns
// 4. Set META_API_TOKEN and META_API_ACCOUNT_ID in .env

let MetaApi;
try { MetaApi = require('metaapi.cloud-sdk'); } catch { MetaApi = null; }

class MT45Service {
  constructor() {
    this.token     = process.env.META_API_TOKEN;
    this.accountId = process.env.META_API_ACCOUNT_ID;
    this.platform  = process.env.MT_PLATFORM || 'mt5'; // 'mt4' or 'mt5'
    this.api       = null;
    this.account   = null;
    this.connection = null;
    this.connected = false;
  }

  async connect() {
    if (!this.token || !this.accountId) {
      console.warn('[MT45] No META_API_TOKEN or META_API_ACCOUNT_ID set — skipping connection');
      return false;
    }
    if (!MetaApi) {
      console.warn('[MT45] metaapi.cloud-sdk not installed — run: npm install metaapi.cloud-sdk');
      return false;
    }

    try {
      this.api     = new MetaApi.default(this.token);
      this.account = await this.api.metatraderAccountApi.getAccount(this.accountId);

      if (this.account.state !== 'DEPLOYED') {
        await this.account.deploy();
        await this.account.waitDeployed(120000);
      }
      await this.account.waitConnected(120000);

      this.connection = this.account.getRPCConnection();
      await this.connection.connect();
      await this.connection.waitSynchronized({ timeoutInSeconds: 120 });

      this.connected = true;
      console.log(`[MT45] Connected — ${this.platform.toUpperCase()} account ${this.accountId}`);
      return true;
    } catch (err) {
      this.connected = false;
      console.error('[MT45] Connect failed:', err.message);
      return false;
    }
  }

  isConnected() { return this.connected && !!this.connection; }

  // Place market order
  // Position size: (accountBalance × riskPercent%) / (entryPrice - slPrice)
  async placeOrder(symbol, direction, entryPrice, slPrice, tp1Price, tp2Price, riskPercent) {
    this._requireConnection();

    const info    = await this.connection.getAccountInformation();
    const balance = info.balance;
    const risk    = Math.abs(entryPrice - slPrice);
    const size    = parseFloat(((balance * (riskPercent / 100)) / risk).toFixed(2));

    const order = direction === 'BUY'
      ? await this.connection.createMarketBuyOrder(symbol, size, slPrice, tp1Price, { comment: 'APEX-V2' })
      : await this.connection.createMarketSellOrder(symbol, size, slPrice, tp1Price, { comment: 'APEX-V2' });

    this.connected = true;
    return {
      orderId:       order.orderId,
      executedPrice: order.openPrice || entryPrice,
      size,
    };
  }

  async getOpenPositions() {
    if (!this.isConnected()) return [];
    try {
      return await this.connection.getPositions();
    } catch (err) {
      console.error('[MT45] getOpenPositions failed:', err.message);
      return [];
    }
  }

  // percent: 100 = full close, 40 = partial
  async closePosition(positionId, percent = 100) {
    this._requireConnection();
    if (percent >= 100) {
      return this.connection.closePosition(positionId, { comment: 'APEX-V2 close' });
    }
    // Partial close — fetch position volume first
    const positions = await this.getOpenPositions();
    const pos = positions.find(p => p.id === positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);
    const closeVolume = parseFloat((pos.volume * (percent / 100)).toFixed(2));
    return this.connection.closePositionPartially(positionId, closeVolume, { comment: 'APEX-V2 partial' });
  }

  async updateStopLoss(positionId, newSlPrice) {
    this._requireConnection();
    const positions = await this.getOpenPositions();
    const pos = positions.find(p => p.id === positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);
    return this.connection.modifyPosition(positionId, newSlPrice, pos.takeProfit);
  }

  async getBalance() {
    if (!this.isConnected()) return null;
    try {
      const info = await this.connection.getAccountInformation();
      return {
        balance: info.balance,
        equity:  info.equity,
        pnl:     info.equity - info.balance,
      };
    } catch (err) {
      console.error('[MT45] getBalance failed:', err.message);
      return null;
    }
  }

  async reconnect() {
    this.connected = false;
    if (this.connection) {
      try { await this.connection.close(); } catch {}
      this.connection = null;
    }
    return this.connect();
  }

  _requireConnection() {
    if (!this.isConnected()) throw new Error('MT45 not connected');
  }
}

module.exports = MT45Service;
