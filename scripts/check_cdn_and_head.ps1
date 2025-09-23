param(
  [string]$Cdn = 'https://updates.threadsbooster.jp'
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs | Out-Null
$root = 'logs/cdn_root_latest.yml'
$nsis = 'logs/cdn_nsis_latest.yml'
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'

Write-Host "Fetching $Cdn/latest.yml -> $root"
& $curl -sSLo $root ($Cdn + '/latest.yml')

Write-Host "Fetching $Cdn/nsis-web/latest.yml -> $nsis"
try { & $curl -sSLo $nsis ($Cdn + '/nsis-web/latest.yml') } catch {}

Write-Host '--- root latest.yml ---'
Get-Content -Raw $root | Out-Host
Write-Host ''
Write-Host '--- nsis-web latest.yml ---'
if (Test-Path $nsis) { Get-Content -Raw $nsis | Out-Host } else { Write-Host 'nsis-web/latest.yml not found on CDN' }

$rootTxt = Get-Content -Raw $root
$pkgRoot = ([regex]::Matches($rootTxt,'(?im)[\w\-. ]+\.nsis\.7z') | Select-Object -Last 1).Value
$pkgNsis = $null
if (Test-Path $nsis) { $nsTxt = Get-Content -Raw $nsis; $pkgNsis = ([regex]::Matches($nsTxt,'(?im)[\w\-. ]+\.nsis\.7z') | Select-Object -Last 1).Value }

Write-Host ''
Write-Host 'PKG root:' $pkgRoot
Write-Host 'PKG nsis:' $pkgNsis

Write-Host ''
Write-Host '--- HEAD root pkg ---'
if ($pkgRoot) { & $curl -I ($Cdn + '/' + $pkgRoot)  | Select-String '^HTTP/|^Content-|^X-Cache|^Via' | Out-Host } else { Write-Host 'no pkgRoot' }

Write-Host ''
Write-Host '--- HEAD nsis pkg ---'
if ($pkgNsis) { & $curl -I ($Cdn + '/nsis-web/' + $pkgNsis) | Select-String '^HTTP/|^Content-|^X-Cache|^Via' | Out-Host } else { Write-Host 'no pkgNsis' }

Write-Host ''
Write-Host '--- Range (first 1MiB) nsis pkg ---'
if ($pkgNsis) { & $curl -A 'INetC/1.0' -r 0-1048575 -s -S -o NUL -D - ($Cdn + '/nsis-web/' + $pkgNsis) | Select-String '^HTTP/|^Content-|^X-Cache|^Via' | Out-Host } else { Write-Host 'no pkgNsis for range check' }

Write-Host ''
Write-Host 'Done. Logs:' $root $nsis


