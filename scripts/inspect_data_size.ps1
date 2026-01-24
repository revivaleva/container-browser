# Inspect container-browser data size
# Note: May take time if there are many files
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'

New-Item -ItemType Directory -Force -Path logs | Out-Null
$log = Join-Path 'logs' 'inspect_data_size.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)`n") -Encoding utf8

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format 'HH:mm:ss'
    $logMsg = "[$timestamp] $Message"
    Add-Content -Path $log -Value $logMsg -Encoding utf8
    Write-Host $logMsg
}

function Format-Size {
    param([long]$Bytes)
    if ($null -eq $Bytes -or $Bytes -lt 0) { return "N/A" }
    if ($Bytes -eq 0) { return "0 B" }
    $units = @('B', 'KB', 'MB', 'GB', 'TB')
    $index = 0
    $size = [double]$Bytes
    while ($size -ge 1024 -and $index -lt ($units.Length - 1)) {
        $size = $size / 1024
        $index++
    }
    return "{0:N2} {1}" -f $size, $units[$index]
}

Write-Log "=== Container Browser Data Size Inspection ==="

$appData = $env:APPDATA
if (-not $appData) {
    $appData = Join-Path $env:USERPROFILE 'AppData\Roaming'
}
$userDataBase = Join-Path $appData 'container-browser'

$results = @()

# 1. Main userData directory
Write-Log "`n--- Main Data Directory ---"
if (Test-Path -LiteralPath $userDataBase) {
    Write-Log "Scanning: $userDataBase (this may take a while...)"
    $items = Get-ChildItem -LiteralPath $userDataBase -Recurse -File -ErrorAction SilentlyContinue
    $totalSize = ($items | Measure-Object -Property Length -Sum).Sum
    $sizeStr = Format-Size $totalSize
    Write-Log "userData (all): $sizeStr ($($items.Count) files)"
    $results += @{ Name = "userData (all)"; Size = $totalSize; Count = $items.Count }
} else {
    Write-Log "Not found: $userDataBase"
}

# 2. Database
Write-Log "`n--- Database ---"
$dbPath = Join-Path $userDataBase 'data.db'
if (Test-Path -LiteralPath $dbPath) {
    $dbInfo = Get-Item -LiteralPath $dbPath
    $sizeStr = Format-Size $dbInfo.Length
    Write-Log "data.db: $sizeStr - $dbPath"
    $results += @{ Name = "data.db"; Size = $dbInfo.Length; Count = 1 }
} else {
    Write-Log "Not found: $dbPath"
}

# 3. Profiles (top level only for speed)
Write-Log "`n--- Profiles Directory ---"
$profilesDir = Join-Path $userDataBase 'profiles'
if (Test-Path -LiteralPath $profilesDir) {
    $profiles = Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue
    Write-Log "Found $($profiles.Count) profiles"
    
    $profileTotalSize = 0
    $profileTotalCount = 0
    foreach ($profile in $profiles) {
        Write-Log "  Scanning profile: $($profile.Name) ..."
        $items = Get-ChildItem -LiteralPath $profile.FullName -Recurse -File -ErrorAction SilentlyContinue
        $size = ($items | Measure-Object -Property Length -Sum).Sum
        $sizeStr = Format-Size $size
        Write-Log "    $($profile.Name): $sizeStr ($($items.Count) files)"
        $profileTotalSize += $size
        $profileTotalCount += $items.Count
        
        # Check cache directories
        $cacheDirs = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache', 'Service Worker')
        foreach ($cacheDirName in $cacheDirs) {
            $cachePath = Join-Path $profile.FullName $cacheDirName
            if (Test-Path -LiteralPath $cachePath) {
                $cacheItems = Get-ChildItem -LiteralPath $cachePath -Recurse -File -ErrorAction SilentlyContinue
                $cacheSize = ($cacheItems | Measure-Object -Property Length -Sum).Sum
                $cacheSizeStr = Format-Size $cacheSize
                Write-Log "      - $cacheDirName : $cacheSizeStr ($($cacheItems.Count) files)" -NoNewline
                Add-Content -Path $log -Value "      - $cacheDirName : $cacheSizeStr ($($cacheItems.Count) files)" -Encoding utf8
            }
        }
    }
    $profilesSizeStr = Format-Size $profileTotalSize
    Write-Log "profiles (total): $profilesSizeStr ($profileTotalCount files)"
    $results += @{ Name = "profiles (total)"; Size = $profileTotalSize; Count = $profileTotalCount }
} else {
    Write-Log "Not found: $profilesDir"
}

