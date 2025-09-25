Param()
New-Item -ItemType Directory -Force -Path logs | Out-Null

Write-Host 'Listing container-browser related files under LOCALAPPDATA...'
Get-ChildItem -Path $env:LOCALAPPDATA -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'container-browser-updater|\\container-browser' } |
  Select-Object FullName,LastWriteTime -First 200 |
  Out-File -FilePath logs/localapp_container_browser_list.txt -Encoding utf8

Write-Host 'Listing latest.yml under LOCALAPPDATA...'
Get-ChildItem -Path $env:LOCALAPPDATA -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ieq 'latest.yml' } |
  Select-Object FullName,LastWriteTime -First 200 |
  Out-File -FilePath logs/localapp_latest_yml_list.txt -Encoding utf8

$squirrelLog = Join-Path $env:LOCALAPPDATA 'container-browser-updater\SquirrelSetup.log'
Write-Host "Checking Squirrel log: $squirrelLog"
if (Test-Path $squirrelLog) {
  Get-Content -Path $squirrelLog -Tail 200 -ErrorAction SilentlyContinue | Out-File -FilePath logs/squirrel_setup_tail.txt -Encoding utf8
} else {
  'No SquirrelSetup.log found' | Out-File -FilePath logs/squirrel_setup_tail.txt -Encoding utf8
}

Write-Host 'Searching LOCALAPPDATA files for manifest references...'
$files = Get-ChildItem -Path $env:LOCALAPPDATA -Recurse -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
if ($files -and $files.Count -gt 0) {
  Select-String -Path $files -Pattern 'container-browser-updates|nsis-web|container-browser-0.3.0' -SimpleMatch -List |
    Select-Object Path,LineNumber,Line |
    Out-File -FilePath logs/localapp_string_search.txt -Encoding utf8
} else {
  'No files to search' | Out-File -FilePath logs/localapp_string_search.txt -Encoding utf8
}

Write-Host 'Wrote logs: localapp_container_browser_list.txt, localapp_latest_yml_list.txt, squirrel_setup_tail.txt, localapp_string_search.txt'
Get-Content logs/localapp_container_browser_list.txt -ErrorAction SilentlyContinue | Select-Object -Last 50 | ForEach-Object { Write-Host $_ }
Get-Content logs/localapp_latest_yml_list.txt -ErrorAction SilentlyContinue | Select-Object -Last 50 | ForEach-Object { Write-Host $_ }
Write-Host '--- Squirrel tail ---'
Get-Content logs/squirrel_setup_tail.txt -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
Write-Host '--- String search results ---'
Get-Content logs/localapp_string_search.txt -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }


