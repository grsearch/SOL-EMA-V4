// src/ema.js — EMA calculation + SELL signal logic
//
// 沿用 PUMP-EMA-15S 经过实战验证的策略：
//
// SELL trigger (anti-shake):
//   EMA9 < EMA20  AND  EMA20 is declining (EMA20_now < EMA20_prev)
//   must hold for EMA_CONFIRM_BARS (default 2) consecutive candle evaluations.
//
// 不使用种子K线、不使用预热跳过、不要求"下穿"动作。
// EMA 自然预热：EMA20 需要至少 21 根K线才产生有效值，
// 15秒K线 × 21 = 315秒 ≈ 5分钟，这段时间就是自然预热期。
//
// Once SELL fires, monitor.js sets exitSent=true immediately, so
// evaluateSignal() is never called again for that token.

const EMA_FAST       = parseInt(process.env.EMA_FAST           || '9');
const EMA_SLOW       = parseInt(process.env.EMA_SLOW           || '20');
const CONFIRM_BARS   = parseInt(process.env.EMA_CONFIRM_BARS   || '2');
const KLINE_INTERVAL = parseInt(process.env.KLINE_INTERVAL_SEC || '15');

/**
 * Calculate EMA array for a price series (oldest-first).
 * Seeded with SMA for the first window, then standard EMA formula.
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
 * tokenState.bearishCount is the only mutable field touched here.
 *
 * SELL条件（与 PUMP-EMA-15S 完全一致）：
 *   1. EMA9 < EMA20（快线在慢线下方）
 *   2. EMA20 斜率向下（EMA20_now < EMA20_prev）
 *   3. 以上两个条件连续 CONFIRM_BARS 次评估都成立
 *
 * 不要求"下穿"动作 — 只要 EMA9 在 EMA20 下方且 EMA20 在下行就算死叉
 * 这解决了"预热期内死叉后永远不卖"的 bug
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const ema9s  = calcEMA(closes, EMA_FAST);
  const ema20s = calcEMA(closes, EMA_SLOW);
  const len    = closes.length;

  // Need at least EMA_SLOW+1 bars: EMA_SLOW to compute EMA20, +1 to compare prev
  if (len < EMA_SLOW + 1) {
    tokenState.bearishCount = 0;
    return { ema9: NaN, ema20: NaN, signal: null, reason: `warming_up(${len}/${EMA_SLOW + 1})` };
  }

  const ema9_now   = ema9s[len - 1];
  const ema20_now  = ema20s[len - 1];
  const ema20_prev = ema20s[len - 2];

  if (isNaN(ema9_now) || isNaN(ema20_now) || isNaN(ema20_prev)) {
    tokenState.bearishCount = 0;
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'ema_nan' };
  }

  const bearish   = ema9_now < ema20_now;      // EMA9 below EMA20
  const declining = ema20_now < ema20_prev;     // EMA20 slope downward

  // Both conditions must hold simultaneously; one break resets the counter
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
      reason: `EMA${EMA_FAST}<EMA${EMA_SLOW} & EMA${EMA_SLOW}↓ ×${tokenState.bearishCount}bars`,
    };
  }

  return { ema9: ema9_now, ema20: ema20_now, signal: null, reason: '' };
}

/**
 * Aggregate raw price ticks into fixed-width OHLCV candles.
 * Gaps (no ticks in a bucket) are forward-filled from previous close.
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
