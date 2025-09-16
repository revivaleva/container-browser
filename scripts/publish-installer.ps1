param(
  [string]$Bucket = 'container-browser-updates',
  [string]$CfId   = 'E1Q66ASB5AODYF',
  [string]$Base   = 'https://updates.threadsbooster.jp'
)
$ErrorActionPreference='Stop'
New-Item -Type Directory -Force logs | Out-Null

# sanity
aws sts get-caller-identity | Out-File -Encoding utf8 'logs\aws_identity.json'
aws s3 ls "s3://$Bucket" | Out-File -Encoding utf8 'logs\s3_ls_bucket.txt'

# upload
aws s3 cp dist/latest.yml   "s3://$Bucket/latest.yml" --content-type text/yaml --cache-control 'no-cache' | Out-Null
aws s3 cp dist/nsis-web/    "s3://$Bucket/nsis-web/" --recursive --acl public-read --cache-control 'public,max-age=31536000,immutable' | Out-Null

# invalidate only latest.yml
aws cloudfront create-invalidation --distribution-id $CfId --paths '/latest.yml' | Out-File -Encoding utf8 'logs\cf_invalidation.json'

# verify
function Head($u){ try{ (Invoke-WebRequest -UseBasicParsing -Method Head $u).StatusCode } catch { try { $_.Exception.Response.StatusCode.value__ } catch { -1 } } }
$exe = (Get-ChildItem dist/nsis-web -Filter *.exe | Sort-Object LastWriteTime -Desc | Select-Object -First 1).Name
$u1  = "$Base/latest.yml"
$u2  = if($exe){ "$Base/nsis-web/$exe" } else { '' }

"latest.yml -> $(Head $u1)  $u1" | Tee-Object -FilePath 'logs\publish_verify.txt'
if($u2){ "installer -> $(Head $u2)  $u2" | Tee-Object -FilePath 'logs\publish_verify.txt' -Append }

Write-Host 'PUBLISH_OK'

