$ErrorActionPreference = 'Continue'
$logDir = 'E:\AI\酒馆工具\JSK管理\C盘整理\logs'
$log = Join-Path $logDir ("zombie-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
try { Start-Transcript -Path $log -Force | Out-Null } catch { }
function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }

Say "=========================================================="
Say "  僵尸数据清理"
Say ("  管理员: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
Say "=========================================================="

# ---------- 1. 失效卸载登记 ----------
Say "`n[1/4] 删除失效的卸载登记（程序目录必须确认已不存在）" 'White'
$roots = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
         'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
         'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
$removed = 0
foreach ($root in $roots) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
        $item = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if (-not $item.DisplayName) { return }
        $name = $item.DisplayName
        # 只处理这四个确认已死的程序
        if ($name -notmatch '^(Ollama|REDlauncher|LOOT|一修大师)') { return }
        $loc = [string]$item.InstallLocation
        $loc = $loc.Trim('"', ' ')
        $un = [string]$item.UninstallString
        if ($un -match '^"([^"]+)"') { $unExe = $Matches[1] } elseif ($un -match '^(\S+\.exe)') { $unExe = $Matches[1] } else { $unExe = '' }

        $locGone = ($loc -and $loc -match '^[A-Za-z]:\\' -and -not (Test-Path -LiteralPath $loc))
        $unGone = ($unExe -and $unExe -match '^[A-Za-z]:\\' -and -not (Test-Path -LiteralPath $unExe))

        if ($locGone -or $unGone) {
            try {
                Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction Stop
                Say ("  删除登记: {0}  (目录已丢: {1})" -f $name, $(if ($locGone) { $loc } else { $unExe })) 'Green'
                $removed++
            } catch { Say ("  删除失败 {0}: {1}" -f $name, $_.Exception.Message) 'Red' }
        } else {
            Say ("  保留（仍有效）: {0}" -f $name) 'DarkGray'
        }
    }
}
Say ("  共删除 {0} 条" -f $removed)

# ---------- 2. 断链快捷方式 ----------
Say "`n[2/4] 删除断链快捷方式" 'White'
$sh = New-Object -ComObject WScript.Shell
$dirsLnk = 'C:\Users\Tk\Desktop', 'C:\Users\Public\Desktop',
           'C:\ProgramData\Microsoft\Windows\Start Menu\Programs',
           'C:\Users\Tk\AppData\Roaming\Microsoft\Windows\Start Menu\Programs'
$n = 0
foreach ($d in $dirsLnk) {
    if (-not (Test-Path $d)) { continue }
    Get-ChildItem $d -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue | ForEach-Object {
        $target = $sh.CreateShortcut($_.FullName).TargetPath
        if ($target -and -not (Test-Path -LiteralPath $target)) {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            Say ("  删除 {0}  ->  {1}" -f $_.FullName, $target) 'Green'
            $n++
        }
    }
}
Say ("  共删除 {0} 个" -f $n)

# ---------- 3. 有体积的残留目录 ----------
Say "`n[3/4] 删除无主程序残留目录" 'White'
foreach ($d in 'D:\CYRJAZWZ\SH', 'D:\CYRJAZWZ\icons') {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    $exe = @(Get-ChildItem $d -Recurse -Filter *.exe -Force -ErrorAction SilentlyContinue).Count
    if ($exe -gt 0) { Say ("  跳过 {0}（里面还有 exe）" -f $d) 'DarkYellow'; continue }
    $sz = (Get-ChildItem $d -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
    Say ("  {0,7:N1} MB  {1}  {2}" -f ($sz / 1MB), $d, $(if (Test-Path $d) { '[残留]' } else { '[已删]' }))
}

# ---------- 4. 空壳目录 ----------
Say "`n[4/4] 删除空壳目录（递归无文件、非链接、非系统保留）" 'White'
$deny = @('Programs', 'ssh', 'TEMP', 'VirtualStore', 'Publishers', 'PlaceholderTileLogoFolder',
    'PeerDistRepub', 'Upgrade', 'Application Data', 'History', 'Temporary Internet Files',
    '桌面', '「开始」菜单', 'Documents', 'Templates', 'Packages', 'SoftwareDistribution',
    'OEM Links', 'Uninstall Information', 'Windows Sidebar', 'ModifiableWindowsApps',
    'WindowsHolographicDevices', 'Common', 'Paradox Interactive')
$scanRoots = 'C:\Program Files', 'C:\Program Files (x86)', 'C:\ProgramData',
             'C:\Users\Tk\AppData\Local', 'C:\Users\Tk\AppData\Roaming', 'D:\CYRJAZWZ'
$del = 0; $fail = 0
foreach ($r in $scanRoots) {
    if (-not (Test-Path $r)) { continue }
    Get-ChildItem $r -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
        if ($deny -contains $_.Name) { return }
        $files = @(Get-ChildItem $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue)
        if ($files.Count -eq 0) {
            try {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                $del++
            } catch { $fail++ }
        }
    }
}
Say ("  删除 {0} 个空目录，失败 {1} 个" -f $del, $fail)

Say "`n=========================================================="
Say "  完成。日志：$log"
Say "=========================================================="
try { Stop-Transcript | Out-Null } catch { }
