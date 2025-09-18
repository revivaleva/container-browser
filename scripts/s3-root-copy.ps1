param(
  [string]$Bucket = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF'
)

$ErrorActionPreference = 'Continue'
if(-not (Test-Path -Path logs)) { New-Item -ItemType Directory -Path logs | Out-Null }
$s3log = "logs/s3-copy_$(Get-Date -Format yyyyMMdd_HHmmss).out"
$cfLog = "logs/cf-inv_$(Get-Date -Format yyyyMMdd_HHmmss).out"
$keys = @(
  'nsis-web/container-browser-0.2.4-x64.nsis.7z',
  'nsis-web/ContainerBrowser-Web-Setup.exe'
)

Add-Content -Path $s3log -Value "Start S3 root-copy: $(Get-Date -Format o)"
$copyPaths = @()

foreach($k in $keys){
  Add-Content -Path $s3log -Value "Checking s3://$Bucket/$k"
  $head = aws s3api head-object --bucket $Bucket --key $k 2>&1
  if($LASTEXITCODE -eq 0){
    Add-Content -Path $s3log -Value "FOUND: $k"
    $leaf = Split-Path $k -Leaf
    $dstKey = $leaf
    if($leaf.ToLower().EndsWith('.exe')){ $contentType = 'application/x-msdownload' }
    elseif($leaf.ToLower().EndsWith('.7z')){ $contentType = 'application/x-compressed' }
    else { $contentType = 'application/octet-stream' }

    Add-Content -Path $s3log -Value "Copying s3://$Bucket/$k -> s3://$Bucket/$dstKey"
    aws s3 cp "s3://$Bucket/$k" "s3://$Bucket/$dstKey" --content-type $contentType --metadata-directive REPLACE --cache-control 'public,max-age=31536000' 2>&1 | Tee-Object -FilePath $s3log -Append
    if($LASTEXITCODE -eq 0){
      Add-Content -Path $s3log -Value "COPY_OK: $dstKey"
      $copyPaths += ('/' + $dstKey)
    } else {
      Add-Content -Path $s3log -Value "COPY_FAIL: $k"
    }
  } else {
    Add-Content -Path $s3log -Value "MISSING_OR_FORBIDDEN: $k -> $head"
  }
}

if($copyPaths.Count -gt 0){
  $items = $copyPaths + '/latest.yml'
  $inv = @{ Paths = @{ Quantity = $items.Count; Items = $items }; CallerReference = ('root-copy-'+(Get-Date -UFormat %s)) }
  $invFile = 'inv.json'
  $inv | ConvertTo-Json -Depth 10 | Out-File -FilePath $invFile -Encoding utf8
  Add-Content -Path $cfLog -Value "Creating CloudFront invalidation for: $($items -join ',')"
  aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://$invFile 2>&1 | Tee-Object -FilePath $cfLog -Append
} else {
  Add-Content -Path $cfLog -Value 'No files copied; skipping CloudFront invalidation'
}

Write-Host "S3 log: $s3log"
Write-Host "CF log: $cfLog"

exit 0



