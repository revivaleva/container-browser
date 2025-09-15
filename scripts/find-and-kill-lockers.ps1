$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

$proj=(Get-Location).Path
New-Item -ItemType Directory -Force logs | Out-Null
$log = 'logs\lock_processes.txt'
$found = @()

Get-Process | ForEach-Object {
  $p = $_
  $path = ''
  try { $path = $p.MainModule.FileName } catch {}
  if ($path -and $path -like "$proj*") { $found += [PSCustomObject]@{Id=$p.Id; Name=$p.ProcessName; Path=$path} }
  elseif ($p.ProcessName -match '(?i)Container|electron|node') { $found += [PSCustomObject]@{Id=$p.Id; Name=$p.ProcessName; Path=$path} }
}

if ($found.Count -eq 0) {
  'No matching processes found' | Out-File -Encoding utf8 $log -Force
} else {
  $found | Sort-Object Name,Id | ForEach-Object { "Id=$($_.Id) Name=$($_.Name) Path=$($_.Path)" } | Out-File -Encoding utf8 $log -Force
}

Get-Content $log | Out-Host

# kill Container-like processes (only those with Name matching 'Container' or path includes project and not current process)
$killedLog='logs\lock_kill.txt'
Remove-Item -Force -ErrorAction SilentlyContinue $killedLog
foreach ($entry in $found) {
  try {
    if ($entry.Name -match '(?i)Container' -or ($entry.Path -and $entry.Path -like "$proj*")) {
      if ($entry.Id -ne $PID) {
        Stop-Process -Id $entry.Id -Force -ErrorAction Stop
        "Stopped $($entry.Id) $($entry.Name)" | Out-File -Append -Encoding utf8 $killedLog
      }
    }
  } catch { "Failed to stop $($entry.Id) $($entry.Name): $_" | Out-File -Append -Encoding utf8 $killedLog }
}

if (Test-Path $killedLog) { Get-Content $killedLog | Out-Host } else { Write-Host 'No container processes killed' }

# run build-installer in fresh PowerShell and capture output
$psExe = (Get-Command powershell.exe).Source
$p = Start-Process -FilePath $psExe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File', (Join-Path $PSScriptRoot 'build-installer.ps1') -NoNewWindow -Wait -PassThru -RedirectStandardOutput 'logs\build_run.out' -RedirectStandardError 'logs\build_run.err'
Write-Host 'BUILD_EXIT=' + $p.ExitCode
if (Test-Path 'logs\build_run.err') { Get-Content -Tail 200 -Encoding utf8 'logs\build_run.err' | Out-Host }
if (Test-Path 'logs\build_run.out') { Get-Content -Tail 200 -Encoding utf8 'logs\build_run.out' | Out-Host }

