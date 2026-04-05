// src/rugWatcher.js — Helius WebSocket 实时 RUG 检测
//
// 架构：
//   买入后立即订阅该代币的 Raydium 池子地址
//   每笔链上交易实时推送（延迟 < 200ms）
//   在本地维护滑动交易窗口，检测 RUG 信号
//   触发后回调 onRug(address, reason)
//
// 替代：Birdeye getTrades 轮询（延迟 10-30s）

'use strict';

const WebSocket = require('ws');
const logger    = require('./logger');

const HELIUS_WS_URL = process.env.HELIUS_WS_URL || '';  // wss://atlas-mainnet.helius-rpc.com?api-key=xxx

// ── RUG 检测参数（与 monitor.js 共用 env）────────────────────
const RUG_COORDINATED_MIN_SELLS     = parseInt(process.env.RUG_COORDINATED_MIN_SELLS      || '6');
const RUG_COORDINATED_MIN_TOTAL_USD = parseFloat(process.env.RUG_COORDINATED_MIN_TOTAL_USD || '300');
const RUG_GAS_DIFF_THRESHOLD        = parseFloat(process.env.RUG_GAS_DIFF_THRESHOLD        || '0.01');
const RUG_NO_BUY_SELL_COUNT         = parseInt(process.env.RUG_NO_BUY_SELL_COUNT           || '10');

// 每个代币保留最近 N 笔交易用于检测
const TRADE_WINDOW = 30;

// Raydium AMM program（用于识别 swap 交易）
const RAYDIUM_AMM_PROGRAM = 'routeUGWgpgyZibjFqnNwezdgjinDDoyxe4Hwur7Eux';

class RugWatcher {
  constructor(onRug) {
    this.onRug      = onRug;           // 回调：(tokenAddress, reason) => void
    this.watches    = new Map();       // Map<tokenAddress, WatchState>
    this.ws         = null;
    this.subIdMap   = new Map();       // Map<subId, tokenAddress>
    this.addrSubMap = new Map();       // Map<tokenAddress, subId>
    this._reconnectTimer = null;
    this._reqId     = 1;
    this._pendingSubs = [];            // 连接建立前缓存的订阅请求
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
      // 重连后重新订阅所有已有的 token
      for (const [addr] of this.watches) {
        this._subscribe(addr);
      }
      // 发送连接前缓存的订阅
      for (const req of this._pendingSubs) {
        this.ws.send(JSON.stringify(req));
      }
      this._pendingSubs = [];
      // 心跳保活
      this._pingTimer = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handleMessage(msg);
      } catch (e) {
        logger.warn(`[RugWatcher] 解析消息失败: ${e.message}`);
      }
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

  // ── 开始监控某个代币 ─────────────────────────────────────────
  watch(tokenAddress, poolAddress) {
    if (this.watches.has(tokenAddress)) return;

    this.watches.set(tokenAddress, {
      tokenAddress,
      poolAddress,
      trades:   [],   // 滑动窗口，最新在前
      triggered: false,
    });

    this._subscribe(tokenAddress);
    logger.info(`[RugWatcher] 开始监控 ${tokenAddress.slice(0, 8)} pool=${poolAddress?.slice(0, 8)}`);
  }

