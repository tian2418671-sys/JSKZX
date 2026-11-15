$ErrorActionPreference = 'Continue'
$dir = 'E:\AI\酒馆工具\JSK管理\C盘整理'
$stateFile = Join-Path $dir 'bg-clean-state.json'
if (-not (Test-Path $stateFile)) { Write-Host "找不到状态文件，无法恢复。" -ForegroundColor Red; exit 1 }
$s = Get-Content $stateFile -Raw | ConvertFrom-Json
Write-Host ("恢复到 " + $s.time + " 的状态") -ForegroundColor Cyan

foreach ($t in @($s.tasks)) {
    try {
        Enable-ScheduledTask -TaskName $t.Name -TaskPath $t.Path -ErrorAction Stop | Out-Null
        Write-Host ("  重新启用任务: " + $t.Name) -ForegroundColor Green
    } catch { Write-Host ("  任务恢复失败 {0}: {1}" -f $t.Name, $_.Exception.Message) -ForegroundColor Red }
}

foreach ($sv in @($s.services)) {
    & sc.exe config $sv.Name start= ($sv.StartType.ToLower()) | Out-Null
    if ($sv.Status -eq 'Running') { Start-Service $sv.Name -ErrorAction SilentlyContinue }
    Write-Host ("  服务恢复: {0} -> {1}" -f $sv.Name, $sv.StartType) -ForegroundColor Green
}

foreach ($r in @($s.runkeys)) {
    Set-ItemProperty -Path $r.Key -Name $r.Name -Value $r.Value -ErrorAction SilentlyContinue
    Write-Host ("  自启恢复: " + $r.Name) -ForegroundColor Green
}

foreach ($rn in @($s.renamed)) {
    if ((Test-Path -LiteralPath $rn.To) -and -not (Test-Path -LiteralPath $rn.From)) {
        Rename-Item -LiteralPath $rn.To -NewName (Split-Path $rn.From -Leaf) -ErrorAction SilentlyContinue
        Write-Host ("  文件名恢复: " + (Split-Path $rn.From -Leaf)) -ForegroundColor Green
    }
}

if (@($s.deleted).Count -gt 0) {
    Write-Host ("`n注意：以下任务是被删除的（破解/可疑工具），未做恢复：") -ForegroundColor Yellow
    @($s.deleted) | ForEach-Object { Write-Host ("  " + $_) }
}
Write-Host "`n恢复完成。部分服务/任务需重启电脑后才完全生效。" -ForegroundColor Cyan
