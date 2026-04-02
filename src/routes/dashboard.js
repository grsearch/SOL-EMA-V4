// src/routes/dashboard.js — REST API for dashboard
const express          = require('express');
const router           = express.Router();
const trader           = require('../trader');
const { TokenMonitor } = require('../monitor');

// GET /api/dashboard — full snapshot
router.get('/dashboard', (req, res) => {
  res.json(TokenMonitor.getInstance().getDashboardData());
});

// GET /api/tokens — whitelist summary
router.get('/tokens', (req, res) => {
  const tokens = [...TokenMonitor.getInstance().tokens.values()].map(s => ({
    address:      s.address,
    symbol:       s.symbol,
    age:          s.age,
    lp:           s.lp,
    fdv:          s.fdv,
    currentPrice: s.currentPrice,
    entryPrice:   s.position?.entryPrice  ?? null,
    peakPrice:    s.position?.peakPrice   ?? null,
    tokenBalance: s.position?.tokenBalance ?? 0,

    pnlPct:       s.pnlPct,
    lastSignal:   s.lastSignal,
    inPosition:   s.inPosition,
    approved:     s.approved,
    ema9:         isNaN(s.ema9)  ? null : +s.ema9.toFixed(10),
    ema20:        isNaN(s.ema20) ? null : +s.ema20.toFixed(10),
    addedAt:      s.addedAt,
    exitSent:     s.exitSent,
  }));
  res.json(tokens);
});

// GET /api/trades — recent trade log
router.get('/trades', (req, res) => {
  res.json(TokenMonitor.getInstance().tradeLog.slice(0, 100));
});

// DELETE /api/tokens/:address — manual removal with full exit
router.delete('/tokens/:address', async (req, res) => {
  const monitor = TokenMonitor.getInstance();
  const state   = monitor.tokens.get(req.params.address);

  if (!state) return res.status(404).json({ ok: false, error: 'Token not found' });

  if (state.inPosition && state.position && !state.exitSent) {
    await trader.exitPosition(state, 'MANUAL_REMOVE');
    state.inPosition = false;
    state.position   = null;
    state.lastSignal = 'SELL';
    // ← 修复：写入退出信息，stats 页面不再显示"持仓中"
    monitor._finalizeTradeRecord(state, 'MANUAL_REMOVE');
    monitor._addTradeLog({ type: 'SELL', symbol: state.symbol, reason: 'MANUAL_REMOVE' });
  }

  state.exitSent   = true;
  state.inPosition = false;
  state.position   = null;
  monitor._removeToken(state.address, 'MANUAL_REMOVE');
  res.json({ ok: true });
});

// GET /api/trade-records — 24h complete trade records for stats dashboard
router.get('/trade-records', (req, res) => {
  res.json(TokenMonitor.getInstance().getTradeRecords());
});

module.exports = router;
