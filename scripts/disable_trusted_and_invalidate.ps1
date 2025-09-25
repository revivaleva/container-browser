Param()
# disable_trusted_and_invalidate.ps1
# Disable TrustedKeyGroups/TrustedSigners on Default and all CacheBehaviors, update distribution,
# create invalidation for installer and package paths, then perform HEAD checks.

$distId = 'E1Q66ASB5AODYF'
$logPrefix = 'logs/disable_trusted'
New-Item -ItemType Directory -Force -Path logs | Out-Null

Write-Host 'Fetching distribution config...'
$rawJson = aws cloudfront get-distribution-config --id $distId --output json 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error 'Failed to get distribution config'; $rawJson | Out-File "$logPrefix-get.txt"; exit 2 }
$raw = $rawJson | ConvertFrom-Json
$etag = $raw.ETag.Trim('"')
$cfg = $raw.DistributionConfig

Write-Host 'Disabling TrustedKeyGroups/TrustedSigners on DefaultCacheBehavior if present...'
if ($cfg.DefaultCacheBehavior) {
  $cfg.DefaultCacheBehavior.TrustedKeyGroups = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }
  $cfg.DefaultCacheBehavior.TrustedSigners = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }
}

Write-Host 'Scanning CacheBehaviors...'
if ($cfg.CacheBehaviors -and $cfg.CacheBehaviors.Items) {
  foreach ($it in $cfg.CacheBehaviors.Items) {
    if ($it.TrustedKeyGroups -and $it.TrustedKeyGroups.Enabled) {
      Write-Host "Disabling TrustedKeyGroups for pattern: $($it.PathPattern)"
      $it.TrustedKeyGroups = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }
    }
    if ($it.TrustedSigners -and $it.TrustedSigners.Enabled) {
      Write-Host "Disabling TrustedSigners for pattern: $($it.PathPattern)"
      $it.TrustedSigners = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }
    }
  }
}

# write modified config without BOM
$json = $cfg | ConvertTo-Json -Depth 50
[System.IO.File]::WriteAllText((Join-Path (Get-Location) ("$logPrefix-dist_config_modified.json")), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $logPrefix-dist_config_modified.json"

Write-Host 'Updating distribution...'
aws cloudfront update-distribution --id $distId --distribution-config file://$logPrefix-dist_config_modified.json --if-match $etag > "$logPrefix-update_resp.json" 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "update failed; see $logPrefix-update_resp.json"; exit 3 }
Write-Host "update succeeded; response saved to $logPrefix-update_resp.json"

# Invalidate relevant paths
$paths = @(
  '/latest.yml',
  '/container-browser-0.3.0-x64.nsis.7z',
  '/ContainerBrowser-Web-Setup.exe',
  '/Container-Browser-Web-Setup-0.3.0.exe',
  '/nsis-web/ContainerBrowser-Web-Setup.exe',
  '/nsis-web/Container-Browser-Web-Setup-0.3.0.exe'
)
$inv = @{ Paths = @{ Quantity = $paths.Count; Items = $paths }; CallerReference = ('disable-trusted-' + (Get-Date -UFormat %s)) }
$invJson = $inv | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText((Join-Path (Get-Location) ("$logPrefix-inv_batch.json")), $invJson, (New-Object System.Text.UTF8Encoding($false)))
aws cloudfront create-invalidation --distribution-id $distId --invalidation-batch file://$logPrefix-inv_batch.json > "$logPrefix-inv_resp.json" 2>&1
Write-Host "Invalidation response saved to $logPrefix-inv_resp.json"

# Perform HEAD checks
$cdn = 'https://updates.threadsbooster.jp'
$results = @()
foreach ($p in $paths) {
  $url = $cdn.TrimEnd('/') + $p
  Write-Host "HEAD $url"
  try { $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop; $results += [PSCustomObject]@{ url=$url; status=$r.StatusCode; length=$r.Headers['Content-Length'] } } catch { $results += [PSCustomObject]@{ url=$url; error = ($_.Exception.Message -replace "\r|\n"," ") } }
}
$resJson = $results | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path (Get-Location) ("$logPrefix-head_results.json")), $resJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $logPrefix-head_results.json"
Get-Content "$logPrefix-head_results.json" -Tail 200


