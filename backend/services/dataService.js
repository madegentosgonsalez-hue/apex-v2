// ═══════════════════════════════════════════════════════════════════════════
// DATA SERVICE — Market data fetching
// Works fully without API keys using realistic mock data
// Real data: Taapi.io (indicators) + 12Data (prices)
// ═══════════════════════════════════════════════════════════════════════════

const MOCK_BASE_PRICES = {
  EURUSD: 1.0847, XAUUSD: 2330.50, GBPUSD: 1.2634, USDJPY: 149.50,
  AUDUSD: 0.6521, USDCAD: 1.3612,  GBPJPY: 188.90, EURJPY: 162.10,
  NZDUSD: 0.6021, USDCHF: 0.9087,  BTCUSD: 67450,  ETHUSD: 3210,
  SOLUSD: 178.50, BNBUSD: 412.30,  XRPUSD: 0.5821, SPY: 528.50,
  NVDA: 875.20,   AAPL: 189.40,    ES1: 5280,       GC1: 2331,
  DXY: 104.20,
};

class DataService {
  constructor({ taapiKey, twelveDataKey } = {}) {
    this.taapiKey    = taapiKey;
    this.twelveKey   = twelveDataKey;
    this.taapiBase   = 'https://api.taapi.io';
    this.twelveBase  = 'https://api.twelvedata.com';
    this.cache       = new Map();
    this.cacheTTL    = 5 * 60 * 1000; // 5 min
    this.mockSeeds   = {}; // Stable mock seeds per symbol
  }

  // ── GET CANDLE DATA (indicators included) ─────────────────────────────────
  async getCandles(symbol, interval, size = 100) {
    const key = `${symbol}_${interval}_${size}`;
    const cached = this._getCache(key);
    if (cached) return cached;

    let data;
    try {
      if (this.taapiKey) {
        data = await this._taapiGet(symbol, interval, size);
      } else if (this.twelveKey) {
        data = await this._twelveGet(symbol, interval, size);
      } else {
        data = this._mockCandles(symbol, interval, size);
      }
    } catch (err) {
      console.warn(`[DataService] ${symbol} ${interval} fetch failed, using mock:`, err.message);
      data = this._mockCandles(symbol, interval, size);
    }

    this._setCache(key, data);
    return data;
  }

  // ── CURRENT TICK PRICE ────────────────────────────────────────────────────
  async getCurrentPrice(symbol) {
    try {
      if (this.twelveKey) {
        const r = await this._fetch(`${this.twelveBase}/price?symbol=${this._toTD(symbol)}&apikey=${this.twelveKey}`);
        return { price: parseFloat(r.price), source: '12data' };
      }
      // Simulate live price with small random walk
      const base = MOCK_BASE_PRICES[symbol] || 100;
      const drift = (Math.random() - 0.5) * base * 0.001;
      return { price: parseFloat((base + drift).toFixed(this._getDecimals(symbol))), source: 'mock' };
    } catch (err) {
      return { price: MOCK_BASE_PRICES[symbol] || 100, source: 'mock' };
    }
  }

  // ── INTERMARKET DATA ──────────────────────────────────────────────────────
  async getIntermarket(symbol) {
    try {
      const dxyData = await this.getCandles('DXY', '4h', 20);
      const dxyPrice = dxyData.closes[dxyData.closes.length - 1];
      const dxyEma21 = dxyData.ema21;
      const dxyTrend = dxyPrice > dxyEma21 ? 'UP' : 'DOWN';

      return {
        dxyTrend,
        dxyPrice,
        vix:          this._getMockVix(),
        btcDominance: this._getMockBtcDom(),
      };
    } catch (err) {
      return { dxyTrend: 'UNKNOWN', vix: null, btcDominance: null };
    }
  }

  // ── TAAPI.IO FETCH ────────────────────────────────────────────────────────
  async _taapiGet(symbol, interval, size) {
    const exchange  = this._getExchange(symbol);
    const taapiSym  = this._toTaapi(symbol);

    const body = {
      secret:    this.taapiKey,
      construct: {
        exchange,
        symbol:    taapiSym,
        interval,
        indicators: [
          { id: 'candles', indicator: 'candles',   results: size },
          { id: 'ema21',   indicator: 'ema',        optInTimePeriod: 21 },
          { id: 'ema50',   indicator: 'ema',        optInTimePeriod: 50 },
          { id: 'rsi14',   indicator: 'rsi',        optInTimePeriod: 14 },
          { id: 'atr14',   indicator: 'atr',        optInTimePeriod: 14 },
          { id: 'adx14',   indicator: 'adx',        optInTimePeriod: 14 },
        ],
      },
    };

    const r = await this._fetch(`${this.taapiBase}/bulk`, { method: 'POST', body: JSON.stringify(body) });
    return this._processTaapi(r, symbol);
  }

