// src/birdeye.js — Birdeye API wrapper
const axios  = require('axios');
const logger = require('./logger');

const BASE = 'https://public-api.birdeye.so';
const KEY  = process.env.BIRDEYE_API_KEY || '';

const client = axios.create({
  baseURL: BASE,
  timeout: 8000,
  headers: {
    'X-API-KEY': KEY,
    'x-chain':   'solana',
  },
});

async function getPrice(address) {
  try {
    const { data } = await client.get('/defi/price', { params: { address } });
    return data?.data?.value ?? null;
  } catch (e) {
    logger.warn(`[Birdeye] getPrice ${address.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

async function getTokenOverview(address) {
  try {
    const { data } = await client.get('/defi/token_overview', { params: { address } });
    return data?.data ?? null;
  } catch (e) {
    logger.warn(`[Birdeye] getTokenOverview ${address.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/**
 * 获取最近 N 笔交易记录，用于 RUG 检测
 * 返回格式：[{ side: 'sell'|'buy', amountUsd: number, gasFee: number, wallet: string, time: number }]
 */
async function getTrades(address, limit = 30) {
  try {
    const { data } = await client.get('/defi/txs/token', {
      params: { address, limit, tx_type: 'swap' },
    });
    const list = data?.data?.items ?? [];
    return list.map(tx => ({
      side:      tx.side === 'sell' ? 'sell' : 'buy',
      amountUsd: tx.volumeUsd ?? 0,
      gasFee:    tx.fee ?? 0,
      wallet:    tx.owner ?? tx.source ?? '',
      time:      tx.blockUnixTime ?? 0,
    }));
  } catch (e) {
    logger.warn(`[Birdeye] getTrades ${address.slice(0, 8)}: ${e.message}`);
    return [];
  }
}

/**
 * 获取 Top N 持仓地址列表，用于判断是否是大户在清仓
 * 返回格式：[{ address: string, pct: number }]
 */
async function getTopHolders(address, limit = 20) {
  try {
    const { data } = await client.get('/defi/token_holder', {
      params: { address, limit },
    });
    const list = data?.data?.items ?? [];
    return list.map(h => ({
      address: h.address ?? h.owner ?? '',
      pct:     h.percentage ?? 0,
    }));
  } catch (e) {
    logger.warn(`[Birdeye] getTopHolders ${address.slice(0, 8)}: ${e.message}`);
    return [];
  }
}

/**
 * 获取代币的 Raydium 流动性池地址（用于 WebSocket 订阅）
 * 返回池子地址字符串，或 null
 */
async function getPoolAddress(tokenAddress) {
  try {
    const { data } = await client.get('/defi/token_markets', {
      params: { address: tokenAddress, sort_by: 'liquidity', sort_type: 'desc', limit: 1 },
    });
    const markets = data?.data?.items ?? data?.data ?? [];
    const first   = Array.isArray(markets) ? markets[0] : null;
    // Birdeye 返回字段可能是 address / pairAddress / id
    return first?.address ?? first?.pairAddress ?? first?.id ?? null;
  } catch (e) {
    logger.warn(`[Birdeye] getPoolAddress ${tokenAddress.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

module.exports = { getPrice, getTokenOverview, getTrades, getTopHolders, getPoolAddress };
