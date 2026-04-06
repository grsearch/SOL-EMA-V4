// src/rugWatcher.js — Helius Enhanced WebSocket 实时 RUG 检测
//
// 架构（Enhanced WebSocket transactionSubscribe）：
//   建立一个全局订阅，监听所有经过 Pump AMM program 的交易
//   每笔交易推送时包含完整的 accountKeys、balances、logs
//   本地过滤：accountKeys 里包含目标 token mint → 属于该 token 的交易
//   直接从 preBalances/postBalances 计算 SOL 金额
//   直接从 meta.fee 获取 Gas
//   ★ 完全不调用 getTransaction，零二次 RPC 延迟
//
// 为什么不用 logsSubscribe：
//   Pump AMM swap 的 accountKeys 不一定包含 token mint
//   logsSubscribe mentions 过滤会漏掉大量交易

'use strict';

const WebSocket = require('ws');
const logger    = require('./logger');

const HELIUS_WS_URL = process.env.HELIUS_WS_URL || '';

// ── RUG 检测参数 ──────────────────────────────────────────────
const RUG_COORDINATED_MIN_SELLS     = parseInt(process.env.RUG_COORDINATED_MIN_SELLS      || '8');
const RUG_COORDINATED_MIN_TOTAL_USD = parseFloat(process.env.RUG_COORDINATED_MIN_TOTAL_USD || '1500');
const RUG_GAS_DIFF_THRESHOLD        = parseFloat(process.env.RUG_GAS_DIFF_THRESHOLD        || '0.01');
const RUG_NO_BUY_SELL_COUNT         = parseInt(process.env.RUG_NO_BUY_SELL_COUNT           || '999'); // 默认999=禁用，误触发率高
const SOL_PRICE_USD                 = parseFloat(process.env.SOL_PRICE_HINT                || '130');
// 时间窗口：N笔卖单必须全部在此时间内发生才触发（毫秒）
// 真RUG通常1-2秒内爆发，正常回调分散在10-30秒
const RUG_TIME_WINDOW_MS            = parseInt(process.env.RUG_TIME_WINDOW_MS              || '2000');

// 买单对冲比例：窗口内买单总金额 > 卖单总金额 × 此比例 → 有足够买盘，不触发
const RUG_BUY_OFFSET_RATIO = parseFloat(process.env.RUG_BUY_OFFSET_RATIO || '0.3');
// 规则B：小额高频无买单出货（针对1秒内连续小额卖单）
const RUG_HFREQ_MIN_SELLS  = parseInt(process.env.RUG_HFREQ_MIN_SELLS    || '10');    // 2秒内卖单数门槛
// RUG_HFREQ_MAX_GAS 已弃用，改用 RUG_GAS_DIFF_THRESHOLD 统一判断Gas一致性
const RUG_HFREQ_TIME_WINDOW_MS = parseInt(process.env.RUG_HFREQ_TIME_WINDOW_MS   || '2000');  // 最新N笔卖单到达时间跨度上限（2秒）
const RUG_HFREQ_MIN_TOTAL_USD  = parseFloat(process.env.RUG_HFREQ_MIN_TOTAL_USD   || '300');   // 规则B卖单总额最低门槛

// Pump AMM program address
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

class RugWatcher {
  constructor(onRug) {
    this.onRug            = onRug;
    this.watches          = new Map();   // Map<tokenAddress, WatchState>
    this.ws               = null;
    this._subId           = null;        // 全局 transactionSubscribe 的 subId
    this._pendingSubReqId = null;
    this._reconnectTimer  = null;
    this._pingTimer       = null;
    this._reqId           = 1;
  }