  _processTaapi(r, symbol) {
    const get = id => r.data?.find(d => d.id === id)?.result;
    const candles = (get('candles') || []).map(c => ({
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
    }));
    return this._buildCandleObj(candles, {
      ema21: parseFloat(get('ema21')?.value || 0),
      ema50: parseFloat(get('ema50')?.value || 0),
      rsi:   parseFloat(get('rsi14')?.value || 50),
      atr:   parseFloat(get('atr14')?.value || 0),
      adx:   parseFloat(get('adx14')?.adx   || 20),
    });
  }

  // ── 12DATA FETCH — 1 API call, all indicators computed locally ────────────
  async _twelveGet(symbol, interval, size) {
    const sym  = this._toTD(symbol);
    const intv = this._toTDInterval(interval);

    // Single time_series call — no 6-way parallel fan-out that hits rate limits
    const ts = await this._fetch(
      `${this.twelveBase}/time_series?symbol=${encodeURIComponent(sym)}&interval=${intv}&outputsize=${size}&apikey=${this.twelveKey}&format=JSON`
    );

    if (ts.status === 'error' || !Array.isArray(ts.values)) {
      throw new Error(ts.message || `Twelve Data: no values for ${symbol} ${interval}`);
    }

    // API returns newest-first; reverse to chronological order
    const candles = ts.values.slice().reverse().map(c => ({
      open:   parseFloat(c.open),
      high:   parseFloat(c.high),
      low:    parseFloat(c.low),
      close:  parseFloat(c.close),
      volume: parseFloat(c.volume || 0),
    }));

    // Compute all indicators locally — no extra API calls needed
    const closes   = candles.map(c => c.close);
    const ema21Arr = this._ema(closes, 21);
    const ema50Arr = this._ema(closes, 50);
    const rsiArr   = this._rsi(closes, 14);
    const atrArr   = this._atr(candles, 14);

    return this._buildCandleObj(candles, {
      ema21: ema21Arr[ema21Arr.length - 1],
      ema50: ema50Arr[ema50Arr.length - 1],
      rsi:   rsiArr[rsiArr.length - 1],
      atr:   atrArr[atrArr.length - 1],
      adx:   this._adx(candles, 14),
    });
  }

