#!/bin/bash
cd "$(dirname "$0")" || exit 1
if [ ! -d "node_modules" ]; then
  echo "正在首次初始化工作台依赖..."
  npm install --no-audit --no-fund
fi
if [ ! -f "dist/index.html" ]; then
  npm run build
fi
echo "正在启动「剧本对应语系工作台」..."
node server/main.mjs
