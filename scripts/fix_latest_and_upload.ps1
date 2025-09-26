Param()
$ErrorActionPreference = 'Stop'
$cdn = 'https://updates.threadsbooster.jp'
$bucket = 'container-browser-updates'
$distId = 'E1Q66ASB5AODYF'
New-Item -ItemType Directory -Force -Path logs | Out-Null
$in = Join-Path (Get-Location) 'logs\cdn_latest.yml'
Write-Host "Fetching $cdn/latest.yml -> $in"
try {
  Invoke-WebRequest -Uri ($cdn + '/latest.yml') -OutFile $in -UseBasicParsing -ErrorAction Stop
} catch {
  Write-Error "Failed to fetch latest.yml: $($_.Exception.Message)"; exit 2
}
$s = Get-Content -Raw -LiteralPath $in
# Replace installer url entry to point to nsis-web fixed name
$fixedInstallerUrl = $cdn + '/nsis-web/ContainerBrowser-Web-Setup.exe'
$s = [regex]::Replace($s, '(?m)^\s*-\s*url:.*', '- url: ' + $fixedInstallerUrl)
# Ensure any path entry referring to Container-Browser-Web-Setup is changed to nsis-web fixed path
$s = [regex]::Replace($s, '(?m)^\s*path:\s*Container-Browser-Web-Setup.*', 'path: nsis-web/ContainerBrowser-Web-Setup.exe')
$out = Join-Path (Get-Location) 'logs\latest_fixed.yml'
Set-Content -Path $out -Value $s -Encoding utf8
Write-Host "WROTE $out"
Write-Host 'Uploading fixed latest.yml to S3 root'
aws s3 cp $out ("s3://$bucket/latest.yml") --content-type 'text/yaml' --cache-control 'no-cache, max-age=0' 2>&1 | Tee-Object -FilePath logs/s3_upload_fixed_latest.txt
Write-Host 'Creating CloudFront invalidation for /latest.yml and /nsis-web/*'
$paths = @('/latest.yml','/nsis-web/*')
$inv = @{ Paths = @{ Quantity = $paths.Count; Items = $paths }; CallerReference = ('fix-latest-' + (Get-Date -UFormat %s)) }
$inv | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 logs/fix_latest_inv.json
aws cloudfront create-invalidation --distribution-id $distId --invalidation-batch file://logs/fix_latest_inv.json 2>&1 | Tee-Object -FilePath logs/fix_latest_inv_resp.txt
Write-Host 'DONE'
Get-Content logs/fix_latest_inv_resp.txt -ErrorAction SilentlyContinue | Write-Host
