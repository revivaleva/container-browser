$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'

function Add-Line([string]$m){ Write-Host $m; $script:SUM += $m }
function HeadStatus([string]$u){
  try { (Invoke-WebRequest -UseBasicParsing -Method Head -Uri $u).StatusCode }
  catch { try { return $_.Exception.Response.StatusCode.value__ } catch { return -1 } }
}

$SUM=@()
$logDir='logs'
New-Item -Type Directory -Force $logDir | Out-Null

Add-Line '== Git 状態 =='
try {
  $branch=(git rev-parse --abbrev-ref HEAD).Trim()
  git status -sb | Tee-Object -FilePath (Join-Path $logDir 'git_status.txt') | Out-Null
  git status --porcelain | Out-File -Encoding utf8 (Join-Path $logDir 'git_porcelain.txt')
  Add-Line ('branch: ' + $branch)
} catch { Add-Line 'git 情報の取得に失敗しました' }

Add-Line ''
Add-Line '== ローカル生成物 (dist) の確認 =='
$latest = Join-Path 'dist' 'latest.yml'
if (Test-Path $latest) {
  $fi=Get-Item $latest
  Add-Line ('dist\latest.yml: ' + $fi.Length + ' bytes, ' + $fi.LastWriteTime)
  try { Get-Content $latest -TotalCount 20 | Out-File -Encoding utf8 (Join-Path $logDir 'latest_head.txt') } catch {}
} else {
  Add-Line 'dist\latest.yml: NOT FOUND'
}

$nsisDir = 'dist\nsis-web'
$exe = $null
if (Test-Path $nsisDir) {
  $list = Get-ChildItem $nsisDir -File -Include *.exe,*.yml,*.blockmap | Sort-Object LastWriteTime -Descending
  $list | Select Name,Length,LastWriteTime | Format-Table -Auto | Out-String | Out-File -Encoding utf8 (Join-Path $logDir 'nsis_listing.txt')
  $exe = $list | Where-Object { $_.Name -like '*.exe' } | Select-Object -First 1
  if ($exe) {
    $hash=(Get-FileHash $exe.FullName -Algorithm SHA256).Hash
    Add-Line ('nsis-web latest exe: ' + $exe.Name + '  size=' + $exe.Length + '  SHA256=' + $hash)
  } else {
    Add-Line 'nsis-web exe: NOT FOUND'
  }
} else {
  Add-Line 'dist\nsis-web: NOT FOUND'
}

Add-Line ''
Add-Line '== 公開URLのHEAD確認 =='
$base='https://updates.threadsbooster.jp'
$latestUrl="$base/latest.yml"
$sc1 = HeadStatus $latestUrl
Add-Line ('HEAD ' + $latestUrl + ' -> ' + $sc1)

if ($exe) {
  $exeUrl = $base + '/nsis-web/' + $exe.Name
  $sc2 = HeadStatus $exeUrl
  Add-Line ('HEAD ' + $exeUrl + ' -> ' + $sc2)
}

Add-Line ''
Add-Line '== S3 一覧（可能なら）=='
$awsOk=$false
try { aws --version *>$null; $awsOk=$true } catch {}
if ($awsOk) {
  try { aws s3 ls s3://container-browser-updates/latest.yml      | Tee-Object -FilePath (Join-Path $logDir 's3_ls_latest.txt') | Out-Null } catch {}
  try { aws s3 ls s3://container-browser-updates/nsis-web/ --recursive | Tee-Object -FilePath (Join-Path $logDir 's3_ls_nsis.txt')   | Out-Null } catch {}
  Add-Line 'S3: listed (logs\ s3_ls_latest.txt / s3_ls_nsis.txt)'
} else {
  Add-Line 'S3: aws CLI が見つからないためスキップ'
}

$summary = ($SUM -join "`n")
$summary | Out-File -Encoding utf8 (Join-Path $logDir 'check_installer_state.summary.txt')
Write-Host "`nSummary: logs\check_installer_state.summary.txt に保存しました" -ForegroundColor Cyan
exit 0


