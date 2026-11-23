#Requires -Version 7
<#
.SYNOPSIS Installs (or with -Remove, removes) the "Pegasus Local CI" scheduled task: poll geonq/main every 2 minutes.
Not installed automatically. The task runs as the current user, only while logged on, through a
headless console (no window), and never starts a second copy while one is running.
#>
param([switch]$Remove, [string]$TaskName = 'Pegasus Local CI')
$ErrorActionPreference = 'Stop'
if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    "removed scheduled task '$TaskName'"
    return
}
$pwsh = (Get-Process -Id $PID).Path
$poll = Join-Path $PSScriptRoot 'poll-main.ps1'
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
    -Argument "--headless `"$pwsh`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$poll`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45) `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Local CI for D:\Pi\pi-gui: runs scripts/local-ci/run-ci.ps1 on new geonq/main commits and deploys the phone update.' -Force | Out-Null
"installed scheduled task '$TaskName' (every 2 minutes); log: D:\Pi\pi-ecosystem\.state\local-ci\scheduler.log"
