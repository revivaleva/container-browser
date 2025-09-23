$Out = 'logs/local_latest_search.txt'
New-Item -ItemType Directory -Force -Path logs | Out-Null
$paths = @()
if ($env:LOCALAPPDATA) { $paths += $env:LOCALAPPDATA }
if ($env:TEMP) { $paths += $env:TEMP }
$prog = Join-Path $env:USERPROFILE 'AppData\Local\Programs'
if (Test-Path $prog) { $paths += $prog }

Set-Content -Path $Out -Value ("Search start: $(Get-Date -Format o)") -Encoding utf8
foreach ($p in $paths) {
  Add-Content -Path $Out -Value ("`n--- Searching: $p ---")
  try {
    Get-ChildItem -Path $p -Filter latest.yml -Recurse -ErrorAction SilentlyContinue |
      ForEach-Object { Add-Content -Path $Out -Value ($_.FullName + '  ' + $_.LastWriteTime) }
  } catch {}
  try {
    Get-ChildItem -Path $p -Recurse -Include '*squirrel*','*updater*','*latest*' -ErrorAction SilentlyContinue |
      ForEach-Object { Add-Content -Path $Out -Value ($_.FullName + '  ' + $_.LastWriteTime) }
  } catch {}
}
Add-Content -Path $Out -Value ("`nSearch end: $(Get-Date -Format o)")
Get-Content -Path $Out -Raw | Write-Host


