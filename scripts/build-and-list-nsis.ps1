$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force logs | Out-Null

# run builder
$npx = (Get-Command npx.cmd).Source
$p = Start-Process -FilePath $npx -ArgumentList 'electron-builder','--win','nsis-web','--x64','--publish','never' -NoNewWindow -Wait -PassThru -RedirectStandardOutput 'logs\builder.out' -RedirectStandardError 'logs\builder.err'
if ($p.ExitCode -ne 0) { Write-Host "BUILDER_FAILED EXIT=$($p.ExitCode)"; Get-Content -Tail 200 -Encoding utf8 'logs\builder.err' | Out-Host; exit $p.ExitCode }

# find nsis dir
$nsisDir = Get-ChildItem -Directory -Filter 'dist*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'nsis-web' }
if (!(Test-Path $nsisDir)) { Write-Host 'nsis-web not found'; exit 1 }
Write-Host 'NSIS_DIR=' + $nsisDir
Get-ChildItem $nsisDir -File | Select-Object Name,Length,LastWriteTime | Format-Table -Auto | Out-String | Out-File -Encoding utf8 logs\nsis_listing.txt
Get-Content logs\nsis_listing.txt | Out-Host
