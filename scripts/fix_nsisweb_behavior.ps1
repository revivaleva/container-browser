Param()
# fix_nsisweb_behavior.ps1
# Add or update nsis-web/* cache behavior to disable TrustedKeyGroups/TrustedSigners,
# update distribution, create invalidation, and verify HEAD access.

$distId = 'E1Q66ASB5AODYF'
$logPrefix = 'logs/fix_nsisweb'
New-Item -ItemType Directory -Force -Path logs | Out-Null

Write-Host 'Fetching distribution config...'
$rawJson = aws cloudfront get-distribution-config --id $distId --output json 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error 'Failed to get distribution config'; $rawJson | Out-File "$logPrefix-get.txt"; exit 2 }
$raw = $rawJson | ConvertFrom-Json
$etag = $raw.ETag.Trim('"')
$cfg = $raw.DistributionConfig

if (-not $cfg.CacheBehaviors) { $cfg.CacheBehaviors = @{ Quantity = 0; Items = @() } }
$items = @()
if ($cfg.CacheBehaviors.Items) { $items = $cfg.CacheBehaviors.Items }

Write-Host 'Checking existing nsis-web/* behavior...'
$exists = $false
foreach ($it in $items) { if ($it.PathPattern -eq 'nsis-web/*') { $exists = $true; Write-Host 'nsis-web/* exists; will update to disable TrustedKeyGroups.'; $it.TrustedKeyGroups = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }; $it.TrustedSigners = [PSCustomObject]@{ Enabled = $false; Quantity = 0 } } }

if (-not $exists) {
  Write-Host 'nsis-web/* not found; adding new behavior.'
  $beh = [PSCustomObject]@{
    PathPattern = 'nsis-web/*'
    TargetOriginId = $cfg.Origins.Items[0].Id
    TrustedSigners = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }
    TrustedKeyGroups = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }
    ViewerProtocolPolicy = 'redirect-to-https'
    AllowedMethods = [PSCustomObject]@{ Quantity = 2; Items = @('HEAD','GET'); CachedMethods = [PSCustomObject]@{ Quantity = 2; Items = @('HEAD','GET') } }
    SmoothStreaming = $false
    Compress = $true
    LambdaFunctionAssociations = [PSCustomObject]@{ Quantity = 0 }
    FunctionAssociations = [PSCustomObject]@{ Quantity = 0 }
    FieldLevelEncryptionId = ''
    CachePolicyId = $cfg.DefaultCacheBehavior.CachePolicyId
    GrpcConfig = [PSCustomObject]@{ Enabled = $false }
  }
  $items += $beh
}

$cfg.CacheBehaviors = @{ Quantity = $items.Count; Items = $items }

# write modified config without BOM
$json = $cfg | ConvertTo-Json -Depth 50
[System.IO.File]::WriteAllText((Join-Path (Get-Location) ("$logPrefix-dist_config_modified.json")), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $logPrefix-dist_config_modified.json"

Write-Host 'Updating distribution...'
aws cloudfront update-distribution --id $distId --distribution-config file://$logPrefix-dist_config_modified.json --if-match $etag > "$logPrefix-update_resp.json" 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "update failed; see $logPrefix-update_resp.json"; exit 3 }
Write-Host "update succeeded; response saved to $logPrefix-update_resp.json"

# Create invalidation for nsis-web EXE and latest.yml
$paths = @('/nsis-web/ContainerBrowser-Web-Setup.exe','/nsis-web/Container-Browser-Web-Setup-0.3.0.exe','/latest.yml')
$inv = @{ Paths = @{ Quantity = $paths.Count; Items = $paths }; CallerReference = ('fix-nsisweb-' + (Get-Date -UFormat %s)) }
$invJson = $inv | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText((Join-Path (Get-Location) ("$logPrefix-inv_batch.json")), $invJson, (New-Object System.Text.UTF8Encoding($false)))
aws cloudfront create-invalidation --distribution-id $distId --invalidation-batch file://$logPrefix-inv_batch.json > "$logPrefix-inv_resp.json" 2>&1
Write-Host "Invalidation response saved to $logPrefix-inv_resp.json"

# HEAD check
$cdn = 'https://updates.threadsbooster.jp'
$results = @()
foreach ($p in $paths) {
  $url = $cdn.TrimEnd('/') + $p
  Write-Host "HEAD $url"
  try { $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop; $results += [PSCustomObject]@{ url=$url; status=$r.StatusCode; length = $r.Headers['Content-Length'] } } catch { $results += [PSCustomObject]@{ url=$url; error = ($_.Exception.Message -replace "\r|\n"," ") } }
}
$resJson = $results | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path (Get-Location) ("$logPrefix-head_results.json")), $resJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $logPrefix-head_results.json"
Get-Content "$logPrefix-head_results.json" -Tail 200


