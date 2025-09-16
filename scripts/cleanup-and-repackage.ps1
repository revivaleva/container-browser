$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs | Out-Null
function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -FilePath logs\cleanup_repackage.log -Append | Out-Null }

Log "== START cleanup-and-repackage =="

if (Test-Path 'dist\win-unpacked') {
  Log "Removing dist\\win-unpacked"
  try { Remove-Item -Recurse -Force -Path 'dist\\win-unpacked' -ErrorAction Stop; Log 'Removed dist\\win-unpacked' } catch { Log "Failed to remove: $_"; Write-Host 'Failed to remove dist\win-unpacked: ' $_; exit 10 }
} else { Log 'No dist\\win-unpacked to remove' }

Log 'Running packaging (local-build-run.ps1)'
Start-Process -FilePath powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\local-build-run.ps1') -NoNewWindow -Wait
if ($LASTEXITCODE -ne 0) { Log "Packaging exited with $LASTEXITCODE"; Write-Host ('Packaging exit='+$LASTEXITCODE) }

Log 'Checking app.asar contents'
if (Test-Path 'dist\\win-unpacked\\resources\\app.asar') {
  npx asar list dist\\win-unpacked\\resources\\app.asar | Out-File -Encoding utf8 logs\\app_asar_list_after_cleanup.txt
  Select-String -Pattern 'out\\main\\index.js' -Path logs\\app_asar_list_after_cleanup.txt -SimpleMatch | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host 'out/main/index.js FOUND in app.asar' } else { Write-Host 'out/main/index.js NOT found in app.asar' }
} else { Write-Host 'app.asar not found after packaging' }

Log '== END cleanup-and-repackage =='
exit 0




