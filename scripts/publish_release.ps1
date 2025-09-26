Param(
  [string]$Bucket = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF',
  [string]$NsisDir = 'dist/nsis-web'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path logs | Out-Null
if (-not (Test-Path $NsisDir)) { Write-Error "$NsisDir not found"; exit 1 }
Write-Host "Publishing artifacts from: $NsisDir -> s3://$Bucket/"
$uploaded7z = @()
$files = Get-ChildItem -Path $NsisDir -File
foreach ($f in $files) {
  $local = $f.FullName
  $name = $f.Name
  if ($name -match '\.nsis\.7z$') {
    Write-Host "Uploading 7z to root: $name"
    aws s3 cp $local ("s3://$Bucket/$name") --content-type 'application/octet-stream' --cache-control 'public,max-age=300' 2>&1 | Tee-Object -FilePath ("logs/s3_upload_$($name -replace '[^0-9A-Za-z\-_.]','_').txt")
    $uploaded7z += $name
  } else {
    Write-Host "Uploading exe to nsis-web: $name"
    aws s3 cp $local ("s3://$Bucket/nsis-web/$name") --content-type 'application/x-msdownload' --cache-control 'public,max-age=300' 2>&1 | Tee-Object -FilePath ("logs/s3_upload_$($name -replace '[^0-9A-Za-z\-_.]','_').txt")
    if ($name -match 'Web-Setup') {
      Write-Host "Uploading fixed nsis-web/ContainerBrowser-Web-Setup.exe"
      aws s3 cp $local ("s3://$Bucket/nsis-web/ContainerBrowser-Web-Setup.exe") --content-type 'application/x-msdownload' --cache-control 'public,max-age=300' 2>&1 | Tee-Object -FilePath logs/s3_upload_fixed_exe.txt
    }
  }
}
$latest = Join-Path $NsisDir 'latest.yml'
if (Test-Path $latest) {
  Write-Host 'Uploading latest.yml to root'
  aws s3 cp $latest ("s3://$Bucket/latest.yml") --content-type 'text/yaml' --cache-control 'no-cache, max-age=0' 2>&1 | Tee-Object -FilePath logs/s3_upload_latest.txt
}
# Build invalidation paths
$paths = @('/latest.yml')
foreach ($z in $uploaded7z) { $paths += '/' + $z }
$paths += '/nsis-web/*'
$inv = @{ Paths = @{ Quantity = $paths.Count; Items = $paths }; CallerReference = ('publish-' + (Get-Date -UFormat %s)) }
$inv | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 logs/publish_inv.json
Write-Host "Creating CloudFront invalidation for: $($paths -join ', ')"
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://logs/publish_inv.json 2>&1 | Tee-Object -FilePath logs/publish_inv_resp.txt
Write-Host 'Publish complete. See logs/ for details.'
Write-Host 'Invalidation response:'
Get-Content logs/publish_inv_resp.txt -Raw
