// src/rugWatcher.js — Helius WebSocket 实时 RUG 检测
//
// 架构：
//   买入后立即订阅该代币（logsSubscribe + mentions）
//   每笔链上交易日志实时推送（延迟 < 200ms）
//   直接从 logs 解析买卖方向 + SOL金额 + Gas
//   ★ 完全不调用 getTransaction，零二次 RPC 延迟
//
// Pump AMM 日志解析原理：
//   每笔 swap 日志包含一行 "Program data: <base64>"
//   base64 解码后，前8字节是 discriminator：
//     Buy  discriminator: [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]
//     Sell discriminator: [0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]
//   之后的字节包含 base_amount_out/in 和 quote_amount_in/out（u64 LE）
//   quote = SOL 数量（lamports）

'use strict';

const WebSocket = require('ws');
const logger    = require('./logger');

const HELIUS_WS_URL = process.env.HELIUS_WS_URL || '';

// ── RUG 检测参数 ──────────────────────────────────────────────
const RUG_COORDINATED_MIN_SELLS     = parseInt(process.env.RUG_COORDINATED_MIN_SELLS      || '6');
const RUG_COORDINATED_MIN_TOTAL_USD = parseFloat(process.env.RUG_COORDINATED_MIN_TOTAL_USD || '300');
const RUG_GAS_DIFF_THRESHOLD        = parseFloat(process.env.RUG_GAS_DIFF_THRESHOLD        || '0.01');
const RUG_NO_BUY_SELL_COUNT         = parseInt(process.env.RUG_NO_BUY_SELL_COUNT           || '10');
const SOL_PRICE_USD                 = parseFloat(process.env.SOL_PRICE_HINT                || '130');

const TRADE_WINDOW = 30;

// ── Pump AMM event discriminators（8字节，固定值）──────────────
// 从 pump_amm IDL 提取，用于识别 Buy/Sell 事件
const BUY_DISC  = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
const SELL_DISC = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

// Pump AMM program address（用于日志过滤）
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

class RugWatcher {
  constructor(onRug) {
    this.onRug        = onRug;
    this.watches      = new Map();   // Map<tokenAddress, WatchState>
    this.ws           = null;
    this.subIdMap     = new Map();   // Map<subId | "pending_N", tokenAddress>
    this.addrSubMap   = new Map();   // Map<tokenAddress, subId>
    this._reconnectTimer = null;
    this._pingTimer      = null;
    this._reqId          = 1;
    this._pendingSubs    = [];
  }

