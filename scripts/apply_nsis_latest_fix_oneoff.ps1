$param = @{ Bucket = 'container-browser-updates'; Region = 'ap-northeast-1'; DistributionId = 'E1Q66ASB5AODYF' }

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path logs | Out-Null

Write-Host "Downloading nsis-web/latest.yml from S3..."
aws s3 cp ("s3://{0}/nsis-web/latest.yml" -f $param.Bucket) logs\nsis_latest.yml --region $param.Region --only-show-errors
if(-not (Test-Path logs\nsis_latest.yml)){ throw 'nsis-web/latest.yml not found in S3' }

$txt = Get-Content -LiteralPath logs\nsis_latest.yml -Raw

# Prefix path/file/url entries with nsis-web/ if not already prefixed
$fixed = [regex]::Replace($txt, '^(\s*(?:path|file|url):\s*)(?!nsis-web/)([\w\-\.\s]+\.(?:exe|7z))$', '${1}nsis-web/${2}', 'Multiline')

$out = 'logs\latest_fixed.yml'
[IO.File]::WriteAllText($out, $fixed, [Text.UTF8Encoding]::new($false))
Write-Host 'Wrote fixed latest to:' $out
Write-Host '--- preview ---'
Get-Content -LiteralPath $out -TotalCount 200 | ForEach-Object { Write-Host $_ }

Write-Host 'Uploading fixed latest.yml to s3 root...'
aws s3 cp $out ("s3://{0}/latest.yml" -f $param.Bucket) --region $param.Region --only-show-errors

Write-Host 'Creating CloudFront invalidation...'
& .\scripts\run_cloudfront_invalidation.ps1 -DistributionId $param.DistributionId -Region $param.Region

# Verify HEAD/Range for package
$pkgMatch = [regex]::Match($fixed, '([\w\-\.\s]+\.nsis\.7z)')
if($pkgMatch.Success){
  $pkg = $pkgMatch.Groups[1].Value.Trim()
  Write-Host "pkg=$pkg"
  $curl = Join-Path $env:SystemRoot 'System32\\curl.exe'
  Write-Host 'HEAD:'
  & $curl -I ("https://updates.threadsbooster.jp/nsis-web/" + [System.Uri]::EscapeDataString($pkg)) | Select-String '^HTTP/' | ForEach-Object { Write-Host $_.Line }
  Write-Host 'Range:'
  & $curl -A 'INetC/1.0' -r 0-1048575 -s -S -D - -o NUL ("https://updates.threadsbooster.jp/nsis-web/" + [System.Uri]::EscapeDataString($pkg)) | Select-String '^HTTP/' | ForEach-Object { Write-Host $_.Line }
} else {
  Write-Host 'No .nsis.7z package found in fixed latest.yml'
}

Write-Host 'Done.'



