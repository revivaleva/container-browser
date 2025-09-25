Param()
New-Item -ItemType Directory -Force -Path logs | Out-Null
$bucket = 'container-browser-updates'
$key = 'container-browser-0.3.0-x64.nsis.7z'
$resource = "arn:aws:s3:::$bucket/$key"

Write-Host "Fetching current bucket policy..."
aws s3api get-bucket-policy --bucket $bucket --output json > logs/bucket_policy_raw.json 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host 'Failed to get bucket policy; see logs/bucket_policy_raw.json'; exit 1 }

$raw = Get-Content -Raw logs/bucket_policy_raw.json | ConvertFrom-Json
$policy = ConvertFrom-Json $raw.Policy

# Check if statement for the resource already exists
$exists = $false
foreach ($st in $policy.Statement) {
  if ($st.Resource -is [System.Array]) {
    if ($st.Resource -contains $resource) { $exists = $true }
  } else {
    if ($st.Resource -eq $resource) { $exists = $true }
  }
}

if ($exists) {
  Write-Host 'Policy already grants access to resource; nothing to change.'
  exit 0
}

# Append a public-read statement for the single .7z key
$newStmt = [PSCustomObject]@{
  Effect = 'Allow'
  Principal = '*'
  Action = 's3:GetObject'
  Resource = $resource
}

if ($policy.Statement -is [System.Array]) {
  $arr = @($policy.Statement)
  $arr += $newStmt
  $policy.Statement = $arr
} else {
  $policy.Statement = @($policy.Statement, $newStmt)
}

$out = ConvertTo-Json $policy -Depth 10
[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'logs/bucket_policy_new.json'), $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'WROTE logs/bucket_policy_new.json'

Write-Host 'Applying new bucket policy...'
aws s3api put-bucket-policy --bucket $bucket --policy file://logs/bucket_policy_new.json > logs/put_bucket_policy_resp.txt 2>&1
Write-Host 'PUT_BUCKET_POLICY_EXIT:' $LASTEXITCODE
Get-Content logs/put_bucket_policy_resp.txt -Raw -ErrorAction SilentlyContinue | Out-Host

Write-Host 'Creating CloudFront invalidation for the package (to refresh CDN)...'
$inv = @{ Paths = @{ Quantity = 1; Items = @('/' + $key) }; CallerReference = ('temp-public-7z-' + (Get-Date -UFormat %s)) }
$inv | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 logs/temp_public_inv.json
aws cloudfront create-invalidation --distribution-id E1Q66ASB5AODYF --invalidation-batch file://logs/temp_public_inv.json > logs/temp_public_inv_resp.txt 2>&1
Write-Host 'INVALIDATION_EXIT:' $LASTEXITCODE
Get-Content logs/temp_public_inv_resp.txt -Raw -ErrorAction SilentlyContinue | Out-Host

Start-Sleep -Seconds 6
Write-Host 'HEAD check for package now:'
try { $r = Invoke-WebRequest -Uri ($"https://updates.threadsbooster.jp/{0}" -f $key) -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop; Write-Host 'OK' $r.StatusCode $r.Headers['Content-Length'] } catch { Write-Host 'ERR' $_.Exception.Message }


