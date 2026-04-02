// src/monitor.js — Core monitoring engine (Singleton)
//
// 买入策略：收录即买
//   webhook 收到代币 → 查 FDV + LP → $15,000 ≤ FDV ≤ $60,000 且 LP ≥ $5,000 → 立即用 0.5 SOL 买入
//   条件不满足 → 静默拒绝，不再跟踪
//
// 出场策略（纯 EMA 死叉）：
//   1. EMA死叉   EMA9 < EMA20 立即卖出（15秒K线，1秒轮询）
//   2. 监控到期  30分钟后清仓退出
//
// 已删除：硬止损、浮动止盈、分批止盈

'use strict';

const birdeye                          = require('./birdeye');
const { evaluateSignal, buildCandles, EMA_SLOW, WARMUP_CANDLES } = require('./ema');
const trader                           = require('./trader');
const { broadcastToClients }           = require('./wsHub');
const logger                           = require('./logger');

const PRICE_POLL_SEC     = parseInt(process.env.PRICE_POLL_SEC        || '1');   // 1秒价格轮询
const KLINE_INTERVAL_SEC = parseInt(process.env.KLINE_INTERVAL_SEC    || '15');  // 15秒K线
const TOKEN_MAX_AGE_MIN  = parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '30');  // 30分钟监控期
const FDV_MIN_USD        = parseInt(process.env.FDV_MIN_USD           || '15000');
const FDV_MAX_USD        = parseInt(process.env.FDV_MAX_USD           || '60000');
const LP_MIN_USD         = parseInt(process.env.LP_MIN_USD            || '5000');
const MAX_TICKS_HISTORY  = 60 * 60 * 1;  // 1h × 60 ticks/min (1s poll) = 3600 ticks max

class TokenMonitor {
  static instance = null;
  static getInstance() {
    if (!TokenMonitor.instance) TokenMonitor.instance = new TokenMonitor();
    return TokenMonitor.instance;
  }

  constructor() {
    this.tokens      = new Map();   // Map<address, TokenState>
    this.tradeLog    = [];          // last 200 trade entries (实时feed)
    this.tradeRecords = [];         // 24h完整交易记录（用于统计dashboard）
    this._pollTimer  = null;
    this._metaTimer  = null;
    this._ageTimer   = null;
    this._dashTimer  = null;
  }

  // ── Add token to whitelist ──────────────────────────────────
  async addToken({ address, symbol, network = 'solana', xMentions, holders, top10Pct, devPct }) {
    if (this.tokens.has(address)) {
      logger.info(`[Monitor] Already in whitelist: ${symbol} (${address.slice(0, 8)})`);
      return { ok: false, reason: 'already_exists' };
    }

    const state = {
      address,
      symbol:       symbol || address.slice(0, 8),
      network,
      addedAt:      Date.now(),
      ticks:        [],
      candles:      [],
      currentPrice: null,
      ema9:         NaN,
      ema20:        NaN,
      lastSignal:   null,
      fdv:          null,
      lp:           null,
      age:          null,
      // 扫描服务器发来的额外数据
      xMentions:    xMentions ?? null,
      holders:      holders   ?? null,
      top10Pct:     top10Pct  ?? null,
      devPct:       devPct    ?? null,
      // Position tracking (null = no open position)
      position:     null,
      pnlPct:       null,
      // EMA warmup tracking
      _candlesSinceBuy: 0,
      _lastCandleCount: 0,
      // Lifecycle flags
      bought:       false,
      exitSent:     false,
      inPosition:   false,
    };

    this.tokens.set(address, state);
    logger.info(`[Monitor] ✅ Added: ${state.symbol} (${address})`);

    await this._fetchMetaAndBuy(state);

    broadcastToClients({ type: 'token_added', data: this._stateView(state) });
    return { ok: true };
  }

  // ── Meta fetch + FDV gate + 立即买入 ────────────────────────
  async _fetchMetaAndBuy(state) {
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (overview) {
        state.fdv    = overview.fdv ?? overview.mc ?? null;
        state.lp     = overview.liquidity ?? null;
        state.symbol = overview.symbol || state.symbol;
        const created = overview.createdAt || overview.created_at || null;
        if (created) {
          state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
        }
      }
    } catch (e) {
      logger.warn(`[Monitor] meta fetch error ${state.symbol}: ${e.message}`);
    }

