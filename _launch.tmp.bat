@echo off
chcp 65001 >nul
cd /d "E:\AI\酒馆工具\JSK管理"
set VITE_DEV_SERVER_URL=http://localhost:5173
"E:\AI\酒馆工具\JSK管理\node_modules\electron\dist\electron.exe" . --remote-debugging-port=9222
