// src/reporter.js — 每日报告生成器
// 北京时间 08:00 自动生成前一日交易记录 CSV，保留最近7份

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const REPORTS_DIR = path.join(__dirname, '../public/reports');
const MAX_REPORTS = 7;  // 最多保留7份

// 确保目录存在
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ── CSV 生成 ──────────────────────────────────────────────────
function recordsToCsv(records) {
  const headers = [
    '币种', '合约地址',
    '买入时间', '卖出时间', '持仓时长(分钟)',
    '买入FDV($)', '买入LP($)', 'LP/FDV(%)',
    'X提及', 'Holders', 'Top10占比', 'Dev占比',
    '卖出FDV($)', '当前FDV($)',
    '买入SOL', '卖出SOL', '盈亏SOL', '盈亏%',
    '退出原因',
    'GMGN链接',
  ];

  const rows = records.map(r => {
    const buyAt  = r.buyAt  ? new Date(r.buyAt).toLocaleString('zh-CN',  { timeZone: 'Asia/Shanghai' }) : '';
    const exitAt = r.exitAt ? new Date(r.exitAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '持仓中';
    const durMin = (r.buyAt && r.exitAt)
      ? Math.round((r.exitAt - r.buyAt) / 60000)
      : '';
    const pnlSol = (r.solReceived != null)
      ? (r.solReceived - r.solSpent).toFixed(4)
      : '';
    const gmgn = `https://gmgn.ai/sol/token/${r.address}`;

    return [
      r.symbol,
      r.address,
      buyAt,
      exitAt,
      durMin,
      r.entryFdv   ?? '',
      r.entryLp    ?? '',
      r.entryLpFdv ?? '',
      r.xMentions  ?? '',
      r.holders    ?? '',
      r.top10Pct   ?? '',
      r.devPct     ?? '',
      r.exitFdv    ?? '',
      r.currentFdv ?? '',
      r.solSpent   ?? '',
      r.solReceived ?? '',
      pnlSol,
      r.pnlPct     ?? '',
      r.exitReason ?? '持仓中',
      gmgn,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });

  return [headers.join(','), ...rows].join('\r\n');
}

// ── 生成报告文件 ──────────────────────────────────────────────
function generateReport(records) {
  const now   = new Date();
  // 报告标题用北京时间当天日期
  const bjDate = new Date(now.getTime() + 8 * 3600 * 1000);
  const dateStr = bjDate.toISOString().slice(0, 10);  // YYYY-MM-DD
  const filename = `report_${dateStr}.csv`;
  const filepath = path.join(REPORTS_DIR, filename);

  const csv = recordsToCsv(records);
  fs.writeFileSync(filepath, '\uFEFF' + csv, 'utf-8');  // BOM for Excel

  logger.info(`[Reporter] ✅ 报告已生成: ${filename} (${records.length} 笔)`);

  // 清理旧报告，只保留最近 MAX_REPORTS 份
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('report_') && f.endsWith('.csv'))
    .sort()
    .reverse();

  files.slice(MAX_REPORTS).forEach(f => {
    fs.unlinkSync(path.join(REPORTS_DIR, f));
    logger.info(`[Reporter] 🗑  已删除旧报告: ${f}`);
  });

  return filename;
}

// ── 获取报告列表 ──────────────────────────────────────────────
function listReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('report_') && f.endsWith('.csv'))
    .sort()
    .reverse()
    .map(f => {
      const stat = fs.statSync(path.join(REPORTS_DIR, f));
      return {
        filename: f,
        url:      `/reports/${f}`,
        size:     stat.size,
        date:     f.replace('report_', '').replace('.csv', ''),
        createdAt: stat.mtime.toISOString(),
      };
    });
}

// ── 定时调度：北京时间每天 08:00 触发 ─────────────────────────
//
// 原理：算出下一个北京时间 08:00 距现在的毫秒数，setTimeout 到那个时刻，
// 然后每 24h 重复一次。
function scheduleDaily(getRecordsFn) {
  function msUntilNext8am() {
    const now   = Date.now();
    const bjNow = new Date(now + 8 * 3600 * 1000);  // UTC+8
    // 今天 08:00 BJT 的 UTC 时间戳
    const target = new Date(Date.UTC(
      bjNow.getUTCFullYear(),
      bjNow.getUTCMonth(),
      bjNow.getUTCDate(),
      0, 0, 0, 0   // 00:00 UTC = 08:00 BJT
    ));
    let ms = target.getTime() - now;
    if (ms <= 0) ms += 24 * 3600 * 1000;  // 已过了，等明天
    return ms;
  }

  function runAndSchedule() {
    const records = getRecordsFn();
    if (records.length > 0) {
      generateReport(records);
    } else {
      logger.info('[Reporter] 今日无交易记录，跳过报告生成');
    }
    // 下次 08:00
    setTimeout(runAndSchedule, msUntilNext8am());
  }

  const ms = msUntilNext8am();
  const nextTime = new Date(Date.now() + ms);
  logger.info(`[Reporter] 下次报告生成时间: ${nextTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  setTimeout(runAndSchedule, ms);
}

module.exports = { scheduleDaily, generateReport, listReports };
