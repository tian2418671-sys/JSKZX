$ErrorActionPreference = 'Continue'
$logDir = 'E:\AI\酒馆工具\JSK管理\C盘整理\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir ("huawei-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
try { Start-Transcript -Path $log -Force | Out-Null } catch { }

function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }

$old = 'D:\HuaweiMoveData'
$new = 'D:\UserData'

Say "=========================================================="
Say "  华为组件清理 + 文档目录改名"
Say "=========================================================="
Say ("管理员: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

# ---------- 1. 停服务 ----------
Say "`n[1/6] 停止并删除华为服务" 'White'
foreach ($svc in 'HwPCCoreService', 'HuaweiHiSuiteService64.exe', 'HwNClx0101') {
    $s = Get-Service $svc -ErrorAction SilentlyContinue
    if ($s) {
        if ($s.Status -eq 'Running') { Stop-Service $svc -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
        & sc.exe delete $svc | Out-Null
        Say ("  删除服务 {0} -> {1}" -f $svc, $(if ($LASTEXITCODE -eq 0) { 'OK' } else { "失败($LASTEXITCODE)" }))
    } else {
        Say ("  服务 {0} 不存在，跳过" -f $svc) 'DarkGray'
    }
}

# ---------- 2. 卸载 HiSuite ----------
Say "`n[2/6] 卸载 HiSuite" 'White'
$uninst = 'C:\Program Files (x86)\HiSuite\uninst.exe'
if (Test-Path $uninst) {
    $p = Start-Process -FilePath $uninst -ArgumentList '/S' -PassThru -ErrorAction SilentlyContinue
    if ($p) {
        $done = $p.WaitForExit(120000)
        Say ("  卸载器退出: 已完成={0} 退出码={1}" -f $done, $p.ExitCode)
    }
    Start-Sleep -Seconds 2
} else {
    Say "  未找到 uninst.exe，直接删目录" 'DarkYellow'
}

# ---------- 3. 删目录 ----------
Say "`n[3/6] 删除华为目录与快捷方式" 'White'
$dirs = @(
    'C:\Program Files\Huawei',
    'C:\Program Files (x86)\HiSuite',
    'C:\Users\Tk\AppData\Local\HiSuite',
    'C:\Users\Tk\AppData\Roaming\com.huawei.grsWin',
    'C:\ProgramData\HiSuite',
    'C:\ProgramData\Huawei'
)
foreach ($d in $dirs) {
    if (Test-Path -LiteralPath $d) {
        $sz = (Get-ChildItem -LiteralPath $d -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
        $left = Test-Path -LiteralPath $d
        if ($left) {
            & icacls.exe $d /grant '*S-1-5-32-544:(OI)(CI)F' /t /c *> $null
            Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
            $left = Test-Path -LiteralPath $d
        }
        Say ("  {0,7:N1} MB  {1}  {2}" -f ($sz / 1MB), $d, $(if ($left) { '[残留]' } else { '[已删]' }))
    }
}
foreach ($lnk in @(
        "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\HiSuite",
        "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\华为手机助手.lnk",
        "C:\Users\Public\Desktop\HiSuite.lnk",
        "C:\Users\Tk\Desktop\HiSuite.lnk"
    )) {
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Recurse -Force -ErrorAction SilentlyContinue; Say ("  删除快捷方式 {0}" -f $lnk) }
}

# ---------- 4. 注册表 ----------
Say "`n[4/6] 清理注册表（保留 Microsoft 的 hwpolicy）" 'White'
$keys = @('HKLM:\SOFTWARE\Huawei', 'HKCU:\SOFTWARE\Huawei', 'HKLM:\SOFTWARE\WOW6432Node\Huawei',
    'HKLM:\SYSTEM\CurrentControlSet\Services\HWHandSet', 'HKLM:\SYSTEM\CurrentControlSet\Services\hw_usbdev')
foreach ($k in $keys) {
    if (Test-Path $k) {
        $msg = try { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction Stop; '已删' } catch { '失败: ' + $_.Exception.Message }
        Say ("  {0}  {1}" -f $k, $msg)
    }
}
# HiSuite 的卸载登记项
$unKeys = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -match 'HiSuite|华为手机助手' }
foreach ($k in $unKeys) {
    $name = (Get-ItemProperty $k.PSPath).DisplayName
    Remove-Item -LiteralPath $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue
    Say ("  删除卸载登记 {0}" -f $name)
}

# ---------- 5. 目录改名 ----------
Say "`n[5/6] 文档目录改名 $old -> $new" 'White'
$docsOld = Join-Path $old 'Users\Tk\Documents'
if (-not (Test-Path -LiteralPath $old)) { Say "  源目录不存在，跳过" 'DarkGray' }
elseif (Test-Path -LiteralPath $new) { Say "  目标已存在，删除或改名操作中止（避免覆盖）" 'Red' }
else {
    try {
        Rename-Item -LiteralPath $old -NewName (Split-Path $new -Leaf) -ErrorAction Stop
        Say ("  改名成功 -> {0}" -f $new) 'Green'
    } catch {
        Say ("  改名失败: " + $_.Exception.Message) 'Red'
    }
}

# 更新引用旧路径的文本配置（先备份）
$newDocs = Join-Path $new 'Users\Tk\Documents'
if (Test-Path -LiteralPath $newDocs) {
    $cfgRoots = @("$env:APPDATA\Tencent", "$env:APPDATA")
    $files = foreach ($r in $cfgRoots) {
        Get-ChildItem -LiteralPath $r -Recurse -File -Include *.ini, *.json, *.xml, *.cfg, *.conf, *.yaml, *.txt -ErrorAction SilentlyContinue |
            Where-Object { $_.Length -lt 1MB }
    }
    $fixed = 0
    foreach ($f in ($files | Select-Object -Unique)) {
        try {
            $txt = [IO.File]::ReadAllText($f.FullName)
            if ($txt -match [regex]::Escape('HuaweiMoveData')) {
                Copy-Item $f.FullName ($f.FullName + '.bak-huawei') -Force -ErrorAction SilentlyContinue
                [IO.File]::WriteAllText($f.FullName, ($txt -replace [regex]::Escape('HuaweiMoveData'), 'UserData'))
                Say ("  修正引用: {0}" -f $f.FullName)
                $fixed++
            }
        } catch { }
    }
    Say ("  共修正 {0} 个配置文件（原文件已留 .bak-huawei 备份）" -f $fixed)
}

# ---------- 6. 重定向「文档」 ----------
Say "`n[6/6] 重定向「文档」到新路径" 'White'
if (Test-Path -LiteralPath $newDocs) {
    Add-Type -Namespace KF -Name Api -MemberDefinition @'
[DllImport("shell32.dll", CharSet=CharSet.Unicode)]
public static extern int SHSetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hToken, string pszPath);
[DllImport("shell32.dll", CharSet=CharSet.Unicode)]
public static extern int SHGetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);
'@
    $fid = [Guid]'FDD39AD0-238F-46AF-ADB4-6C85480369C7'
    $rc = [KF.Api]::SHSetKnownFolderPath([ref]$fid, 0, [IntPtr]::Zero, $newDocs)
    Say ("  SHSetKnownFolderPath 返回: {0}" -f $rc)
    if ($rc -ne 0) {
        $sf = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
        Set-ItemProperty -Path $sf -Name 'Personal' -Value $newDocs -ErrorAction SilentlyContinue
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -Name 'Personal' -Value $newDocs -ErrorAction SilentlyContinue
        Say "  已改用注册表方式写入 User Shell Folders" 'DarkYellow'
    }
    $ptr = [IntPtr]::Zero
    $rc2 = [KF.Api]::SHGetKnownFolderPath([ref]$fid, 0, [IntPtr]::Zero, [ref]$ptr)
    if ($rc2 -eq 0) {
        $actual = [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)
        Say ("  当前「文档」实际指向: {0}" -f $actual) 'Green'
    }
} else {
    Say "  新路径不存在，跳过重定向" 'Red'
}

