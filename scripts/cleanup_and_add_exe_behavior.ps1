Param()
# cleanup_and_add_exe_behavior.ps1
# Fetch distribution config, add EXE behaviors, remove nsis-web/* if present, update distribution, invalidate, and check access.

$distId = 'E1Q66ASB5AODYF'
$logPrefix = 'logs/cleanup_cf'
New-Item -ItemType Directory -Force -Path logs | Out-Null

Write-Host 'Fetching distribution config...'
$rawJson = aws cloudfront get-distribution-config --id $distId --output json 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error 'Failed to get distribution config'; $rawJson | Out-File "$logPrefix-get.txt"; exit 2 }
$raw = $rawJson | ConvertFrom-Json
$etag = $raw.ETag.Trim('"')
$cfg = $raw.DistributionConfig

Write-Host 'Inspecting CacheBehaviors...'
$items = @()
if ($cfg.CacheBehaviors -and $cfg.CacheBehaviors.Items) { $items = $cfg.CacheBehaviors.Items }
Write-Host 'Current patterns:'
foreach ($it in $items) { Write-Host ' - ' $it.PathPattern }

# Remove nsis-web/* if exists
$items = $items | Where-Object { $_.PathPattern -ne 'nsis-web/*' }

# Ensure EXE behaviors
function Ensure-Pattern([string]$pattern) {
  foreach ($it in $items) { if ($it.PathPattern -eq $pattern) { Write-Host "pattern exists: $pattern"; return } }
  $beh = [PSCustomObject]@{
    PathPattern = $pattern
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
  Write-Host "added: $pattern"
}

Ensure-Pattern 'ContainerBrowser-Web-Setup.exe'
Ensure-Pattern 'Container-Browser-Web-Setup-*.exe'

$cfg.CacheBehaviors = @{ Quantity = $items.Count; Items = $items }

# Write modified config without BOM so aws CLI can read it
$json = $cfg | ConvertTo-Json -Depth 50
[System.IO.File]::WriteAllText((Resolve-Path "$logPrefix-dist_config_modified.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $logPrefix-dist_config_modified.json (no BOM)"

Write-Host "Updating distribution..."
aws cloudfront update-distribution --id $distId --distribution-config file://$logPrefix-dist_config_modified.json --if-match $etag > "$logPrefix-update_resp.json" 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "update failed, see $logPrefix-update_resp.json"; exit 3 }
Write-Host "Updated distribution; response saved to $logPrefix-update_resp.json"

# Invalidate EXE paths and latest.yml
$paths = @('/ContainerBrowser-Web-Setup.exe','/Container-Browser-Web-Setup-0.3.0.exe','/latest.yml')
$inv = @{ Paths = @{ Quantity = $paths.Count; Items = $paths }; CallerReference = ('cleanup-exe-' + (Get-Date -UFormat %s)) }
# Write invalidation batch without BOM
$invJson = $inv | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText((Resolve-Path "$logPrefix-inv_batch.json"), $invJson, (New-Object System.Text.UTF8Encoding($false)))
aws cloudfront create-invalidation --distribution-id $distId --invalidation-batch file://"$logPrefix-inv_batch.json" > "$logPrefix-inv_resp.json" 2>&1
Write-Host "Invalidation response: $logPrefix-inv_resp.json"

# HEAD checks
$cdn = 'https://updates.threadsbooster.jp'
$results = @()
foreach ($p in $paths) {
  $url = $cdn.TrimEnd('/') + $p
  Write-Host "HEAD $url"
  try {
    $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    $results += [PSCustomObject]@{ url=$url; status=$r.StatusCode; length=$r.Headers['Content-Length'] }
  } catch {
    $results += [PSCustomObject]@{ url=$url; error = ($_.Exception.Message -replace "\r|\n"," ") }
  }
}
# Write results without BOM
$resJson = $results | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Resolve-Path "$logPrefix-exe_head_results.json"), $resJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $logPrefix-exe_head_results.json"
Get-Content "$logPrefix-exe_head_results.json" -Tail 200


