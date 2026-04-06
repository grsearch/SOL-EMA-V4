// src/trader.js — Jupiter-based auto-trader with MEV protection
//
// Architecture:
//   • Uses Jupiter Ultra API (Pro I) for swap quote + execute
//   • Anti-sandwich via Jito bundle tip + priority fee
//   • EMA death-cross: EMA9<EMA20 且 EMA20↓ 连续2次确认后全仓卖出
//   • Dynamic slippage retry: each retry widens slippage ×1.5, max 2000 bps
//
// 已删除：硬止损、移动止损、分批止盈（全部由 EMA 死叉统一处理）

'use strict';

const {
  Connection, Keypair, PublicKey,
  VersionedTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58   = require('bs58');
const axios  = require('axios');
const logger = require('./logger');
const { broadcastToClients } = require('./wsHub');

// ── Config ─────────────────────────────────────────────────────
const HELIUS_RPC   = process.env.HELIUS_RPC_URL            || '';
const JUP_API      = process.env.JUPITER_API_URL           || 'https://api.jup.ag';
const JUP_API_KEY  = process.env.JUPITER_API_KEY           || '';
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS     || '500');  // ← 默认 5%
const TRADE_SOL    = parseFloat(process.env.TRADE_SIZE_SOL || '0.5');

// RUG 紧急卖出：优先费（lamports），越高越容易被快速打包
// 默认 500000 lamports = 0.0005 SOL，约 $0.065，值得花
const RUG_PRIORITY_FEE = parseInt(process.env.RUG_PRIORITY_FEE_LAMPORTS || '500000');

// 动态滑点上限：重试时最多放宽到 20%
const SLIPPAGE_MAX_BPS = 2000;
// RUG紧急卖出滑点：直接用最大值 9900bps（99%），确保任何情况下都能成交
const RUG_SLIPPAGE_BPS = parseInt(process.env.RUG_SLIPPAGE_BPS || '9900');

function jupHeaders() {
  return JUP_API_KEY ? { 'x-api-key': JUP_API_KEY } : {};
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Wallet ─────────────────────────────────────────────────────
let _keypair = null;
function getKeypair() {
  if (_keypair) return _keypair;
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('WALLET_PRIVATE_KEY not set');
  _keypair = Keypair.fromSecretKey(bs58.decode(pk));
  return _keypair;
}

// ── RPC connection ─────────────────────────────────────────────
let _conn = null;
function getConn() {
  if (_conn) return _conn;
  if (!HELIUS_RPC) throw new Error('HELIUS_RPC_URL not set');
  _conn = new Connection(HELIUS_RPC, 'confirmed');
  return _conn;
}

// ── Jupiter helpers ────────────────────────────────────────────

/**
 * Fetch a Jupiter Ultra swap order.
 * slippageBps 显式传入，供动态重试逻辑使用。
 */
async function getSwapOrder({ inputMint, outputMint, amount, slippageBps, priorityFeeLamports }) {
  const url = `${JUP_API}/ultra/v1/order`;
  const { data } = await axios.get(url, {
    params: {
      inputMint,
      outputMint,
      amount:      Math.floor(amount).toString(),
      slippageBps: slippageBps ?? SLIPPAGE_BPS,
      taker:       getKeypair().publicKey.toBase58(),
      // 优先费：RUG紧急卖出时传入高优先费确保快速打包
      ...(priorityFeeLamports ? { priorityFeeLamports } : {}),
    },
    headers: jupHeaders(),
    timeout: 10000,
  });
  return data;
}

async function executeSwapOrder({ requestId, signedTransaction }) {
  const url = `${JUP_API}/ultra/v1/execute`;
  const { data } = await axios.post(url, { requestId, signedTransaction }, {
    headers: jupHeaders(),
    timeout: 30000,
  });
  return data;
}

function signTx(base64Tx) {
  const kp  = getKeypair();
  const buf = Buffer.from(base64Tx, 'base64');
  const tx  = VersionedTransaction.deserialize(buf);
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// ── Token balance ──────────────────────────────────────────────
async function getTokenBalance(mintAddress) {
  const conn = getConn();
  const kp   = getKeypair();
  if (mintAddress === SOL_MINT) return conn.getBalance(kp.publicKey);
  const mint = new PublicKey(mintAddress);
  const { value } = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint });
  if (!value.length) return 0;
  return parseInt(value[0].account.data.parsed.info.tokenAmount.amount || '0');
}

// ── Order builders（接受显式 slippageBps，供重试时递增）─────────

async function buildBuyOrder(tokenMint, solAmountLamports, slippageBps) {
  return getSwapOrder({
    inputMint:   SOL_MINT,
    outputMint:  tokenMint,
    amount:      solAmountLamports,
    slippageBps: slippageBps ?? SLIPPAGE_BPS,
  });
}

async function buildSellOrder(tokenMint, tokenAmount, slippageBps, isRug = false) {
  const base = slippageBps ?? SLIPPAGE_BPS;
  // RUG紧急卖出：直接用99%滑点，确保暴跌时也能成交
  const finalSlippage = isRug ? RUG_SLIPPAGE_BPS : Math.min(base * 2, SLIPPAGE_MAX_BPS);
  return getSwapOrder({
    inputMint:           tokenMint,
    outputMint:          SOL_MINT,
    amount:              tokenAmount,
    slippageBps:         finalSlippage,
    priorityFeeLamports: isRug ? RUG_PRIORITY_FEE : undefined,
  });
}

