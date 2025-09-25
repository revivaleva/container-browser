Param()
# sync_latest_and_copy_7z.ps1
# Copy nsis-web .7z to S3 root, rewrite latest.yml to point installer to nsis-web and package to root, upload and invalidate, then verify HEAD.

New-Item -ItemType Directory -Force -Path logs | Out-Null
$bucket = 'container-browser-updates'
$cdn = 'https://updates.threadsbooster.jp'

Write-Host '1) Copy .7z from nsis-web to root'
$srcKey = 'nsis-web/container-browser-0.3.0-x64.nsis.7z'
$dstKey = 'container-browser-0.3.0-x64.nsis.7z'
aws s3 cp ("s3://$bucket/" + $srcKey) ("s3://$bucket/" + $dstKey) > logs/s3_copy_7z.txt 2>&1
Write-Host 'WROTE logs/s3_copy_7z.txt'

Write-Host '2) Read manifests'
$rootPath = 'logs/latest_root.yml'
$nsisPath = 'logs/latest_nsis.yml'
$root = Get-Content -Raw $rootPath
$nsis = Get-Content -Raw $nsisPath

Write-Host '3) Determine installer filename from nsis latest.yml'
$m = [regex]::Match($nsis, '(?m)^\s*-\s*url:\s*(.*)$')
if ($m.Success) { $inst = $m.Groups[1].Value.Trim() -replace '"','' } else { $inst = 'ContainerBrowser-Web-Setup.exe' }
Write-Host "installer: $inst"

Write-Host '4) Rewrite root latest.yml'
$root = [regex]::Replace($root, '(?m)^(\s*-\s*url:\s*).*$', '${1}' + $cdn + '/nsis-web/' + $inst)
$root = [regex]::Replace($root, '(?m)^(\s*path:\s*).*$', '${1}' + $cdn + '/' + $dstKey)
$outPath = 'logs/latest_root_rewrite.yml'
Set-Content -Path $outPath -Value $root -Encoding utf8
Write-Host "WROTE $outPath"

Write-Host '5) Upload rewritten latest.yml to S3 root'
aws s3 cp $outPath ("s3://$bucket/latest.yml") --content-type 'text/yaml' --cache-control 'no-cache, max-age=0' > logs/upload_latest_root.txt 2>&1
Write-Host 'WROTE logs/upload_latest_root.txt'

Write-Host '6) Create CloudFront invalidation for latest.yml, root .7z and nsis-web installer'
$inv = @{ Paths = @{ Quantity = 3; Items = @('/latest.yml', '/' + $dstKey, '/nsis-web/' + $inst) }; CallerReference = ('sync-latest-' + (Get-Date -UFormat %s)) }
$inv | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 logs/sync_inv.json
aws cloudfront create-invalidation --distribution-id E1Q66ASB5AODYF --invalidation-batch file://logs/sync_inv.json > logs/sync_inv_resp.json 2>&1
Write-Host 'WROTE logs/sync_inv_resp.json'

Write-Host '7) HEAD checks (wait a few seconds for invalidation to propagate)'
Start-Sleep -Seconds 6
$urls = @($cdn + '/latest.yml', $cdn + '/' + $dstKey, $cdn + '/nsis-web/' + $inst)
if (Test-Path 'logs/sync_head_results.txt') { Remove-Item 'logs/sync_head_results.txt' -Force }
foreach ($u in $urls) {
  Write-Host 'HEAD' $u
  try {
    $r = Invoke-WebRequest -Uri $u -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    ("OK $u $($r.StatusCode) $($r.Headers['Content-Length'])") | Out-File -FilePath logs/sync_head_results.txt -Append -Encoding utf8
  } catch {
    ("ERR $u -> $($_.Exception.Message -replace '\r|\n',' ' )") | Out-File -FilePath logs/sync_head_results.txt -Append -Encoding utf8
  }
}
Write-Host 'WROTE logs/sync_head_results.txt'
Get-Content logs/sync_head_results.txt -Tail 200


