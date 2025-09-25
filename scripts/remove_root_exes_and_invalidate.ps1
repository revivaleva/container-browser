Param()
# Remove root EXEs were already deleted. Create CloudFront invalidation and verify HEAD for root and nsis-web paths.

$distId = 'E1Q66ASB5AODYF'
$logPrefix = 'logs/remove_root'
New-Item -ItemType Directory -Force -Path logs | Out-Null

$paths = @(
  '/ContainerBrowser-Web-Setup.exe',
  '/Container-Browser-Web-Setup-0.3.0.exe'
)

$inv = @{ Paths = @{ Quantity = $paths.Count; Items = $paths }; CallerReference = ('remove-root-' + (Get-Date -UFormat %s)) }
$invJson = $inv | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path (Get-Location) ("$logPrefix-inv.json")), $invJson, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Creating invalidation with: $logPrefix-inv.json"
aws cloudfront create-invalidation --distribution-id $distId --invalidation-batch file://$logPrefix-inv.json > "$logPrefix-inv_resp.json" 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "create-invalidation failed; see $logPrefix-inv_resp.json" }
else { Write-Host "Invalidation created; see $logPrefix-inv_resp.json" }

# HEAD checks for root and nsis-web
$cdn = 'https://updates.threadsbooster.jp'
$checkPaths = @(
  '/ContainerBrowser-Web-Setup.exe',
  '/Container-Browser-Web-Setup-0.3.0.exe',
  '/nsis-web/ContainerBrowser-Web-Setup.exe',
  '/nsis-web/Container-Browser-Web-Setup-0.3.0.exe'
)

if (Test-Path "$logPrefix-head_results.txt") { Remove-Item "$logPrefix-head_results.txt" -Force }
foreach ($p in $checkPaths) {
  $url = $cdn.TrimEnd('/') + $p
  Write-Host "HEAD $url"
  try {
    $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    $line = "OK $p $($r.StatusCode) $($r.Headers['Content-Length'])"
  } catch {
    $line = "ERR $p -> $($_.Exception.Message -replace '\r|\n',' ' )"
  }
  $line | Out-File -FilePath "$logPrefix-head_results.txt" -Append -Encoding utf8
}
Write-Host "WROTE $logPrefix-head_results.txt"

# Print summary
Get-Content "$logPrefix-head_results.txt" -Tail 200 | ForEach-Object { Write-Host $_ }


