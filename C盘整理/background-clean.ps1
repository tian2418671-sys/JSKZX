$ErrorActionPreference = 'Continue'
$dir = 'E:\AI\酒馆工具\JSK管理\C盘整理'
$log = Join-Path $dir ("bg-clean-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
try { Start-Transcript -Path $log -Force | Out-Null } catch { }
function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }

$state = [ordered]@{
    time    = (Get-Date).ToString('s')
    tasks   = @()      # 被禁用的任务
    deleted = @()      # 被删除的任务名
    services = @()     # 服务原状态
    runkeys = @()      # 原 Run 键
    renamed = @()      # 被改名的 exe
}

Say "=========================================================="
Say "  后台常驻清理"
Say ("  管理员: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
Say "=========================================================="

# ---------- 1. 禁用更新器任务 ----------
Say "`n[1/6] 禁用更新器/广告类计划任务" 'White'
$disablePatterns = 'iTop', 'Driver Booster', 'Software Updater', 'Smart Game Booster', 'QuarkUpdater', 'Ubisoft Connect Background Update', '360ZipUpdater', 'IObit BF2026'
$allTasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -notmatch '\\Microsoft\\' }
foreach ($t in $allTasks) {
    $hit = $disablePatterns | Where-Object { $t.TaskName -like "*$_*" }
    if (-not $hit) { continue }
    if ($t.State -eq 'Disabled') { Say ("  已是禁用: {0}" -f $t.TaskName) 'DarkGray'; continue }
    $state.tasks += [pscustomobject]@{ Name = $t.TaskName; Path = $t.TaskPath; State = [string]$t.State }
    try {
        Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop | Out-Null
        Say ("  禁用: {0}" -f $t.TaskName) 'Green'
    } catch { Say ("  失败 {0}: {1}" -f $t.TaskName, $_.Exception.Message) 'Red' }
}

# ---------- 2. 删除可疑/破解任务 ----------
Say "`n[2/6] 删除可疑与破解相关任务" 'White'
$deletePatterns = 'copy_dlc_unlocker', 'dllrepair_win', 'Readertray', 'SoftLanding'
foreach ($t in $allTasks) {
    $hit = $deletePatterns | Where-Object { $t.TaskName -like "*$_*" }
    if (-not $hit) { continue }
    try {
        Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction Stop
        $state.deleted += ("{0}{1}" -f $t.TaskPath, $t.TaskName)
        Say ("  删除: {0}" -f $t.TaskName) 'Green'
    } catch { Say ("  失败 {0}: {1}" -f $t.TaskName, $_.Exception.Message) 'Red' }
}

# ---------- 3. 停用服务 ----------
Say "`n[3/6] 停用服务" 'White'
$svcList = 'AlibabaProtect', 'XboxService', 'GameInputRedistService', 'GamingServices', 'GamingServicesNet', 'GameViewerService'
foreach ($sn in $svcList) {
    $s = Get-Service $sn -ErrorAction SilentlyContinue
    if (-not $s) { Say ("  不存在: {0}" -f $sn) 'DarkGray'; continue }
    $state.services += [pscustomobject]@{ Name = $sn; StartType = [string]$s.StartType; Status = [string]$s.Status }
    if ($s.Status -eq 'Running') { Stop-Service $sn -Force -ErrorAction SilentlyContinue }
    & sc.exe config $sn start= disabled | Out-Null
    $after = (Get-Service $sn).StartType
    Say ("  {0,-26} {1} -> {2}" -f $sn, $s.Status, $after) $(if ($after -eq 'Disabled') { 'Green' } else { 'DarkYellow' })
}

# ---------- 4. 结束进程 ----------
Say "`n[4/6] 结束进程" 'White'
$procNames = 'AIConsole', 'SogouCloud', 'SGTool', 'AlibabaProtect', 'GameViewer', 'GameViewerService', 'GameViewerServer'
foreach ($pn in $procNames) {
    $ps = Get-Process -Name $pn -ErrorAction SilentlyContinue
    foreach ($x in $ps) {
        $mb = [math]::Round($x.WorkingSet64 / 1MB)
        try { Stop-Process -Id $x.Id -Force -ErrorAction Stop; Say ("  结束 {0} (PID {1}, {2} MB)" -f $pn, $x.Id, $mb) 'Green' }
        catch { Say ("  无法结束 {0}: {1}" -f $pn, $_.Exception.Message) 'DarkYellow' }
    }
}

# ---------- 5. 去掉自启项 ----------
Say "`n[5/6] 移除开机自启项" 'White'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
foreach ($rn in 'Docker Desktop', 'Gemini') {
    $v = (Get-ItemProperty $runKey -ErrorAction SilentlyContinue).$rn
    if ($v) {
        $state.runkeys += [pscustomobject]@{ Key = $runKey; Name = $rn; Value = [string]$v }
        Remove-ItemProperty -Path $runKey -Name $rn -Force -ErrorAction SilentlyContinue
        Say ("  移除自启: {0}" -f $rn) 'Green'
    } else { Say ("  未找到自启项: {0}" -f $rn) 'DarkGray' }
}

# ---------- 6. 防止搜狗云组件自启（改名） ----------
Say "`n[6/6] 处理搜狗云组件（改名，可恢复）" 'White'
foreach ($exe in 'D:\CYRJAZWZ\SogouInput\16.10.0.5813\SogouCloud.exe') {
    if (Test-Path -LiteralPath $exe) {
        $off = $exe + '.off'
        if (Test-Path -LiteralPath $off) { Say "  已改过名，跳过" 'DarkGray'; continue }
        try {
            Rename-Item -LiteralPath $exe -NewName (Split-Path $off -Leaf) -ErrorAction Stop
            $state.renamed += [pscustomobject]@{ From = $exe; To = $off }
            Say ("  已改名: {0} -> .off" -f (Split-Path $exe -Leaf)) 'Green'
        } catch { Say ("  改名失败: " + $_.Exception.Message) 'Red' }
    }
}

# ---------- 保存状态 ----------
$stateFile = Join-Path $dir 'bg-clean-state.json'
($state | ConvertTo-Json -Depth 5) | Set-Content -Path $stateFile -Encoding UTF8
Say ("`n  状态已保存: {0}" -f $stateFile)

# ---------- 汇总 ----------
Say "`n=========================================================="
Say ("  禁用任务 {0} 个 / 删除任务 {1} 个 / 停用服务 {2} 个 / 移除自启 {3} 个" -f $state.tasks.Count, $state.deleted.Count, $state.services.Count, $state.runkeys.Count)
$mem = (Get-Process -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum
Say ("  当前总内存占用: {0:N2} GB" -f ($mem / 1GB))
Say ("  日志: {0}" -f $log)
Say "=========================================================="
try { Stop-Transcript | Out-Null } catch { }
