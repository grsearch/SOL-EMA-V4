# SOL EMA Monitor v2

Solana 新币 EMA9/EMA20 策略监控 + Jupiter 自动交易机器人。

5分钟K线 · 1分钟价格轮询 · 2小时监控窗口 · 分批止盈 · 防夹保护

---

## 核心变化（vs v1）

| 项目 | v1 | v2 |
|------|----|----|
| K线周期 | 15秒 | **5分钟** |
| 价格轮询 | 5秒 | **1分钟** |
| 监控窗口 | 60分钟 | **2小时** |
| FDV门槛 | $10,000 | **$15,000–$60,000** |
| 交易方式 | 发Webhook到外部机器人 | **Jupiter API直接执行** |
| 买入策略 | EMA金叉确认后买入 | **收录即买（FDV+LP合格立即买入）** |
| 止盈策略 | EMA死叉全仓出 | **分批止盈 + 移动止损** |
| 防夹保护 | 无 | **Jito MEV保护 + 优先费** |

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

### 出场优先级（由高到低）

| 优先级 | 条件 | 行为 |
|--------|------|------|
| 1 | 价格跌破入场价 -25% | 硬止损，全仓清出 |
| 2 | 峰值回撤 -30%（仅在盈利50%+后激活） | 移动止损，全仓清出 |
| 3 | TP1: 盈利 +100% | 卖出剩余仓位的 33% |
| 3 | TP2: 盈利 +200% | 卖出剩余仓位的 33% |
| 3 | TP3: 盈利 +400% | 卖出剩余仓位的 50% |
| 4 | EMA9 下穿 EMA20（死叉）| 清仓剩余全部 |
| 5 | FDV跌破 $10,000 | 强制清仓退出 |
| 6 | 监控2小时到期 | 清仓退出，移除白名单 |

---

## 目录结构

```
sol-ema-monitor-v2/
├── src/
│   ├── index.js        # 主入口，HTTP + WebSocket
│   ├── monitor.js      # 核心引擎（轮询、K线、策略调度）
│   ├── ema.js          # EMA计算 + SELL信号（仅出场）
│   ├── trader.js       # Jupiter交易机器人（买入/卖出/止盈/止损）
│   ├── birdeye.js      # Birdeye API封装
│   ├── wsHub.js        # WebSocket广播
│   ├── logger.js       # 日志
│   └── routes/
│       ├── webhook.js  # POST /webhook/add-token
│       └── dashboard.js# REST API
├── public/
│   └── index.html      # 实时Dashboard（含分批止盈进度）
├── .env.example
├── deploy.sh
└── package.json
```

---

## 快速部署

### 1. 上传代码到服务器

```bash
scp -r sol-ema-monitor-v2/ ubuntu@YOUR_SERVER_IP:~/
ssh ubuntu@YOUR_SERVER_IP
cd ~/sol-ema-monitor-v2
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
TRADE_SIZE_SOL=0.1     # 每笔交易买入的SOL数量
```

```bash
sudo systemctl restart sol-ema-monitor
```

### 4. 开放端口

```bash
sudo ufw allow 3001/tcp
# 或腾讯云安全组添加 TCP 3001 入站规则
```

### 5. 访问 Dashboard

```
http://YOUR_SERVER_IP:3001
```

---

## 防夹（Anti-Sandwich）机制

1. **Jito MEV保护**（`USE_JITO=true`）：交易打包进Jito bundle，绕过公共mempool，无法被三明治攻击
2. **优先费**（`PRIORITY_FEE_MICROLAMPORTS=100000`）：确保交易被优先打包
3. **Jito Tip**（`JITO_TIP_LAMPORTS=1000000` ≈ 0.001 SOL）：支付给Jito验证者
4. **双倍滑点卖出**：卖出时slippage翻倍（最大10%），确保止损单一定成交

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BIRDEYE_API_KEY` | — | Birdeye API Key（必填） |
| `HELIUS_RPC_URL` | — | Helius私有RPC URL（必填） |
| `HELIUS_API_KEY` | — | Helius API Key（必填） |
| `JUPITER_API_URL` | `https://api.jup.ag` | Jupiter API（Pro I自动使用） |
| `WALLET_PRIVATE_KEY` | — | 交易钱包Base58私钥（必填） |
| `TRADE_SIZE_SOL` | `0.1` | 每笔买入SOL数量 |
| `SLIPPAGE_BPS` | `300` | 滑点（100=1%，300=3%） |
| `USE_JITO` | `true` | 是否使用Jito MEV保护 |
| `JITO_TIP_LAMPORTS` | `1000000` | Jito小费（lamports） |
| `PRIORITY_FEE_MICROLAMPORTS` | `100000` | 优先费（microlamports/CU） |
| `TP_ENABLED` | `false` | 是否启用分批止盈（false=EMA死叉一次性清仓） |
| `TP1_PCT` / `TP1_SELL` | `100` / `33` | 第1止盈：+100%时卖出33% |
| `TP2_PCT` / `TP2_SELL` | `200` / `33` | 第2止盈：+200%时卖出33% |
| `TP3_PCT` / `TP3_SELL` | `400` / `50` | 第3止盈：+400%时卖出50% |
| `STOP_LOSS_PCT` | `25` | 硬止损：跌25%清仓 |
| `TRAIL_PCT` | `30` | 移动止损：峰值回撤30%清仓 |
| `TRAIL_ACTIVATE_PCT` | `50` | 移动止损激活门槛：峰值涨幅超过50%后激活 |
| `TOKEN_MAX_AGE_MINUTES` | `120` | 监控窗口（分钟） |
| `FDV_MIN_USD` | `15000` | 买入最低FDV门槛（$） |
| `FDV_MAX_USD` | `60000` | 买入最高FDV门槛（$） |
| `LP_MIN_USD` | `5000` | 最低LP门槛（$） |
| `EMA_FAST` / `EMA_SLOW` | `9` / `20` | EMA周期 |
| `EMA_CONFIRM_BARS` | `2` | 防震荡确认K线数 |
| `PRICE_POLL_SEC` | `1` | 价格轮询间隔（秒） |
| `KLINE_INTERVAL_SEC` | `300` | K线宽度（秒） |
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

# 手动移除（有持仓自动卖出）
curl -X DELETE http://YOUR_SERVER:3001/api/tokens/TOKEN_ADDRESS
```

---

## 常见问题

**Q: 钱包私钥安全吗？**
A: 私钥仅存在 `.env` 文件中，用于本地签名交易。不会发送到任何第三方服务。建议专门创建一个交易用小钱包，存入适量SOL，不要用主钱包。

**Q: EMA显示 WARMING UP？**
A: 正常。EMA20需要至少21根5分钟K线（≈1小时45分钟）才能计算。预热期内不会触发任何卖出信号，但买入不受影响（收录即买）。

**Q: Jito保护不生效怎么办？**
A: 设置 `USE_JITO=false` 回退到标准模式。同时可以适当提高 `PRIORITY_FEE_MICROLAMPORTS`。

**Q: 交易失败怎么处理？**
A: trader.js 内置动态滑点重试（最多3次，滑点每次×1.5，上限20%）。连续失败后不会再次尝试，等待下一个信号。查看 `logs/trades.log` 了解详情。

**Q: 如何调整仓位大小？**
A: 修改 `TRADE_SIZE_SOL`。建议从小仓位（0.05~0.1 SOL）开始测试。
