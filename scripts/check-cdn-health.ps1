param(
  [string]$CDN = 'https://updates.threadsbooster.jp'
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''
New-Item -ItemType Directory -Force logs | Out-Null
$yPath = Join-Path $PWD 'logs\cdn_latest.yml'
& "$env:SystemRoot\System32\curl.exe" -sSLo $yPath "$CDN/latest.yml"
$y = Get-Content $yPath -Raw
$pkg = ([regex]::Matches($y,'(?im)[\w\-.]+\.nsis\.7z') | Select-Object -Last 1).Value
Write-Host "PKG: $pkg"
& "$env:SystemRoot\System32\curl.exe" -I "$CDN/nsis-web/$pkg" | Select-String '^HTTP/' | Out-Host
& "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$CDN/nsis-web/$pkg" | Select-String '^HTTP/' | Out-Host
