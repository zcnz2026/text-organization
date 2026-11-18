@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules" (
  echo 正在首次初始化工作台依赖...
  call npm install --no-audit --no-fund
)
if not exist "dist\index.html" (
  call npm run build
)
echo 正在启动「剧本对应语系工作台」（关闭此黑框将停止后台本地桥接服务）...
node server/main.mjs
