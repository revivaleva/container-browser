param(
  [string]$DistributionId = 'E1Q66ASB5AODYF',
  [string]$CfJson = 'cf_distribution.json'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path logs | Out-Null

if (-not (Test-Path -Path $CfJson)) { Write-Error "$CfJson not found; please ensure you previously ran aws cloudfront get-distribution --id <id> > $CfJson"; exit 2 }

$json = Get-Content -Raw $CfJson | ConvertFrom-Json
$etag = $json.ETag
$config = $json.Distribution.DistributionConfig

# Build new cache behavior for root .nsis.7z files
$newBehavior = @{ 
  PathPattern = '*.nsis.7z';
  TargetOriginId = $config.Origins.Items[0].Id;
  TrustedSigners = @{ Enabled = $false; Quantity = 0 };
  TrustedKeyGroups = @{ Enabled = $false; Quantity = 0 };
  ViewerProtocolPolicy = 'redirect-to-https';
  AllowedMethods = @{ Quantity = 2; Items = @('HEAD','GET'); CachedMethods = @{ Quantity = 2; Items = @('HEAD','GET') } };
  SmoothStreaming = $false;
  Compress = $true;
  CachePolicyId = $config.DefaultCacheBehavior.CachePolicyId;
}

if (-not $config.CacheBehaviors) { $config.CacheBehaviors = @{ Quantity = 0; Items = @() } }

# Avoid duplicating identical PathPattern
$exists = $false
foreach ($b in $config.CacheBehaviors.Items) {
  if ($b.PathPattern -eq $newBehavior.PathPattern) { $exists = $true; break }
}

if ($exists) { Write-Host "CacheBehavior for '$($newBehavior.PathPattern)' already exists; aborting update."; exit 0 }

$config.CacheBehaviors.Items += $newBehavior
$config.CacheBehaviors.Quantity = $config.CacheBehaviors.Items.Count

$outFile = 'cf_distribution_config_for_update.json'
$config | ConvertTo-Json -Depth 50 | Set-Content -Path $outFile -Encoding utf8

Write-Host "Prepared distribution config for update: $outFile (If-Match: $etag)"

try {
  Write-Host "Calling aws cloudfront update-distribution --id $DistributionId --if-match $etag --distribution-config file://$outFile"
  aws cloudfront update-distribution --id $DistributionId --distribution-config (Get-Item -LiteralPath $outFile).FullName --if-match $etag | Tee-Object -FilePath logs/cf_update_resp.json
  Write-Host "Update requested; response saved to logs/cf_update_resp.json"
} catch {
  Write-Error "CloudFront update failed: $($_.Exception.Message)"
  exit 3
}

# Quick HEAD check for a typical root .7z name (non-exhaustive). The user likely knows the exact filename; adjust if needed.
$sample = 'container-browser-0.3.0-x64.nsis.7z'
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
Write-Host "HEAD check for root path: https://updates.threadsbooster.jp/$sample"
& $curl -I ("https://updates.threadsbooster.jp/$sample") | Select-String '^HTTP/' | ForEach-Object { Write-Host $_.Line }

Write-Host 'Done.'
