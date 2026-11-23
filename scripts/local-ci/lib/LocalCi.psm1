#Requires -Version 7
# Shared logic for the local CI runner: change detection, the runner lock, the deploy rule, the
# process-tree step runner and the state files. Pure functions here are covered by tests/run-tests.ps1.
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

if (-not ('CiProcess' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'CiProcess.cs')
}

# ---------------------------------------------------------------- change detection

# Files whose change can alter the native iOS build (a new runtime), not just the JS bundle.
$script:NativePatterns = @(
    '^apps/mobile/package\.json$', '^apps/mobile/pnpm-lock\.yaml$', '^apps/mobile/app\.config\.ts$',
    '^apps/mobile/\.npmrc$', '^apps/mobile/deps/', '^apps/mobile/plugins/', '^apps/mobile/ios/',
    '^apps/mobile/babel\.config\.js$', '^apps/mobile/certs/'
)
# Files that ship to the phone over the air.
$script:OtaPatterns = @('^apps/mobile/src/', '^apps/mobile/assets/', '^apps/mobile/index\.ts$')

<#
.SYNOPSIS Maps changed repo paths to the check areas they affect.
$Files = $null means "unknown base" (first run or unreachable last green): everything is affected.
#>
function Get-CiAreas {
    param([AllowNull()][string[]]$Files)
    $a = [ordered]@{ desktop = $false; rust = $false; mobile = $false; ios = $false; ota = $false; ci = $false; files = 0 }
    if ($null -eq $Files) {
        foreach ($k in 'desktop', 'rust', 'mobile', 'ios', 'ota', 'ci') { $a[$k] = $true }
        $a.files = -1
        return [pscustomobject]$a
    }
    foreach ($raw in $Files) {
        $f = $raw.Replace('\', '/')
        if (-not $f) { continue }
        $a.files++
        if ($f -like 'apps/mobile/*') {
            $a.mobile = $true
            if ($script:NativePatterns.Where({ $f -match $_ }, 'First')) { $a.ios = $true }
            if ($script:OtaPatterns.Where({ $f -match $_ }, 'First')) { $a.ota = $true }
            # The desktop typecheck compiles this file against the desktop wire types.
            if ($f -eq 'apps/mobile/src/api/types.ts') { $a.desktop = $true }
            # Prettier and ESLint configs live at the root, but they ignore apps/mobile, so nothing else.
            continue
        }
        if ($f -like 'crates/*') {
            $a.rust = $true
            # protocol.rs generates packages/host-protocol/src/generated.ts, which the desktop compiles.
            if ($f -like 'crates/pegasus-core/*') { $a.desktop = $true }
            continue
        }
        if ($f -like 'packages/host-protocol/*') { $a.rust = $true; $a.desktop = $true; continue }
        if ($f -like 'scripts/local-ci/*') { $a.ci = $true; continue }
        # A separate experimental crate that no CI ever built; it has its own Cargo.lock.
        if ($f -like 'apps/pegasus-rs/*') { continue }
        # Everything else (desktop, website, packages, examples, root config, docs, workflows) is
        # covered by the desktop checks, which include prettier over Markdown and the workflow guards.
        $a.desktop = $true
    }
    [pscustomobject]$a
}

# ---------------------------------------------------------------- runner lock

function Get-ProcessStartIso {
    param([int]$ProcessId)
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    try { $p.StartTime.ToUniversalTime().ToString('o') } catch { $null }
}

<#
.SYNOPSIS True when the exact process (PID and its start time, so a reused PID does not count) still runs.
#>
function Test-CiLockHolderAlive {
    param([AllowNull()]$Holder)
    if (-not $Holder -or -not $Holder.pid) { return $false }
    $start = Get-ProcessStartIso -ProcessId ([int]$Holder.pid)
    return ($null -ne $start -and $start -eq $Holder.startTime)
}

function Read-CiLockHolder {
    param([string]$Path)
    try {
        $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
        try { $text = [IO.StreamReader]::new($fs).ReadToEnd() } finally { $fs.Dispose() }
        if ($text.Trim()) { return $text | ConvertFrom-Json }
    } catch { }
    return $null
}

<#
.SYNOPSIS Takes the single runner lock, or returns $null after WaitSeconds.
The lock is an open handle (FileShare.Read), so Windows releases it if the runner dies; the PID and
start time inside let a waiter name the holder and prove a leftover file is stale.
#>
function Enter-CiLock {
    param([string]$Path, [int]$WaitSeconds = 0, [hashtable]$Info = @{}, [scriptblock]$OnWait)
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $announced = $false
    New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
    while ($true) {
        $fs = $null
        try { $fs = [IO.File]::Open($Path, 'OpenOrCreate', 'ReadWrite', 'Read') } catch [IO.IOException] { $fs = $null }
        if ($fs) {
            $previous = $null
            if ($fs.Length -gt 0) {
                $text = [IO.StreamReader]::new($fs, [Text.Encoding]::UTF8, $false, 1024, $true).ReadToEnd()
                try { $previous = $text | ConvertFrom-Json } catch { }
            }
            # Handle is free. A holder that is still alive (same PID and start time) without the handle
            # would be a runner from an older lock scheme: stay conservative and wait for it.
            if ($previous -and $previous.pid -ne $PID -and (Test-CiLockHolderAlive $previous)) {
                $fs.Dispose()
            } else {
                $me = [ordered]@{ pid = $PID; startTime = (Get-ProcessStartIso -ProcessId $PID); acquired = (Get-Date).ToUniversalTime().ToString('o') }
                foreach ($k in $Info.Keys) { $me[$k] = $Info[$k] }
                $bytes = [Text.Encoding]::UTF8.GetBytes(($me | ConvertTo-Json -Compress))
                $fs.SetLength(0); $fs.Position = 0; $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true)
                return [pscustomobject]@{ Stream = $fs; Path = $Path; StalePrevious = $(if ($previous -and $previous.pid -ne $PID) { $previous } else { $null }) }
            }
        }
        $holder = Read-CiLockHolder $Path
        if (-not $announced -and $OnWait) { & $OnWait $holder; $announced = $true }
        if ((Get-Date) -ge $deadline) { return $null }
        Start-Sleep -Milliseconds 1000
    }
}

