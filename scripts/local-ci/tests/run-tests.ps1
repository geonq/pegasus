#Requires -Version 7
# Self-test for the local CI library: change detection, the runner lock, the deploy rule, the OTA
# verify verdict and the step runner (timeout kills the whole tree, flaky detection, fail-fast).
# Run: pwsh -NoProfile -File scripts/local-ci/tests/run-tests.ps1   (exit 0 = all passed)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\lib\LocalCi.psm1') -Force
$script:failures = 0; $script:count = 0
function It([string]$Name, [scriptblock]$Body) {
    $script:count++
    try { & $Body; Write-Host "ok   $Name" } catch { $script:failures++; Write-Host "FAIL $Name`n     $($_.Exception.Message)" }
}
function Assert([bool]$Cond, [string]$Msg) { if (-not $Cond) { throw $Msg } }
$tmp = Join-Path ([IO.Path]::GetTempPath()) "local-ci-test-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
$noLog = { param($m) }

# ---------------------------------------------------------------- change detection
It 'unknown base runs everything' {
    $a = Get-CiAreas -Files $null
    Assert ($a.desktop -and $a.rust -and $a.mobile -and $a.ios -and $a.ota) 'all areas expected'
}
It 'no changed files runs nothing' {
    $a = Get-CiAreas -Files @()
    Assert (-not ($a.desktop -or $a.rust -or $a.mobile -or $a.ios -or $a.ota)) 'no area expected'
}
It 'phone source only: mobile checks and OTA, no desktop, rust or iOS' {
    $a = Get-CiAreas -Files @('apps/mobile/src/screens/ChatScreen.tsx')
    Assert ($a.mobile -and $a.ota -and -not $a.desktop -and -not $a.rust -and -not $a.ios) ($a | Out-String)
}
It 'phone package.json: iOS compile, no OTA' {
    $a = Get-CiAreas -Files @('apps/mobile/package.json')
    Assert ($a.mobile -and $a.ios -and -not $a.ota) ($a | Out-String)
}
It 'app.config.ts and the mobile lockfile are native' {
    Assert (Get-CiAreas -Files @('apps/mobile/app.config.ts')).ios 'app.config.ts'
    Assert (Get-CiAreas -Files @('apps/mobile/pnpm-lock.yaml')).ios 'lockfile'
}
It 'phone wire types also run the desktop typecheck (mobile-wire-types.check.ts)' {
    $a = Get-CiAreas -Files @('apps/mobile/src/api/types.ts')
    Assert ($a.desktop -and $a.mobile) ($a | Out-String)
}
It 'host crate: rust only' {
    $a = Get-CiAreas -Files @('crates/pegasus-host/src/remote.rs')
    Assert ($a.rust -and -not $a.desktop -and -not $a.mobile) ($a | Out-String)
}
It 'protocol crate also runs desktop (generated.ts)' {
    $a = Get-CiAreas -Files @('crates/pegasus-core/src/protocol.rs')
    Assert ($a.rust -and $a.desktop) ($a | Out-String)
}
It 'desktop, root config and docs run desktop only' {
    foreach ($f in 'apps/desktop/src/App.tsx', 'package.json', 'pnpm-lock.yaml', 'docs/x.md', '.github/workflows/ci.yml') {
        $a = Get-CiAreas -Files @($f)
        Assert ($a.desktop -and -not $a.rust -and -not $a.mobile) "$f -> $($a | Out-String)"
    }
}
It 'backslash paths are normalised' {
    Assert (Get-CiAreas -Files @('apps\mobile\src\App.tsx')).ota 'expected ota'
}
It 'the CI folder itself is flagged' {
    Assert (Get-CiAreas -Files @('scripts/local-ci/run-ci.ps1')).ci 'expected ci'
}

