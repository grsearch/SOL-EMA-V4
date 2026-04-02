# SOL EMA Monitor v2

Solana 新币 EMA9/EMA20 策略监控 + Jupiter 自动交易机器人。

15秒K线 · 1秒价格轮询 · 30分钟监控窗口 · EMA死叉清仓 · 防夹保护

---

## 策略逻辑

### 买入条件
```
扫描服务器发送代币到白名单
→ 查询 FDV 和 LP
→ $15,000 ≤ FDV ≤ $60,000 且 LP ≥ $5,000
→ 立即用 TRADE_SIZE_SOL 买入
→ 条件不满足则静默拒绝，不跟踪
```

### 出场策略

| 优先级 | 条件 | 行为 |
|--------|------|------|
| 1 | EMA9 < EMA20 且 EMA20 斜率向下，连续2次确认 | 全仓卖出 |
| 2 | FDV 跌破 $15,000 | 立即清仓（不等EMA预热，30秒检查一次） |
| 3 | 监控30分钟到期 | 清仓退出，移除白名单 |

- **15秒K线聚合**：1秒轮询采集价格，每15秒聚合一根K线
- **自然预热**：EMA20需要21根K线（约5分钟）才能计算，预热期内不触发任何信号
- **防震荡确认**：死叉条件需连续2次评估都成立才触发（EMA_CONFIRM_BARS=2）
- **沿用 PUMP-EMA-15S 实战验证的策略**，不使用种子K线

---

## 目录结构

```
sol-ema-v2/
├── src/
│   ├── index.js        # 主入口，HTTP + WebSocket
│   ├── monitor.js      # 核心引擎（1s轮询、15sK线、EMA死叉判断）
│   ├── ema.js          # EMA计算 + SELL信号（EMA9<EMA20 & EMA20↓ ×2确认）
│   ├── trader.js       # Jupiter交易（买入/卖出）
│   ├── birdeye.js      # Birdeye API封装
│   ├── reporter.js     # 每日报告
│   ├── wsHub.js        # WebSocket广播
│   ├── logger.js       # 日志
│   └── routes/
│       ├── webhook.js  # POST /webhook/add-token
│       └── dashboard.js# REST API
├── public/
│   ├── index.html      # 实时Dashboard
│   └── stats.html      # 24h交易统计
├── .env.example
├── deploy.sh
└── package.json
```

---

## 快速部署

### 1. 上传代码到服务器

```bash
scp -r sol-ema-v2/ ubuntu@YOUR_SERVER_IP:~/
ssh ubuntu@YOUR_SERVER_IP
cd ~/sol-ema-v2
```

### 2. 一键部署

```bash
bash deploy.sh
```

### 3. 填写配置

```bash
nano .env
```

**必填项：**
```
BIRDEYE_API_KEY=       # Birdeye API Key
HELIUS_RPC_URL=        # https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=        # Helius API Key
WALLET_PRIVATE_KEY=    # 钱包Base58私钥（仅用于签名，不存储）
TRADE_SIZE_SOL=0.2     # 每笔交易买入的SOL数量
```

```bash
sudo systemctl restart sol-ema-monitor
```

### 4. 开放端口

```bash
sudo ufw allow 3001/tcp
```

### 5. 访问 Dashboard

```
http://YOUR_SERVER_IP:3001
```

---

## 防夹（Anti-Sandwich）机制

1. **Jito MEV保护**（`USE_JITO=true`）：交易打包进Jito bundle，绕过公共mempool
2. **优先费**（`PRIORITY_FEE_MICROLAMPORTS=100000`）：确保交易被优先打包
3. **Jito Tip**（`JITO_TIP_LAMPORTS=1000000` ≈ 0.001 SOL）：支付给Jito验证者
4. **双倍滑点卖出**：卖出时slippage翻倍（最大20%），确保卖出单成交

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BIRDEYE_API_KEY` | — | Birdeye API Key（必填） |
| `HELIUS_RPC_URL` | — | Helius私有RPC URL（必填） |
| `HELIUS_API_KEY` | — | Helius API Key（必填） |
| `JUPITER_API_URL` | `https://api.jup.ag` | Jupiter API |
| `JUPITER_API_KEY` | — | Jupiter API Key |
| `WALLET_PRIVATE_KEY` | — | 交易钱包Base58私钥（必填） |
| `TRADE_SIZE_SOL` | `0.2` | 每笔买入SOL数量 |
| `SLIPPAGE_BPS` | `300` | 滑点（100=1%） |
| `TOKEN_MAX_AGE_MINUTES` | `30` | 监控窗口（分钟） |
| `FDV_MIN_USD` | `15000` | 买入最低FDV门槛 |
| `FDV_MAX_USD` | `60000` | 买入最高FDV门槛 |
| `LP_MIN_USD` | `5000` | 最低LP门槛 |
| `EMA_FAST` | `9` | EMA快线周期 |
| `EMA_SLOW` | `20` | EMA慢线周期 |
| `EMA_CONFIRM_BARS` | `2` | 死叉确认次数（连续N次EMA9<EMA20且EMA20↓） |
| `PRICE_POLL_SEC` | `1` | 价格轮询间隔（秒） |
| `KLINE_INTERVAL_SEC` | `15` | K线宽度（秒） |
| `PORT` | `3001` | HTTP端口 |

---

## API

```bash
# 添加代币（来自扫描服务器）
curl -X POST http://YOUR_SERVER:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"TOKEN_ADDRESS","symbol":"TOKEN_SYMBOL"}'

# 查询接口
curl http://YOUR_SERVER:3001/api/dashboard
curl http://YOUR_SERVER:3001/api/tokens
curl http://YOUR_SERVER:3001/api/trades
curl http://YOUR_SERVER:3001/api/trade-records

# 手动移除（有持仓自动卖出）
curl -X DELETE http://YOUR_SERVER:3001/api/tokens/TOKEN_ADDRESS
```

---

## 常见问题

**Q: EMA显示 WARMING UP？**
A: 正常。EMA20需要至少20根15秒K线（≈5分钟）才能计算。预热期内不会触发卖出信号，但买入不受影响（收录即买）。另外买入后额外有5根K线的预热保护期（约75秒），防止EMA值不稳定时误判。

**Q: 交易失败怎么处理？**
A: trader.js 内置动态滑点重试（最多3次，滑点每次×1.5，上限20%）。连续失败后不会再次尝试，等待下一个信号。

**Q: 如何调整仓位大小？**
A: 修改 `TRADE_SIZE_SOL`。建议从小仓位（0.05~0.1 SOL）开始测试。

**Q: 如何查看EMA实时状态？**
A: 日志中每次轮询都会打印 `[EMA]` 行，包含 EMA9/EMA20 值、差距百分比和信号状态。使用 `journalctl -u sol-ema-monitor -f` 实时查看。