  // ── 停止监控 ─────────────────────────────────────────────────
  unwatch(tokenAddress) {
    const subId = this.addrSubMap.get(tokenAddress);
    if (subId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id:      this._reqId++,
        method:  'logsUnsubscribe',
        params:  [subId],
      }));
      this.subIdMap.delete(subId);
      this.addrSubMap.delete(tokenAddress);
    }
    this.watches.delete(tokenAddress);
    logger.info(`[RugWatcher] 停止监控 ${tokenAddress.slice(0, 8)}`);
  }

  // ── 内部：发送订阅请求 ────────────────────────────────────────
  _subscribe(tokenAddress) {
    const watch = this.watches.get(tokenAddress);
    if (!watch) return;

    const reqId = this._reqId++;
    const req = {
      jsonrpc: '2.0',
      id:      reqId,
      method:  'logsSubscribe',
      params:  [
        // 监听包含该代币 mint 地址的日志
        { mentions: [tokenAddress] },
        { commitment: 'confirmed' },
      ],
    };

    // 记录 reqId → tokenAddress，等待服务端返回 subId
    this.subIdMap.set(`pending_${reqId}`, tokenAddress);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(req));
    } else {
      this._pendingSubs.push(req);
    }
  }

  // ── 处理推送消息 ──────────────────────────────────────────────
  _handleMessage(msg) {
    // 订阅确认：服务端返回 subId
    if (msg.id !== undefined && msg.result !== undefined) {
      const key = `pending_${msg.id}`;
      const addr = this.subIdMap.get(key);
      if (addr) {
        this.subIdMap.delete(key);
        this.subIdMap.set(msg.result, addr);
        this.addrSubMap.set(addr, msg.result);
      }
      return;
    }

    // 实时交易推送
    if (msg.method === 'logsNotification') {
      const subId  = msg.params?.subscription;
      const addr   = this.subIdMap.get(subId);
      if (!addr) return;

      const watch = this.watches.get(addr);
      if (!watch || watch.triggered) return;

      const value  = msg.params?.result?.value;
      if (!value || value.err) return;  // 失败交易忽略

      this._parseTrade(watch, value);
    }
  }

  // ── 解析交易，推入滑动窗口 ────────────────────────────────────
  _parseTrade(watch, txValue) {
    const logs = txValue.logs ?? [];

    // 判断买卖方向：通过日志关键词
    // Raydium swap 日志包含 "ray_log" 或 "SwapBaseIn"/"SwapBaseOut"
    const isSwapIn  = logs.some(l => l.includes('SwapBaseIn')  || l.includes('buy'));
    const isSwapOut = logs.some(l => l.includes('SwapBaseOut') || l.includes('sell'));

    if (!isSwapIn && !isSwapOut) return;

    // 从日志中提取金额（简化：用 SOL 变化量估算）
    // 完整解析需要 getTransaction，这里用签名异步获取
    const sig = txValue.signature;
    if (sig) {
      // 异步获取完整交易数据解析金额
      this._fetchAndParseTx(watch, sig, isSwapOut ? 'sell' : 'buy');
    }
  }

  // ── 异步获取交易详情，解析金额和 Gas ─────────────────────────
  async _fetchAndParseTx(watch, sig, side) {
    try {
      const HELIUS_RPC = process.env.HELIUS_RPC_URL || '';
      if (!HELIUS_RPC) return;

      const resp = await fetch(HELIUS_RPC, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'getTransaction',
          params:  [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
      });

      const data = await resp.json();
      const tx   = data?.result;
      if (!tx) return;

      const meta       = tx.meta;
      const feeLamports = meta?.fee ?? 0;
      const gasFee      = feeLamports / 1e9;  // lamports → SOL

      // 估算交易金额：用 SOL 余额变化（preBalances - postBalances）
      const preB  = meta?.preBalances  ?? [];
      const postB = meta?.postBalances ?? [];
      let solDelta = 0;
      for (let i = 0; i < preB.length; i++) {
        const delta = Math.abs((preB[i] ?? 0) - (postB[i] ?? 0));
        if (delta > solDelta) solDelta = delta;
      }

      // 用当前价格换算为 USD（粗估，只用于 RUG 门槛判断）
      // 实际金额用 SOL 价格 × solDelta，这里简化用 solDelta * 130（SOL ~$130）
      const SOL_PRICE_USD = parseFloat(process.env.SOL_PRICE_HINT || '130');
      const amountUsd     = (solDelta / 1e9) * SOL_PRICE_USD;

      const trade = { side, amountUsd, gasFee, sig, time: Date.now() };

      watch.trades.unshift(trade);
      if (watch.trades.length > TRADE_WINDOW) watch.trades.length = TRADE_WINDOW;

      logger.info(
        `[RugWatcher] ${watch.tokenAddress.slice(0, 8)}` +
        ` ${side.toUpperCase()} $${amountUsd.toFixed(2)} gas=${gasFee.toFixed(4)}`
      );

      // 检测 RUG 信号
      const reason = this._checkRug(watch);
      if (reason) {
        watch.triggered = true;
        logger.warn(`[RugWatcher] ⚠️  RUG检测触发 ${watch.tokenAddress.slice(0, 8)} — ${reason}`);
        this.onRug(watch.tokenAddress, reason);
      }

    } catch (e) {
      logger.warn(`[RugWatcher] fetchTx error ${sig?.slice(0, 12)}: ${e.message}`);
    }
  }

  // ── RUG 信号检测（与原 _checkRugSignals 相同逻辑）────────────
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