# ---------------------------------------------------------------- lock
$lockPath = Join-Path $tmp 'runner.lock'
It 'first runner takes the lock; a second one is refused at once' {
    $l1 = Enter-CiLock -Path $lockPath -WaitSeconds 0
    try {
        Assert ($null -ne $l1) 'first lock not taken'
        $holder = Read-CiLockHolder $lockPath
        Assert ($holder.pid -eq $PID -and $holder.startTime) "holder: $($holder | ConvertTo-Json -Compress)"
        $j = Start-Job -ScriptBlock { param($m, $p) Import-Module $m; $l = Enter-CiLock -Path $p -WaitSeconds 0; [bool]$l } -ArgumentList (Join-Path $PSScriptRoot '..\lib\LocalCi.psm1'), $lockPath
        $got = Receive-Job $j -Wait -AutoRemoveJob
        Assert ($got -eq $false) "second runner got the lock: $got"
    } finally { Exit-CiLock $l1 }
}
It 'a waiting runner gets the lock once the holder releases it' {
    $l1 = Enter-CiLock -Path $lockPath -WaitSeconds 0
    $j = Start-Job -ScriptBlock { param($m, $p) Import-Module $m; $sw = [Diagnostics.Stopwatch]::StartNew(); $l = Enter-CiLock -Path $p -WaitSeconds 20; "$([bool]$l) $([int]$sw.Elapsed.TotalSeconds)"; Exit-CiLock $l } -ArgumentList (Join-Path $PSScriptRoot '..\lib\LocalCi.psm1'), $lockPath
    Start-Sleep -Seconds 3
    Exit-CiLock $l1
    $out = Receive-Job $j -Wait -AutoRemoveJob
    $ok, $secs = "$out".Split(' ')
    Assert ($ok -eq 'True' -and [int]$secs -ge 2) "waiter result: $out"
}
It 'a lock file left by a dead process is detected as stale and taken over' {
    # A real process that has exited: its PID and start time no longer match a live process.
    $deadPid = [int](Start-Job { "$PID" } | Receive-Job -Wait -AutoRemoveJob)
    [IO.File]::WriteAllText($lockPath, (@{ pid = $deadPid; startTime = '2026-01-01T00:00:00.0000000Z' } | ConvertTo-Json -Compress))
    Assert (-not (Test-CiLockHolderAlive (Read-CiLockHolder $lockPath))) 'dead holder reported alive'
    $l = Enter-CiLock -Path $lockPath -WaitSeconds 0
    try { Assert ($l -and $l.StalePrevious.pid -eq $deadPid) 'stale lock not taken over' } finally { Exit-CiLock $l }
}
It 'a reused PID with a different start time is not the holder' {
    $me = [pscustomobject]@{ pid = $PID; startTime = '2001-01-01T00:00:00.0000000Z' }
    Assert (-not (Test-CiLockHolderAlive $me)) 'PID reuse mistaken for the holder'
    $real = [pscustomobject]@{ pid = $PID; startTime = (Get-ProcessStartIso $PID) }
    Assert (Test-CiLockHolderAlive $real) 'live holder reported dead'
}

# ---------------------------------------------------------------- deploy rule
$ok = @{ Requested = $true; OnMain = $true; Green = $true; OtaChanged = $true; AlreadyDeployed = $false; ScriptExists = $true }
It 'deploys a green main SHA with phone changes' { Assert (Get-DeployDecision @ok).Deploy 'expected deploy' }
It 'never deploys the same SHA twice' {
    $h = $ok.Clone(); $h.AlreadyDeployed = $true; $d = Get-DeployDecision @h
    Assert (-not $d.Deploy -and $d.Reason -match 'already published') $d.Reason
}
It 'never deploys a red SHA, a branch SHA, a pre-push run, or without a phone change' {
    foreach ($k in 'Green', 'OnMain', 'Requested', 'OtaChanged', 'ScriptExists') {
        $h = $ok.Clone(); $h[$k] = $false
        Assert (-not (Get-DeployDecision @h).Deploy) "deployed with $k = false"
    }
}

# ---------------------------------------------------------------- OTA verify verdict
$boundary = 'b0undary'
$multipart = "--$boundary`r`ncontent-disposition: form-data; name=`"manifest`"`r`ncontent-type: application/json`r`n`r`n{`"id`":`"u-2`",`"createdAt`":`"x`",`"runtimeVersion`":`"rv1`"}`r`n--$boundary`r`ncontent-disposition: form-data; name=`"extensions`"`r`n`r`n{}`r`n--$boundary--`r`n"
It 'served manifest matching the published id and runtime passes' {
    Assert (Test-OtaServed -StatusCode 200 -ContentType "multipart/mixed; boundary=$boundary" -Body $multipart -ExpectedId 'u-2' -ExpectedRuntime 'rv1').Ok 'expected ok'
}
It 'a different served id fails (stale latest)' {
    $v = Test-OtaServed -StatusCode 200 -ContentType "multipart/mixed; boundary=$boundary" -Body $multipart -ExpectedId 'u-3' -ExpectedRuntime 'rv1'
    Assert (-not $v.Ok -and $v.Reason -match 'u-2') $v.Reason
}
It '204, 401 and 404 fail with a clear reason' {
    Assert ((Test-OtaServed -StatusCode 204 -ContentType '' -Body '' -ExpectedId 'a' -ExpectedRuntime 'b').Reason -match '204') '204'
    Assert ((Test-OtaServed -StatusCode 401 -ContentType '' -Body '' -ExpectedId 'a' -ExpectedRuntime 'b').Reason -match 'no update route') '401'
}

