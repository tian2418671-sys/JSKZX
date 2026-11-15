<#
  C 盘整理 · 管理员脚本
  ------------------------------------------------------------------
  用法（二选一）：
    1) 双击 run-admin.cmd            —— 自动提权，跑「预演」
    2) 预演看完后真正执行：
       powershell -ExecutionPolicy Bypass -File admin-clean.ps1 -Execute

  可选开关：
    -Deep            额外清理 WinSxS 组件（DISM StartComponentCleanup，较慢，可能省 1-3 GB）
    -EmptyRecycleBin 顺带清空回收站

  原则：
    · 默认只「预演」，不删任何东西；
    · 驱动库只删「同一 INF 的旧版本」，每个 INF 保留最新一版；
    · 删除时不加 /force —— 正在被设备使用的驱动会被系统拒绝，自动跳过。
#>

param(
    [switch]$Execute,
    [switch]$Deep,
    [switch]$EmptyRecycleBin
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

# ---------- 提权 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# 需要真删却没权限：用自身路径重新拉起管理员实例（不经过引号转义，避免路径被判非法）
if (-not $isAdmin -and $Execute) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', $PSCommandPath)
    if ($Deep)            { $argList += '-Deep' }
    if ($EmptyRecycleBin) { $argList += '-EmptyRecycleBin' }
    $argList += '-Execute'

    Write-Host ""
    Write-Host "  正在请求管理员权限，UAC 弹窗请点「是」..." -ForegroundColor Yellow
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -ErrorAction Stop
        Write-Host "  已启动管理员窗口，本窗口可以关闭。" -ForegroundColor Green
        Start-Sleep -Seconds 2
        exit 0
    } catch {
        Write-Host ("  [X] 提权失败：" + $_.Exception.Message) -ForegroundColor Red
        Read-Host "按回车关闭"
        exit 1
    }
}

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "  [i] 当前不是管理员，本次只做只读预演，不会删除任何东西。" -ForegroundColor DarkYellow
}

$logDir = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log   = Join-Path $logDir ("clean-$stamp.log")
try { Start-Transcript -Path $log -Force | Out-Null } catch { }

