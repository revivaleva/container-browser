$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

# Accept CDN via environment variable, first positional argument, or default
if ($env:CDN -and -not [string]::IsNullOrWhiteSpace($env:CDN)){
  $CDN = $env:CDN
} elseif ($args.Count -gt 0) {
  # Support both: positional URL, and named-style invocation where args may be ('-CDN','https://...')
  if ($args[0] -match '^(?:-+)?CDN$' -and $args.Count -gt 1) {
    $CDN = $args[1]
  } else {
    # try to find the first arg that looks like a URL
    $found = $args | Where-Object { $_ -match 'https?://'} | Select-Object -First 1
    if ($found) { $CDN = $found } else { $CDN = $args[0] }
  }
} else {
  $CDN = 'https://updates.threadsbooster.jp'
}
New-Item -ItemType Directory -Force logs | Out-Null
$yPath = Join-Path $PWD 'logs\cdn_latest.yml'
& "$env:SystemRoot\System32\curl.exe" -sSLo $yPath "$CDN/latest.yml"
$y = Get-Content $yPath -Raw
$pkg = ([regex]::Matches($y,'(?im)[\w\-.]+\.nsis\.7z') | Select-Object -Last 1).Value
Write-Host "PKG: $pkg"
& "$env:SystemRoot\System32\curl.exe" -I "$CDN/nsis-web/$pkg" | Select-String '^HTTP/' | Out-Host
& "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$CDN/nsis-web/$pkg" | Select-String '^HTTP/' | Out-Host
