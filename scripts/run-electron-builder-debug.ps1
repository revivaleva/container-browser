$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force logs | Out-Null
$out = Join-Path $PSScriptRoot '..\logs\electron_debug.out'
$err = Join-Path $PSScriptRoot '..\logs\electron_debug.err'

$npx = ''
try { $npx = (Get-Command npx.cmd).Source } catch { $npx = 'npx.cmd' }

Write-Host "Running electron-builder (debug), stdout->$out stderr->$err"
$p = Start-Process -FilePath $npx -ArgumentList 'electron-builder','--win','--x64','--publish','never','--debug' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Write-Host 'EXIT=' + $p.ExitCode

if (Test-Path $err) { Write-Host '== ERR (tail 500) ==' ; Get-Content -Tail 500 -Encoding utf8 $err | Out-Host }
if (Test-Path $out) { Write-Host '== OUT (tail 500) ==' ; Get-Content -Tail 500 -Encoding utf8 $out | Out-Host }
