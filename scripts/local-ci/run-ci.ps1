#Requires -Version 7
<#
.SYNOPSIS
  Local CI/CD for Pegasus: checks one exact commit in an isolated worktree, then (on green main)
  publishes the phone's over-the-air update and verifies it. No GitHub Actions, no cloud.

.DESCRIPTION
  Stages, fail-fast in this order:
    0 prepare  lock, reset the worktree to the SHA, install only when a lockfile changed
    1 static   desktop: prettier, eslint, architecture guards, typecheck | mobile: tsc
    2 unit     desktop: guards, package tests, extension examples, release helpers, desktop unit
               specs | rust: cargo test (pegasus-core + pegasus-host) | mobile: node --test
    3 build    iOS compile on the Mac (unsigned), only when native phone files changed
    4 deploy   OTA publish (main, green, phone change, never twice per SHA)
    5 verify   fetch the live manifest; on mismatch roll "latest" back and fail
  Only steps whose area changed since the last green SHA run (see Get-CiAreas in lib/LocalCi.psm1).

.PARAMETER Sha        Commit to check (default: geonq/main if -Trigger scheduled, else HEAD of D:\Pi\pi-gui).
.PARAMETER Trigger    manual | pre-push | scheduled. Only "scheduled" and "manual -Deploy" may publish.
.PARAMETER Full       Ignore the last-green base and run every check.
.PARAMETER Deploy     Allow stage 4/5 for a manual run.
.PARAMETER WaitSeconds How long to wait for another run's lock (default 0: exit 3 at once).

