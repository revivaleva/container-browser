Param()
# check_nsis_web_head.ps1
# nsis-web 配下の EXE と latest.yml の HEAD をチェックして logs/nsis_web_head_results.json に保存

New-Item -ItemType Directory -Force -Path logs | Out-Null
$paths = @(
  '/nsis-web/ContainerBrowser-Web-Setup.exe',
  '/nsis-web/Container-Browser-Web-Setup-0.3.0.exe',
  '/latest.yml'
)
$cdn = 'https://updates.threadsbooster.jp'
$results = @()

foreach ($p in $paths) {
  $url = $cdn.TrimEnd('/') + $p
  Write-Host "HEAD $url"
  try {
    $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    $results += [PSCustomObject]@{ url = $url; status = $r.StatusCode; length = $r.Headers['Content-Length'] }
    Write-Host "OK $($r.StatusCode) length=$($r.Headers['Content-Length'])"
  } catch {
    $msg = $_.Exception.Message -replace "\r|\n", ' '
    $results += [PSCustomObject]@{ url = $url; error = $msg }
    Write-Host "ERR $msg"
  }
}

$json = $results | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Resolve-Path 'logs/nsis_web_head_results.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'WROTE logs/nsis_web_head_results.json'
Get-Content logs/nsis_web_head_results.json -Tail 200