  // ── 连接 WebSocket ───────────────────────────────────────────
  connect() {
    if (!HELIUS_WS_URL) {
      logger.warn('[RugWatcher] HELIUS_WS_URL 未配置，RUG实时检测已禁用');
      return;
    }
    logger.info('[RugWatcher] 连接 Helius WebSocket...');
    this.ws = new WebSocket(HELIUS_WS_URL);

    this.ws.on('open', () => {
      logger.info('[RugWatcher] WebSocket 已连接');
      for (const [addr] of this.watches) this._subscribe(addr);
      for (const req of this._pendingSubs) this.ws.send(JSON.stringify(req));
      this._pendingSubs = [];
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
      this._reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
  }

  // ── 开始监控 ─────────────────────────────────────────────────
  watch(tokenAddress) {
    if (this.watches.has(tokenAddress)) return;
    this.watches.set(tokenAddress, { tokenAddress, trades: [], triggered: false });
    this._subscribe(tokenAddress);
    logger.info(`[RugWatcher] 开始监控 ${tokenAddress.slice(0, 8)}`);
  }

  // ── 停止监控 ─────────────────────────────────────────────────
  unwatch(tokenAddress) {
    const subId = this.addrSubMap.get(tokenAddress);
    if (subId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0', id: this._reqId++,
        method: 'logsUnsubscribe', params: [subId],
      }));
      this.subIdMap.delete(subId);
      this.addrSubMap.delete(tokenAddress);
    }
    this.watches.delete(tokenAddress);
    logger.info(`[RugWatcher] 停止监控 ${tokenAddress.slice(0, 8)}`);
  }

  // ── 订阅 ─────────────────────────────────────────────────────
  _subscribe(tokenAddress) {
    if (!this.watches.has(tokenAddress)) return;
    const reqId = this._reqId++;
    const req = {
      jsonrpc: '2.0', id: reqId,
      method: 'logsSubscribe',
      params: [{ mentions: [tokenAddress] }, { commitment: 'confirmed' }],
    };
    this.subIdMap.set(`pending_${reqId}`, tokenAddress);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(req));
    } else {
      this._pendingSubs.push(req);
    }
  }

  // ── 处理推送消息 ──────────────────────────────────────────────
  _handleMessage(msg) {
    // 订阅确认
    if (msg.id !== undefined && msg.result !== undefined) {
      const key  = `pending_${msg.id}`;
      const addr = this.subIdMap.get(key);
      if (addr) {
        this.subIdMap.delete(key);
        this.subIdMap.set(msg.result, addr);
        this.addrSubMap.set(addr, msg.result);
      }
      return;
    }

    if (msg.method !== 'logsNotification') return;
    const subId = msg.params?.subscription;
    const addr  = this.subIdMap.get(subId);
    if (!addr) return;

    const watch = this.watches.get(addr);
    if (!watch || watch.triggered) return;

    const value = msg.params?.result?.value;
    if (!value || value.err) return;

    this._parseTrade(watch, value);
  }

  // ── 从 logs 直接解析交易（无需 getTransaction）────────────────
  //
  // logsNotification 的 value 结构：
  // {
  //   signature: "...",
  //   logs: ["Program pAMM... invoke", ..., "Program data: <base64>", ...]
  //   fee: number (lamports) — Helius Enhanced WS 包含此字段
  // }
  _parseTrade(watch, value) {
    const logs = value.logs ?? [];

    // 只处理 Pump AMM 交易
    const isPumpAMM = logs.some(l =>
      l.includes(PUMP_AMM_PROGRAM) || l.startsWith('Program pAMMBay')
    );
    if (!isPumpAMM) return;

    // 从 "Program data: <base64>" 行解析事件
    for (const log of logs) {
      if (!log.startsWith('Program data: ')) continue;

      const b64  = log.slice('Program data: '.length).trim();
      let buf;
      try { buf = Buffer.from(b64, 'base64'); }
      catch { continue; }

      if (buf.length < 8) continue;

      const disc = buf.slice(0, 8);
      const isBuy  = disc.equals(BUY_DISC);
      const isSell = disc.equals(SELL_DISC);
      if (!isBuy && !isSell) continue;

      const side = isSell ? 'sell' : 'buy';

      // Pump AMM Buy event layout（字节偏移，小端 u64）：
      //   [0..8]   discriminator
      //   [8..16]  base_amount_out  (tokens received)
      //   [16..24] max_quote_amount (SOL max input)
      //   [24..32] quote_amount_in  (SOL actually spent) ← 实际金额
      //
      // Pump AMM Sell event layout：
      //   [0..8]   discriminator
      //   [8..16]  base_amount_in   (tokens sold)
      //   [16..24] min_quote_amount (SOL min output)
      //   [24..32] quote_amount_out (SOL actually received) ← 实际金额
      let solLamports = 0;
      if (buf.length >= 32) {
        try {
          solLamports = Number(buf.readBigUInt64LE(24));
        } catch {
          solLamports = 0;
        }
      }

      const amountUsd = (solLamports / 1e9) * SOL_PRICE_USD;

      // Gas fee：Helius Enhanced WS 在 value.fee 里直接提供（lamports）
      // 标准 logsSubscribe 没有 fee 字段，回退为 0（不影响 RUG 检测逻辑）
      const gasFee = (value.fee ?? 0) / 1e9;

      const trade = { side, amountUsd, gasFee, sig: value.signature, time: Date.now() };
      watch.trades.unshift(trade);
      if (watch.trades.length > TRADE_WINDOW) watch.trades.length = TRADE_WINDOW;

      logger.info(
        `[RugWatcher] ${watch.tokenAddress.slice(0, 8)}` +
        ` ${side.toUpperCase()}` +
        ` SOL=${(solLamports / 1e9).toFixed(4)}` +
        ` $${amountUsd.toFixed(2)}` +
        ` gas=${gasFee.toFixed(4)}`
      );

      // 每笔交易后立即检测
      const reason = this._checkRug(watch);
      if (reason) {
        watch.triggered = true;
        logger.warn(`[RugWatcher] ⚠️  ${watch.tokenAddress.slice(0, 8)} — ${reason}`);
        this.onRug(watch.tokenAddress, reason);
      }

      break; // 每笔交易只有一个 Program data 事件
    }
  }

  // ── RUG 信号检测 ──────────────────────────────────────────────
  _checkRug(watch) {
    const trades = watch.trades;
    if (trades.length < 3) return null;

    // 信号①：连续N笔全卖单 + 总金额≥$X + Gas一致
    const recentN = trades.slice(0, RUG_COORDINATED_MIN_SELLS);
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

    // 信号④：连续N笔全卖单（买盘消失）
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
