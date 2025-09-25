$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'
$env:AWS_PAGER = ''

# prepare logs
New-Item -ItemType Directory -Force logs | Out-Null

$dist = 'E1Q66ASB5AODYF'
$payloadPath = 'logs/invalidation_payload.json'
$createOut = 'logs/cloudfront_create.txt'
$finalOut = 'logs/cloudfront_invalidation_final.json'

$payload = @{ Paths = @{ Quantity = 2; Items = @('/latest.yml','/*') }; CallerReference = 'invalidate-' + (Get-Date -UFormat %s) }
$payload | ConvertTo-Json -Compress | Set-Content -Path $payloadPath -Encoding ascii
Write-Host "WROTE payload -> $payloadPath"

# create invalidation
$create = aws cloudfront create-invalidation --distribution-id $dist --invalidation-batch file://$payloadPath --output json 2>&1
$create | Out-File -FilePath $createOut -Encoding ascii
try {
  $j = $create | ConvertFrom-Json
  $id = $j.Invalidation.Id
  Write-Host "InvalidationId: $id"
} catch {
  Write-Host 'Failed to create/parse invalidation. See logs:'
  Get-Content $createOut | Out-Host
  exit 1
}

# poll for completion (timeout ~10min)
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 5
  $statusJson = aws cloudfront get-invalidation --distribution-id $dist --id $id --output json 2>$null
  if (-not $statusJson) { Write-Host 'get-invalidation empty, retry'; continue }
  try { $status = ($statusJson | ConvertFrom-Json).Invalidation.Status } catch { Write-Host 'parse error, retry'; continue }
  Write-Host ("Status: {0}" -f $status)
  if ($status -eq 'Completed') { $statusJson | Out-File -FilePath $finalOut -Encoding ascii; break }
}

if (-not (Test-Path $finalOut)) { Write-Host 'Invalidation did not complete within timeout' } else { Write-Host 'Invalidation completed' }

# CDN checks
& "$env:SystemRoot\System32\curl.exe" -I "https://updates.threadsbooster.jp/latest.yml" > logs/head_latest_root.txt 2>&1
& "$env:SystemRoot\System32\curl.exe" -I "https://updates.threadsbooster.jp/ContainerBrowser-Web-Setup.exe" > logs/head_web_root.txt 2>&1
& "$env:SystemRoot\System32\curl.exe" -A 'INetC/1.0' -r 0-1048575 -s -S -o NUL -D - "https://updates.threadsbooster.jp/container-browser-0.3.0-x64.nsis.7z" > logs/range_pkg_root.txt 2>&1

Write-Host 'CDN checks done'

