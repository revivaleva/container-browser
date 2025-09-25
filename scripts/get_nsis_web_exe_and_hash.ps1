Param()
# scripts/get_nsis_web_exe_and_hash.ps1
New-Item -ItemType Directory -Force -Path logs | Out-Null
$bucket = 'container-browser-updates'
$key = 'nsis-web/ContainerBrowser-Web-Setup.exe'
$local = 'logs/ContainerBrowser-Web-Setup.exe'

Write-Host "Downloading s3://$bucket/$key -> $local"
aws s3 cp "s3://$bucket/$key" $local --no-progress 2>&1 | Tee-Object logs/s3_cp_nsis_web_exe.txt
if ($LASTEXITCODE -ne 0) { Write-Host 'S3 CP failed; see logs/s3_cp_nsis_web_exe.txt'; exit 1 }

Write-Host 'Computing SHA256...'
$hash = Get-FileHash -Path $local -Algorithm SHA256
$hash | ConvertTo-Json | Out-File -Encoding utf8 logs/sha256_nsis_web.json

Write-Host 'Fetching S3 head-object metadata...'
aws s3api head-object --bucket $bucket --key $key > logs/head_nsis_web_exe.json 2>&1

Write-Host 'Done. Logs: logs/s3_cp_nsis_web_exe.txt, logs/sha256_nsis_web.json, logs/head_nsis_web_exe.json'