Exit codes: 0 green, 1 a check failed, 2 the runner itself failed, 3 another run holds the lock.
#>
[CmdletBinding()]
param(
    [string]$Sha,
    [ValidateSet('manual', 'pre-push', 'scheduled')][string]$Trigger = 'manual',
    [switch]$Full,
    [switch]$Deploy,
    # Explicit opt-out for when the Mac is offline. The run is then never recorded as green, so the
    # native change is checked again by the next run.
    [switch]$SkipIos,
    [int]$WaitSeconds = 0,
    [string]$Repo = 'D:\Pi\pi-gui',
    [string]$StateDir = 'D:\Pi\pi-ecosystem\.state\local-ci',
    [string]$MacHost = 'georgdomke@100.71.145.90',
    [string]$MacRepo = '~/Pi/pi-gui-attachments',
    [string]$ManifestUrl = 'http://127.0.0.1:47831/v1/updates/manifest'
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\LocalCi.psm1') -Force

$Node = (Get-Command node -ErrorAction Stop).Source
$Git = (Get-Command git -ErrorAction Stop).Source
$Work = Join-Path $StateDir 'work\pi-gui'
$RunsDir = Join-Path $StateDir 'runs'
$CacheDir = Join-Path $StateDir 'cache'
$CargoTarget = Join-Path $CacheDir 'cargo-target'
New-Item -ItemType Directory -Force -Path $RunsDir, $CacheDir | Out-Null

$runClock = [Diagnostics.Stopwatch]::StartNew()
$script:LogFile = $null
$script:Pending = [Collections.Generic.List[string]]::new()
function Log([string]$Text) {
    $line = "[{0,6:0.0}s] {1}" -f $runClock.Elapsed.TotalSeconds, $Text
    Write-Host $line
    if ($script:LogFile) { [IO.File]::AppendAllText($script:LogFile, $line + "`n") } else { $script:Pending.Add($line) }
}
function GitOut([string]$Dir, [string[]]$GitArgs) {
    $out = & $Git -C $Dir @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed: $out" }
    $out
}

# ---------------------------------------------------------------- lock (one runner at a time)
$lock = Enter-CiLock -Path (Join-Path $StateDir 'runner.lock') -WaitSeconds $WaitSeconds -Info @{ trigger = $Trigger } -OnWait {
    param($h)
    $who = if ($h) { "PID $($h.pid) (started $($h.startTime), trigger $($h.trigger), sha $($h.sha))" } else { 'another process' }
    if ($WaitSeconds -gt 0) { Write-Host "local-ci: waiting up to ${WaitSeconds}s for the running CI: $who" }
    else { Write-Host "local-ci: another CI run holds the lock: $who" }
}
if (-not $lock) { Write-Host 'local-ci: BUSY - not started, nothing ran (exit 3)'; exit 3 }
if ($lock.StalePrevious) { Log "lock: took over a stale lock from PID $($lock.StalePrevious.pid) (that exact process is gone)" }

$status = $null
$steps = [Collections.Generic.List[object]]::new()
$exitCode = 2
# Read by the finally block even when the run fails before they are set.
$runId = $null; $RunDir = $null; $onMain = $false; $areas = $null
try {
    # ---------------------------------------------------------------- resolve the commit
    if (-not $Sha) { $Sha = if ($Trigger -eq 'scheduled') { 'refs/remotes/geonq/main' } else { 'HEAD' } }
    $Sha = (GitOut $Repo @('rev-parse', '--verify', "$Sha^{commit}")).Trim()
    $short = $Sha.Substring(0, 10)
    $runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $short
    $RunDir = Join-Path $RunsDir $runId
    New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
    $script:LogFile = Join-Path $RunDir 'run.log'
    [IO.File]::WriteAllLines($script:LogFile, $script:Pending)
    $lock.Stream.SetLength(0)
    $info = [Text.Encoding]::UTF8.GetBytes((@{ pid = $PID; startTime = (Get-ProcessStartIso $PID); sha = $Sha; trigger = $Trigger; run = $runId } | ConvertTo-Json -Compress))
    $lock.Stream.Write($info, 0, $info.Length); $lock.Stream.Flush($true)
    Log "local-ci $Trigger run $runId (sha $Sha)"

    # main = the SHA is contained in geonq/main as this machine last fetched it (the scheduler fetches).
    & $Git -C $Repo merge-base --is-ancestor $Sha 'refs/remotes/geonq/main' 2>$null
    $onMain = ($LASTEXITCODE -eq 0)

    # ---------------------------------------------------------------- what changed since the last green SHA
    $lastGreenFile = Join-Path $StateDir 'last-green.txt'
    $base = if (Test-Path $lastGreenFile) { (Get-Content -Raw $lastGreenFile).Trim() } else { '' }
    $greenSet = Read-ShaSet (Join-Path $StateDir 'green-shas.txt')
    $files = $null
    if ($Full) { Log 'changes: -Full, every check runs' }
    elseif (-not $base) { Log 'changes: no last green SHA yet, every check runs' }
    elseif ($greenSet.Contains($Sha)) {
        # The exact SHA (same tree) already passed; only the deploy decision is left.
        $files = @(); Log "changes: $short already passed CI, nothing to check"
    } else {
        & $Git -C $Repo cat-file -e "$base^{commit}" 2>$null
        if ($LASTEXITCODE -ne 0) { Log "changes: last green $base is unknown here, every check runs" }
        else {
            # Diff from the merge base, but only when that base itself passed: an older SHA than the
            # last green one (merge base = the SHA itself) must not inherit a green it never earned.
            $mb = (GitOut $Repo @('merge-base', $base, $Sha)).Trim()
            if ($mb -eq $base -or $greenSet.Contains($mb)) {
                $files = @(GitOut $Repo @('diff', '--name-only', '--no-renames', $mb, $Sha) | Where-Object { $_ })
                Log "changes: $($files.Count) file(s) since green $($mb.Substring(0, 10))"
            } else { Log "changes: no green ancestor shared with last green $($base.Substring(0, 10)), every check runs" }
        }
    }
    $areas = Get-CiAreas -Files $files
    # Changing the CI itself re-runs everything once, so a broken runner cannot report green.
    if ($areas.ci -and $null -ne $files) { $areas = Get-CiAreas -Files $null; Log 'changes: scripts/local-ci changed, every check runs' }
    Log ("areas: desktop={0} rust={1} mobile={2} ios-native={3} phone-ota={4}" -f $areas.desktop, $areas.rust, $areas.mobile, $areas.ios, $areas.ota)

    # ---------------------------------------------------------------- stage 0: clean worktree of the exact SHA
    $prep = [Diagnostics.Stopwatch]::StartNew()
    $anyCheck = $areas.desktop -or $areas.rust -or $areas.mobile
    if (-not (Test-Path (Join-Path $Work '.git'))) {
        Log "prepare: creating worktree $Work"
        GitOut $Repo @('worktree', 'add', '--detach', '--force', $Work, $Sha) | Out-Null
    }
    GitOut $Work @('checkout', '--quiet', '--force', '--detach', $Sha) | Out-Null
    # -x removes ignored files too (stale builds, test output); only node_modules stays. Other caches\n    # (cargo target, eslint) live outside the worktree in $CacheDir.
    GitOut $Work @('clean', '-fdxq', '-e', 'node_modules') | Out-Null
    $head = (GitOut $Work @('rev-parse', 'HEAD')).Trim()
    if ($head -ne $Sha) { throw "worktree is at $head, expected $Sha" }
    $dirty = GitOut $Work @('status', '--porcelain', '--untracked-files=all', '--ignored=no')
    if ($dirty) { throw "worktree is not clean after reset: $dirty" }
    Log ("prepare: worktree at {0}, clean ({1:0.0}s)" -f $short, $prep.Elapsed.TotalSeconds)

    $baseEnv = @{
        CI = $null; FORCE_COLOR = '0'; NO_COLOR = '1'; CARGO_TARGET_DIR = $CargoTarget; CARGO_TERM_COLOR = 'never'
        PEGASUS_HOST = '0'; PI_APP_TEST_MODE = $null; npm_config_yes = 'true'
        # Some tests look for these; never hand the CI's own lock or the owner's data to them.
        PLAYWRIGHT_HTML_OPEN = 'never'
    }
    if ([CiProcess]::CurrentTokenRestricted()) {
        # Same opt-out the specs document (tests/helpers/electron-app.ts): Chromium's sandbox cannot
        # start under a restricted token. A run from the owner's terminal or the scheduled task keeps it.
        $baseEnv.PI_APP_TEST_NO_SANDBOX = '1'
        Log 'env: restricted token (agent sandbox), Electron specs run with PI_APP_TEST_NO_SANDBOX=1'
    }
    # pnpm itself comes from the runner's own install (D:\Pi\pi-gui), pinned by its lockfile; the
    # worktree cannot bootstrap it before its first install.
    $pnpm = @($Node, (Join-Path $PSScriptRoot '..\..\node_modules\pnpm\bin\pnpm.cjs' | Resolve-Path).Path)
    $stamps = Join-Path $CacheDir 'install-stamps.json'
    $stamp = if (Test-Path $stamps) { Get-Content -Raw $stamps | ConvertFrom-Json -AsHashtable } else { @{} }
    $installSteps = @()
    $rootLockHash = Get-FilesHash -Root $Work -RelativePaths @('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '.npmrc', 'patches')
    $mobileLockHash = Get-FilesHash -Root $Work -RelativePaths @('apps/mobile/pnpm-lock.yaml', 'apps/mobile/package.json', 'apps/mobile/.npmrc', 'apps/mobile/deps')
    $needRoot = $areas.desktop -and ($stamp['root'] -ne $rootLockHash -or -not (Test-Path (Join-Path $Work 'node_modules\.modules.yaml')))
    $needMobile = ($areas.mobile -or $areas.ota) -and ($stamp['mobile'] -ne $mobileLockHash -or -not (Test-Path (Join-Path $Work 'apps\mobile\node_modules\.modules.yaml')))
    if ($needRoot) { $installSteps += New-CiStep -Name 'install-root' -Stage prepare -Kind setup -Cwd $Work -TimeoutSec 2700 -Command ($pnpm + @('install', '--frozen-lockfile', '--prefer-offline', '--reporter=append-only')) }
    if ($needMobile) { $installSteps += New-CiStep -Name 'install-mobile' -Stage prepare -Kind setup -Cwd (Join-Path $Work 'apps\mobile') -TimeoutSec 2700 -Command ($pnpm + @('install', '--frozen-lockfile', '--prefer-offline', '--ignore-workspace', '--reporter=append-only')) }
    if ($installSteps) {
        Log "stage prepare: $(($installSteps | ForEach-Object Name) -join ', ') (lockfile changed or first run)"
        $installSteps | ForEach-Object { $steps.Add($_) }
        if (-not (Invoke-CiStage -Steps $installSteps -LogDir $RunDir -BaseEnv $baseEnv -Log { param($m) Log $m })) { throw [Management.Automation.RuntimeException]::new('CHECK_FAILED') }
        if ($needRoot) { $stamp['root'] = $rootLockHash }
        if ($needMobile) { $stamp['mobile'] = $mobileLockHash }
        Write-JsonAtomic -Path $stamps -Value $stamp
    } elseif ($anyCheck) { Log 'prepare: dependencies cached (lockfile hashes unchanged), no install' }

    # ---------------------------------------------------------------- stage 1 + 2: checks
    $mobileDir = Join-Path $Work 'apps\mobile'
    $mobileTests = if ($areas.mobile) { @(Get-ChildItem -Path (Join-Path $mobileDir 'src') -Recurse -Filter '*.test.ts' | ForEach-Object { [IO.Path]::GetRelativePath($mobileDir, $_.FullName).Replace('\', '/') }) } else { @() }
    $cargo = @((Get-Command cargo -ErrorAction Stop).Source)
    $cargoTest = $cargo + @('test', '--manifest-path', 'crates/Cargo.toml', '-q', '-p', 'pegasus-core', '-p', 'pegasus-host')
    $playwright = @($Node, (Join-Path $Work 'node_modules\@playwright\test\cli.js'))

    $static = @()
    if ($areas.desktop) {
        # build:shared first: lint, typecheck and the tests all import the built shared packages.
        $static += New-CiStep -Name 'desktop-build-shared' -Stage static -Cwd $Work -TimeoutSec 300 -Command ($pnpm + @('run', 'build:shared'))
        $static += New-CiStep -Name 'desktop-format' -Stage static -Cwd $Work -TimeoutSec 300 -Command ($pnpm + @('exec', 'prettier', '--check', '.', '--log-level', 'warn'))
        $static += New-CiStep -Name 'desktop-architecture' -Stage static -Cwd $Work -TimeoutSec 120 -Command ($pnpm + @('run', 'check:architecture'))
        $static += New-CiStep -Name 'desktop-lint' -Stage static -Cwd $Work -TimeoutSec 600 -Needs 'desktop-build-shared' -Command @($Node, '--max-old-space-size=8192', 'node_modules/eslint/bin/eslint.js', '.', '--max-warnings', '0', '--cache', '--cache-location', (Join-Path $CacheDir 'eslint\'), '--cache-strategy', 'content')
        # Desktop unit specs start the Rust host (packages/host-protocol/src/shared.ts): build it from
        # this SHA instead of letting them find a stale binary or none.
        $static += New-CiStep -Name 'host-build' -Stage static -Cwd $Work -TimeoutSec 900 -Command ($cargo + @('build', '--manifest-path', 'crates/Cargo.toml', '-q', '-p', 'pegasus-host'))
        $static += New-CiStep -Name 'desktop-workspaces' -Stage static -Cwd $Work -TimeoutSec 120 -Command ($pnpm + @('run', 'check:workspaces'))
        $static += New-CiStep -Name 'desktop-typecheck' -Stage static -Cwd $Work -TimeoutSec 600 -Needs 'desktop-build-shared' -Command ($pnpm + @('-r', '--if-present', 'typecheck'))
        $static += New-CiStep -Name 'desktop-typecheck-examples' -Stage static -Cwd $Work -TimeoutSec 300 -Needs 'desktop-build-shared' -Command ($pnpm + @('run', 'typecheck:extension-examples'))
    }
    if ($areas.mobile) {
        $static += New-CiStep -Name 'mobile-typecheck' -Stage static -Cwd $mobileDir -TimeoutSec 300 -Command @($Node, 'node_modules/typescript/bin/tsc', '--noEmit')
    }
    $unit = @()
    if ($areas.desktop) {
        $unit += New-CiStep -Name 'desktop-guards' -Stage unit -Kind test -Cwd $Work -TimeoutSec 300 -Command ($pnpm + @('run', 'test:guards'))
        $unit += New-CiStep -Name 'desktop-packages' -Stage unit -Kind test -Cwd $Work -TimeoutSec 600 -Command ($pnpm + @('--filter', '@pi-gui/catalogs', '--filter', '@pi-gui/host-protocol', '--filter', '@pi-gui/pi-sdk-driver', '--filter', '@pi-gui/extension-ui', 'test'))
        $unit += New-CiStep -Name 'desktop-extension-examples' -Stage unit -Kind test -Cwd $Work -TimeoutSec 600 -Command ($pnpm + @('run', 'test:extension-examples'))
        $unit += New-CiStep -Name 'desktop-release-helpers' -Stage unit -Kind test -Cwd $Work -TimeoutSec 300 -Command ($pnpm + @('run', 'test:release-helpers'))
        $unit += New-CiStep -Name 'desktop-unit' -Stage unit -Kind test -Cwd $Work -TimeoutSec 900 -Env @{ PEGASUS_HOST = '0'; PEGASUS_HOST_PATH = (Join-Path $CargoTarget 'debug\pegasus-host.exe') } -Command ($playwright + @('test', '-c', 'apps/desktop/playwright.config.ts', 'apps/desktop/tests/unit', '--reporter=line', '--workers=4'))
    }
    if ($areas.rust) {
        $unit += New-CiStep -Name 'rust-test' -Stage unit -Kind test -Cwd $Work -TimeoutSec 900 -Command $cargoTest
    }
    if ($areas.mobile -and $mobileTests) {
        $unit += New-CiStep -Name 'mobile-test' -Stage unit -Kind test -Cwd $mobileDir -TimeoutSec 300 -Command (@($Node, '--test', '--experimental-strip-types', '--test-reporter=dot') + $mobileTests)
    }

    foreach ($stage in @(@{ n = 'static'; s = $static }, @{ n = 'unit'; s = $unit })) {
        if (-not $stage.s) { Log "stage $($stage.n): nothing affected"; continue }
        Log "stage $($stage.n): $(($stage.s | ForEach-Object Name) -join ', ')"
        $stage.s | ForEach-Object { $steps.Add($_) }
        if (-not (Invoke-CiStage -Steps $stage.s -LogDir $RunDir -BaseEnv $baseEnv -MaxParallel 4 -Log { param($m) Log $m })) { throw [Management.Automation.RuntimeException]::new('CHECK_FAILED') }
    }

    # ---------------------------------------------------------------- stage 3: iOS compile on the Mac
    if ($areas.ios -and $SkipIos) {
        Log 'stage build: native phone files changed, but -SkipIos: NOT compiled, so this SHA is not recorded as green'
    } elseif ($areas.ios) {
        Log 'stage build: native phone files changed, compiling iOS on the Mac (unsigned)'
        $sshExe = (Get-Command ssh -ErrorAction Stop).Source
        $scpExe = (Get-Command scp -ErrorAction Stop).Source
        $sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4')
        $infraLog = Join-Path $RunDir 'ios-infra.log'
        $tar = Join-Path $RunDir 'mobile.tar'
        GitOut $Work @('archive', '--format=tar', '-o', $tar, $Sha, 'apps/mobile') | Out-Null
        $copy = [Diagnostics.Stopwatch]::StartNew()
        try {
            # Only the transport is retried (Tailscale or ssh hiccups), never the compile.
            Invoke-InfraRetry -What 'copy sources to the Mac' -Log { param($m) Log $m } -Action {
                & $scpExe @sshOpts -q $tar (Join-Path $PSScriptRoot 'mac\ios-compile.sh') "${MacHost}:/tmp/" *>> $infraLog
                if ($LASTEXITCODE -ne 0) { throw "scp exit $LASTEXITCODE (see $infraLog)" }
            }
        } catch {
            $steps.Add([pscustomobject]@{ Name = 'ios-copy'; Stage = 'build'; Status = 'failed'; Seconds = [math]::Round($copy.Elapsed.TotalSeconds, 1); ExitCode = $null; Attempts = 3; Note = "Mac unreachable: $($_.Exception.Message)"; Log = $infraLog })
            Log "  FAILED   ios-copy: Mac unreachable after 3 attempts"
            throw [Management.Automation.RuntimeException]::new('CHECK_FAILED')
        }
        $ios = New-CiStep -Name 'ios-compile' -Stage build -Cwd $Work -TimeoutSec 1800 `
            -Command (@($sshExe) + $sshOpts + @($MacHost, "bash /tmp/ios-compile.sh /tmp/mobile.tar $Sha")) -OnTimeout {
                # Killing the local ssh tree does not reach the Mac; stop the remote build by its PID file.
                & $sshExe -o BatchMode=yes -o ConnectTimeout=15 $MacHost 'p=$(cat /tmp/pegasus-ci-ios.pid 2>/dev/null) && { pkill -TERM -P "$p"; kill -TERM "$p"; }; true' *>> $infraLog
            }
        $steps.Add($ios)
        if (-not (Invoke-CiStage -Steps @($ios) -LogDir $RunDir -BaseEnv $baseEnv -Log { param($m) Log $m })) { throw [Management.Automation.RuntimeException]::new('CHECK_FAILED') }
    } else { Log 'stage build: no native phone change, iOS compile skipped' }

    # ---------------------------------------------------------------- green
    $exitCode = 0
    $greenFile = Join-Path $StateDir 'green-shas.txt'
    if ($areas.ios -and $SkipIos) { throw [Management.Automation.RuntimeException]::new('PARTIAL') }
    if (-not $greenSet.Contains($Sha)) { [IO.File]::AppendAllText($greenFile, "$Sha`n") }
    # The diff base for the next run. Diffs start at merge-base(last green, next SHA), so a green SHA
    # on a side branch is still a correct base.
    [IO.File]::WriteAllText($lastGreenFile, $Sha)

    # ---------------------------------------------------------------- stage 4 + 5: deploy and verify
    $deployedFile = Join-Path $StateDir 'deployed-shas.txt'
    $deployed = Read-ShaSet $deployedFile
    $publish = Join-Path $mobileDir 'scripts\publish-update.mjs'
    # Phone changes count since the last *deployed* SHA, not the last green one: a green pre-push run
    # (which never deploys) must not hide a phone change from the scheduler's deploy.
    $lastDeployedFile = Join-Path $StateDir 'last-deployed.txt'
    # Never derived from this run's areas: a green SHA whose deploy failed has no changes left to
    # check, but its phone change is still undeployed. Nothing deployed yet counts as a change.
    $otaChanged = $true
    if (Test-Path $lastDeployedFile) {
        $ld = (Get-Content -Raw $lastDeployedFile).Trim()
        & $Git -C $Repo cat-file -e "$ld^{commit}" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $otaChanged = @(GitOut $Repo @('diff', '--name-only', $ld, $Sha, '--', 'apps/mobile/src', 'apps/mobile/assets', 'apps/mobile/index.ts') | Where-Object { $_ }).Count -gt 0
        }
    }
    $decision = Get-DeployDecision -Requested ($Trigger -eq 'scheduled' -or $Deploy) -OnMain $onMain -Green $true -OtaChanged $otaChanged `
        -AlreadyDeployed $deployed.Contains($Sha) -ScriptExists (Test-Path $publish)
    if (-not $decision.Deploy) { Log "stage deploy: skipped - $($decision.Reason)" }
    else {
        Log "stage deploy: $($decision.Reason)"
        $exitCode = 1   # until verified
        $readResult = {
            param($Step)
            $line = Get-Content $Step.Log | Where-Object { $_ -match '^\s*\{.*"id".*\}\s*$' } | Select-Object -Last 1
            if (-not $line) { $Step.Status = 'failed'; $Step.Note = 'printed no JSON result line'; return $null }
            $line | ConvertFrom-Json
        }
        $pub = New-CiStep -Name 'ota-publish' -Stage deploy -Cwd $mobileDir -TimeoutSec 600 -Env @{ PEGASUS_UPDATE_SOURCE_SHA = $Sha } -Command @($Node, $publish, '--json')
        $steps.Add($pub)
        if (-not (Invoke-CiStage -Steps @($pub) -LogDir $RunDir -BaseEnv $baseEnv -Log { param($m) Log $m })) { throw [Management.Automation.RuntimeException]::new('CHECK_FAILED') }
        $published = & $readResult $pub
        if (-not $published) { Log "  FAILED   ota-publish: no JSON result line (log $($pub.Log))"; throw [Management.Automation.RuntimeException]::new('CHECK_FAILED') }
        Log "  update $($published.id) runtime $($published.runtimeVersion) previous $($published.previousId) skipped=$($published.skipped)"

        # ---------------------------------------------------------------- stage 5: what a phone would get
        $verifyServed = {
            param([string]$Name, $Expect)
            $v = [pscustomobject]@{ Name = $Name; Stage = 'verify'; Status = 'running'; Seconds = 0.0; Attempts = 0; ExitCode = $null; Note = $null; Log = (Join-Path $RunDir "$Name.log") }
            $steps.Add($v)
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $verdict = $null
            try {
                $verdict = Invoke-InfraRetry -What "GET $ManifestUrl" -Log { param($m) Log $m } -Action {
                    $v.Attempts++
                    $r = Invoke-WebRequest -Uri $ManifestUrl -TimeoutSec 15 -SkipHttpErrorCheck -Headers @{
                        'expo-protocol-version' = '1'; 'expo-platform' = 'ios'; 'expo-runtime-version' = "$($Expect.runtimeVersion)"; 'accept' = 'multipart/mixed'
                    }
                    $body = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
                    $ct = "$($r.Headers['Content-Type'])"
                    [IO.File]::AppendAllText($v.Log, "attempt $($v.Attempts): HTTP $($r.StatusCode) $ct`n$($body.Substring(0, [math]::Min(3000, $body.Length)))`n")
                    # Server errors may be transient; every other answer is final.
                    if ($r.StatusCode -ge 500) { throw "HTTP $($r.StatusCode)" }
                    Test-OtaServed -StatusCode $r.StatusCode -ContentType $ct -Body $body -ExpectedId "$($Expect.id)" -ExpectedRuntime "$($Expect.runtimeVersion)"
                }
            } catch { $verdict = [pscustomobject]@{ Ok = $false; Reason = "host unreachable: $($_.Exception.Message)" } }
            $v.Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); $v.Note = $verdict.Reason
            $v.Status = if ($verdict.Ok) { 'passed' } else { 'failed' }
            Log ("  {0,-8} {1}: {2} ({3}s)" -f $v.Status.ToUpper(), $Name, $verdict.Reason, $v.Seconds)
            $verdict.Ok
        }
        if (& $verifyServed 'ota-verify' $published) {
            $exitCode = 0
            [IO.File]::AppendAllText($deployedFile, "$Sha`n")
            [IO.File]::WriteAllText($lastDeployedFile, $Sha)
        } elseif ($published.skipped) {
            Log '  publish was an idempotent skip, nothing new to roll back'
        } elseif (-not $published.previousId) {
            Log '  no previous update to roll back to'
        } else {
            # Rollback republishes the previous update's assets as a NEW, newer update, because iOS only
            # loads updates newer than the one it runs; pointing "latest" at the old id would not undo it.
            $rb = New-CiStep -Name 'ota-rollback' -Stage verify -Cwd $mobileDir -TimeoutSec 180 -Command @($Node, $publish, '--rollback', "$($published.previousId)", '--json')
            $steps.Add($rb)
            $rolled = $null
            if (Invoke-CiStage -Steps @($rb) -LogDir $RunDir -BaseEnv $baseEnv -Log { param($m) Log $m }) { $rolled = & $readResult $rb }
            if ($rolled -and (& $verifyServed 'ota-rollback-verify' $rolled)) { Log "  ROLLED BACK: latest is $($rolled.id) (the assets of $($published.previousId))" }
            else { Log "  ROLLBACK NOT VERIFIED - the phone may be offered $($published.id); see $RunDir" }
        }
        if ($exitCode -ne 0) { throw [Management.Automation.RuntimeException]::new('CHECK_FAILED') }
    }
} catch {
    if ($_.Exception.Message -eq 'CHECK_FAILED') { $exitCode = 1 }
    elseif ($_.Exception.Message -eq 'PARTIAL') { $exitCode = 0; Log 'checks passed without the iOS compile (-SkipIos); last-green not moved, no deploy' }
    else {
        $exitCode = 2
        Log "RUNNER ERROR: $($_.Exception.Message) at $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber)"
    }
} finally {
    # Nothing a step started may outlive the run.
    foreach ($s in $steps) { if ($s.PSObject.Properties['Process'] -and $s.Process) { Stop-CiStepProcess -Step $s -Status 'cancelled' -Note 'runner exiting' } }
    $total = [math]::Round($runClock.Elapsed.TotalSeconds, 1)
    $result = @('PASSED', 'FAILED', 'ERROR', 'BUSY')[$exitCode]
    if ($exitCode -eq 0 -and $areas -and $areas.ios -and $SkipIos) { $result = 'PARTIAL' }
    $flaky = @($steps | Where-Object Status -eq 'flaky' | ForEach-Object Name)
    $bad = @($steps | Where-Object { $_.Status -in 'failed', 'timeout', 'flaky' } | ForEach-Object { "$($_.Name)=$($_.Status)" })
    if ($script:LogFile) {
        $status = [ordered]@{
            sha = $Sha; result = $result.ToLower(); trigger = $Trigger; run = $runId; onMain = $onMain
            time = (Get-Date).ToUniversalTime().ToString('o'); seconds = $total; logDir = $RunDir
            areas = $areas; flaky = $flaky
            steps = @($steps | ForEach-Object { [ordered]@{ name = $_.Name; stage = $_.Stage; status = $_.Status; seconds = $_.Seconds; exitCode = $_.ExitCode; attempts = $_.Attempts; note = $_.Note; log = $_.Log } })
        }
        Write-JsonAtomic -Path (Join-Path $RunDir 'status.json') -Value $status
        Write-JsonAtomic -Path (Join-Path $StateDir 'status.json') -Value $status
        Add-JsonLine -Path (Join-Path $StateDir 'history.jsonl') -Value ([ordered]@{ sha = $Sha; result = $status.result; trigger = $Trigger; time = $status.time; seconds = $total; flaky = $flaky; steps = @($steps | ForEach-Object { [ordered]@{ name = $_.Name; status = $_.Status; seconds = $_.Seconds } }) })
        $pruned = Remove-OldRunFolders -RunsDir $RunsDir -Keep 30
        if ($pruned) { Log "pruned $pruned old run folder(s)" }
    }
    $ran = @($steps | Where-Object { $_.Status -ne 'skipped' }).Count
    $line = "local-ci $result $(if ($Sha) { $Sha.Substring(0, [math]::Min(10, $Sha.Length)) }) in ${total}s, $ran step(s)$(if ($bad) { ': ' + ($bad -join ', ') })$(if ($script:LogFile) { " | $RunDir" })"
    Log $line
    Exit-CiLock $lock
}
exit $exitCode
