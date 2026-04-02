#!/bin/bash
# ============================================================
# deploy.sh — SOL EMA Monitor v2  (Ubuntu 22.04 + systemd)
# Usage: bash deploy.sh
# ============================================================
set -e

DEPLOY_USER="${SUDO_USER:-$USER}"
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="sol-ema-monitor"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "========================================="
echo " SOL EMA Monitor v2 — Deploy"
echo " User : $DEPLOY_USER"
echo " Dir  : $INSTALL_DIR"
echo "========================================="

# ── 1. Node.js 18 ────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[1/5] Installing Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1/5] Node.js $(node -v) already installed"
fi
NODE_BIN="$(command -v node)"

# ── 2. npm install ───────────────────────────────────────────
echo "[2/5] npm install..."
npm install --production

# ── 3. .env ──────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo "[3/5] Creating .env from template..."
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  echo ""
  echo "  ⚠️  请填写 .env 后再启动服务:"
  echo "      nano $INSTALL_DIR/.env"
  echo ""
  echo "  必填项: BIRDEYE_API_KEY  HELIUS_RPC_URL"
  echo "          HELIUS_API_KEY  WALLET_PRIVATE_KEY"
  echo ""
else
  echo "[3/5] .env already exists — skipping"
fi

# ── 4. Directories ───────────────────────────────────────────
mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/data"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$INSTALL_DIR/logs" "$INSTALL_DIR/data" 2>/dev/null || true
echo "[4/5] Directories ready"

# ── 5. systemd unit — hardened ───────────────────────────────
echo "[5/5] Writing hardened systemd service..."

# 使用 printf 写文件，避免 heredoc 的变量展开陷阱
UNIT_FILE="/tmp/${SERVICE_NAME}.service"

printf '[Unit]\n' > "$UNIT_FILE"
printf 'Description=SOL EMA Monitor v2 — Jupiter Trading Bot\n' >> "$UNIT_FILE"
printf 'After=network-online.target\n' >> "$UNIT_FILE"
printf 'Wants=network-online.target\n' >> "$UNIT_FILE"
printf '\n' >> "$UNIT_FILE"
printf '[Service]\n' >> "$UNIT_FILE"
printf 'Type=simple\n' >> "$UNIT_FILE"
printf 'User=%s\n' "$DEPLOY_USER" >> "$UNIT_FILE"
printf 'Group=%s\n' "$DEPLOY_USER" >> "$UNIT_FILE"
printf 'WorkingDirectory=%s\n' "$INSTALL_DIR" >> "$UNIT_FILE"
printf 'EnvironmentFile=%s/.env\n' "$INSTALL_DIR" >> "$UNIT_FILE"
printf 'ExecStart=%s src/index.js\n' "$NODE_BIN" >> "$UNIT_FILE"
printf '\n' >> "$UNIT_FILE"
printf '# ── 重启策略 ──────────────────────────────────────────\n' >> "$UNIT_FILE"
printf '# on-failure: 崩溃/信号/超时均触发重启，正常 SIGTERM 不重启\n' >> "$UNIT_FILE"
printf 'Restart=on-failure\n' >> "$UNIT_FILE"
printf 'RestartSec=5s\n' >> "$UNIT_FILE"
printf '# 60s 内最多重启 10 次，超过则进入 failed，防止崩溃死循环\n' >> "$UNIT_FILE"
printf 'StartLimitIntervalSec=60s\n' >> "$UNIT_FILE"
printf 'StartLimitBurst=10\n' >> "$UNIT_FILE"
printf '\n' >> "$UNIT_FILE"
printf '# ── 资源限制 ──────────────────────────────────────────\n' >> "$UNIT_FILE"
printf 'LimitNOFILE=65536\n' >> "$UNIT_FILE"
printf 'LimitNPROC=4096\n' >> "$UNIT_FILE"
printf '# Node 堆内存上限 1.5 GB，防止内存泄漏把服务器打满\n' >> "$UNIT_FILE"
printf 'Environment=NODE_OPTIONS=--max-old-space-size=1536\n' >> "$UNIT_FILE"
printf '\n' >> "$UNIT_FILE"
printf '# ── 日志 ──────────────────────────────────────────────\n' >> "$UNIT_FILE"
printf 'StandardOutput=journal\n' >> "$UNIT_FILE"
printf 'StandardError=journal\n' >> "$UNIT_FILE"
printf 'SyslogIdentifier=%s\n' "$SERVICE_NAME" >> "$UNIT_FILE"
printf '\n' >> "$UNIT_FILE"
printf '# ── 安全沙箱加固 ──────────────────────────────────────\n' >> "$UNIT_FILE"
printf '# 系统目录只读（/usr /boot /etc 等）\n' >> "$UNIT_FILE"
printf 'ProtectSystem=strict\n' >> "$UNIT_FILE"
printf '# 工作目录下 logs/ 和 data/ 可写\n' >> "$UNIT_FILE"
printf 'ReadWritePaths=%s/logs %s/data\n' "$INSTALL_DIR" "$INSTALL_DIR" >> "$UNIT_FILE"
printf '# home 目录只读（Node 读 node_modules 需要）\n' >> "$UNIT_FILE"
printf 'ProtectHome=read-only\n' >> "$UNIT_FILE"
printf '# 禁止进程获取新权限（防止提权）\n' >> "$UNIT_FILE"
printf 'NoNewPrivileges=true\n' >> "$UNIT_FILE"
printf '# 私有 /tmp，进程间隔离\n' >> "$UNIT_FILE"
printf 'PrivateTmp=true\n' >> "$UNIT_FILE"
printf '# 禁止操作内核模块/参数/cgroup\n' >> "$UNIT_FILE"
printf 'ProtectKernelModules=true\n' >> "$UNIT_FILE"
printf 'ProtectKernelTunables=true\n' >> "$UNIT_FILE"
printf 'ProtectControlGroups=true\n' >> "$UNIT_FILE"
printf '\n' >> "$UNIT_FILE"
printf '[Install]\n' >> "$UNIT_FILE"
printf 'WantedBy=multi-user.target\n' >> "$UNIT_FILE"

sudo mv "$UNIT_FILE" "$SERVICE_FILE"
sudo chmod 644 "$SERVICE_FILE"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

sleep 2
echo ""
sudo systemctl status "$SERVICE_NAME" --no-pager -l || true

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "========================================="
echo " ✅ Deploy complete!"
echo "========================================="
SERVER_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo 'YOUR_IP')
PORT=$(grep -E '^PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo '3001')
echo " Dashboard : http://${SERVER_IP}:${PORT}"
echo " Webhook   : POST http://localhost:${PORT}/webhook/add-token"
echo ""
echo " 服务管理:"
echo "   sudo systemctl status  ${SERVICE_NAME}               # 查看状态"
echo "   sudo systemctl restart ${SERVICE_NAME}               # 重启"
echo "   sudo systemctl stop    ${SERVICE_NAME}               # 停止"
echo "   sudo systemctl reset-failed ${SERVICE_NAME}         # 清除 failed 状态"
echo ""
echo " 日志查看:"
echo "   sudo journalctl -u ${SERVICE_NAME} -f                # 实时滚动"
echo "   sudo journalctl -u ${SERVICE_NAME} --since '1h ago'  # 近1小时"
echo "   sudo journalctl -u ${SERVICE_NAME} -p err            # 仅错误"
echo "   cat ${INSTALL_DIR}/logs/trades.log                   # 交易日志"
echo "========================================="
