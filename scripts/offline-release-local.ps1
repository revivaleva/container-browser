param(
  [string]$Bucket = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF',
  [string]$Cdn = 'https://updates.threadsbooster.jp'
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path 'logs' | Out-Null

$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$logMain = "logs/offline_release_$ts.main.out"

Write-Host "== Offline release (local artifacts) start =="
Write-Host "Bucket=$Bucket DistributionId=$DistributionId CDN=$Cdn"

# Find latest dist_update_* that contains nsis-web/latest.yml
$nsisDir = Get-ChildItem -Directory -Filter 'dist_update_*' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  ForEach-Object { Join-Path $_.FullName 'nsis-web' } |
  Where-Object { Test-Path (Join-Path $_ 'latest.yml') } |
  Select-Object -First 1

if(-not $nsisDir){ throw 'No local nsis-web artifacts found (run build locally first or provide dist_update)' }

Write-Host "Using NSIS dir: $nsisDir"
Get-ChildItem -LiteralPath $nsisDir | Tee-Object -FilePath $logMain -Append | Out-Host

# Locate exe (prefer fixed name if present)
$exe = Get-ChildItem -Path $nsisDir -Filter '*.exe' -File | Select-Object -First 1
if(-not $exe){ throw 'No EXE found in nsis-web dir' }

$fixedName = 'ContainerBrowser-Offline-Setup.exe'
$fixedPath = Join-Path $nsisDir $fixedName
Copy-Item -Path $exe.FullName -Destination $fixedPath -Force

Write-Host "Uploading $fixedName to s3://$Bucket/nsis-web/"
aws s3 cp $fixedPath ("s3://$Bucket/nsis-web/$fixedName") --region ap-northeast-1 --only-show-errors | Out-Null
Add-Content -Path $logMain -Value ("Uploaded: s3://$Bucket/nsis-web/$fixedName")

# Invalidate CloudFront for the offline file and nsis-web/*
$invObj = @{ Paths = @{ Quantity = 2; Items = @('/nsis-web/' + $fixedName,'/nsis-web/*') }; CallerReference = 'offline-' + $ts }
$invJson = $invObj | ConvertTo-Json -Compress
$tmp = Join-Path $env:TEMP ("inv_offline_$ts.json")
Set-Content -Path $tmp -Value $invJson -Encoding ascii
Add-Content -Path $logMain -Value ("Inv payload: $invJson")

try {
  $res = aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch "file://$tmp" --region ap-northeast-1
  Add-Content -Path $logMain -Value ("Invalidation response: $res")
  Write-Host "Invalidation created (in progress)"
} catch {
  Add-Content -Path $logMain -Value ("WARNING: invalidation failed: $($_.Exception.Message)")
  Write-Host "Warning: invalidation failed: $($_.Exception.Message)"
}
Remove-Item -Path $tmp -ErrorAction SilentlyContinue

# Verify CDN HEAD and Range
$pkgPath = '/nsis-web/' + $fixedName
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
& $curl -I ($Cdn + $pkgPath) | Select-String '^HTTP/' | Tee-Object -FilePath $logMain -Append | Out-Host
& $curl -A 'INetC/1.0' -r 0-1048575 -s -S -o NUL -D - ($Cdn + $pkgPath) | Select-String '^HTTP/' | Tee-Object -FilePath $logMain -Append | Out-Host

Write-Host "Done. Logs: $logMain"


