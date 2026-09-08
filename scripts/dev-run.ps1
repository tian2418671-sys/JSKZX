# =========================================================
# dev 模式一键热启动（修复终端中文乱码）
# ---------------------------------------------------------
# 乱码根因：Windows PowerShell 终端代码页默认 GBK(936)，
# 而 Electron/Node/Chromium 向终端输出 UTF-8 字节 →
# 中文日志/系统错误显示为乱码（閫氬父... 鎷掔粷...）。
#
# 本脚本在启动前把当前会话的输出编码切换为 UTF-8，
# 使 Electron 启动日志与渲染层转发日志中的中文全部正常显示。
#
# 用法（VS Code 集成终端 / PowerShell）：
#   .\scripts\dev-run.ps1          # 连 Vite dev server (5173) + 调试端口
#   .\scripts\dev-run.ps1 -Port 9223
# =========================================================
param(
    [int]$Port = 9222
)

# 🔤 切换到 UTF-8：代码页 + .NET 控制台输出编码双保险
try { chcp 65001 | Out-Null } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 校验 Vite dev server 是否在 5173（未启动则提示先跑 npm run dev）
$viteUp = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if (-not $viteUp) {
    Write-Host "⚠️  未检测到 Vite dev server (5173)。请先另开终端运行: npm run dev" -ForegroundColor Yellow
    Write-Host "   或本脚本将自动尝试启动 Vite..." -ForegroundColor DarkGray
}

$env:VITE_DEV_SERVER_URL = 'http://localhost:5173'
Write-Host "🚀 启动 dev 模式 Electron (远程调试端口 $Port) ..." -ForegroundColor Cyan
& npx electron . --remote-debugging-port=$Port 2>&1