# 4. Partitions (top level only for speed)
Write-Log "`n--- Partitions Directory ---"
$partitionsDir = Join-Path $userDataBase 'Partitions'
if (Test-Path -LiteralPath $partitionsDir) {
    $partitions = Get-ChildItem -LiteralPath $partitionsDir -Directory -ErrorAction SilentlyContinue
    Write-Log "Found $($partitions.Count) partitions"
    
    $partitionTotalSize = 0
    $partitionTotalCount = 0
    foreach ($partition in $partitions) {
        Write-Log "  Scanning partition: $($partition.Name) ..."
        $items = Get-ChildItem -LiteralPath $partition.FullName -Recurse -File -ErrorAction SilentlyContinue
        $size = ($items | Measure-Object -Property Length -Sum).Sum
        $sizeStr = Format-Size $size
        Write-Log "    $($partition.Name): $sizeStr ($($items.Count) files)"
        $partitionTotalSize += $size
        $partitionTotalCount += $items.Count
        
        # Check cache directories
        $cacheDirs = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache', 'Service Worker')
        foreach ($cacheDirName in $cacheDirs) {
            $cachePath = Join-Path $partition.FullName $cacheDirName
            if (Test-Path -LiteralPath $cachePath) {
                $cacheItems = Get-ChildItem -LiteralPath $cachePath -Recurse -File -ErrorAction SilentlyContinue
                $cacheSize = ($cacheItems | Measure-Object -Property Length -Sum).Sum
                $cacheSizeStr = Format-Size $cacheSize
                Write-Log "      - $cacheDirName : $cacheSizeStr ($($cacheItems.Count) files)" -NoNewline
                Add-Content -Path $log -Value "      - $cacheDirName : $cacheSizeStr ($($cacheItems.Count) files)" -Encoding utf8
            }
        }
    }
    $partitionsSizeStr = Format-Size $partitionTotalSize
    Write-Log "Partitions (total): $partitionsSizeStr ($partitionTotalCount files)"
    $results += @{ Name = "Partitions (total)"; Size = $partitionTotalSize; Count = $partitionTotalCount }
} else {
    Write-Log "Not found: $partitionsDir"
}

# 5. Temp directory
Write-Log "`n--- Temp Directory ---"
$tempDir = Join-Path $userDataBase 'temp'
if (Test-Path -LiteralPath $tempDir) {
    $items = Get-ChildItem -LiteralPath $tempDir -Recurse -File -ErrorAction SilentlyContinue
    $size = ($items | Measure-Object -Property Length -Sum).Sum
    $sizeStr = Format-Size $size
    Write-Log "temp: $sizeStr ($($items.Count) files)"
    $results += @{ Name = "temp"; Size = $size; Count = $items.Count }
} else {
    Write-Log "Not found: $tempDir"
}

# 6. Updater cache
Write-Log "`n--- Updater Cache ---"
$updaterCache = Join-Path $env:LOCALAPPDATA 'container-browser-updater'
if (Test-Path -LiteralPath $updaterCache) {
    Write-Log "Scanning: $updaterCache ..."
    $items = Get-ChildItem -LiteralPath $updaterCache -Recurse -File -ErrorAction SilentlyContinue
    $size = ($items | Measure-Object -Property Length -Sum).Sum
    $sizeStr = Format-Size $size
    Write-Log "container-browser-updater: $sizeStr ($($items.Count) files)"
    $results += @{ Name = "container-browser-updater"; Size = $size; Count = $items.Count }
} else {
    Write-Log "Not found: $updaterCache"
}

# 7. SquirrelTemp
Write-Log "`n--- SquirrelTemp ---"
$squirrelTemp = Join-Path $env:LOCALAPPDATA 'SquirrelTemp'
if (Test-Path -LiteralPath $squirrelTemp) {
    $items = Get-ChildItem -LiteralPath $squirrelTemp -Recurse -Force -ErrorAction SilentlyContinue | 
             Where-Object { $_.FullName -like '*container-browser*' -and -not $_.PSIsContainer }
    if ($items) {
        $size = ($items | Measure-Object -Property Length -Sum).Sum
        $sizeStr = Format-Size $size
        Write-Log "SquirrelTemp (container-browser): $sizeStr ($($items.Count) files)"
        $results += @{ Name = "SquirrelTemp (container-browser)"; Size = $size; Count = $items.Count }
    } else {
        Write-Log "No container-browser files in SquirrelTemp"
    }
} else {
    Write-Log "Not found: $squirrelTemp"
}

# Summary
Write-Log "`n=== Summary ==="
$totalSize = ($results | Where-Object { $null -ne $_.Size } | Measure-Object -Property Size -Sum).Sum
$totalSizeStr = Format-Size $totalSize
Write-Log "Total Size: $totalSizeStr`n"

Write-Log "Sorted by size (largest first):"
$sorted = $results | Where-Object { $null -ne $_.Size } | Sort-Object -Property Size -Descending
foreach ($item in $sorted) {
    $sizeStr = Format-Size $item.Size
    $percent = if ($totalSize -gt 0) { ($item.Size / $totalSize * 100).ToString('F1') } else { "0.0" }
    Write-Log "  $($item.Name): $sizeStr ($percent%)"
}

Add-Content -Path $log -Value "`nEnd: $(Get-Date -Format o)"
Write-Log "`nLog file: $log"
Write-Log "Done."
