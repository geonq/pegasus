#Requires -Version 7
<#
.SYNOPSIS One poll of geonq/main: when main moved, runs CI for its head, which deploys the phone update on green.
Called every 2 minutes by the scheduled task from install-scheduler.ps1. An unchanged main costs one
`git fetch` and writes nothing. A busy runner (exit 3) or a runner error (exit 2) is retried next poll.
#>
param(
    [string]$Repo = 'D:\Pi\pi-gui',
    [string]$StateDir = 'D:\Pi\pi-ecosystem\.state\local-ci'
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\LocalCi.psm1') -Force
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$log = Join-Path $StateDir 'scheduler.log'
function Log([string]$m) { [IO.File]::AppendAllText($log, "$(Get-Date -Format o) $m`n") }

try {
    Invoke-InfraRetry -What 'git fetch geonq main' -Log { param($m) Log $m } -Action {
        $out = git -C $Repo fetch --quiet geonq main 2>&1
        if ($LASTEXITCODE -ne 0) { throw "git fetch exit ${LASTEXITCODE}: $out" }
    }
} catch { Log "poll: fetch failed after retries: $($_.Exception.Message)"; exit 2 }
$sha = (git -C $Repo rev-parse 'refs/remotes/geonq/main').Trim()
$polledFile = Join-Path $StateDir 'last-polled.txt'
if ((Test-Path $polledFile) -and (Get-Content -Raw $polledFile).Trim() -eq $sha) { exit 0 }

Log "poll: geonq/main is $sha, running CI"
& (Join-Path $PSScriptRoot 'run-ci.ps1') -Trigger scheduled -Sha $sha -Repo $Repo -StateDir $StateDir *>> $log
$code = $LASTEXITCODE
# 0 and 1 are verdicts on this SHA; 2 (runner error) and 3 (busy) are retried on the next poll.
if ($code -in 0, 1) { [IO.File]::WriteAllText($polledFile, $sha) }
Log "poll: run-ci exit $code"
exit $code
