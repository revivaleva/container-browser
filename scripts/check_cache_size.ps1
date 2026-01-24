# Check cache size for all containers
# Shows how much space can be freed by clearing cache
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'

New-Item -ItemType Directory -Force -Path logs | Out-Null
$log = Join-Path 'logs' 'check_cache_size.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)`n") -Encoding utf8

function Write-Log {
    param([string]$Message, [switch]$NoNewline)
    $timestamp = Get-Date -Format 'HH:mm:ss'
    $logMsg = "[$timestamp] $Message"
    Add-Content -Path $log -Value $logMsg -Encoding utf8
    if ($NoNewline) {
        Write-Host $logMsg -NoNewline
    } else {
        Write-Host $logMsg
    }
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

function Get-DirectorySize {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return @{ Size = 0; Count = 0 }
    }
    try {
        $items = Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue
        $size = ($items | Measure-Object -Property Length -Sum).Sum
        $count = $items.Count
        return @{ Size = $size; Count = $count }
    } catch {
        return @{ Size = 0; Count = 0 }
    }
}

Write-Log "=== Container Browser Cache Size Check ==="
Write-Log "This script shows how much space can be freed by clearing cache."

$appData = $env:APPDATA
if (-not $appData) {
    $appData = Join-Path $env:USERPROFILE 'AppData\Roaming'
}
$userDataBase = Join-Path $appData 'container-browser'

if (-not (Test-Path -LiteralPath $userDataBase)) {
    Write-Log "Error: userData directory not found: $userDataBase"
    exit 1
}

# Cache directories to check
$cacheDirNames = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache', 'Service Worker', 'ServiceWorker', 'VideoDecodeStats')

$totalCacheSize = 0
$totalCacheFiles = 0
$containersWithCache = 0
$cacheBreakdown = @{}

# 1. Check cache in Partitions directory
Write-Log "`n--- Cache in Partitions ---"
$partitionsDir = Join-Path $userDataBase 'Partitions'
if (Test-Path -LiteralPath $partitionsDir) {
    $partitions = Get-ChildItem -LiteralPath $partitionsDir -Directory -ErrorAction SilentlyContinue
    Write-Log "Found $($partitions.Count) partitions"
    
    foreach ($partition in $partitions) {
        $partitionCacheSize = 0
        $partitionCacheFiles = 0
        $hasCache = $false
        
        foreach ($cacheDirName in $cacheDirNames) {
            $cachePath = Join-Path $partition.FullName $cacheDirName
            if (Test-Path -LiteralPath $cachePath) {
                $hasCache = $true
                $cacheSize = Get-DirectorySize $cachePath
                $sizeStr = Format-Size $cacheSize.Size
                
                $partitionCacheSize += $cacheSize.Size
                $partitionCacheFiles += $cacheSize.Count
                
                if (-not $cacheBreakdown.ContainsKey($cacheDirName)) {
                    $cacheBreakdown[$cacheDirName] = @{ Size = 0; Count = 0 }
                }
                $cacheBreakdown[$cacheDirName].Size += $cacheSize.Size
                $cacheBreakdown[$cacheDirName].Count += $cacheSize.Count
                
                Write-Log "    $($partition.Name)/$cacheDirName : $sizeStr ($($cacheSize.Count) files)"
            }
        }
        
        if ($hasCache) {
            $containersWithCache++
            $totalCacheSize += $partitionCacheSize
            $totalCacheFiles += $partitionCacheFiles
            $partitionTotalStr = Format-Size $partitionCacheSize
            Write-Log "  → $($partition.Name) total: $partitionTotalStr ($partitionCacheFiles files)"
        }
    }
} else {
    Write-Log "Partitions directory not found: $partitionsDir"
}

# 2. Check cache in profiles directory
Write-Log "`n--- Cache in Profiles ---"
$profilesDir = Join-Path $userDataBase 'profiles'
if (Test-Path -LiteralPath $profilesDir) {
    $profiles = Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue
    Write-Log "Found $($profiles.Count) profiles"
    
    foreach ($profile in $profiles) {
        $profileCacheSize = 0
        $profileCacheFiles = 0
        $hasCache = $false
        
        foreach ($cacheDirName in $cacheDirNames) {
            $cachePath = Join-Path $profile.FullName $cacheDirName
            if (Test-Path -LiteralPath $cachePath) {
                $hasCache = $true
                $cacheSize = Get-DirectorySize $cachePath
                $sizeStr = Format-Size $cacheSize.Size
                
                $profileCacheSize += $cacheSize.Size
                $profileCacheFiles += $cacheSize.Count
                
                if (-not $cacheBreakdown.ContainsKey($cacheDirName)) {
                    $cacheBreakdown[$cacheDirName] = @{ Size = 0; Count = 0 }
                }
                $cacheBreakdown[$cacheDirName].Size += $cacheSize.Size
                $cacheBreakdown[$cacheDirName].Count += $cacheSize.Count
                
                Write-Log "    $($profile.Name)/$cacheDirName : $sizeStr ($($cacheSize.Count) files)"
            }
        }
        
        if ($hasCache) {
            $totalCacheSize += $profileCacheSize
            $totalCacheFiles += $profileCacheFiles
            $profileTotalStr = Format-Size $profileCacheSize
            Write-Log "  → $($profile.Name) total: $profileTotalStr ($profileCacheFiles files)"
        }
    }
} else {
    Write-Log "Profiles directory not found: $profilesDir"
}

# Summary
Write-Log "`n=== Summary ==="
$totalCacheSizeStr = Format-Size $totalCacheSize
Write-Log "Containers/Partitions with cache: $containersWithCache"
Write-Log "Total cache size: $totalCacheSizeStr"
Write-Log "Total cache files: $totalCacheFiles"

if ($cacheBreakdown.Count -gt 0) {
    Write-Log "`nCache breakdown by type:"
    foreach ($cacheType in $cacheBreakdown.Keys | Sort-Object) {
        $sizeStr = Format-Size $cacheBreakdown[$cacheType].Size
        Write-Log "  - $cacheType : $sizeStr ($($cacheBreakdown[$cacheType].Count) files)"
    }
}

Write-Log "`nTo clear this cache, run: .\scripts\clear_all_container_cache.ps1"
Write-Log "Note: Clearing cache will preserve cookies and session data."

Add-Content -Path $log -Value ("`nEnd: $(Get-Date -Format o)") -Encoding utf8
Write-Log "`nDone. Log saved to: $log"
