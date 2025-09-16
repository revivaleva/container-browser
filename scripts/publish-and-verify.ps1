param()

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'

New-Item -ItemType Directory -Force -Path logs | Out-Null
function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -File logs\publish.log -Append | Out-Null }

Log "== START publish-and-verify =="

# 0) AWS creds check
$hasKey = -not [string]::IsNullOrEmpty($env:AWS_ACCESS_KEY_ID)
$hasSecret = -not [string]::IsNullOrEmpty($env:AWS_SECRET_ACCESS_KEY)
Write-Host "AWS_ACCESS_KEY_ID_set=$hasKey"
Write-Host "AWS_SECRET_ACCESS_KEY_set=$hasSecret"
if(-not ($hasKey -and $hasSecret)){
  Log "AWS creds missing; skipping publish"
  Write-Host "AWS credentials not set; skipping publish"
  exit 2
}

# 1) publish build
Log "[1] publish build start"
$NPX = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if(-not $NPX){ $NPX = "C:\Program Files\nodejs\npx.cmd" }
Start-Process -FilePath $NPX -ArgumentList @('electron-builder','--win','--x64','--publish','always') -NoNewWindow -Wait -PassThru -RedirectStandardOutput logs\publish.out -RedirectStandardError logs\publish.err | Out-Null
Write-Host ('EXIT:'+ $LASTEXITCODE)
Log "[1] publish exit=$LASTEXITCODE"
if($LASTEXITCODE -ne 0){ Write-Host 'publish failed; see logs/publish.err'; exit 3 }

# 2) check latest.yml
Log "[2] fetching latest.yml"
try{
  $h = Invoke-WebRequest -Method Head -Uri 'https://updates.threadsbooster.jp/latest.yml' -UseBasicParsing -ErrorAction Stop
  Write-Host "latest.yml HEAD: $($h.StatusCode)"
}catch{
  Write-Host "latest.yml HEAD failed: $($_.Exception.Message)"
}
try{
  $content = (Invoke-WebRequest -Uri 'https://updates.threadsbooster.jp/latest.yml' -UseBasicParsing -ErrorAction Stop).Content
  $content | Tee-Object -FilePath logs\latest.yml | Out-Null
  Write-Host "latest.yml saved to logs/latest.yml"
}catch{
  Write-Host "failed to GET latest.yml: $($_.Exception.Message)"
}

# 3) extract installer url and open
try{
  $y = Get-Content logs\latest.yml -Raw
  $m = [regex]::Match($y,'(?m)^\s*url:\s*(?<u>.+?\.exe)\s*$')
  if(-not $m.Success){ $m = [regex]::Match($y,'nsis-web/.+?\.exe') }
  if(-not $m.Success){ Write-Host 'installer url not found in latest.yml'; } else {
    $rel = $m.Groups['u'].Value; if(-not $rel){ $rel = $m.Value }
    $rel = $rel.Trim()
    $url = 'https://updates.threadsbooster.jp/' + $rel
    Write-Host ('INSTALLER_URL: ' + $url)
    try{ (Invoke-WebRequest -Method Head -Uri $url -UseBasicParsing).StatusCode | Write-Host } catch { Write-Host 'HEAD failed' }
    Start-Process $url
  }
}catch{
  Write-Host 'installer extraction failed: ' + $_.Exception.Message
}

# 4) nsis-web health check sample
try{
  $m2 = [regex]::Match($y,'nsis-web/.+?\.(7z|nupkg|exe)')
  if($m2.Success){ $u2 = 'https://updates.threadsbooster.jp/' + $m2.Value; try{ (Invoke-WebRequest -Method Head -Uri $u2 -UseBasicParsing).StatusCode | Write-Host } catch { Write-Host 'health-check HEAD failed' } } else { Write-Host 'no nsis-web sample found, skip health check' }
}catch{}

# 5) CloudFront invalidation (optional)
if(Get-Command aws -ErrorAction SilentlyContinue){
  try{
    aws cloudfront create-invalidation --distribution-id E1Q66ASB5AODYF --paths '/latest.yml' '/nsis-web/*' | Out-File -Encoding utf8 logs\cf_invalidate.json
    Write-Host 'CF invalidation requested -> logs/cf_invalidate.json'
  }catch{ Write-Host 'aws CLI invalidation failed: ' + $_.Exception.Message }
}else{ Write-Host 'aws CLI not found: skip invalidation' }

Log "== DONE publish-and-verify =="
exit 0





