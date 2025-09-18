# Apply latest.yml fix: prefix path/file/url entries with nsis-web/ and upload to S3 latest.yml
param(
  [string]$SrcLocal = 'dist_update_20250917_121924/nsis-web/latest.yml',
  [string]$OutLocal = 'logs/latest_upload_manual.yml',
  [string]$Bucket = 'container-browser-updates',
  [string]$Cdn = 'https://updates.threadsbooster.jp'
)

$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path 'logs' | Out-Null

if(-not (Test-Path $SrcLocal)){
  Write-Host "ERROR: source latest not found: $SrcLocal"; exit 2
}

$content = Get-Content -LiteralPath $SrcLocal -Raw
$content2 = [regex]::Replace($content,'^(\s*(?:path|file|url):\s*)([\w\-\.\s]+\.(?:exe|7z))$','${1}nsis-web/${2}','Multiline')
Set-Content -Path $OutLocal -Value $content2 -Encoding utf8
Write-Host "Wrote modified latest -> $OutLocal"

# Upload to s3 root latest.yml
$s3target = "s3://$Bucket/latest.yml"
Write-Host "Uploading to $s3target"
aws s3 cp $OutLocal $s3target --region ap-northeast-1 | Write-Host

Write-Host 'Uploaded. Now creating CloudFront invalidation (via script)...'
& .\scripts\run_cloudfront_invalidation.ps1

Write-Host 'Verifying CDN HEAD results:'
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
& $curl -I ($Cdn + '/latest.yml') | Select-String '^HTTP/' | ForEach-Object { Write-Host $_.Line }
& $curl -I ($Cdn + '/nsis-web/container-browser-0.2.9-x64.nsis.7z') | Select-String '^HTTP/' | ForEach-Object { Write-Host $_.Line }

Write-Host 'Done.'