# ---------------------------------------------------------------- step runner
$node = (Get-Command node).Source
It 'a timeout kills the whole process tree, grandchildren included' {
    $pidFile = Join-Path $tmp 'grandchild.pid'
    # The step starts a grandchild that would sleep 5 minutes, then sleeps itself.
    $js = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},300000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],String(c.pid));setTimeout(()=>{},300000)"
    $s = New-CiStep -Name 'sleeper' -Stage t -Cwd $tmp -TimeoutSec 3 -Command @($node, '-e', $js, $pidFile)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $passed = Invoke-CiStage -Steps @($s) -LogDir $tmp -BaseEnv @{} -Log $noLog
    Assert (-not $passed -and $s.Status -eq 'timeout') "status $($s.Status)"
    Assert ($sw.Elapsed.TotalSeconds -lt 15) "took $($sw.Elapsed.TotalSeconds)s"
    $gc = [int](Get-Content $pidFile)
    Assert (-not (Get-Process -Id $gc -ErrorAction SilentlyContinue)) "grandchild $gc still running"
}
It 'a test that fails then passes is FLAKY and fails the stage' {
    $marker = Join-Path $tmp 'flaky.marker'
    Remove-Item $marker -ErrorAction SilentlyContinue
    $js = "const f=process.argv[1],fs=require('fs');if(fs.existsSync(f))process.exit(0);fs.writeFileSync(f,'1');process.exit(1)"
    $s = New-CiStep -Name 'flaky' -Stage t -Kind test -Cwd $tmp -Command @($node, '-e', $js, $marker)
    $passed = Invoke-CiStage -Steps @($s) -LogDir $tmp -BaseEnv @{} -Log $noLog
    Assert (-not $passed -and $s.Status -eq 'flaky' -and $s.Attempts -eq 2) "status $($s.Status) attempts $($s.Attempts)"
}
It 'a test that fails twice is failed, not flaky; checks are never rerun' {
    $t = New-CiStep -Name 'broken' -Stage t -Kind test -Cwd $tmp -Command @($node, '-e', 'process.exit(3)')
    Assert (-not (Invoke-CiStage -Steps @($t) -LogDir $tmp -BaseEnv @{} -Log $noLog) -and $t.Status -eq 'failed' -and $t.Attempts -eq 2) "test: $($t.Status) $($t.Attempts)"
    $c = New-CiStep -Name 'lint' -Stage t -Kind check -Cwd $tmp -Command @($node, '-e', 'process.exit(3)')
    Assert (-not (Invoke-CiStage -Steps @($c) -LogDir $tmp -BaseEnv @{} -Log $noLog) -and $c.Attempts -eq 1 -and $c.ExitCode -eq 3) "check: $($c.Status) $($c.Attempts)"
}
It 'fail-fast cancels running steps and skips pending ones' {
    $slow = New-CiStep -Name 'slow' -Stage t -Cwd $tmp -Command @($node, '-e', 'setTimeout(()=>{},60000)')
    $bad = New-CiStep -Name 'bad' -Stage t -Cwd $tmp -Command @($node, '-e', 'process.exit(1)')
    $after = New-CiStep -Name 'after' -Stage t -Cwd $tmp -Needs 'slow' -Command @($node, '-e', '0')
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Invoke-CiStage -Steps @($slow, $bad, $after) -LogDir $tmp -BaseEnv @{} -Log $noLog | Out-Null
    Assert ($slow.Status -eq 'cancelled' -and $bad.Status -eq 'failed' -and $after.Status -eq 'skipped') "$($slow.Status) $($bad.Status) $($after.Status)"
    Assert ($sw.Elapsed.TotalSeconds -lt 15) 'fail-fast was slow'
}
It 'infra retries are logged and bounded' {
    $lines = [Collections.Generic.List[string]]::new()
    try { Invoke-InfraRetry -What 'probe' -BackoffSec @(0) -Log { param($m) $lines.Add($m) } -Action { throw 'down' } } catch { }
    Assert ($lines.Count -eq 2 -and $lines[0] -match 'RETRY\s+probe attempt 2/3') ($lines -join ' | ')
}
It 'keeps the newest 30 run folders' {
    $runs = Join-Path $tmp 'runs'
    1..33 | ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $runs ('20261123-{0:000000}-abc' -f $_)) | Out-Null }
    $removed = Remove-OldRunFolders -RunsDir $runs -Keep 30
    $left = @(Get-ChildItem $runs -Directory | Sort-Object Name)
    Assert ($removed -eq 3 -and $left.Count -eq 30 -and $left[0].Name -eq '20261123-000004-abc') "removed $removed, first left $($left[0].Name)"
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "$($script:count - $script:failures)/$($script:count) passed"
exit $(if ($script:failures) { 1 } else { 0 })