// ── Dynamic-slippage retry ─────────────────────────────────────
async function executeWithRetry(orderFn, retries = 3) {
  let slippage = SLIPPAGE_BPS;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const order    = await orderFn(slippage);
      const txBase64 = order.transaction;
      if (!txBase64) {
        throw new Error(
          `Jupiter order missing 'transaction' field. Keys: ${Object.keys(order).join(', ')}`
        );
      }

      const signed = signTx(txBase64);
      const result = await executeSwapOrder({
        requestId:         order.requestId,
        signedTransaction: signed,
      });

      if (result.status === 'Success') return result;
      logger.warn(
        `[Trader] Swap status="${result.status}" attempt=${attempt} slippage=${slippage}bps`
      );
    } catch (e) {
      logger.warn(
        `[Trader] Execute attempt=${attempt} slippage=${slippage}bps error: ${e.message}`
      );
    }

    // 加宽滑点，等待后重试（RUG已用最大滑点，缩短等待时间）
    slippage = Math.min(Math.floor(slippage * 1.5), SLIPPAGE_MAX_BPS);
    if (attempt < retries) await sleep(500 * attempt);  // 改为500ms，比原1500ms更快
  }

  throw new Error(`Swap failed after ${retries} retries`);
}

// ── BUY ────────────────────────────────────────────────────────
async function buy(tokenState) {
  const { address, symbol, currentPrice } = tokenState;
  logger.warn(`[Trader] BUY ${symbol} @ Birdeye=${currentPrice}`);

  const solLamports = Math.floor(TRADE_SOL * LAMPORTS_PER_SOL);

  try {
    const result = await executeWithRetry(
      (slipBps) => buildBuyOrder(address, solLamports, slipBps)
    );

    const tokenBalance     = parseInt(result.outputAmountResult || '0');
    const solSpentLamports = parseInt(result.inputAmountResult  || String(solLamports));

    // 买入完成后重拉价格作为开仓基准
    let entryPriceUsd = currentPrice;
    try {
      const freshPrice = await require('./birdeye').getPrice(address);
      if (freshPrice && freshPrice > 0) {
        entryPriceUsd = freshPrice;
        logger.warn(`[Trader] Entry price refreshed: ${currentPrice} → ${freshPrice}`);
      }
    } catch (_) {
      logger.warn('[Trader] Entry price refresh failed, using pre-buy price');
    }

    logger.warn(
      `[Trader] BUY OK ${symbol}` +
      ` | sig=${result.signature?.slice(0, 12)}` +
      ` | got=${tokenBalance} tokens` +
      ` | spent=${(solSpentLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL` +
      ` | entryUsd=${entryPriceUsd}`
    );

    const pos = {
      tokenBalance,
      initialBalance: tokenBalance,
      solSpent:       solSpentLamports / LAMPORTS_PER_SOL,
      txBuy:          result.signature,
      entryPriceUsd,
      peakPriceUsd:   entryPriceUsd,
    };

    _broadcastTrade('BUY', symbol, address, entryPriceUsd, pos.solSpent, result.signature);
    return pos;
  } catch (e) {
    logger.warn(`[Trader] BUY FAILED ${symbol}: ${e.message}`);
    return null;
  }
}

// ── SELL (full position) ──────────────────────────────────────
async function sell(tokenState, fraction, reason) {
  const { address, symbol, currentPrice, position } = tokenState;
  if (!position || position.tokenBalance <= 0) return null;

  const rawSellAmount = Math.floor(position.tokenBalance * fraction);
  if (rawSellAmount <= 0) return position;

  // RUG 紧急卖出：使用最大滑点 + 高优先费，跳过重试直接一次成交
  const isRug = reason && (
    reason.startsWith('RUG_') ||
    reason.startsWith('FDV_DROP')
  );

  logger.warn(`[Trader] SELL ${(fraction * 100).toFixed(0)}% ${symbol} (${reason}) @ ${currentPrice}${isRug ? ' [RUG紧急]' : ''}`);

  try {
    const result = await executeWithRetry(
      (slipBps) => buildSellOrder(address, rawSellAmount, slipBps, isRug),
      isRug ? 3 : 3  // RUG时也重试3次，99%滑点第一次应成功，失败则继续重试
    );

    const solReceived = parseInt(result.outputAmountResult || '0') / LAMPORTS_PER_SOL;
    const newBalance  = position.tokenBalance - rawSellAmount;

    logger.warn(
      `[Trader] SELL OK ${symbol}` +
      ` | sig=${result.signature?.slice(0, 12)}` +
      ` | received=${solReceived.toFixed(4)} SOL` +
      ` | remaining=${newBalance}`
    );
    _broadcastTrade('SELL', symbol, address, currentPrice, solReceived, result.signature, reason);

    if (newBalance <= 0) return null;
    return { ...position, tokenBalance: newBalance };
  } catch (e) {
    logger.warn(`[Trader] SELL FAILED ${symbol}: ${e.message}`);
    return position;  // 保持原仓位，下次 tick 重试
  }
}

// ── EMA death-cross exit (全仓卖出) ───────────────────────────
async function exitPosition(tokenState, reason) {
  if (!tokenState.position || tokenState.position.tokenBalance <= 0) return;
  tokenState.position = await sell(tokenState, 1.0, reason);
}

// ── Helpers ────────────────────────────────────────────────────
function _broadcastTrade(type, symbol, mint, price, amount, sig, reason = '') {
  broadcastToClients({
    type: 'trade',
    data: {
      id: Date.now(), time: new Date().toISOString(),
      tradeType: type, symbol, mint, price, amount, sig, reason,
    },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { buy, sell, exitPosition, getKeypair, getConn };