  _adx(candles, period = 14) {
    if (candles.length < period + 1) return 20;
    let pdm = 0, mdm = 0, tr = 0;
    const sl = candles.slice(-(period + 1));
    for (let i = 1; i < sl.length; i++) {
      const up = sl[i].high - sl[i - 1].high;
      const dn = sl[i - 1].low  - sl[i].low;
      if (up > dn && up > 0) pdm += up;
      if (dn > up && dn > 0) mdm += dn;
      const h = sl[i].high, lo = sl[i].low, pc = sl[i - 1].close;
      tr += Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc));
    }
    if (!tr) return 20;
    const pdi = (pdm / tr) * 100, mdi = (mdm / tr) * 100;
    return Math.abs(pdi - mdi) / (pdi + mdi + 1e-9) * 100;
  }

  // ── MOCK CANDLE GENERATOR ─────────────────────────────────────────────────
  // Generates realistic price action with trends, structure, OBs, FVGs
  _mockCandles(symbol, interval, size) {
    const base   = MOCK_BASE_PRICES[symbol] || 100;
    const vol    = base * this._getVolatility(interval);
    const candles = [];
    let price = base * (0.985 + Math.random() * 0.03);

    // Create a realistic trend (not pure random)
    const trend = Math.random() > 0.5 ? 1 : -1;
    const trendStrength = 0.0003;

    for (let i = 0; i < size; i++) {
      const trendBias = trend * trendStrength * base;
      const noise = (Math.random() - 0.48) * vol;
      const open = price;
      const close = price + noise + trendBias;
      const body = Math.abs(close - open);
      const wick = body * (0.3 + Math.random() * 0.8);
      const high = Math.max(open, close) + wick * Math.random();
      const low  = Math.min(open, close) - wick * Math.random();
      const volume = 500 + Math.random() * 8000;

      candles.push({ open, high, low, close, volume });
      price = close;
    }

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    // Calculate indicators from raw data
    const ema21 = this._ema(closes, 21);
    const ema50 = this._ema(closes, 50);
    const rsiVal = this._rsi(closes, 14);
    const atrVal = this._atr(candles, 14);
    const adxVal = 15 + Math.random() * 25; // 15-40 range

    return this._buildCandleObj(candles, {
      ema21: ema21[ema21.length - 1],
      ema50: ema50[ema50.length - 1],
      rsi:   rsiVal[rsiVal.length - 1],
      atr:   atrVal[atrVal.length - 1],
      adx:   adxVal,
    });
  }

  _buildCandleObj(candles, indicators) {
    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    return {
      candles, closes, highs, lows, volumes,
      ema21:      indicators.ema21,
      ema50:      indicators.ema50,
      rsi:        indicators.rsi,
      atr:        indicators.atr,
      adx:        indicators.adx,
      swingHighs: this._swingPoints(highs, 'HIGH'),
      swingLows:  this._swingPoints(lows,  'LOW'),
      poc:        null,
    };
  }

  // ── INDICATOR CALCULATORS ─────────────────────────────────────────────────
  _ema(closes, period) {
    if (closes.length < period) return closes.map(() => closes[0]);
    const k = 2 / (period + 1);
    const result = [closes[0]];
    for (let i = 1; i < closes.length; i++) {
      result.push(closes[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }

  _rsi(closes, period = 14) {
    if (closes.length < period + 1) return closes.map(() => 50);
    const result = new Array(period).fill(50);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) avgGain += diff; else avgLoss -= diff;
    }
    avgGain /= period; avgLoss /= period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
      result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return result;
  }

  _atr(candles, period = 14) {
    const trs = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const prev = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    });
    const result = new Array(period - 1).fill(trs[0]);
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(atr);
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      result.push(atr);
    }
    return result;
  }

  _swingPoints(values, type, lookback = 3) {
    const pts = [];
    for (let i = lookback; i < values.length - lookback; i++) {
      const window = values.slice(i - lookback, i + lookback + 1);
      if (type === 'HIGH' && values[i] === Math.max(...window)) pts.push(values[i]);
      if (type === 'LOW'  && values[i] === Math.min(...window)) pts.push(values[i]);
    }
    return pts;
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  _getMockVix()    { return 12 + Math.random() * 15; }
  _getMockBtcDom() { return 48 + Math.random() * 10; }

  _getVolatility(interval) {
    const map = { '1W': 0.02, '1D': 0.01, '4h': 0.005, '2h': 0.003, '1h': 0.002, '30m': 0.0015, '15m': 0.001 };
    return map[interval] || 0.002;
  }

  _getDecimals(symbol) {
    if (symbol === 'XAUUSD' || symbol === 'GC1') return 2;
    if (symbol?.includes('JPY')) return 3;
    if (['BTCUSD','ETHUSD'].includes(symbol)) return 2;
    return 5;
  }

  _getExchange(symbol) {
    if (['BTCUSD','ETHUSD','SOLUSD','BNBUSD','XRPUSD'].includes(symbol)) return 'binance';
    if (['SPY','NVDA','AAPL'].includes(symbol)) return 'stocks';
    return 'forex';
  }

  _toTaapi(symbol) {
    const map = { XAUUSD: 'XAU/USD', BTCUSD: 'BTC/USDT', ETHUSD: 'ETH/USDT',
                  SOLUSD: 'SOL/USDT', BNBUSD: 'BNB/USDT', XRPUSD: 'XRP/USDT' };
    return map[symbol] || (symbol.length === 6 ? `${symbol.slice(0,3)}/${symbol.slice(3)}` : symbol);
  }

  _toTD(symbol) {
    const map = { XAUUSD: 'XAU/USD', BTCUSD: 'BTC/USD', ETHUSD: 'ETH/USD' };
    return map[symbol] || symbol;
  }

  _toTDInterval(interval) {
    const map = { '1W': '1week', '1D': '1day', '4h': '4h', '2h': '2h', '1h': '1h', '30m': '30min', '15m': '15min' };
    return map[interval] || interval;
  }

  async _fetch(url, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
  }

  _getCache(key) {
    const entry = this.cache.get(key);
    if (!entry || Date.now() - entry.ts > this.cacheTTL) { this.cache.delete(key); return null; }
    return entry.data;
  }

  _setCache(key, data) { this.cache.set(key, { data, ts: Date.now() }); }
}

module.exports = DataService;
