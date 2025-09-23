param(
  [string]$Cdn = 'https://updates.threadsbooster.jp',
  [string]$Bucket = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF'
)

$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path logs | Out-Null
$cdnLatest = Join-Path 'logs' 'cdn_latest.yml'
Write-Host "Downloading $Cdn/latest.yml -> $cdnLatest"
& "$env:SystemRoot\System32\curl.exe" -sSLo $cdnLatest ($Cdn + '/latest.yml')
if (-not (Test-Path $cdnLatest)) { Write-Error 'failed to download latest.yml from CDN'; exit 2 }

$content = Get-Content -LiteralPath $cdnLatest -Raw
Write-Host 'Current latest.yml (CDN):'
Write-Host $content

$pattern = '^(\s*(?:path|file|url):\s*)([^\r\n]+\.(?:exe|7z))$'
$matches = [regex]::Matches($content,$pattern,'Multiline')
$needFix = $false
foreach ($m in $matches) {
  $val = $m.Groups[2].Value.Trim()
  if (-not $val.StartsWith('nsis-web/')) {
    Write-Host "Will prefix: $val"
    $needFix = $true
  }
}

if (-not $needFix) { Write-Host 'No plain filenames to prefix; nothing to do.'; exit 0 }

Write-Host 'Building modified latest with nsis-web/ prefix for plain filenames'
$modified = [regex]::Replace($content, $pattern, '${1}nsis-web/${2}', 'Multiline')
$out = Join-Path 'logs' 'latest_prefixed.yml'
Set-Content -LiteralPath $out -Value $modified -Encoding UTF8
Write-Host "Wrote modified latest to: $out"
Write-Host 'Uploading to S3 root latest.yml'
aws s3 cp $out ('s3://' + $Bucket + '/latest.yml') --content-type text/yaml --cache-control 'no-cache' | Out-Null
Write-Host 'Creating CloudFront invalidation for /latest.yml'
try {
  aws cloudfront create-invalidation --distribution-id $DistributionId --paths '/latest.yml' | Out-Null
  Write-Host 'Invalidation created'
} catch {
  Write-Warning "CloudFront invalidation failed: $($_.Exception.Message)"
}

Write-Host 'Fetch CDN latest.yml after invalidation (may take a few seconds to propagate)'
Start-Sleep -Seconds 5
& "$env:SystemRoot\System32\curl.exe" -sSLo (Join-Path 'logs' 'cdn_latest_after.yml') ($Cdn + '/latest.yml')
Write-Host 'CDN latest after:'
Get-Content -LiteralPath (Join-Path 'logs' 'cdn_latest_after.yml') -Raw | Write-Host

Write-Host 'Done.'
exit 0


