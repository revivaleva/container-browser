$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

param([Parameter(Mandatory=$true)][string]$Path)

if(-not (Test-Path $Path)){
  throw "Installer not found: $Path"
}

New-Item -ItemType Directory -Force logs | Out-Null
$ts = Get-Date -Format yyyyMMdd_HHmmss
$log = "logs\local_install_$ts.log"

"Launching installer: $Path" | Tee-Object -FilePath $log -Append | Out-Host

# Launch interactive installer (will prompt UAC)
Start-Process -FilePath $Path -Verb RunAs -Wait

"Installer process exited" | Tee-Object -FilePath $log -Append | Out-Host

# Re-run installed info check
Write-Host "Collecting installed info..."
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-installed-info.ps1 | Out-Host

"Done. Installer log: $log" | Tee-Object -FilePath $log -Append | Out-Host

