<#
Backup local updater cache (container-browser-updater) by renaming it with timestamp,
and list any container-browser files under %LOCALAPPDATA%\SquirrelTemp for diagnosis.
#>
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs | Out-Null
$log = Join-Path 'logs' 'backup_updater_cache.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)") -Encoding utf8

$up = Join-Path $env:LOCALAPPDATA 'container-browser-updater'
if (Test-Path -LiteralPath $up) {
  $bak = $up + '.' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.bak'
  Move-Item -LiteralPath $up -Destination $bak -Force
  Write-Host "MOVED: $up -> $bak"
  Add-Content -Path $log -Value ("MOVED: $up -> $bak")
} else {
  Write-Host "Not found: $up"
  Add-Content -Path $log -Value ("Not found: $up")
}

$sdir = Join-Path $env:LOCALAPPDATA 'SquirrelTemp'
if (Test-Path -LiteralPath $sdir) {
  $hits = Get-ChildItem -LiteralPath $sdir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like '*container-browser*' } | Select-Object FullName,Length,LastWriteTime
  if ($hits -and $hits.Count -gt 0) {
    foreach ($h in $hits) {
      Write-Host ("SQUIRREL ITEM: $($h.FullName)  $($h.Length) bytes  $($h.LastWriteTime)")
      Add-Content -Path $log -Value ("SQUIRREL ITEM: $($h.FullName)  $($h.Length) bytes  $($h.LastWriteTime)")
    }
  } else {
    Write-Host 'No container-browser files in SquirrelTemp'
    Add-Content -Path $log -Value 'No container-browser files in SquirrelTemp'
  }
} else {
  Write-Host "SquirrelTemp not found: $sdir"
  Add-Content -Path $log -Value ("SquirrelTemp not found: $sdir")
}

Add-Content -Path $log -Value ("End: " + (Get-Date -Format o))
Write-Host "Done. Logs: $log"


