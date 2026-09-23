<#
    Capacity check - build a giant replica library, launch the app against it, measure, clean up.

    WHY: users keep asking "how big a library can this handle". We answered it once by hand
    (22,372 cards / ~20 GB replica) but hand-run tests are not repeatable. This script makes the
    whole thing one command, so we can re-check capacity after every perf change.

    WHAT IT DOES
      1. finds the biggest library under -Source (most .png files) unless -Lib is given
      2. makes a replica at "<parent of lib>\_cap-test-<stamp>" with -Copies full copies
         (copy #1 = the whole lib; #2..N go into subfolders _copyN, the scanner is recursive)
      3. writes an ISOLATED profile in %TEMP% (--user-data-dir) pointing lastFolder at the replica
         so the real config / caches / crash.log are never touched
      4. starts Vite (dev mode) + Electron with --remote-debugging-port
      5. waits until cards are loaded, then samples heap + index stats via CDP
         (and optionally triggers one real refresh, the operation most likely to blow the heap)
      6. prints a summary and deletes the replica unless -Keep is passed

    TRAPS LEARNED THE HARD WAY
      · never use hardlinks/junctions for the replica: the app WRITES tags back into the PNGs,
        and hardlinks share content, so a write-back would corrupt the source library.
      · the app being measured must not write inside this repo while Vite dev is running,
        otherwise Vite full-reloads the page and invalidates every measurement.
      · this file must stay pure ASCII: Windows PowerShell 5.1 decodes BOM-less .ps1 as ANSI,
        so Chinese literals would turn into mojibake and paths would silently break.

    EXAMPLES
      powershell -File scripts\capacity-check.ps1                      # 2x biggest lib under I:\03
      powershell -File scripts\capacity-check.ps1 -Copies 1 -SkipRefresh
      powershell -File scripts\capacity-check.ps1 -Lib "E:\...\cards" -Keep
#>
param(
    [string]$Source = 'I:\03',
    [string]$Lib = '',
    # ⚠️ 参数名不能叫 $Replica：下面内部变量 `$replica = ''` 在 PowerShell 里与其**大小写不敏感**同名，
    #    会把传入的路径覆盖成空字符串（实测导致 -Replica 静默失效、又白复制了 20GB）。
    [string]$ReplicaDir = '',
    [int]$Copies = 2,
    [int]$Port = 9338,
    [int]$TimeoutSec = 600,
    [string]$Mode = 'dev',
    [string]$Label = '',
    [switch]$SkipRefresh,
    [switch]$Keep,
    [switch]$Hold
)

$ErrorActionPreference = 'Stop'
$script:stamp = Get-Date -Format 'MMdd-HHmm'
$script:stages = @{}
$script:failed = $false

function Info([string]$m) { Write-Host $m }
function Stage([string]$name, [string]$m) {
    $script:stages[$name] = $m
    Write-Host ("  {0,-14} {1}" -f $name, $m)
}
function Wait-Port([int]$p, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) {
        $ok = $false
        try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $ok = $c.Connected; $c.Close() } catch { $ok = $false }
        if ($ok) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}
function Invoke-Mem([string[]]$extra) {
    $cmdArgs = @('scripts/tools/_cdp-mem.mjs', '--port', "$Port", '--json') + $extra
    # Native commands that write to stderr abort the whole script under
    # $ErrorActionPreference='Stop' (PS 5.1 raises NativeCommandError) - that turned a plain
    # "page is not ready yet" poll into a hard failure. Polling must never be fatal.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = $null
    try { $out = & node @cmdArgs 2>$null } catch { $out = $null } finally { $ErrorActionPreference = $prevEap }
    if (-not $out) { return $null }
    try {
        $o = $out | Select-Object -Last 1 | ConvertFrom-Json
        if ($o.ok -eq $false) { return $null }
        return $o
    } catch { return $null }
}
function Get-FileCount([string]$p, [string]$filter) {
    if (-not (Test-Path -LiteralPath $p)) { return 0 }
    # cmd's dir enumerates huge trees (games / wikis next to a card library) far faster than
    # Get-ChildItem -Recurse, and we only ever count *.png here.
    $out = & cmd /c "dir /s /b `"$p\$filter`" 2>nul"
    if (-not $out) { return 0 }
    return @($out).Count
}
function Remove-Tree([string]$p) {
    if (-not (Test-Path $p)) { return $true }
    # cmd rmdir survives the long-path / 10k-file cases where Remove-Item chokes
    & cmd /c "rmdir /s /q `"$p`"" | Out-Null
    return -not (Test-Path $p)
}

