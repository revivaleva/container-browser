# Quick check: container-browser data size
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

function Get-DirSize {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $items = Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue -File
        return ($items | Measure-Object -Property Length -Sum).Sum
    } catch {
        return 0
    }
}

function Format-Size {
    param([long]$Bytes)
    if ($null -eq $Bytes -or $Bytes -lt 0) { return "N/A" }
    $units = @('B', 'KB', 'MB', 'GB')
    $index = 0
    $size = [double]$Bytes
    while ($size -ge 1024 -and $index -lt $units.Length - 1) {
        $size = $size / 1024
        $index++
    }
    return "{0:N2} {1}" -f $size, $units[$index]
}

Write-Host "`n=== Container Browser Data Size Check ===" -ForegroundColor Cyan
Write-Host "Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n"

$appData = $env:APPDATA
if (-not $appData) {
    $appData = Join-Path $env:USERPROFILE 'AppData\Roaming'
}
$userDataBase = Join-Path $appData 'container-browser'

$results = @()

# Main directories
Write-Host "--- Main Data Directories ---" -ForegroundColor Yellow
$dirs = @(
    @{ Name = "userData (all)"; Path = $userDataBase },
    @{ Name = "profiles"; Path = Join-Path $userDataBase 'profiles' },
    @{ Name = "Partitions"; Path = Join-Path $userDataBase 'Partitions' },
    @{ Name = "temp"; Path = Join-Path $userDataBase 'temp' }
)

foreach ($dir in $dirs) {
    $size = Get-DirSize $dir.Path
    if ($null -ne $size) {
        $sizeStr = Format-Size $size
        Write-Host "$($dir.Name): $sizeStr - $($dir.Path)" -ForegroundColor White
        $results += @{ Name = $dir.Name; Size = $size; Path = $dir.Path }
    } else {
        Write-Host "$($dir.Name): Not found - $($dir.Path)" -ForegroundColor Gray
    }
}

# Database
Write-Host "`n--- Database ---" -ForegroundColor Yellow
$dbPath = Join-Path $userDataBase 'data.db'
if (Test-Path -LiteralPath $dbPath) {
    $dbSize = (Get-Item -LiteralPath $dbPath).Length
    $sizeStr = Format-Size $dbSize
    Write-Host "data.db: $sizeStr - $dbPath" -ForegroundColor White
    $results += @{ Name = "data.db"; Size = $dbSize; Path = $dbPath }
}

# Updater cache
Write-Host "`n--- Updater Cache ---" -ForegroundColor Yellow
$updaterCache = Join-Path $env:LOCALAPPDATA 'container-browser-updater'
$updaterSize = Get-DirSize $updaterCache
if ($null -ne $updaterSize) {
    $sizeStr = Format-Size $updaterSize
    Write-Host "container-browser-updater: $sizeStr - $updaterCache" -ForegroundColor White
    $results += @{ Name = "container-browser-updater"; Size = $updaterSize; Path = $updaterCache }
}

# Summary
Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$totalSize = ($results | Where-Object { $null -ne $_.Size } | Measure-Object -Property Size -Sum).Sum
$totalSizeStr = Format-Size $totalSize
Write-Host "Total Size: $totalSizeStr`n" -ForegroundColor Green

Write-Host "Sorted by size (largest first):" -ForegroundColor Yellow
$sorted = $results | Where-Object { $null -ne $_.Size } | Sort-Object -Property Size -Descending
foreach ($item in $sorted) {
    $sizeStr = Format-Size $item.Size
    $percent = if ($totalSize -gt 0) { ($item.Size / $totalSize * 100).ToString('F1') } else { "0.0" }
    Write-Host "  $($item.Name): $sizeStr ($percent%)" -ForegroundColor White
}

Write-Host "`nDone." -ForegroundColor Green
