[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [string]$TaskName = 'MusicFleet-PM2'
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$selectedNode = (Resolve-Path -LiteralPath $NodeExecutable).Path
if ([System.IO.Path]::GetFileName($selectedNode) -ne 'node.exe') { throw 'NodeExecutable must point to node.exe.' }
& $selectedNode (Join-Path $projectRoot 'scripts\pm2-preflight.js')
if ($LASTEXITCODE -ne 0) { throw 'PM2 preflight failed; task was not registered.' }
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '"' + (Join-Path $projectRoot 'scripts\pm2-control.js') + '" start'
$action = New-ScheduledTaskAction -Execute $selectedNode -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start the local music fleet PM2 process after user logon.' -Force | Out-Null
Write-Host "Registered '$TaskName' for $currentUser at logon. Node: $selectedNode"
