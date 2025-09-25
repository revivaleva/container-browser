Param()
# check_access.ps1
# CDN 上のパスに対して HEAD を行い結果を logs/access_check_results.json に出力する

$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path logs | Out-Null
[int]$TimeoutSec = 30
$paths = @(
    '/ContainerBrowser-Web-Setup.exe',
    '/Container-Browser-Web-Setup-0.3.0.exe',
    '/container-browser-0.3.0-x64.nsis.7z',
    '/latest.yml'
)
$cdn = 'https://updates.threadsbooster.jp'
$results = @()

foreach ($p in $paths) {
    $url = $cdn.TrimEnd('/') + $p
    Write-Host "HEAD $url"
    try {
        $resp = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        $status = $resp.StatusCode
        $len = $resp.Headers['Content-Length']
        $results += [PSCustomObject]@{ url = $url; status = $status; length = $len }
        Write-Host "OK $status length=$len"
    } catch {
        $msg = $_.Exception.Message -replace "\r|\n", ' '
        $results += [PSCustomObject]@{ url = $url; error = $msg }
        Write-Host "ERR $url -> $msg"
    }
}

$results | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 logs/access_check_results.json
Write-Host 'WROTE logs/access_check_results.json'
Get-Content logs/access_check_results.json -Tail 200

