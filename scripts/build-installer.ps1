param()
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
New-Item -Type Directory -Force logs | Out-Null

# npm ci
$npm = (Get-Command npm.cmd).Source
$p = Start-Process -FilePath $npm -ArgumentList 'ci' -NoNewWindow -Wait -PassThru -RedirectStandardOutput 'logs\npm_ci.out' -RedirectStandardError 'logs\npm_ci.err'
if($p.ExitCode -ne 0){ throw 'npm ci failed' }

# build (no publish)
$npx = (Get-Command npx.cmd).Source
$p = Start-Process -FilePath $npx -ArgumentList 'electron-builder --win --x64 --publish never' -NoNewWindow -Wait -PassThru -RedirectStandardOutput 'logs\build_only.out' -RedirectStandardError 'logs\build_only.err'
if($p.ExitCode -ne 0){ throw 'electron-builder failed' }

# outputs list
Get-ChildItem dist -Recurse -Include latest.yml,*.exe,*.blockmap |
 Sort-Object LastWriteTime -Desc |
 Tee-Object -FilePath 'logs\build_outputs.txt' |
 Format-Table Name,Length,LastWriteTime -Auto
Write-Host 'BUILD_OK'

