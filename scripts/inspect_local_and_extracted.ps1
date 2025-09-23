# Inspect extracted package and local updater cache
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs,tmp | Out-Null
$log = Join-Path 'logs' 'inspect_local_and_extracted.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)") -Encoding utf8

Write-Host '== Check: tmp/pkg/resources/app-update.yml =='
$p = Join-Path (Join-Path (Get-Location) 'tmp') 'pkg\resources\app-update.yml'
if (Test-Path -LiteralPath $p) {
  Add-Content -Path $log -Value ('Found app-update.yml: ' + $p)
  Write-Host '--- app-update.yml ---'
  Get-Content -Raw -LiteralPath $p | Tee-Object -FilePath $log -Append | Out-Host
  Write-Host '--- end ---'
} else {
  Add-Content -Path $log -Value ('Not found: ' + $p)
  Write-Host 'Not found:' $p
}

Write-Host "`n== List: tmp/pkg/resources =="
$d = Join-Path (Join-Path (Get-Location) 'tmp') 'pkg\resources'
if (Test-Path -LiteralPath $d) {
  Get-ChildItem -LiteralPath $d -Force | Select-Object Name,Length,LastWriteTime | Tee-Object -FilePath $log -Append | ForEach-Object { Write-Host ("ITEM: $($_.Name)  $($_.Length) bytes  $($_.LastWriteTime)") }
} else {
  Add-Content -Path $log -Value ('Not found: ' + $d)
  Write-Host 'Not found:' $d
}

Write-Host "`n== List: %LOCALAPPDATA%\container-browser-updater =="
$up = Join-Path $env:LOCALAPPDATA 'container-browser-updater'
if (Test-Path -LiteralPath $up) {
  Get-ChildItem -LiteralPath $up -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object FullName,Length,LastWriteTime | Tee-Object -FilePath $log -Append | ForEach-Object { Write-Host ("ITEM: $($_.FullName)  $($_.Length) bytes  $($_.LastWriteTime)") }
} else {
  Add-Content -Path $log -Value ('Not found: ' + $up)
  Write-Host 'Not found:' $up
}

Add-Content -Path $log -Value ('End: ' + (Get-Date -Format o))
Write-Host "Done. Logs: $log"


