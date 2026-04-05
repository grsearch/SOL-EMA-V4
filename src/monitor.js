// src/monitor.js — Core monitoring engine (Singleton)
//
// 买入策略：收录即买
//   webhook 收到代币 → 查 FDV + LP → $15,000 ≤ FDV ≤ $60,000 且 LP ≥ $5,000 → 立即用 0.5 SOL 买入
//   条件不满足 → 静默拒绝，不再跟踪
//
// 出场策略（沿用 PUMP-EMA-15S 实战验证逻辑）：
//   1. EMA死叉   EMA9 < EMA20 且 EMA20 斜率向下，连续2次确认后卖出
//                （15秒K线，1秒轮询，自然预热约5分钟）
//   2. FDV止损   FDV 跌破 $15,000 立即清仓（不等EMA预热，30秒检查一次）
//   3. 监控到期  30分钟后清仓退出
//
// 已删除：硬止损、浮动止盈、分批止盈

'use strict';

const birdeye                          = require('./birdeye');
const { evaluateSignal, buildCandles } = require('./ema');
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

// ── RUG 检测参数 ──────────────────────────────────────────────
// 信号①：连续卖单 ≥ N笔 + 总金额 ≥ $X + Gas一致，三个条件同时满足才触发
const RUG_COORDINATED_MIN_SELLS     = parseInt(process.env.RUG_COORDINATED_MIN_SELLS      || '6');   // 连续卖单数
const RUG_COORDINATED_MIN_TOTAL_USD = parseFloat(process.env.RUG_COORDINATED_MIN_TOTAL_USD || '300'); // 总金额门槛
const RUG_GAS_DIFF_THRESHOLD        = parseFloat(process.env.RUG_GAS_DIFF_THRESHOLD        || '0.01'); // Gas一致性阈值
// 信号④ 买盘消失：连续N笔全卖单，或买单金额全部低于阈值
const RUG_NO_BUY_SELL_COUNT     = parseInt(process.env.RUG_NO_BUY_SELL_COUNT    || '10');
const RUG_NO_BUY_MIN_USD        = parseFloat(process.env.RUG_NO_BUY_MIN_USD     || '0');  // 默认0=禁用，误触发率高
// 方案B触发参数：
//   价格1秒内下跌超过此阈值 → 立即触发RUG检测
//   兜底轮询间隔：即使没有价格异动，每N秒也检测一次
const RUG_PRICE_DROP_TRIGGER_PCT = parseFloat(process.env.RUG_PRICE_DROP_TRIGGER_PCT || '5');  // 5%
const RUG_FALLBACK_INTERVAL_SEC  = parseInt(process.env.RUG_FALLBACK_INTERVAL_SEC    || '1');  // 1秒兜底

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
      // EMA state（bearishCount 由 evaluateSignal 直接读写）
      bearishCount: 0,
      // Lifecycle flags
      bought:       false,
      exitSent:     false,
      inPosition:   false,
      // RUG检测状态
      lastRugCheck:    0,      // 上次调用 getTrades 的时间戳
      lastPriceForRug: null,   // 上一tick价格，用于计算1秒内跌幅
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

      // 不使用种子K线。EMA20 需要 21 根 15秒K线（约5分钟）自然积累后才有效值。
      // 预热期内 evaluateSignal 返回 warming_up，不会触发任何卖出信号。
      // 这是 PUMP-EMA-15S 经过实战验证的方式，简洁可靠。

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

      // FDV 跌破买入门槛 → 立即清仓（相当于止损）
      // 不等 EMA 预热，买入后任何时刻 FDV < FDV_MIN_USD 都会触发
      if (state.inPosition && state.position && state.fdv !== null && state.fdv < FDV_MIN_USD) {
        logger.warn(`[Monitor] ⚠️ FDV止损: ${state.symbol} FDV=$${state.fdv} < $${FDV_MIN_USD} — 立即清仓`);
        await this._doExit(state, `FDV_DROP($${state.fdv}<$${FDV_MIN_USD})`);
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
          // 用全部K线（含当前未收盘的），与 PUMP-EMA-15S 一致
          state.candles = buildCandles(state.ticks, KLINE_INTERVAL_SEC);

          const result = evaluateSignal(state.candles, state);
          state.ema9   = result.ema9;
          state.ema20  = result.ema20;

          // 调试日志
          if (!isNaN(result.ema9) && !isNaN(result.ema20)) {
            const gap = ((result.ema9 - result.ema20) / result.ema20 * 100).toFixed(3);
            logger.info(
              `[EMA] ${state.symbol}` +
              ` | candles=${state.candles.length}` +
              ` | bearish=${state.bearishCount||0}` +
              ` | EMA9=${result.ema9.toExponential(4)}` +
              ` | EMA20=${result.ema20.toExponential(4)}` +
              ` | gap=${gap}%` +
              ` | signal=${result.signal || 'HOLD'}` +
              ` | ${result.reason}`
            );
          } else if (result.reason) {
            logger.info(`[EMA] ${state.symbol} | ${result.reason}`);
          }

          if (result.signal === 'SELL') {
            logger.warn(`[Strategy] ⚡ EMA死叉 SELL ${state.symbol} — ${result.reason}`);
            await this._doExit(state, result.reason);
          }
        }

        // ── RUG 检测：方案B（价格异动触发 + 1秒兜底）──────────
        // 触发条件（满足任意一个立即调用 getTrades）：
        //   A. 当前价格相对上一tick下跌 ≥ RUG_PRICE_DROP_TRIGGER_PCT（默认5%）
        //   B. 距上次检测已超过 RUG_FALLBACK_INTERVAL_SEC（默认1秒）
        if (state.inPosition && !state.exitSent) {
          const now        = Date.now();
          const prevPrice  = state.lastPriceForRug;
          const dropPct    = prevPrice ? (prevPrice - price) / prevPrice * 100 : 0;
          const priceDrop  = dropPct >= RUG_PRICE_DROP_TRIGGER_PCT;
          const fallback   = now - state.lastRugCheck >= RUG_FALLBACK_INTERVAL_SEC * 1000;

          if (priceDrop || fallback) {
            if (priceDrop) {
              logger.info(`[RUG] 价格异动触发检测 ${state.symbol} 跌幅=${dropPct.toFixed(2)}%`);
            }
            state.lastRugCheck    = now;
            state.lastPriceForRug = price;

            const rugReason = await this._checkRugSignals(state);
            if (rugReason) {
              logger.warn(`[RUG] ⚠️  ${state.symbol} — ${rugReason}`);
              await this._doExit(state, rugReason);
            }
          } else {
            // 没有触发检测，仍然更新上一tick价格
            state.lastPriceForRug = price;
          }
        }
      }

      await sleep(10);  // 10ms 间隔错开 Birdeye 请求
    }
  }

  // ── RUG 检测：信号①②④ ────────────────────────────────────
  //
  // 返回原因字符串（触发）或 null（未触发）
  // 每 RUG_CHECK_INTERVAL_SEC 秒调用一次，避免 API 过载
  async _checkRugSignals(state) {
    let trades;
    try {
      trades = await birdeye.getTrades(state.address, 30);
    } catch (e) {
      logger.warn(`[RUG] getTrades error ${state.symbol}: ${e.message}`);
      return null;
    }

    if (!trades || trades.length < 3) return null;

    // ── 信号①：连续N笔全卖单 + 总金额≥$X + Gas一致，同时满足才触发 ──
    const recentN   = trades.slice(0, RUG_COORDINATED_MIN_SELLS);
    if (recentN.length >= RUG_COORDINATED_MIN_SELLS) {
      const allSells = recentN.every(t => t.side === 'sell');
      if (allSells) {
        const totalUsd = recentN.reduce((s, t) => s + t.amountUsd, 0);
        const fees     = recentN.map(t => t.gasFee);
        const feeMin   = Math.min(...fees);
        const feeMax   = Math.max(...fees);
        const gasOk    = feeMax - feeMin <= RUG_GAS_DIFF_THRESHOLD;
        const totalOk  = totalUsd >= RUG_COORDINATED_MIN_TOTAL_USD;

        if (gasOk && totalOk) {
          return (
            `RUG_COORDINATED: 连续${recentN.length}笔卖单` +
            ` 总额=$${totalUsd.toFixed(0)}` +
            ` Gas差异=${(feeMax - feeMin).toFixed(4)}SOL`
          );
        }
      }
    }

    // ── 信号④ 买盘完全消失 ───────────────────────────────────
    // 方式A：最近 N 笔全是卖单
    const recentForBuy = trades.slice(0, RUG_NO_BUY_SELL_COUNT);
    if (recentForBuy.length >= RUG_NO_BUY_SELL_COUNT) {
      const noBuys = recentForBuy.every(t => t.side === 'sell');
      if (noBuys) {
        return `RUG_NO_BUYS: 连续${recentForBuy.length}笔全为卖单`;
      }
    }
    // 方式B：最近10笔中所有买单金额均低于阈值（买盘极薄）
    const recent10 = trades.slice(0, 10);
    const buys10   = recent10.filter(t => t.side === 'buy');
    if (buys10.length > 0 && buys10.every(t => t.amountUsd < RUG_NO_BUY_MIN_USD)) {
      const maxBuy = Math.max(...buys10.map(t => t.amountUsd));
      return `RUG_WEAK_BUYS: 买单最大仅$${maxBuy.toFixed(2)}<$${RUG_NO_BUY_MIN_USD}`;
    }

    return null;
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
