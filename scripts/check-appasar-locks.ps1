$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$proj=(Get-Location).Path
$target = Join-Path $proj 'dist\win-unpacked\resources\app.asar'
New-Item -ItemType Directory -Force logs | Out-Null
$out='logs\appasar_locking_processes.txt'
$results = @()

Get-Process | ForEach-Object {
  $p = $_
  try {
    # check main module
    try { if ($p.MainModule -and $p.MainModule.FileName -and $p.MainModule.FileName -like '*app.asar*') { $results += [PSCustomObject]@{Id=$p.Id; Name=$p.ProcessName; Module=$p.MainModule.FileName}; return } } catch {}
    # check modules collection
    foreach ($m in $p.Modules) {
      if ($m.FileName -and $m.FileName -like '*app.asar*') { $results += [PSCustomObject]@{Id=$p.Id; Name=$p.ProcessName; Module=$m.FileName}; break }
    }
  } catch {}
}

if ($results.Count -eq 0) {
  'No matching processes found' | Out-File -Encoding utf8 $out -Force
} else {
  $results | Sort-Object Name,Id | ForEach-Object { "Id=$($_.Id) Name=$($_.Name) Module=$($_.Module)" } | Out-File -Encoding utf8 $out -Force
}

Get-Content $out | Out-Host
