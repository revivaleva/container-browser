$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

param(
  [string]$Url = 'https://updates.threadsbooster.jp/nsis-web/ContainerBrowser-Offline-Setup.exe'
)

New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$tmp = Join-Path $env:TEMP 'cb_offline_installer.exe'
Write-Host "Downloading $Url -> $tmp"
Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
Write-Host "Downloaded. Launching installer (interactive). Please complete installer UI to finish installation."
# Launch interactive installer (may prompt UAC)
Start-Process -FilePath $tmp -Verb RunAs -Wait
Write-Host "Installer process exited."


