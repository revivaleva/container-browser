$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force logs | Out-Null

# npm install
$npm = (Get-Command npm.cmd).Source
$p = Start-Process -FilePath $npm -ArgumentList 'install' -NoNewWindow -Wait -PassThru -RedirectStandardOutput 'logs\npm_install.out' -RedirectStandardError 'logs\npm_install.err'
if ($p.ExitCode -ne 0) { Write-Host "NPM_INSTALL_FAILED EXIT=$($p.ExitCode)"; exit $p.ExitCode }

# start dev in background and capture logs
$p2 = Start-Process -FilePath $npm -ArgumentList 'run','dev' -NoNewWindow -PassThru -RedirectStandardOutput 'logs\dev.out' -RedirectStandardError 'logs\dev.err'
Write-Host "DEV_STARTED_PID=$($p2.Id)"
