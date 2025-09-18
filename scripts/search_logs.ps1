$dir = 'scripts/logs/run_17790673856_job_50566778843'
if (-not (Test-Path $dir)) { Write-Output 'dir not found'; exit 0 }
$patterns = @('nsis-web build failed','Env WIN_CSC_LINK','WIN_CSC_LINK','cannot resolve','cannot find file','ExitCode','Error: Process completed with exit code','sign')
foreach ($f in Get-ChildItem -Path $dir -Recurse -File) {
  foreach ($pat in $patterns) {
    $m = Select-String -Path $f.FullName -Pattern $pat -SimpleMatch -Context 0,5 -ErrorAction SilentlyContinue
    if ($m) {
      Write-Output "---- Match in $($f.FullName) pattern:$pat ----"
      $m | ForEach-Object { Write-Output $_.ToString() }
    }
  }
}