function Exit-CiLock {
    param($Lock)
    if (-not $Lock) { return }
    try { $Lock.Stream.SetLength(0); $Lock.Stream.Flush($true) } catch { }
    $Lock.Stream.Dispose()
}

# ---------------------------------------------------------------- deploy rule

<#
.SYNOPSIS The only place that decides whether a run may publish an over-the-air update.
#>
function Get-DeployDecision {
    param(
        [bool]$Requested, [bool]$OnMain, [bool]$Green, [bool]$OtaChanged,
        [bool]$AlreadyDeployed, [bool]$ScriptExists
    )
    if (-not $Requested) { return [pscustomobject]@{ Deploy = $false; Reason = 'deploy not requested for this trigger' } }
    if (-not $Green) { return [pscustomobject]@{ Deploy = $false; Reason = 'this SHA has no green run' } }
    if (-not $OnMain) { return [pscustomobject]@{ Deploy = $false; Reason = 'SHA is not on main' } }
    if ($AlreadyDeployed) { return [pscustomobject]@{ Deploy = $false; Reason = 'SHA already published (idempotent skip)' } }
    if (-not $OtaChanged) { return [pscustomobject]@{ Deploy = $false; Reason = 'no apps/mobile src/assets change since the last deployed SHA' } }
    if (-not $ScriptExists) { return [pscustomobject]@{ Deploy = $false; Reason = 'apps/mobile/scripts/publish-update.mjs does not exist yet' } }
    [pscustomobject]@{ Deploy = $true; Reason = 'green main SHA with phone changes' }
}

