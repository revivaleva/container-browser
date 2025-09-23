param()

$Out = 'logs/list_updater_cache.out'
New-Item -ItemType Directory -Force -Path logs | Out-Null
Set-Content -Path $Out -Value ("List run: $(Get-Date -Format o)`n") -Encoding utf8
$d = 'C:\Users\revival\AppData\Local\container-browser-updater'
Add-Content -Path $Out -Value "\n--- container-browser-updater ---"
if (Test-Path $d) {
  Get-ChildItem -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { Add-Content -Path $Out -Value ("ITEM: " + $_.FullName + "  " + ($_.Length -as [string]) + " bytes  " + $_.LastWriteTime) }
} else { Add-Content -Path $Out -Value "(not present)" }

$s = 'C:\Users\revival\AppData\Local\SquirrelTemp'
Add-Content -Path $Out -Value "\n--- SquirrelTemp (recent 100) ---"
if (Test-Path $s) {
  Get-ChildItem -LiteralPath $s -Recurse -Force -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 100 | ForEach-Object { Add-Content -Path $Out -Value ("ITEM: " + $_.FullName + "  " + ($_.Length -as [string]) + " bytes  " + $_.LastWriteTime) }
} else { Add-Content -Path $Out -Value "(not present)" }

Add-Content -Path $Out -Value "\n--- Search for latest.yml under AppData\Local ---"
try {
  Get-ChildItem -Path 'C:\Users\revival\AppData\Local' -Recurse -Filter 'latest.yml' -ErrorAction SilentlyContinue | ForEach-Object { Add-Content -Path $Out -Value ("FOUND: " + $_.FullName + "  " + $_.LastWriteTime) }
} catch { Add-Content -Path $Out -Value 'search failed' }

Add-Content -Path $Out -Value "\nDone: $(Get-Date -Format o)"

Get-Content -Path $Out -Raw | Write-Host


