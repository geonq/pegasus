#Requires -Version 7
<#
.SYNOPSIS Points this clone's git hooks at the versioned folder scripts/local-ci/hooks (core.hooksPath).
Undo: git -C D:\Pi\pi-gui config --unset core.hooksPath
#>
param([string]$Repo = 'D:\Pi\pi-gui')
$ErrorActionPreference = 'Stop'
$existing = git -C $Repo config --get core.hooksPath
$legacy = @(Get-ChildItem (Join-Path $Repo '.git\hooks') -File -ErrorAction SilentlyContinue | Where-Object Extension -ne '.sample')
if ($legacy) { throw "Active hooks in .git/hooks would stop running: $($legacy.Name -join ', '). Move them into scripts/local-ci/hooks first." }
if ($existing -and $existing -ne 'scripts/local-ci/hooks') { throw "core.hooksPath is already '$existing'; not overwriting it." }
git -C $Repo config core.hooksPath scripts/local-ci/hooks
if ($LASTEXITCODE -ne 0) { throw 'git config failed' }
"core.hooksPath = $(git -C $Repo config --get core.hooksPath)"