  // ── 连接并订阅 ───────────────────────────────────────────────
  connect() {
    if (!HELIUS_WS_URL) {
      logger.warn('[RugWatcher] HELIUS_WS_URL 未配置，RUG实时检测已禁用');
      return;
    }
    logger.info('[RugWatcher] 连接 Helius Enhanced WebSocket...');
    this.ws = new WebSocket(HELIUS_WS_URL);

    this.ws.on('open', () => {
      logger.info('[RugWatcher] WebSocket 已连接');
      this._sendGlobalSubscribe();
      this._pingTimer = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try { this._handleMessage(JSON.parse(data)); }
      catch (e) { logger.warn(`[RugWatcher] 消息解析失败: ${e.message}`); }
    });

    this.ws.on('error', (err) => {
      logger.warn(`[RugWatcher] WebSocket 错误: ${err.message}`);
    });

    this.ws.on('close', () => {
      logger.warn('[RugWatcher] WebSocket 断开，5秒后重连...');
      clearInterval(this._pingTimer);
      this._subId = null;
      this._reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
  }

  // ── 发送全局 transactionSubscribe ────────────────────────────
  _sendGlobalSubscribe() {
    const reqId = this._reqId++;
    this._pendingSubReqId = reqId;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id:      reqId,
      method:  'transactionSubscribe',
      params:  [
        {
          failed:         false,
          accountInclude: [PUMP_AMM_PROGRAM],
        },
        {
          commitment:                     'processed',  // processed比confirmed快400ms-1s
          encoding:                       'jsonParsed',
          transactionDetails:             'full',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }));
    logger.info('[RugWatcher] 已发送 transactionSubscribe（Pump AMM）');
  }

  // ── 开始监控某个 token ───────────────────────────────────────
  watch(tokenAddress) {
    if (this.watches.has(tokenAddress)) return;
    this.watches.set(tokenAddress, { tokenAddress, trades: [], triggered: false });
    logger.info(`[RugWatcher] 开始监控 ${tokenAddress.slice(0, 8)}`);
  }

  // ── 停止监控某个 token ───────────────────────────────────────
  unwatch(tokenAddress) {
    this.watches.delete(tokenAddress);
    logger.info(`[RugWatcher] 停止监控 ${tokenAddress.slice(0, 8)}`);
  }

  // ── 处理推送消息 ──────────────────────────────────────────────
  _handleMessage(msg) {
    // 订阅确认
    if (msg.id !== undefined && msg.result !== undefined) {
      if (msg.id === this._pendingSubReqId) {
        this._subId = msg.result;
        logger.info(`[RugWatcher] transactionSubscribe 确认 subId=${this._subId}`);
      }
      return;
    }

    if (msg.error) {
      logger.warn(`[RugWatcher] 订阅错误: ${JSON.stringify(msg.error)}`);
      return;
    }

    if (msg.method !== 'transactionNotification') return;
    if (msg.params?.subscription !== this._subId) return;

    const tx = msg.params?.result;
    if (!tx) return;

    this._processTx(tx);
  }

  // ── 处理一笔推送过来的交易 ────────────────────────────────────
  _processTx(tx) {
    const transaction = tx.transaction?.transaction;
    const meta        = tx.transaction?.meta;
    if (!transaction || !meta || meta.err) return;

    // 提取所有 accountKeys
    const message     = transaction.message;
    const accountKeys = (message?.accountKeys ?? []).map(k =>
      typeof k === 'string' ? k : (k.pubkey ?? k)
    );

    // 查找是否有我们监控的 token
    let targetWatch = null;
    for (const [addr, watch] of this.watches) {
      if (watch.triggered) continue;
      if (accountKeys.includes(addr)) {
        targetWatch = watch;
        break;
      }
    }
    if (!targetWatch) return;

    // 判断买卖方向
    const logs   = meta.logMessages ?? [];
    const isBuy  = logs.some(l => l.includes('Instruction: Buy'));
    const isSell = logs.some(l => l.includes('Instruction: Sell'));
    if (!isBuy && !isSell) return;
    const side = isSell ? 'sell' : 'buy';

    // 计算 SOL 金额：最大余额变化量（扣除 fee）
    const preB  = meta.preBalances  ?? [];
    const postB = meta.postBalances ?? [];
    let maxDelta = 0;
    for (let i = 0; i < preB.length; i++) {
      const delta = Math.abs((preB[i] ?? 0) - (postB[i] ?? 0));
      if (delta > maxDelta) maxDelta = delta;
    }
    const fee         = meta.fee ?? 0;
    const solLamports = Math.max(0, maxDelta - fee);
    const amountUsd   = (solLamports / 1e9) * SOL_PRICE_USD;
    const gasFee      = fee / 1e9;

    const sig   = tx.signature ?? transaction.signatures?.[0] ?? '';
    const trade = { side, amountUsd, gasFee, sig: sig.slice(0, 16), time: Date.now() };

    targetWatch.trades.unshift(trade);
    if (targetWatch.trades.length > TRADE_WINDOW) targetWatch.trades.length = TRADE_WINDOW;

    logger.info(
      `[RugWatcher] ${targetWatch.tokenAddress.slice(0, 8)}` +
      ` ${side.toUpperCase()}` +
      ` SOL=${(solLamports / 1e9).toFixed(4)}` +
      ` $${amountUsd.toFixed(2)}` +
      ` gas=${gasFee.toFixed(4)}`
    );

    const reason = this._checkRug(targetWatch);
    if (reason) {
      targetWatch.triggered = true;
      logger.warn(`[RugWatcher] ⚠️  ${targetWatch.tokenAddress.slice(0, 8)} — ${reason}`);
      this.onRug(targetWatch.tokenAddress, reason);
    }
  }

  // ── RUG 信号检测 ──────────────────────────────────────────────
  _checkRug(watch) {
    const trades = watch.trades;
    if (trades.length < 3) return null;

    // 信号①：时间窗口内，卖单笔数≥N + 卖单总金额≥$X + Gas一致
    // 不要求连续，允许中间夹买单（防绕过检测）
    const now      = Date.now();
    const inWindow = trades.filter(t => now - t.time <= RUG_TIME_WINDOW_MS);
    const sells    = inWindow.filter(t => t.side === 'sell');

    if (sells.length >= RUG_COORDINATED_MIN_SELLS) {
      const totalUsd    = sells.reduce((s, t) => s + t.amountUsd, 0);
      const fees        = sells.map(t => t.gasFee);
      const feeMin      = Math.min(...fees);
      const feeMax      = Math.max(...fees);
      const gasOk       = feeMax - feeMin <= RUG_GAS_DIFF_THRESHOLD;
      const totalOk     = totalUsd >= RUG_COORDINATED_MIN_TOTAL_USD;

      // 买单对冲检查：窗口内买单总金额 > 卖单总金额 × 比例 → 有足够买盘承接，不是RUG
      const buys        = inWindow.filter(t => t.side === 'buy');
      const buyTotal    = buys.reduce((s, t) => s + t.amountUsd, 0);
      const buyOffsetOk = buyTotal <= totalUsd * RUG_BUY_OFFSET_RATIO;

      if (gasOk && totalOk && buyOffsetOk) {
        const spanMs = inWindow.length > 1
          ? inWindow[0].time - inWindow[inWindow.length - 1].time
          : 0;
        return (
          `RUG_COORDINATED: ${sells.length}笔卖单/${inWindow.length}笔交易` +
          ` 卖=$${totalUsd.toFixed(0)} 买=$${buyTotal.toFixed(0)}` +
          ` 时间=${spanMs}ms` +
          ` Gas差异=${(feeMax - feeMin).toFixed(4)}SOL`
        );
      }

      // 调试：条件未满足时记录原因
      if (gasOk && totalOk && !buyOffsetOk) {
        logger.info(
          `[RugWatcher] 买单对冲拦截 ${watch.tokenAddress.slice(0, 8)}` +
          ` 卖=$${totalUsd.toFixed(0)} 买=$${buyTotal.toFixed(0)}` +
          ` 买/卖=${(buyTotal / totalUsd * 100).toFixed(0)}%`
        );
      }
    }



    // 规则B：小额高频无买单出货（基于最新N笔卖单的时间跨度）
    // 不用时间窗口，而是看最新10笔卖单从第1笔到第10笔的时间跨度
    // 这样不受推送延迟影响：只要10笔卖单到达，立即检查它们的跨度
    const allSells = trades.filter(t => t.side === 'sell');
    if (allSells.length >= RUG_HFREQ_MIN_SELLS) {
      const latestSells = allSells.slice(0, RUG_HFREQ_MIN_SELLS);
      const spanMs      = latestSells[0].time - latestSells[latestSells.length - 1].time;

      // 时间跨度在窗口内（推送到达时间跨度，2秒）
      if (spanMs <= RUG_HFREQ_TIME_WINDOW_MS) {
        // Gas一致性检查（与规则A相同逻辑，差异 < 阈值即为一致）
        const fees    = latestSells.map(t => t.gasFee);
        const feeMin  = Math.min(...fees);
        const feeMax  = Math.max(...fees);
        const gasOk   = feeMax - feeMin <= RUG_GAS_DIFF_THRESHOLD;

        // 检查这10笔卖单期间是否有买单夹杂
        // 取第10笔和第1笔之间的所有买单
        const oldestTime  = latestSells[latestSells.length - 1].time;
        const newestTime  = latestSells[0].time;
        const buysInSpan  = trades.filter(t =>
          t.side === 'buy' && t.time >= oldestTime && t.time <= newestTime
        );
        const noBuys = buysInSpan.length === 0;

        if (gasOk && noBuys) {
          const totalUsdB = latestSells.reduce((s, t) => s + t.amountUsd, 0);
          if (totalUsdB < RUG_HFREQ_MIN_TOTAL_USD) {
            logger.info(`[RugWatcher] 规则B金额不足 ${watch.tokenAddress.slice(0, 8)} 总额=$${totalUsdB.toFixed(0)}<$${RUG_HFREQ_MIN_TOTAL_USD}`);
            return null;
          }
          return (
            `RUG_HFREQ: ${latestSells.length}笔卖单 无买单` +
            ` 总额=$${totalUsdB.toFixed(0)}` +
            ` 时间跨度=${spanMs}ms` +
            ` Gas差异=${(feeMax - feeMin).toFixed(4)}SOL`
          );
        }
      }
    }

    // 信号④：连续N笔全卖单（买盘消失，默认禁用）
    const recentForBuy = trades.slice(0, RUG_NO_BUY_SELL_COUNT);
    if (recentForBuy.length >= RUG_NO_BUY_SELL_COUNT) {
      if (recentForBuy.every(t => t.side === 'sell')) {
        return `RUG_NO_BUYS: 连续${recentForBuy.length}笔全为卖单`;
      }
    }

    return null;
  }

  disconnect() {
    clearInterval(this._pingTimer);
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    logger.info('[RugWatcher] 已断开');
  }
}

module.exports = { RugWatcher };
