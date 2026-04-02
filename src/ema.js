// src/ema.js — EMA calculation + SELL signal logic
//
// Candle width: KLINE_INTERVAL_SEC (default 15 = 15秒K线)
// Price poll  : PRICE_POLL_SEC     (default 5  = 5秒轮询)
//
// BUY  : 收录即买，由 monitor._fetchMetaAndBuy() 直接执行，本模块不处理
// SELL : EMA9 下穿 EMA20 立即卖出（上一根K线EMA9>=EMA20，当前EMA9<EMA20）

const EMA_FAST  = parseInt(process.env.EMA_FAST           || '9');
const EMA_SLOW  = parseInt(process.env.EMA_SLOW           || '20');
const KLINE_SEC = parseInt(process.env.KLINE_INTERVAL_SEC || '15');

// EMA 预热保护：买入后至少等待这么多根K线再开始判断死叉
// 防止刚买入时 EMA 尚未稳定就误判
const WARMUP_CANDLES = parseInt(process.env.EMA_WARMUP_CANDLES || '5');

/**
 * Calculate EMA array for a price series (oldest-first).
 * Seeded with SMA for the first `period` values.
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
 * Evaluate SELL signal from candles (including current unfinished candle).
 * BUY is handled upstream (收录即买)，本函数只判断死叉出场。
 *
 * SELL条件：EMA9 下穿 EMA20（死叉），立即触发
 *   - 上一根K线 EMA9 >= EMA20（在上方或相交）
 *   - 当前K线   EMA9 <  EMA20（穿到下方）
 *   - 内置预热保护：买入后前 WARMUP_CANDLES 根K线不触发
 *
 * Returns: { ema9, ema20, signal: null|'SELL', reason }
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const ema9s  = calcEMA(closes, EMA_FAST);
  const ema20s = calcEMA(closes, EMA_SLOW);
  const len    = closes.length;

  // EMA20 至少需要 EMA_SLOW+1 根K线（当前+上一根都有有效值才能比较）
  if (len < EMA_SLOW + 1) {
    return { ema9: NaN, ema20: NaN, signal: null, reason: `warming_up(${len}/${EMA_SLOW + 1})` };
  }

  const ema9_now   = ema9s[len - 1];
  const ema20_now  = ema20s[len - 1];
  const ema9_prev  = ema9s[len - 2];
  const ema20_prev = ema20s[len - 2];

  if (isNaN(ema9_now) || isNaN(ema20_now) || isNaN(ema9_prev) || isNaN(ema20_prev)) {
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'ema_nan' };
  }

  // 预热保护：买入后前几根K线不触发，等 EMA 值稳定
  // candlesSinceBuy 由 monitor 设置
  const candlesSinceBuy = tokenState._candlesSinceBuy || 0;
  if (candlesSinceBuy < WARMUP_CANDLES) {
    return {
      ema9: ema9_now, ema20: ema20_now, signal: null,
      reason: `warmup(${candlesSinceBuy}/${WARMUP_CANDLES})`,
    };
  }

  // 死叉判断：EMA9 从上方穿越到下方（下穿）→ 立即卖出
  //   上一根K线 EMA9 >= EMA20（在上方或相交）
  //   当前K线   EMA9 <  EMA20（穿到下方）
  const wasAboveOrEqual = ema9_prev >= ema20_prev;
  const nowBelow        = ema9_now  <  ema20_now;

  if (wasAboveOrEqual && nowBelow) {
    return {
      ema9: ema9_now, ema20: ema20_now, signal: 'SELL',
      reason: `EMA${EMA_FAST}下穿EMA${EMA_SLOW}_死叉卖出`,
    };
  }

  return { ema9: ema9_now, ema20: ema20_now, signal: null, reason: '' };
}

/**
 * Aggregate raw price ticks into fixed-width OHLCV candles.
 * Empty buckets are forward-filled from previous close.
 */
function buildCandles(ticks, intervalSec = KLINE_SEC) {
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

module.exports = { calcEMA, evaluateSignal, buildCandles, EMA_FAST, EMA_SLOW, WARMUP_CANDLES };
