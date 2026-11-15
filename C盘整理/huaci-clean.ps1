$ErrorActionPreference = 'Continue'
$dir = 'E:\AI\酒馆工具\JSK管理\C盘整理'
$log = Join-Path $dir ("huaci-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
try { Start-Transcript -Path $log -Force | Out-Null } catch { }
function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }

$exe = 'D:\CYRJAZWZ\360\360Safe\SoftMgr\GetWordSearch.exe'
$stateFile = Join-Path $dir 'bg-clean-state.json'

Say "=== 1. 结束划词搜索进程 ==="
foreach ($p in (Get-Process -Name 'GetWordSearch' -ErrorAction SilentlyContinue)) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Say ("  已结束 PID {0}" -f $p.Id) 'Green' }
    catch { Say ("  结束失败: " + $_.Exception.Message) 'Red' }
}

Say "`n=== 2. 改名封堵 ==="
$renamed = @()
foreach ($t in @(
        @{ p = $exe; to = $exe + '.off' },
        @{ p = 'D:\CYRJAZWZ\360\360Safe\SoftMgr\SMLGetWord'; to = 'D:\CYRJAZWZ\360\360Safe\SoftMgr\SMLGetWord.off' }
    )) {
    if (-not (Test-Path -LiteralPath $t.p)) { Say ("  不存在: {0}" -f $t.p) 'DarkGray'; continue }
    if (Test-Path -LiteralPath $t.to) { Say ("  已改过: {0}" -f (Split-Path $t.p -Leaf)) 'DarkGray'; continue }
    try {
        Rename-Item -LiteralPath $t.p -NewName (Split-Path $t.to -Leaf) -ErrorAction Stop
        $renamed += [pscustomobject]@{ From = $t.p; To = $t.to }
        Say ("  已改名: {0}" -f (Split-Path $t.p -Leaf)) 'Green'
    } catch { Say ("  改名失败 {0}: {1}" -f (Split-Path $t.p -Leaf), $_.Exception.Message) 'Red' }
}

Say "`n=== 3. 写入恢复状态 ==="
if ($renamed.Count -gt 0) {
    if (Test-Path $stateFile) {
        $st = Get-Content $stateFile -Raw | ConvertFrom-Json
        $all = @($st.renamed) + $renamed
        $st.renamed = $all
        ($st | ConvertTo-Json -Depth 6) | Set-Content -Path $stateFile -Encoding UTF8
        Say ("  已追加 {0} 条到 bg-clean-state.json（restore 脚本会一并还原）" -f $renamed.Count) 'Green'
    } else {
        Say "  状态文件不存在，未追加" 'DarkYellow'
    }
}

Say "`n=== 4. 等待 15 秒观察是否被 360 自修复 ==="
Start-Sleep -Seconds 15
$back = Get-Process -Name 'GetWordSearch' -ErrorAction SilentlyContinue
if ($back) { Say ("  已被拉回：{0} 个进程" -f @($back).Count) 'Red' }
else { Say "  没有复活" 'Green' }
Say ("  文件是否被还原: " + (Test-Path $exe)) $(if (Test-Path $exe) { 'Red' } else { 'Green' })
Say "`n日志: $log"
try { Stop-Transcript | Out-Null } catch { }
