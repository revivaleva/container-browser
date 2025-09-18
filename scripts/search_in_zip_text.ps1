$f = 'scripts/logs/run_17790673856_job_50566778843.zip'
if (-not (Test-Path $f)) { Write-Output "file not found: $f"; exit 0 }
$text = Get-Content -LiteralPath $f -Raw -ErrorAction Stop
$patterns = @('nsis-web build failed','Env WIN_CSC_LINK','WIN_CSC_LINK','cannot resolve','cannot find file','ExitCode','Error: Process completed with exit code','cannot resolve','sign')
foreach ($pat in $patterns) {
  $matches = Select-String -InputObject $text -Pattern $pat -SimpleMatch -AllMatches -ErrorAction SilentlyContinue
  if ($matches) {
    Write-Output "---- Pattern: $pat ----"
    $matches | ForEach-Object { Write-Output $_.Line }
  }
}
Write-Output '--- tail of file ---'
Get-Content -LiteralPath $f -Tail 200 | ForEach-Object { Write-Output $_ }



