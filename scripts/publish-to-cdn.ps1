$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

param(
  [string]$BUCKET = 'container-browser-updates',
  [string]$DISTID = 'E1Q66ASB5AODYF',
  [string]$CDN = 'https://updates.threadsbooster.jp'
)

New-Item -ItemType Directory -Force logs | Out-Null

$nsisDir = Get-ChildItem -Directory -Filter 'dist*' | Sort-Object LastWriteTime -Desc | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'nsis-web' }
if(!(Test-Path $nsisDir)){ throw "nsis-web が見つかりません" }

Write-Host "Uploading latest.yml and nsis-web/* from $nsisDir to s3://$BUCKET/nsis-web/"
& aws s3 cp (Join-Path $nsisDir 'latest.yml') "s3://$BUCKET/latest.yml" --no-progress | Out-Null
& aws s3 cp $nsisDir "s3://$BUCKET/nsis-web/" --recursive --no-progress --cache-control "public,max-age=300" | Out-Null

$ts=Get-Date -Format yyyyMMdd_HHmmss
$inv=@{Paths=@{Quantity=2;Items=@('/latest.yml','/nsis-web/*')};CallerReference="autoupd-$ts"} | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_$ts.json",$inv,[Text.UTF8Encoding]::new($false))
& aws cloudfront create-invalidation --distribution-id $DISTID --invalidation-batch file://logs/inv_$ts.json | Out-Null
Write-Host 'PUBLISH_DONE'
