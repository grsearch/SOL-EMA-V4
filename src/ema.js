// src/ema.js — EMA calculation + SELL signal logic
//
// ═══════════════════════════════════════════════════════════════
//  SELL 策略（V5 修改版）：EMA9 向下收窄 + 交叉瞬间立即卖出
// ═══════════════════════════════════════════════════════════════
//
//  触发条件（三个同时成立，立即卖出，不等确认）：
//    1. EMA9 正在向下运动        (ema9_now < ema9_prev)
//    2. EMA9 与 EMA20 差距收窄  (|ema9_now - ema20_now| < |ema9_prev - ema20_prev|)
//    3. EMA9 从上方穿越 EMA20   (ema9_prev >= ema20_prev  AND  ema9_now < ema20_now)
//
//  核心改变：
//    - 原逻辑：等死叉后再连续2次确认 → 太晚
//    - 新逻辑：死叉发生的那根K线，同时满足"向下+收窄"，立即触发
//    - CONFIRM_BARS 不再用于主卖出信号，保留用于"保底死叉"兜底逻辑
//
//  兜底逻辑（保险）：
//    若主信号因某种原因未触发，EMA9 < EMA20 且 EMA20 斜率向下
//    连续 CONFIRM_BARS 次仍可触发卖出，防止漏单。

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
 * ─── 主卖出信号（优先）────────────────────────────────────────
 *  EMA9 向下 + 差距收窄 + 交叉瞬间 → 立即卖出（0确认延迟）
 *
 * ─── 兜底信号（保险）─────────────────────────────────────────
 *  EMA9 < EMA20 且 EMA20 斜率向下，连续 CONFIRM_BARS 次 → 卖出
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
  const ema9_prev  = ema9s[len - 2];
  const ema20_prev = ema20s[len - 2];

  if (isNaN(ema9_now) || isNaN(ema20_now) || isNaN(ema9_prev) || isNaN(ema20_prev)) {
    tokenState.bearishCount = 0;
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'ema_nan' };
  }

  // ─── 主信号：EMA9向下 + 差距收窄 + 交叉瞬间 ─────────────────
  const ema9_falling   = ema9_now < ema9_prev;
  const gap_now        = Math.abs(ema9_now  - ema20_now);
  const gap_prev       = Math.abs(ema9_prev - ema20_prev);
  const gap_narrowing  = gap_now < gap_prev;
  const crossunder     = ema9_prev >= ema20_prev && ema9_now < ema20_now; // 从上方穿越到下方

  if (ema9_falling && gap_narrowing && crossunder) {
    tokenState.bearishCount = 0; // 重置兜底计数器
    return {
      ema9:   ema9_now,
      ema20:  ema20_now,
      signal: 'SELL',
      reason: `EMA9↓收窄交叉 gap=${gap_now.toExponential(2)} prev=${gap_prev.toExponential(2)}`,
    };
  }

  // ─── 兜底信号：经典死叉 + EMA20下行 × CONFIRM_BARS ──────────
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
