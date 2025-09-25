Param()
New-Item -ItemType Directory -Force -Path logs | Out-Null
$bucket = 'container-browser-updates'
$src = 'nsis-web/Container-Browser-Web-Setup-0.3.0.exe'
$dst = 'Container-Browser-Web-Setup-0.3.0.exe'

Write-Host "Copying s3://$bucket/$src -> s3://$bucket/$dst"
aws s3 cp "s3://$bucket/$src" "s3://$bucket/$dst" --acl public-read --content-type 'application/x-msdownload' --cache-control 'public,max-age=300' > logs/copy_root_exe.txt 2>&1
Write-Host "COPY_EXIT: $LASTEXITCODE (see logs/copy_root_exe.txt)"

$cdnBase = 'https://updates.threadsbooster.jp'
$urls = @()
$urls += "$cdnBase/$dst"
$urls += "$cdnBase/$src"
$urls += "$cdnBase/container-browser-0.3.0-x64.nsis.7z"

if (Test-Path 'logs/copy_root_head.txt') { Remove-Item 'logs/copy_root_head.txt' -Force }
foreach ($u in $urls) {
  Write-Host "HEAD $u"
  try {
    $r = Invoke-WebRequest -Uri $u -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    $len = $r.Headers['Content-Length']
    ("OK $u $($r.StatusCode) $len") | Out-File -FilePath logs/copy_root_head.txt -Append -Encoding utf8
  } catch {
    $msg = $_.Exception.Message -replace "\r|\n"," "
    ("ERR $u -> $msg") | Out-File -FilePath logs/copy_root_head.txt -Append -Encoding utf8
  }
}
Write-Host 'WROTE logs/copy_root_head.txt'
Get-Content logs/copy_root_head.txt -Tail 200