<#
.SYNOPSIS Pulls the JSON of the part named "manifest" out of an expo-updates multipart/mixed response.
#>
function Get-OtaManifestPart {
    param([string]$ContentType, [string]$Body)
    $m = [regex]::Match($ContentType, 'boundary="?(?<b>[^";]+)"?')
    if (-not $m.Success) { return $null }
    foreach ($part in ($Body -split [regex]::Escape('--' + $m.Groups['b'].Value))) {
        $split = [regex]::Match($part, '\r?\n\r?\n')
        if (-not $split.Success) { continue }
        $headers = $part.Substring(0, $split.Index)
        if ($headers -notmatch '(?im)^content-disposition:.*\bname="?manifest"?') { continue }
        try { return ($part.Substring($split.Index + $split.Length).Trim() | ConvertFrom-Json) } catch { return $null }
    }
    $null
}

<#
.SYNOPSIS Decides whether the host serves exactly the update that was just published.
#>
function Test-OtaServed {
    param([int]$StatusCode, [string]$ContentType, [string]$Body, [string]$ExpectedId, [string]$ExpectedRuntime)
    $fail = { param($r) [pscustomobject]@{ Ok = $false; Reason = $r } }
    if ($StatusCode -in 401, 404) { return & $fail "HTTP ${StatusCode}: the running Pegasus host has no update route yet (ship the Pegasus update with the host routes)" }
    if ($StatusCode -eq 204) { return & $fail "HTTP 204: the host serves no update for runtime $ExpectedRuntime" }
    if ($StatusCode -ne 200) { return & $fail "HTTP $StatusCode" }
    $manifest = Get-OtaManifestPart -ContentType $ContentType -Body $Body
    if (-not $manifest) { return & $fail 'response has no readable "manifest" part' }
    if ("$($manifest.id)" -ne $ExpectedId -or "$($manifest.runtimeVersion)" -ne $ExpectedRuntime) {
        return & $fail "host serves id $($manifest.id) / runtime $($manifest.runtimeVersion), expected $ExpectedId / $ExpectedRuntime"
    }
    [pscustomobject]@{ Ok = $true; Reason = "host serves update $ExpectedId" }
}

# ---------------------------------------------------------------- state files