    // FDV 门槛检查（下限 + 上限）
    if (state.fdv === null || state.fdv < FDV_MIN_USD) {
      const reason = state.fdv === null
        ? 'FDV_UNKNOWN'
        : `FDV_TOO_LOW($${state.fdv}<$${FDV_MIN_USD})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${reason}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, reason), 1000);
      return;
    }

    if (state.fdv > FDV_MAX_USD) {
      const reason = `FDV_TOO_HIGH($${state.fdv}>$${FDV_MAX_USD})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${reason}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, reason), 1000);
      return;
    }

    // LP 门槛检查
    if (state.lp === null || state.lp < LP_MIN_USD) {
      const reason = state.lp === null
        ? 'LP_UNKNOWN'
        : `LP_TOO_LOW($${state.lp}<$${LP_MIN_USD})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${reason}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, reason), 1000);
      return;
    }

    // FDV + LP 均合格 → 立即买入
    logger.warn(`[Monitor] ✅ ${state.symbol} FDV=$${state.fdv?.toLocaleString()} LP=$${state.lp?.toLocaleString()} — 立即买入`);
    const pos = await trader.buy(state);
    if (pos) {
      state.position   = pos;
      state.inPosition = true;
      state.bought     = true;
      state.lastSignal = 'BUY';

      // ── 种子K线：用买入价回填历史K线，让EMA立即可用 ──────────
      // EMA20 需要 21 根K线才能计算。买入时用 entryPrice 填充前 EMA_SLOW+WARMUP 根K线，
      // 这样第一根真实K线收盘后就能开始死叉判断，不用再等5分钟。
      // 种子K线全部相同价格 → EMA9 = EMA20 = entryPrice，不会误触发
      const seedPrice = pos.entryPriceUsd;
      const seedCount = EMA_SLOW + WARMUP_CANDLES + 2;  // 多填几根确保充足
      const now = Date.now();
      for (let i = seedCount; i >= 1; i--) {
        state.ticks.push({
          time:  now - i * KLINE_INTERVAL_SEC * 1000,
          price: seedPrice,
        });
      }
      // 预热计数器直接跳过预热期（种子K线已经提供了足够的历史）
      state._candlesSinceBuy = WARMUP_CANDLES;
      state._lastCandleCount = 0;
      logger.info(`[Monitor] 🌱 Seeded ${seedCount} ticks @ ${seedPrice} for ${state.symbol} — EMA ready immediately`);

      this._addTradeLog({ type: 'BUY', symbol: state.symbol, reason: 'WHITELIST_IMMEDIATE' });

      // 创建24h交易记录
      this._createTradeRecord(state, pos);
    } else {
      // 买入失败（Jupiter 错误等）→ 不监控，移除
      logger.warn(`[Monitor] ⚠️  ${state.symbol} 买入失败，移除白名单`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, 'BUY_FAILED'), 1000);
    }
  }

  // ── Meta refresh every 30s: check FDV drop ───────────────────
  async _fetchMeta(state) {
    if (state.exitSent) return;
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (!overview) return;

      state.fdv    = overview.fdv ?? overview.mc ?? null;
      state.lp     = overview.liquidity ?? null;
      state.symbol = overview.symbol || state.symbol;
      const created = overview.createdAt || overview.created_at || null;
      if (created) {
        state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
      }
    } catch (e) {
      logger.warn(`[Monitor] meta refresh error ${state.symbol}: ${e.message}`);
    }
  }

  // ── Start all timers ──────────────────────────────────────────
  start() {
    logger.info(
      `[Monitor] Starting — poll ${PRICE_POLL_SEC}s | kline ${KLINE_INTERVAL_SEC}s` +
      ` | FDV_MIN $${FDV_MIN_USD} | FDV_MAX $${FDV_MAX_USD} | max_age ${TOKEN_MAX_AGE_MIN}min`
    );
    // 价格轮询 + EMA评估合并为同一个定时器（每5秒）
    this._pollTimer  = setInterval(() => this._pollAndEvaluate(), PRICE_POLL_SEC * 1000);
    this._metaTimer  = setInterval(async () => {
      for (const s of this.tokens.values()) {
        await this._fetchMeta(s);
        await sleep(100);
      }
    }, 30_000);
    this._ageTimer  = setInterval(() => this._checkAgeExpiry(), 15_000);
    this._dashTimer = setInterval(() => {
      broadcastToClients({ type: 'update', data: this.getDashboardData() });
    }, 5000);
    // 每15分钟刷新交易记录里的 currentFdv
    this._fdvTimer  = setInterval(() => this._refreshTradeRecordFdv(), 15 * 60 * 1000);
  }

  stop() {
    [this._pollTimer, this._metaTimer, this._ageTimer, this._dashTimer, this._fdvTimer]
      .forEach(t => t && clearInterval(t));
    logger.info('[Monitor] Stopped');
  }

  // ── 价格轮询 + EMA死叉评估 每 PRICE_POLL_SEC (1s) ──────────
  //
  // 每1秒拉一次价格，聚合成15秒K线，检查 EMA9 < EMA20 死叉
  // 已删除：硬止损、浮动止盈、分批止盈（全部由 EMA 死叉统一处理）
  async _pollAndEvaluate() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent || !state.bought) continue;

      const price = await birdeye.getPrice(addr);
      if (price !== null && price > 0) {
        state.currentPrice = price;
        state.ticks.push({ time: Date.now(), price });
        if (state.ticks.length > MAX_TICKS_HISTORY) {
          state.ticks.splice(0, state.ticks.length - MAX_TICKS_HISTORY);
        }

        // 更新 PnL 显示
        if (state.inPosition && state.position && state.position.entryPriceUsd) {
          const pnlPct = (price - state.position.entryPriceUsd) / state.position.entryPriceUsd * 100;
          state.pnlPct = pnlPct.toFixed(2);
        }

        // 更新 dashboard 显示用的峰值
        if (state.position && price > (state.position.peakPriceUsd ?? 0)) {
          state.position.peakPriceUsd = price;
        }

        // ── EMA 死叉评估 ──────────────────────────────────────
        if (state.inPosition && state.ticks.length >= 2) {
          // 用全部K线（含当前未收盘的），实时反应价格变动
          state.candles = buildCandles(state.ticks, KLINE_INTERVAL_SEC);

          // 追踪买入后经过了多少根K线（用于预热保护）
          const currentCandleCount = state.candles.length;
          if (currentCandleCount > state._lastCandleCount) {
            state._candlesSinceBuy += (currentCandleCount - state._lastCandleCount);
            state._lastCandleCount = currentCandleCount;
          }

          const result = evaluateSignal(state.candles, state);
          state.ema9   = result.ema9;
          state.ema20  = result.ema20;

          // 调试日志：每次评估都打印
          if (!isNaN(result.ema9) && !isNaN(result.ema20)) {
            const gap = ((result.ema9 - result.ema20) / result.ema20 * 100).toFixed(3);
            logger.info(
              `[EMA] ${state.symbol}` +
              ` | candles=${currentCandleCount}` +
              ` | warmup=${state._candlesSinceBuy}` +
              ` | EMA9=${result.ema9.toExponential(4)}` +
              ` | EMA20=${result.ema20.toExponential(4)}` +
              ` | gap=${gap}%` +
              ` | signal=${result.signal || 'HOLD'}` +
              ` | ${result.reason}`
            );
          } else {
            logger.info(`[EMA] ${state.symbol} | ${result.reason}`);
          }

          if (result.signal === 'SELL') {
            logger.warn(`[Strategy] ⚡ EMA死叉 SELL ${state.symbol} — ${result.reason}`);
            await this._doExit(state, result.reason);
          }
        }
      }

      await sleep(10);  // 10ms 间隔错开 Birdeye 请求
    }
  }

  // ── Full exit helper ──────────────────────────────────────────
  async _doExit(state, reason) {
    await trader.exitPosition(state, reason);
    state.inPosition = false;
    state.position   = null;
    state.lastSignal = 'SELL';
    state.exitSent   = true;
    this._addTradeLog({ type: 'SELL', symbol: state.symbol, reason });
    this._finalizeTradeRecord(state, reason);
    setTimeout(() => this._removeToken(state.address, reason), 5000);
  }

  // ── Age expiry check every 15s ────────────────────────────────
  async _checkAgeExpiry() {
    const maxMin = TOKEN_MAX_AGE_MIN;
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;

      const ageMin = (Date.now() - state.addedAt) / 60000;

      if (ageMin < maxMin) continue;

      state.exitSent = true;

      if (state.inPosition && state.position) {
        logger.info(`[Monitor] ⏰ Age expiry SELL: ${state.symbol} (${ageMin.toFixed(1)}min)`);
        await trader.exitPosition(state, `AGE_EXPIRY_${maxMin}min`);
        state.inPosition = false;
        state.position   = null;
        this._addTradeLog({ type: 'SELL', symbol: state.symbol, reason: 'AGE_EXPIRY' });
        this._finalizeTradeRecord(state, 'AGE_EXPIRY');
        setTimeout(() => this._removeToken(addr, 'AGE_EXPIRY'), 5000);
      } else {
        logger.info(`[Monitor] ⏰ Age expiry (no position): ${state.symbol}`);
        this._removeToken(addr, 'AGE_EXPIRY_NO_POSITION');
      }
    }
  }

  _removeToken(addr, reason) {
    const state = this.tokens.get(addr);
    if (state) {
      logger.info(`[Monitor] 🗑  Removed ${state.symbol} — ${reason}`);
      this.tokens.delete(addr);
      broadcastToClients({ type: 'token_removed', data: { address: addr, reason } });
    }
  }

  // ── 24h 交易记录 ──────────────────────────────────────────────
  _createTradeRecord(state, pos) {
    const rec = {
      id:          state.address,
      address:     state.address,
      symbol:      state.symbol,
      buyAt:       Date.now(),
      // 买入时的链上数据
      entryFdv:    state.fdv,
      entryLp:     state.lp,
      entryLpFdv:  state.fdv ? +((state.lp / state.fdv) * 100).toFixed(1) : null,
      // 扫描服务器发来的数据
      xMentions:   state.xMentions,
      holders:     state.holders,
      top10Pct:    state.top10Pct,
      devPct:      state.devPct,
      // 买入信息
      solSpent:    pos.solSpent,
      entryPrice:  pos.entryPriceUsd,
      // 退出信息（待填）
      exitAt:      null,
      exitReason:  null,
      exitFdv:     null,
      solReceived: null,
      pnlPct:      null,
      // 当前FDV（15分钟更新）
      currentFdv:  state.fdv,
      fdvUpdatedAt: Date.now(),
    };
    this.tradeRecords.unshift(rec);
    // 只保留 24h 内的记录
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.tradeRecords = this.tradeRecords.filter(r => r.buyAt > cutoff);
  }

  _finalizeTradeRecord(state, reason) {
    const rec = this.tradeRecords.find(r => r.id === state.address);
    if (!rec) return;
    rec.exitAt     = Date.now();
    rec.exitReason = reason;
    rec.exitFdv    = state.fdv;
    rec.pnlPct     = state.pnlPct;
    // 用 pnlPct 和买入SOL反推卖出SOL
    if (state.pnlPct != null && rec.solSpent) {
      const pnl = parseFloat(state.pnlPct) / 100;
      rec.solReceived = +(rec.solSpent * (1 + pnl)).toFixed(4);
    }
  }

  // 每15分钟更新一次 currentFdv
  async _refreshTradeRecordFdv() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.tradeRecords = this.tradeRecords.filter(r => r.buyAt > cutoff);
    for (const rec of this.tradeRecords) {
      try {
        const overview = await birdeye.getTokenOverview(rec.address);
        if (overview) {
          rec.currentFdv   = overview.fdv ?? overview.mc ?? rec.currentFdv;
          rec.fdvUpdatedAt = Date.now();
        }
      } catch (_) {}
      await sleep(200);
    }
  }

  getTradeRecords() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.tradeRecords.filter(r => r.buyAt > cutoff);
  }

  _addTradeLog(entry) {
    const log = { id: Date.now(), time: new Date().toISOString(), ...entry };
    this.tradeLog.unshift(log);
    if (this.tradeLog.length > 200) this.tradeLog.length = 200;
    broadcastToClients({ type: 'trade_log', data: log });
  }

  _stateView(s) {
    const pos = s.position;
    return {
      address:       s.address,
      symbol:        s.symbol,
      age:           s.age,
      lp:            s.lp,
      fdv:           s.fdv,
      currentPrice:  s.currentPrice,
      entryPrice:    pos?.entryPriceUsd ?? null,
      peakPrice:     pos?.peakPriceUsd  ?? null,
      tokenBalance:  pos?.tokenBalance  ?? 0,
      pnlPct:        s.pnlPct,
      ema9:          isNaN(s.ema9)  ? null : +s.ema9.toFixed(10),
      ema20:         isNaN(s.ema20) ? null : +s.ema20.toFixed(10),
      lastSignal:    s.lastSignal,
      candleCount:   s.candles.length,
      tickCount:     s.ticks.length,
      addedAt:       s.addedAt,
      bought:        s.bought,
      exitSent:      s.exitSent,
      inPosition:    s.inPosition,
      recentCandles: s.candles.slice(-60),
    };
  }

  getDashboardData() {
    return {
      tokens:     [...this.tokens.values()].map(s => this._stateView(s)),
      tradeLog:   this.tradeLog.slice(0, 100),
      uptime:     process.uptime(),
      tokenCount: this.tokens.size,
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { TokenMonitor };
