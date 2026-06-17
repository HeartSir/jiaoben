#!/bin/bash
#
# deploy.sh — 一键部署到 Linux 服务器
#
# 使用方法：
#   1. 把整个项目传到服务器
#   2. chmod +x deploy.sh && ./deploy.sh
#

set -e

echo ""
echo "  🏸 川大场馆抢订系统 — 服务器部署"
echo "  ═══════════════════════════════════"
echo ""

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- 1. 检查 Node.js ----
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 Node.js，请先安装 Node.js >= 18"
  echo "   https://nodejs.org"
  exit 1
fi
echo "✅ Node.js $(node --version)"

# ---- 2. 安装 npm 依赖 ----
echo ""
echo "📦 安装 npm 依赖..."
cd "$BASE_DIR"
npm install --production
echo "✅ npm 依赖安装完成"

# ---- 3. 下载 Chromium ----
echo ""
if [ -d "$HOME/.cache/ms-playwright" ] && ls "$HOME/.cache/ms-playwright/" | grep -q chromium; then
  echo "✅ Chromium 已存在，跳过下载"
else
  echo "🌐 下载 Chromium（约 200MB）..."
  node setup.js
  echo "✅ Chromium 下载完成"
fi

# ---- 4. 创建默认配置 ----
if [ ! -f "$BASE_DIR/config.json" ]; then
  cat > "$BASE_DIR/config.json" << 'CONFIG'
{
  "venueId": 1,
  "targetHour": 8,
  "targetMinute": 30,
  "targetSecond": 0,
  "preWakeMs": 120000,
  "serverPassword": "",
  "wishes": [
    { "name": "3号场", "fieldId": 38, "time": "21:00", "timeEnd": "22:00", "enabled": true }
  ],
  "fallbackEnabled": true,
  "fallbackVenues": [
    { "name": "3号场", "fieldId": 38 },
    { "name": "4号场", "fieldId": 39 }
  ],
  "fallbackTimes": [
    { "time": "21:00", "timeEnd": "22:00" }
  ]
CONFIG
  echo "✅ 已创建默认 config.json"
fi

# ---- 5. 设置环境变量 ----
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"

# 自动查找 Chromium 路径
CHROME_PATH=$(find "$HOME/.cache/ms-playwright" -name "chrome" -type f 2>/dev/null | head -1)
if [ -n "$CHROME_PATH" ]; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$CHROME_PATH"
  echo "✅ Chromium 路径: $CHROME_PATH"
fi

# ---- 6. 启动 ----
echo ""
echo "  ═══════════════════════════════════"
echo "  🎯 部署完成！启动服务："
echo ""
echo "  export PLAYWRIGHT_BROWSERS_PATH=\"\$HOME/.cache/ms-playwright\""
echo "  node dashboard.js"
echo ""
echo "  或使用 PM2 后台运行："
echo "  npm install -g pm2"
echo "  pm2 start dashboard.js --name venue-booking"
echo ""
echo "  📍 面板地址: http://localhost:3456"
echo "  ═══════════════════════════════════"
echo ""
