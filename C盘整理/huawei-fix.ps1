$ErrorActionPreference = 'Continue'
$logDir = 'E:\AI\酒馆工具\JSK管理\C盘整理\logs'
$log = Join-Path $logDir ("huawei-fix-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
try { Start-Transcript -Path $log -Force | Out-Null } catch { }
function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }

$old = 'D:\HuaweiMoveData'
$new = 'D:\UserData'
$newDocs = Join-Path $new 'Users\Tk\Documents'

Say "=== 1. 建立兼容链接（旧路径 -> 新路径） ==="
if (-not (Test-Path -LiteralPath $old)) {
    & cmd.exe /c "mklink /J `"$old`" `"$new`"" | Out-Null
    Say ("  {0} -> {1} : {2}" -f $old, $new, $(if (Test-Path -LiteralPath $old) { 'OK' } else { 'FAILED' }))
} else { Say "  已存在，跳过" 'DarkGray' }

Say "`n=== 2. 修正配置文件中的旧路径 ==="
$files = Get-ChildItem -LiteralPath "$env:APPDATA\Tencent" -Recurse -File -Include *.ini, *.json, *.xml, *.cfg, *.conf, *.txt -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -lt 1MB }
$fixed = 0
foreach ($f in $files) {
    try {
        $txt = [IO.File]::ReadAllText($f.FullName)
        if ($txt.Contains('HuaweiMoveData')) {
            Copy-Item $f.FullName ($f.FullName + '.bak-huawei') -Force -ErrorAction SilentlyContinue
            [IO.File]::WriteAllText($f.FullName, $txt.Replace('HuaweiMoveData', 'UserData'))
            Say ("  修正: {0}" -f $f.FullName)
            $fixed++
        }
    } catch { Say ("  跳过 {0}: {1}" -f $f.FullName, $_.Exception.Message) 'DarkYellow' }
}
Say ("  共修正 {0} 个文件" -f $fixed)

Say "`n=== 3. 重定向「文档」 ==="
Add-Type -Namespace KF2 -Name Api -MemberDefinition @'
[DllImport("shell32.dll", CharSet=CharSet.Unicode)]
public static extern int SHSetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hToken, string pszPath);
[DllImport("shell32.dll", CharSet=CharSet.Unicode)]
public static extern int SHGetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);
'@
$fid = [Guid]'FDD39AD0-238F-46AF-ADB4-6C85480369C7'
$rc = [KF2.Api]::SHSetKnownFolderPath([ref]$fid, 0, [IntPtr]::Zero, $newDocs)
Say ("  SHSetKnownFolderPath = {0}" -f $rc)
if ($rc -ne 0) {
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -Name 'Personal' -Value $newDocs
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -Name 'Personal' -Value $newDocs
    Say "  已回退到注册表写入" 'DarkYellow'
}
$ptr = [IntPtr]::Zero
if ([KF2.Api]::SHGetKnownFolderPath([ref]$fid, 0, [IntPtr]::Zero, [ref]$ptr) -eq 0) {
    Say ("  当前「文档」= {0}" -f [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)) 'Green'
}

Say "`n=== 校验 ==="
Say ("  User Shell Folders = " + (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').Personal)
$ini = "$env:APPDATA\Tencent\xwechat\config\51a1fffea11325a1e4104c6b3de47af7.ini"
if (Test-Path $ini) { Say ("  微信配置 = " + ((Select-String -Path $ini -Pattern 'UserData|HuaweiMoveData' | Select-Object -First 1).Line).Trim()) }
Say ("  旧路径可访问 = " + (Test-Path 'D:\HuaweiMoveData\Users\Tk\Documents'))
Say ("  新路径可访问 = " + (Test-Path $newDocs))
Say ("  日志: " + $log)
try { Stop-Transcript | Out-Null } catch { }