$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
$profileDir = Join-Path $env:TEMP ("jsk-cap-$stamp")
$stdoutLog = Join-Path $profileDir 'app-stdout.log'
$viteProc = $null
$appProc = $null
$replica = ''

try {
    # ---------- 1. pick the source library ----------
    if ($ReplicaDir) {
        # reusing an existing replica: skip both the scan and the 20 GB copy (the P1 work loop
        # needs the same library over and over, and copying takes minutes on a slow disk)
        if (-not (Test-Path -LiteralPath $ReplicaDir)) { throw "replica not found: $ReplicaDir" }
        $replica = $ReplicaDir
        Stage 'source' '(skipped - replica supplied)'
    } elseif (-not $Lib) {
        Info "[1/6] looking for the biggest library under $Source ..."
        $cands = @()
        # the app's own last-opened folder is the cheapest and most relevant hint
        foreach ($cfgName in @('tavern_manager_config.json', 'app_config.json')) {
            $cfgPath = Join-Path (Join-Path $env:APPDATA 'sillytavern-card-manager') $cfgName
            if (Test-Path -LiteralPath $cfgPath) {
                try {
                    $j = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($j.lastFolder -and (Test-Path -LiteralPath $j.lastFolder)) {
                        $hint = Get-FileCount $j.lastFolder '*.png'
                        Info "      hint from $cfgName -> $($j.lastFolder) ($hint png)"
                        if ($hint -ge 500) { $cands += [pscustomobject]@{ Path = $j.lastFolder; Png = $hint } }
                    }
                } catch { /* unreadable config is not fatal */ }
            }
        }
        $scanned = 0
        foreach ($d in @(Get-ChildItem -Path $Source -Directory -Recurse -Depth 2 -ErrorAction SilentlyContinue)) {
            if ($d.Name.StartsWith('.')) { continue }            # skip .accelerate / .bak_history style dirs
            # ⚠️ never pick our own replica as the source: it is the biggest PNG dir on disk, so a
            # leaked replica (killed run) would silently double the library to 44k cards / 40 GB.
            if ($d.Name -like '_cap-test-*') { continue }
            if ($cands.Path -contains $d.FullName) { continue }
            $n = Get-FileCount $d.FullName '*.png'
            $scanned++
            # only report dirs that actually qualify - a real library has 150+ subfolders and the
            # full listing drowns the run output
            if ($n -ge 500) { Info "      $n png  $($d.FullName)" }
            if ($n -ge 500) { $cands += [pscustomobject]@{ Path = $d.FullName; Png = $n } }
        }
        Info "      (scanned $scanned folders under $Source)"
        if ($cands.Count -eq 0) { throw "no library with >= 500 png files found under $Source (pass -Lib <path>)" }
        $Lib = ($cands | Sort-Object Png -Descending | Select-Object -First 1).Path
    }
    if (-not $ReplicaDir) {
        if (-not (Test-Path -LiteralPath $Lib)) { throw "library not found: $Lib" }
        $srcPng = Get-FileCount $Lib '*.png'
        Stage 'source' "$Lib ($srcPng png)"
    }

    # ---------- 2. build the replica ----------
    if (-not $ReplicaDir) {
        $parent = Split-Path -Parent $Lib
        $replica = Join-Path $parent ("_cap-test-$stamp")
        if (Test-Path $replica) { throw "replica already exists: $replica" }
        Info "[2/6] replicating x$Copies -> $replica"
        $t0 = Get-Date
        for ($i = 1; $i -le $Copies; $i++) {
            $dst = if ($i -eq 1) { $replica } else { Join-Path $replica "_copy$i" }
            $null = New-Item -ItemType Directory -Path $dst -Force
            # /E copy subdirs incl. empty, /MT parallel, quiet flags. Full copy on purpose (no hardlinks).
            $rc = Start-Process robocopy -ArgumentList @("`"$Lib`"", "`"$dst`"", '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1') -Wait -PassThru -NoNewWindow
            if ($rc.ExitCode -ge 8) { throw "robocopy failed with exit code $($rc.ExitCode) on pass $i" }
            Info ("      pass {0}/{1} done ({2:n0}s)" -f $i, $Copies, ((Get-Date) - $t0).TotalSeconds)
        }
        $repPng = Get-FileCount $replica '*.png'
        $repGB = [math]::Round((@(Get-ChildItem -Path $replica -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB), 2)
        Stage 'replica' "$repPng png / $repGB GB in $([math]::Round(((Get-Date) - $t0).TotalSeconds))s"
    }

    if ($ReplicaDir) {
        $repPng = Get-FileCount $replica '*.png'
        $repGB = [math]::Round((@(Get-ChildItem -Path $replica -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB), 2)
        Stage 'replica' "$repPng png / $repGB GB (reused)"
    }

    # ---------- 3. isolated profile ----------
    Info "[3/6] isolated profile $profileDir"
    $null = New-Item -ItemType Directory -Path $profileDir -Force
    $cfg = @{ lastFolder = $replica } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $profileDir 'tavern_manager_config.json'), $cfg, (New-Object System.Text.UTF8Encoding($false)))
    Stage 'profile' "$profileDir (only lastFolder -> replica)"

    # ---------- 4. launch ----------
    Info "[4/6] launching ($Mode) ..."
    if ($Mode -eq 'dev') {
        $viteProc = Start-Process -FilePath 'cmd' -ArgumentList @('/c', 'npm', 'run', 'dev') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $profileDir 'vite.log')
        if (-not (Wait-Port 5173 90)) { throw 'vite dev server did not open port 5173 within 90s' }
        $env:VITE_DEV_SERVER_URL = 'http://localhost:5173'
        Stage 'vite' 'ready on 5173'
    } else {
        $env:VITE_DEV_SERVER_URL = ''
    }
    # 直接用 electron.exe 而不是 node_modules\.bin\electron.cmd 包装器：
    # 包装器的 stdout 重定向不可靠，且它的 HasExited 早于真实应用退出（cmd 先返回）。
    $electronExe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electronExe)) { $electronExe = Join-Path $repo 'node_modules\.bin\electron.cmd' }
    $electronArgs = @('.', "--user-data-dir=$profileDir", "--remote-debugging-port=$Port")
    $appProc = Start-Process -FilePath $electronExe -ArgumentList $electronArgs -PassThru -NoNewWindow -RedirectStandardOutput $stdoutLog
    Stage 'app' "pid $($appProc.Id) / cdp $Port / $electronExe"

    # ---------- 5. wait + measure ----------
    Info "[5/6] waiting for the library to finish loading ..."
    $tLoad = Get-Date
    $last = $null
    $stable = 0
    $polls = 0
    while (((Get-Date) - $tLoad).TotalSeconds -lt $TimeoutSec) {
        $m = Invoke-Mem @()
        $polls++
        if ($m -and $m.cards -and $m.cards -gt 0) {
            if ($last -and $last.cards -eq $m.cards) { $stable++ } else { $stable = 0 }
            $last = $m
            Info ("      poll {0}: {1} cards / heap {2}/{3} MB / {4}s - {5} png files" -f $polls, $m.cards, $m.heapUsedMB, $m.heapLimitMB, [math]::Round(((Get-Date) - $tLoad).TotalSeconds), $repPng)
            if ($stable -ge 2) { break }
        } else {
            $alive = $true
            try { $alive = -not $appProc.HasExited } catch { $alive = $false }
            Info ("      poll {0}: not ready (electron alive: {1}) - {2}s" -f $polls, $alive, [math]::Round(((Get-Date) - $tLoad).TotalSeconds))
            if (-not $alive) { throw "electron exited before the library loaded - see $stdoutLog" }
        }
        Start-Sleep -Seconds 8
    }
    if (-not $last) { throw "no CDP sample with cards>0 within $TimeoutSec s (app log: $stdoutLog)" }
    $loadSec = [math]::Round(((Get-Date) - $tLoad).TotalSeconds)
    Stage 'loaded' "$($last.cards) cards in ~${loadSec}s"
    # Final sample WITH a forced GC so the number is comparable with the earlier 3.05-3.26 GB baseline
    # (polling deliberately does not GC: forcing a full GC every 8 s stretched the 22k load past 215 s).
    $final = Invoke-Mem @('--gc')
    if ($final -and $final.cards) { $last = $final }
    # profile timing line + card count from the app log
    $profLine = ''
    try {
        $profLine = (Select-String -Path $stdoutLog -Pattern '[profile]' -SimpleMatch | Select-Object -Last 1).Line
        if ($profLine) { $profLine = $profLine.Trim() } else { $profLine = '(no [profile] line yet)' }
    } catch { $profLine = '(log unavailable)' }
    Stage 'profile-line' $profLine

    $heapCap = if ($last.heapLimitMB) { $last.heapLimitMB } else { 0 }
    $ratio = if ($last.heapLimitMB) { [math]::Round(100 * $last.heapUsedMB / $last.heapLimitMB) } else { 0 }
    Stage 'heap' "$($last.heapUsedMB) MB used / $heapCap MB cap ($ratio%)"
    if ($last.idx) { Stage 'index' "cards=$($last.idx.cardCount) building=$($last.idx.indexBuilding) dirty=$($last.idx.indexDirty)" }
    if ($last.mem) { Stage 'guard' "samples=$($last.mem.samples) warns=$($last.mem.warns) criticals=$($last.mem.criticals) gcCalls=$($last.mem.gcCalls) last=$($last.mem.lastLevel)" }
    # ⚠️ 判定 js-flags 是否生效：只看 window.gc **不够** —— 实测 window.gc 存在（--expose-gc 生效），
    #    但 Chromium 渲染进程根本不采纳 --max-old-space-size（堆到 ~3.3GB 仍 reason=oom，
    #    jsHeapSizeLimit 恒为 4192MB）。所以这里只报「expose-gc 是否生效」，上限看 crash.log。
    if ($last.gcAvailable -eq $true) {
        Stage 'js-flags' 'expose-gc OK (window.gc available). NOTE: renderer heap cap CANNOT be raised by js-flags - check crash.log for oom'
    } else {
        Stage 'js-flags' 'expose-gc MISSING (window.gc undefined) - the js-flags switch in main.js did not reach the renderer'
    }

    if (-not $SkipRefresh) {
        Info "[5b] triggering one refresh (worst case for the heap) ..."
        $r = Invoke-Mem @('--refresh', '--gc')
        if ($r -and $r.refresh) { Stage 'refresh' "$([math]::Round($r.refresh.refreshMs / 1000))s total, then heap $($r.heapUsedMB) MB ($([math]::Round(100 * $r.heapUsedMB / $r.heapLimitMB))%)" }
        else { Stage 'refresh' 'FAILED (page reloaded / CDP lost)' }
        if ($r -and $r.mem) { Stage 'guard-after' "warns=$($r.mem.warns) criticals=$($r.mem.criticals) gcCalls=$($r.mem.gcCalls)" }
    }

    $crash = Join-Path $profileDir 'crash.log'
    if (Test-Path $crash) {
        $cl = @(Get-Content $crash -ErrorAction SilentlyContinue)
        Stage 'crash.log' "$($cl.Count) line(s) - inspect $crash"
    } else {
        Stage 'crash.log' 'none (no renderer crash)'
    }

    # ---------- 6. summary ----------
    Info ''
    Info "================ summary ($stamp) ================"
    if ($Label) { Info "label          : $Label" }
    foreach ($k in @('source', 'replica', 'profile', 'vite', 'app', 'loaded', 'profile-line', 'heap', 'js-flags', 'index', 'guard', 'refresh', 'guard-after', 'crash.log')) {
        if ($script:stages.ContainsKey($k)) { Info ("{0,-14}: {1}" -f $k, $script:stages[$k]) }
    }
    Info "artifacts      : $profileDir (stdout: app-stdout.log)"
    Info "================================================="
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if (Test-Path $stdoutLog) {
        Write-Host '--- last 40 lines of app stdout ---'
        Get-Content $stdoutLog -Tail 40 | ForEach-Object { Write-Host $_ }
    }
    $script:failed = $true
} finally {
    # NOTE: no `return` inside a finally block - that would swallow a pending exception.
    if ($Hold) {
        Info '[6/6] -Hold set: leaving app + replica + profile alive for follow-up probes'
        Info "      cdp port : $Port"
        Info "      replica  : $replica"
        Info "      profile  : $profileDir"
        if ($appProc) { Info "      electron : pid $($appProc.Id)" }
        if ($viteProc) { Info "      vite     : pid $($viteProc.Id)" }
    } else {
        if ($appProc -and -not $appProc.HasExited) { Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue }
        # killing the main electron process usually takes GPU/renderer children with it, but be explicit:
        # only touch electron processes that were launched with OUR isolated profile (never the user's app).
        try {
            Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profileDir*" } |
                ForEach-Object { & taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
        } catch { /* best effort */ }
        if ($viteProc -and -not $viteProc.HasExited) {
            & taskkill /PID $viteProc.Id /T /F 2>$null | Out-Null
        }
    }
    if ($replica -and (Test-Path $replica)) {
        if ($Keep) { Info "[6/6] -Keep set, replica left at $replica" }
        else {
            Info "[6/6] deleting replica (use -Keep to inspect it) ..."
            if (Remove-Tree $replica) { Info '      deleted' } else { Info "      could not delete $replica - delete it by hand" }
        }
    }
    Pop-Location
}
if ($script:failed) { exit 1 }
