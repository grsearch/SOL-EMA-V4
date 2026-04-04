// src/ema.js — EMA calculation + SELL signal logic
//
// ═══════════════════════════════════════════════════════════════
//  SELL 策略（V5.1）：死叉瞬间立即卖出
// ═══════════════════════════════════════════════════════════════
//
//  触发条件（满足即立即卖出，0延迟，0确认）：
//
//    EMA9 从上方穿越 EMA20 的那一根K线：
//      ema9_prev >= ema20_prev  AND  ema9_now < ema20_now
//
//  为什么去掉"收窄"条件：
//    价格急速下跌时 EMA9 大步穿越 EMA20，差距不一定收窄，
//    加了收窄反而漏掉最佳出场点。
//
//  兜底逻辑（保险）：
//    若穿越时 EMA9 已经在 EMA20 下方（极端行情下已错过交叉），
//    EMA9 < EMA20 且 EMA20 斜率向下，连续 CONFIRM_BARS 次 → 卖出。

const EMA_FAST       = parseInt(process.env.EMA_FAST           || '9');
const EMA_SLOW       = parseInt(process.env.EMA_SLOW           || '20');
const CONFIRM_BARS   = parseInt(process.env.EMA_CONFIRM_BARS   || '2');
const KLINE_INTERVAL = parseInt(process.env.KLINE_INTERVAL_SEC || '15');

/**
 * Calculate EMA array for a price series (oldest-first).
 */
function calcEMA(closes, period) {
  const k      = 2 / (period + 1);
  const result = new Array(closes.length).fill(NaN);
  let prev     = null;

  for (let i = 0; i < closes.length; i++) {
    if (prev === null) {
      if (i >= period - 1) {
        prev      = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
        result[i] = prev;
      }
    } else {
      prev      = closes[i] * k + prev * (1 - k);
      result[i] = prev;
    }
  }
  return result;
}

/**
 * Evaluate whether a SELL signal should fire.
 *
 * ─── 主卖出信号（优先，0延迟）────────────────────────────────
 *  EMA9 从上方穿越 EMA20 的那根K线 → 立即卖出
 *
 * ─── 兜底信号────────────────────────────────────────────────
 *  EMA9 < EMA20 且 EMA20 斜率向下，连续 CONFIRM_BARS 次 → 卖出
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const ema9s  = calcEMA(closes, EMA_FAST);
  const ema20s = calcEMA(closes, EMA_SLOW);
  const len    = closes.length;

  if (len < EMA_SLOW + 1) {
    tokenState.bearishCount = 0;
    return { ema9: NaN, ema20: NaN, signal: null, reason: `warming_up(${len}/${EMA_SLOW + 1})` };
  }

  const ema9_now   = ema9s[len - 1];
  const ema20_now  = ema20s[len - 1];
  const ema9_prev  = ema9s[len - 2];
  const ema20_prev = ema20s[len - 2];

  if (isNaN(ema9_now) || isNaN(ema20_now) || isNaN(ema9_prev) || isNaN(ema20_prev)) {
    tokenState.bearishCount = 0;
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'ema_nan' };
  }

  // ─── 主信号：死叉瞬间（上穿变下穿）立即卖出 ─────────────────
  //  上一根K线结束时 EMA9 >= EMA20，这根K线结束时 EMA9 < EMA20
  const crossunder = ema9_prev >= ema20_prev && ema9_now < ema20_now;

  if (crossunder) {
    tokenState.bearishCount = 0;
    return {
      ema9:   ema9_now,
      ema20:  ema20_now,
      signal: 'SELL',
      reason: `死叉瞬间 EMA9穿越 prev(${ema9_prev.toFixed(0)}>=${ema20_prev.toFixed(0)}) now(${ema9_now.toFixed(0)}<${ema20_now.toFixed(0)})`,
    };
  }

  // ─── 兜底信号：EMA9已在下方 + EMA20下行 × CONFIRM_BARS ──────
  const bearish   = ema9_now < ema20_now;
  const declining = ema20_now < ema20_prev;

  if (bearish && declining) {
    tokenState.bearishCount = (tokenState.bearishCount || 0) + 1;
  } else {
    tokenState.bearishCount = 0;
  }

  if (tokenState.bearishCount >= CONFIRM_BARS) {
    return {
      ema9:   ema9_now,
      ema20:  ema20_now,
      signal: 'SELL',
      reason: `兜底死叉 EMA${EMA_FAST}<EMA${EMA_SLOW} & EMA${EMA_SLOW}↓ ×${tokenState.bearishCount}bars`,
    };
  }

  return { ema9: ema9_now, ema20: ema20_now, signal: null, reason: '' };
}

/**
 * Aggregate raw price ticks into fixed-width OHLCV candles.
 */
function buildCandles(ticks, intervalSec = KLINE_INTERVAL) {
  if (!ticks.length) return [];

  const intervalMs = intervalSec * 1000;
  const candles    = [];
  let bucketStart  = Math.floor(ticks[0].time / intervalMs) * intervalMs;
  let current      = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.time / intervalMs) * intervalMs;

    if (bucket !== bucketStart) {
      if (current) candles.push(current);

      let gap = bucketStart + intervalMs;
      while (gap < bucket) {
        const prev = candles[candles.length - 1];
        candles.push({
          time: gap, open: prev.close, high: prev.close,
          low: prev.close, close: prev.close, volume: 0,
        });
        gap += intervalMs;
      }

      bucketStart = bucket;
      current     = null;
    }

    if (!current) {
      current = {
        time: bucket, open: tick.price, high: tick.price,
        low: tick.price, close: tick.price, volume: 1,
      };
    } else {
      if (tick.price > current.high) current.high = tick.price;
      if (tick.price < current.low)  current.low  = tick.price;
      current.close = tick.price;
      current.volume++;
    }
  }

  if (current) candles.push(current);
  return candles;
}

module.exports = { calcEMA, evaluateSignal, buildCandles, EMA_FAST, EMA_SLOW };
