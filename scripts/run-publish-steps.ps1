$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

# Set profile/region for this session
$env:AWS_PROFILE='default'
$env:AWS_REGION='ap-northeast-1'

New-Item -ItemType Directory -Force -Path logs | Out-Null
function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -File logs\run_publish_steps.log -Append | Out-Null }

Log "== START run-publish-steps =="
Write-Host "PROFILE=$env:AWS_PROFILE REGION=$env:AWS_REGION"

Log "[1] aws --version"
try{
  aws --version 2>&1 | Tee-Object -File logs\aws_version.txt
}catch{
  Write-Host "aws CLI not found or failed: $_"; Log "aws --version failed"; exit 10
}

Log "[2] sts get-caller-identity"
try{
  aws sts get-caller-identity --output json --region $env:AWS_REGION | Out-File -Encoding utf8 logs\aws_identity.json
  if($LASTEXITCODE -ne 0){ Write-Host 'AWS auth NG'; Log 'AWS auth NG'; exit 11 }
  Write-Host 'AWS auth OK -> logs/aws_identity.json'
  Log 'AWS auth OK'
}catch{
  Write-Host 'AWS auth NG: ' + $_.Exception.Message; Log 'AWS auth NG'; exit 11
}

Log "[3] s3 ls container-browser-updates"
aws s3 ls s3://container-browser-updates --region $env:AWS_REGION | Tee-Object -FilePath logs\s3_ls.txt
if($LASTEXITCODE -ne 0){ Write-Host 'S3 list NG (check permissions/bucket)'; Log 'S3 list NG'; exit 12 } else { Write-Host 'S3 list OK -> logs/s3_ls.txt'; Log 'S3 list OK' }

Log "[4] call publish-and-verify"
Start-Process -FilePath powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\publish-and-verify.ps1') -NoNewWindow -Wait -PassThru -RedirectStandardOutput logs\publish_and_verify.out -RedirectStandardError logs\publish_and_verify.err | Out-Null
Write-Host ('PUBLISH_SCRIPT_EXIT:' + $LASTEXITCODE)
Log "[4] publish-and-verify exit=$LASTEXITCODE"

Log "== DONE run-publish-steps =="
exit 0