function Get-FreeGB { (Get-PSDrive C).Free / 1GB }
function Show-Free($tag) {
    Write-Host ("  [{0}] C 盘可用：{1:N2} GB" -f $tag, (Get-FreeGB)) -ForegroundColor Cyan
}
function Get-DirBytes([string]$p) {
    if (-not (Test-Path -LiteralPath $p)) { return 0 }
    (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum
}
function Remove-Target([string]$label, [string]$path, [switch]$ContentsOnly) {
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host ("  跳过  {0}（不存在）" -f $label) -ForegroundColor DarkGray
        return
    }
    $before = Get-DirBytes $path
    if (-not $Execute) {
        Write-Host ("  预演  {0,-28} 可释放 {1,8:N2} GB   {2}" -f $label, ($before/1GB), $path) -ForegroundColor Yellow
        return
    }
    if ($ContentsOnly) {
        Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
    $after = Get-DirBytes $path

    # 有些系统文件只有 SYSTEM 的 ACE，管理员也进不去 —— 属主是 Administrators 时可改权限后再删
    if ($after -gt 0 -and $isAdmin) {
        Write-Host ("  权限不足，尝试授予 Administrators 完全控制后重试：{0}" -f $label) -ForegroundColor DarkYellow
        & icacls.exe $path /grant '*S-1-5-32-544:(OI)(CI)F' /t /c *> $null
        if ($ContentsOnly) {
            Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
        }
        $after = Get-DirBytes $path
    }

    $ok     = ($before - $after) / 1GB
    $color  = if ($after -gt 0) { 'Red' } else { 'Green' }
    $tag    = if ($after -gt 0) { ("残留 {0:N0} MB（被占用或受保护）" -f ($after/1MB)) } else { '完成' }
    Write-Host ("  {0,8:N2} GB  {1,-28} {2}" -f $ok, $label, $tag) -ForegroundColor $color
}

Write-Host ""
Write-Host "==============================================================" -ForegroundColor White
Write-Host ("  C 盘整理 · " + $(if ($Execute) { "执行模式（会真正删除）" } else { "预演模式（只看不删）" })) -ForegroundColor White
Write-Host "==============================================================" -ForegroundColor White
$startFree = Get-FreeGB
Show-Free '开始'

# ---------- 1. 崩溃转储 ----------
Write-Host ""
Write-Host "[1/5] 崩溃转储" -ForegroundColor White
Remove-Target 'OpenSquilla 崩溃转储'  'C:\OpenSquillaDumps' -ContentsOnly
Remove-Target '根目录 dumps'          'C:\dumps'            -ContentsOnly
Remove-Target 'Windows 微型转储'      'C:\Windows\Minidump' -ContentsOnly
Remove-Target 'Windows 内核报告'      'C:\Windows\LiveKernelReports' -ContentsOnly

# ---------- 2. 第三方工具下载包 ----------
Write-Host ""
Write-Host "[2/5] 第三方工具缓存的安装包" -ForegroundColor White
Remove-Target 'IObit 驱动下载包' 'C:\ProgramData\IObit\Driver Booster\Download' -ContentsOnly
Remove-Target 'IObit 驱动备份'   'C:\ProgramData\IObit\Driver Booster\Backups'  -ContentsOnly
Remove-Target 'NVIDIA 驱动残留'  'C:\ProgramData\NVIDIA Corporation\NVIDIA app\UpdateFramework\ota-artifacts' -ContentsOnly
Remove-Target '系统临时文件'     'C:\Windows\Temp' -ContentsOnly

# ---------- 3. 驱动库重复版本 ----------
Write-Host ""
Write-Host "[3/5] 驱动库（DriverStore）—— 同一 INF 只留最新版" -ForegroundColor White

function ConvertTo-SortKey([string]$v) {
    if ($v -match '^(\d{1,2})/(\d{1,2})/(\d{4})$') { return ('D{0:yyyyMMdd}' -f ([datetime]::new([int]$Matches[3], [int]$Matches[1], [int]$Matches[2]))) }
    if ($v -match '^\d+(\.\d+)+$') {
        $parts = $v.Split('.') | ForEach-Object { $_.PadLeft(6, '0') }
        return ('N' + ($parts -join ''))
    }
    return ('S' + $v)
}

$drivers = @()
$cur     = $null
foreach ($line in (& pnputil /enum-drivers 2>&1)) {
    $l = [string]$line
    if ($l -match '^(?:Published Name|发布名称)\s*[:：]\s*(\S+)') {
        if ($cur) { $drivers += [pscustomobject]$cur }
        $cur = @{ Name = $Matches[1] }
    }
    elseif ($l -match '^(?:Original Name|原始名称)\s*[:：]\s*(\S+)')  { if ($cur) { $cur.Orig  = $Matches[1] } }
    elseif ($l -match '^(?:Provider Name|提供程序名称)\s*[:：]\s*(.+)$') { if ($cur) { $cur.Prov  = $Matches[1].Trim() } }
    elseif ($l -match '^(?:Class Name|类名称)\s*[:：]\s*(.+)$')         { if ($cur) { $cur.Class = $Matches[1].Trim() } }
    elseif ($l -match '^(?:Driver Version|驱动程序版本)\s*[:：]\s*(\S+)') { if ($cur) { $cur.Ver   = $Matches[1] } }
}
if ($cur) { $drivers += [pscustomobject]$cur }
$drivers = $drivers | Where-Object { $_.Orig }

Write-Host ("  驱动包总计 {0} 个" -f $drivers.Count) -ForegroundColor Cyan

$groups = $drivers | Group-Object Orig | Where-Object { $_.Count -gt 1 }
$plan   = @()
foreach ($g in $groups) {
    $sorted = $g.Group | Sort-Object { ConvertTo-SortKey $_.Ver } -Descending
    $keep   = $sorted[0]
    $drop   = $sorted | Select-Object -Skip 1
    $plan  += [pscustomobject]@{
        INF   = $g.Name
        Count = $g.Count
        Keep  = $keep.Name
        KeepV = $keep.Ver
        Drop  = $drop
    }
}

if (-not $plan) {
    Write-Host "  没有发现重复版本。" -ForegroundColor Green
} else {
    $plan | Sort-Object Count -Descending | Select-Object -First 15 | ForEach-Object {
        Write-Host ("  {0,-42} {1,2} 个版本  ->  保留 {2} ({3})" -f $_.INF, $_.Count, $_.Keep, $_.KeepV)
    }
    $totalDrop = ($plan | ForEach-Object { @($_.Drop).Count } | Measure-Object -Sum).Sum
    Write-Host ("  拟删除旧版本 {0} 个（每个 INF 保留 1 个最新版）" -f $totalDrop) -ForegroundColor Yellow

    if ($Execute) {
        $ok = 0; $fail = 0; $i = 0
        $free0 = Get-FreeGB
        Write-Host ("  开始逐个删除（共 {0} 个，每个约 1-2 秒，请勿关闭窗口）..." -f $totalDrop) -ForegroundColor Yellow
        foreach ($p in $plan) {
            foreach ($d in $p.Drop) {
                $i++
                $tag = ("[{0}/{1}] {2} ({3})" -f $i, $totalDrop, $d.Name, $p.INF)
                & pnputil /delete-driver $d.Name *> $null
                if ($LASTEXITCODE -eq 0) {
                    $ok++
                    Write-Host ("    删除 {0}" -f $tag) -ForegroundColor Green
                } else {
                    $fail++
                    Write-Host ("    跳过 {0} —— 在用或受保护" -f $tag) -ForegroundColor DarkGray
                }
            }
        }
        $freed = (Get-FreeGB) - $free0
        Write-Host ("  驱动包删除：成功 {0} 个，跳过 {1} 个，释放约 {2:N2} GB" -f $ok, $fail, $freed) -ForegroundColor Green
    } else {
        Write-Host "  （预演：未删除。）" -ForegroundColor DarkGray
    }
}

# ---------- 4. WinSxS ----------
Write-Host ""
Write-Host "[4/5] 组件库（WinSxS）" -ForegroundColor White
if ($Deep) {
    if (-not $Execute) {
        Write-Host "  预演：将执行 DISM /Online /Cleanup-Image /StartComponentCleanup（耗时数分钟）" -ForegroundColor Yellow
    } elseif ($isAdmin) {
        Write-Host "  正在清理组件（请耐心等待）..." -ForegroundColor Yellow
        & dism.exe /Online /Cleanup-Image /StartComponentCleanup /NoRestart 2>&1 |
            Select-String '完成|completed|错误|error' | ForEach-Object { Write-Host ("  " + $_.Line) }
    } else {
        Write-Host "  需要管理员权限，已跳过。" -ForegroundColor Red
    }
} else {
    Write-Host "  未启用（加 -Deep 才做，耗时较长）" -ForegroundColor DarkGray
}

# ---------- 5. 回收站 ----------
Write-Host ""
Write-Host "[5/5] 回收站" -ForegroundColor White
if ($EmptyRecycleBin) {
    if ($Execute) {
        try {
            Clear-RecycleBin -DriveLetter C -Force -ErrorAction Stop
            Write-Host "  已清空 C 盘回收站" -ForegroundColor Green
        } catch { Write-Host ("  清空失败：" + $_.Exception.Message) -ForegroundColor Red }
    } else {
        Write-Host "  预演：将清空 C 盘回收站" -ForegroundColor Yellow
    }
} else {
    Write-Host "  未启用（加 -EmptyRecycleBin 才做，会永久删除回收站内容）" -ForegroundColor DarkGray
}

# ---------- 汇总 ----------
Write-Host ""
Write-Host "==============================================================" -ForegroundColor White
$endFree = Get-FreeGB
if ($Execute) {
    Write-Host ("  本次释放 {0:N2} GB ；当前可用 {1:N2} GB" -f ($endFree - $startFree), $endFree) -ForegroundColor Green
} else {
    Write-Host ("  预演结束，未删除任何文件。当前可用 {0:N2} GB" -f $endFree) -ForegroundColor Yellow
    Write-Host "  确认无误后加 -Execute 再跑一次：" -ForegroundColor White
    Write-Host "    powershell -ExecutionPolicy Bypass -File .\admin-clean.ps1 -Execute" -ForegroundColor Gray
}
Write-Host ("  日志：{0}" -f $log) -ForegroundColor DarkGray
Write-Host "==============================================================" -ForegroundColor White

try { Stop-Transcript | Out-Null } catch { }

if ($Execute) {
    Write-Host ""
    Read-Host "按回车关闭窗口"
}