# ---------- 兼容链接 ----------
Say "`n[附加] 为微信等可能写死旧路径的程序建立兼容链接" 'White'
if (Test-Path -LiteralPath $new -and -not (Test-Path -LiteralPath $old)) {
    & cmd.exe /c "mklink /J `"$old`" `"$new`"" | Out-Null
    Say ("  {0} -> {1} : {2}" -f $old, $new, $(if (Test-Path -LiteralPath $old) { '已建立（0 字节联接）' } else { '建立失败' }))
} else {
    Say "  跳过（源/目标状态不满足）" 'DarkGray'
}

# ---------- 汇总 ----------
Say "`n=========================================================="
Say "  完成汇总"
Say ("  服务: " + ((Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'HwPCCore|HiSuite|HwNClx' } | ForEach-Object { $_.Name }) -join ', '))
Say ("  C:\Program Files\Huawei 存在: " + (Test-Path 'C:\Program Files\Huawei'))
Say ("  HiSuite 目录存在: " + (Test-Path 'C:\Program Files (x86)\HiSuite'))
Say ("  D:\UserData 存在: " + (Test-Path 'D:\UserData'))
Say ("  D:\ 目录清单: " + ((Get-ChildItem D:\ -Directory -Force | Where-Object { $_.Name -match 'Huawei|UserData' } | ForEach-Object { $_.Name }) -join ', '))
Say ("  日志: " + $log)
Say "=========================================================="

try { Stop-Transcript | Out-Null } catch { }