function Write-JsonAtomic {
    param([string]$Path, $Value, [int]$Depth = 8)
    $tmp = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($tmp, ($Value | ConvertTo-Json -Depth $Depth), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Add-JsonLine {
    param([string]$Path, $Value)
    [IO.File]::AppendAllText($Path, (($Value | ConvertTo-Json -Depth 8 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Read-ShaSet {
    param([string]$Path)
    $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if (Test-Path -LiteralPath $Path) { foreach ($l in [IO.File]::ReadAllLines($Path)) { if ($l.Trim()) { [void]$set.Add($l.Trim()) } } }
    , $set
}

function Remove-OldRunFolders {
    param([string]$RunsDir, [int]$Keep = 30)
    $dirs = @(Get-ChildItem -LiteralPath $RunsDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    $old = @($dirs | Select-Object -Skip $Keep)
    foreach ($d in $old) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    $old.Count
}

function Get-FilesHash {
    param([string]$Root, [string[]]$RelativePaths)
    $sha = [Security.Cryptography.SHA256]::Create()
    $sb = [Text.StringBuilder]::new()
    foreach ($rel in $RelativePaths) {
        $p = Join-Path $Root $rel
        $files = if (Test-Path -LiteralPath $p -PathType Container) { Get-ChildItem -LiteralPath $p -File -Recurse | Sort-Object FullName } elseif (Test-Path -LiteralPath $p) { Get-Item -LiteralPath $p } else { @() }
        foreach ($f in $files) {
            $h = [Convert]::ToHexString($sha.ComputeHash([IO.File]::ReadAllBytes($f.FullName)))
            [void]$sb.Append($f.FullName.Substring($Root.Length)).Append('=').Append($h).Append("`n")
        }
    }
    [Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sb.ToString())))
}

# ---------------------------------------------------------------- step runner

function ConvertTo-CommandLine {
    param([string[]]$Parts)
    ($Parts | ForEach-Object {
        if ($_ -notmatch '[\s"]' -and $_ -ne '') { $_ }
        else { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
    }) -join ' '
}

function New-CiStep {
    param(
        [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Stage,
        [Parameter(Mandatory)][string[]]$Command, [Parameter(Mandatory)][string]$Cwd,
        [int]$TimeoutSec = 600, [string[]]$Needs = @(),
        [ValidateSet('test', 'check', 'infra', 'setup')][string]$Kind = 'check',
        [hashtable]$Env = @{}, [scriptblock]$OnTimeout
    )
    [pscustomobject]@{
        Name = $Name; Stage = $Stage; Command = $Command; Cwd = $Cwd; TimeoutSec = $TimeoutSec; Needs = $Needs
        Kind = $Kind; Env = $Env; OnTimeout = $OnTimeout
        Status = 'pending'; ExitCode = $null; Seconds = 0.0; Log = $null; Attempts = 0; Note = $null; Process = $null; Started = $null
    }
}

function Start-CiStepProcess {
    param($Step, [string]$LogDir, [hashtable]$BaseEnv)
    $Step.Log = Join-Path $LogDir ($Step.Name + '.log')
    $Step.Attempts++
    $env = @{}; foreach ($k in $BaseEnv.Keys) { $env[$k] = $BaseEnv[$k] }; foreach ($k in $Step.Env.Keys) { $env[$k] = $Step.Env[$k] }
    $line = ConvertTo-CommandLine $Step.Command
    $header = "### attempt $($Step.Attempts) $(Get-Date -Format o)`n### cwd $($Step.Cwd)`n### $line`n"
    [IO.File]::AppendAllText($Step.Log, $header)
    $Step.Process = [CiProcess]::Start($line, $Step.Cwd, $Step.Log, $env)
    $Step.Started = [Diagnostics.Stopwatch]::StartNew()
    $Step.Status = 'running'
}

function Stop-CiStepProcess {
    param($Step, [string]$Status, [string]$Note)
    if ($Step.Process) {
        $Step.Process.KillTree(1)
        $left = $Step.Process.ActiveProcesses
        $Step.Process.Dispose(); $Step.Process = $null
        if ($left -gt 0) { $Note = "$Note; $left process(es) still in the job after kill" }
    }
    $Step.Status = $Status; $Step.Note = $Note
    if ($Step.Started) { $Step.Seconds += [math]::Round($Step.Started.Elapsed.TotalSeconds, 1); $Step.Started = $null }
}

<#
.SYNOPSIS Runs one stage's steps (parallel where their Needs allow), fail-fast, with per-step timeouts.
A failed test step gets ONE diagnostic rerun: if it then passes it is "flaky", which still fails the run.
#>
function Invoke-CiStage {
    param([object[]]$Steps, [string]$LogDir, [hashtable]$BaseEnv, [int]$MaxParallel = 4, [scriptblock]$Log)
    $failed = $false
    while ($true) {
        # A step on its diagnostic rerun is still a running process: poll and time it out the same way.
        $running = @($Steps | Where-Object { $_.Status -in 'running', 'rerun' })
        foreach ($s in $running) {
            if ($s.Process.HasExited) {
                $code = $s.Process.ExitCode
                # The root process exiting does not end its tree; anything it left behind is killed here.
                $orphans = $s.Process.ActiveProcesses
                $s.Process.Dispose(); $s.Process = $null
                $s.Seconds += [math]::Round($s.Started.Elapsed.TotalSeconds, 1); $s.Started = $null
                $s.ExitCode = $code
                if ($orphans -gt 0) { & $Log "  $($s.Name): killed $orphans leftover process(es) after exit" }
                if ($code -eq 0) {
                    if ($s.Status -eq 'rerun') { $s.Status = 'flaky'; $s.Note = 'failed, then passed on the diagnostic rerun'; $failed = $true }
                    else { $s.Status = 'passed' }
                    & $Log ("  {0,-8} {1} ({2}s)" -f $s.Status.ToUpper(), $s.Name, $s.Seconds)
                } elseif ($s.Kind -eq 'test' -and $s.Attempts -eq 1) {
                    & $Log "  FAILED   $($s.Name) exit $code ($($s.Seconds)s); diagnostic rerun to tell flaky from broken (the run fails either way)"
                    Start-CiStepProcess -Step $s -LogDir $LogDir -BaseEnv $BaseEnv
                    $s.Status = 'rerun'
                } else {
                    $s.Status = 'failed'; $failed = $true
                    if ($s.Attempts -gt 1) { $s.Note = 'failed twice (not flaky)' }
                    & $Log "  FAILED   $($s.Name) exit $code ($($s.Seconds)s) log: $($s.Log)"
                }
            } elseif ($s.Started.Elapsed.TotalSeconds -ge $s.TimeoutSec) {
                Stop-CiStepProcess -Step $s -Status 'timeout' -Note "timed out after $($s.TimeoutSec)s; process tree killed"
                if ($s.OnTimeout) { try { & $s.OnTimeout $s } catch { & $Log "  $($s.Name) timeout cleanup failed: $_" } }
                $failed = $true
                & $Log "  TIMEOUT  $($s.Name) after $($s.TimeoutSec)s; killed its process tree. log: $($s.Log)"
            }
        }
        if ($failed) {
            foreach ($s in @($Steps | Where-Object { $_.Status -in 'running', 'rerun' })) {
                # A diagnostic rerun still finishes, so the flaky/broken verdict is not lost.
                if ($s.Status -eq 'rerun') { continue }
                Stop-CiStepProcess -Step $s -Status 'cancelled' -Note 'stopped by fail-fast'
                if ($s.OnTimeout) { try { & $s.OnTimeout $s } catch { } }
                & $Log "  CANCEL   $($s.Name) (fail-fast)"
            }
            foreach ($s in @($Steps | Where-Object Status -eq 'pending')) { $s.Status = 'skipped'; $s.Note = 'not started: an earlier step failed' }
            if (-not @($Steps | Where-Object Status -eq 'rerun')) { break }
        }
        $active = @($Steps | Where-Object { $_.Status -in 'running', 'rerun' }).Count
        if (-not $failed) {
            foreach ($s in @($Steps | Where-Object Status -eq 'pending')) {
                if ($active -ge $MaxParallel) { break }
                $blocked = $false
                foreach ($n in $s.Needs) {
                    $dep = $Steps | Where-Object Name -eq $n
                    if ($dep -and $dep.Status -ne 'passed') { $blocked = $true }
                }
                if ($blocked) { continue }
                & $Log "  start    $($s.Name)"
                try { Start-CiStepProcess -Step $s -LogDir $LogDir -BaseEnv $BaseEnv; $active++ }
                catch { $s.Status = 'failed'; $s.Note = "could not start: $_"; $failed = $true; & $Log "  FAILED   $($s.Name) could not start: $_" }
            }
        }
        if (-not @($Steps | Where-Object { $_.Status -in 'running', 'rerun', 'pending' })) { break }
        Start-Sleep -Milliseconds 250
    }
    -not $failed
}

<#
.SYNOPSIS Retries an infrastructure action (ssh, network), never a test. Every retry is logged.
#>
function Invoke-InfraRetry {
    param([string]$What, [scriptblock]$Action, [int]$Retries = 2, [int[]]$BackoffSec = @(5, 20), [scriptblock]$Log)
    for ($i = 0; ; $i++) {
        try { return & $Action }
        catch {
            if ($i -ge $Retries) { throw }
            $wait = $BackoffSec[[math]::Min($i, $BackoffSec.Count - 1)]
            & $Log "  RETRY    $What attempt $($i + 2)/$($Retries + 1) in ${wait}s after: $($_.Exception.Message)"
            Start-Sleep -Seconds $wait
        }
    }
}

Export-ModuleMember -Function Get-CiAreas, Test-CiLockHolderAlive, Read-CiLockHolder, Enter-CiLock, Exit-CiLock,
    Get-DeployDecision, Get-OtaManifestPart, Test-OtaServed, Write-JsonAtomic, Add-JsonLine, Read-ShaSet, Remove-OldRunFolders, Get-FilesHash,
    ConvertTo-CommandLine, New-CiStep, Invoke-CiStage, Invoke-InfraRetry, Stop-CiStepProcess, Get-ProcessStartIso
