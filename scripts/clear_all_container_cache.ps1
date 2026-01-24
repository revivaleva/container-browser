# Clear cache for all containers (preserves cookies and session data)
# Clears: HTTP cache, ServiceWorker cache, CacheStorage, and other cache directories
# Preserves: cookies, localStorage, IndexedDB, and other session data
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'

New-Item -ItemType Directory -Force -Path logs | Out-Null
$log = Join-Path 'logs' 'clear_all_container_cache.log'
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

Write-Log "=== Container Browser Cache Cleanup ==="
Write-Log "This script will clear cache for all containers while preserving cookies and session data."
Write-Log ""
Write-Log "IMPORTANT: This script preserves:"
Write-Log "  - Cookies (login state will be maintained)"
Write-Log "  - LocalStorage (site preferences and data)"
Write-Log "  - IndexedDB (application data)"
Write-Log ""
Write-Log "Only cache directories are deleted (HTTP cache, Code cache, GPU cache, etc.)"
Write-Log "Note: Some sites using ServiceWorker may need to re-register, but login state is preserved."

$appData = $env:APPDATA
if (-not $appData) {
    $appData = Join-Path $env:USERPROFILE 'AppData\Roaming'
}
$userDataBase = Join-Path $appData 'container-browser'

if (-not (Test-Path -LiteralPath $userDataBase)) {
    Write-Log "Error: userData directory not found: $userDataBase"
    exit 1
}

# Cache directories to clear (from Partitions and profiles)
$cacheDirNames = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache', 'Service Worker', 'ServiceWorker', 'VideoDecodeStats')

$totalFreed = 0
$totalFilesDeleted = 0
$containersProcessed = 0
$errors = @()

# 1. Clear cache from Partitions directory
Write-Log "`n--- Clearing Cache from Partitions ---"
$partitionsDir = Join-Path $userDataBase 'Partitions'
if (Test-Path -LiteralPath $partitionsDir) {
    $partitions = Get-ChildItem -LiteralPath $partitionsDir -Directory -ErrorAction SilentlyContinue
    Write-Log "Found $($partitions.Count) partitions"
    
    foreach ($partition in $partitions) {
        $containersProcessed++
        Write-Log "  Processing partition: $($partition.Name) ..."
        
        foreach ($cacheDirName in $cacheDirNames) {
            $cachePath = Join-Path $partition.FullName $cacheDirName
            if (Test-Path -LiteralPath $cachePath) {
                try {
                    # Calculate size before deletion
                    $cacheSize = Get-DirectorySize $cachePath
                    $sizeStr = Format-Size $cacheSize.Size
                    
                    # Delete cache directory
                    Remove-Item -LiteralPath $cachePath -Recurse -Force -ErrorAction Stop
                    
                    $totalFreed += $cacheSize.Size
                    $totalFilesDeleted += $cacheSize.Count
                    Write-Log "    ✓ Deleted $cacheDirName : $sizeStr ($($cacheSize.Count) files)"
                } catch {
                    $errorMsg = "    ✗ Failed to delete $cacheDirName : $($_.Exception.Message)"
                    Write-Log $errorMsg
                    $errors += "$($partition.Name)/$cacheDirName : $($_.Exception.Message)"
                }
            }
        }
    }
} else {
    Write-Log "Partitions directory not found: $partitionsDir"
}

# 2. Clear cache from profiles directory (if any)
Write-Log "`n--- Clearing Cache from Profiles ---"
$profilesDir = Join-Path $userDataBase 'profiles'
if (Test-Path -LiteralPath $profilesDir) {
    $profiles = Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue
    Write-Log "Found $($profiles.Count) profiles"
    
    foreach ($profile in $profiles) {
        foreach ($cacheDirName in $cacheDirNames) {
            $cachePath = Join-Path $profile.FullName $cacheDirName
            if (Test-Path -LiteralPath $cachePath) {
                try {
                    # Calculate size before deletion
                    $cacheSize = Get-DirectorySize $cachePath
                    $sizeStr = Format-Size $cacheSize.Size
                    
                    # Delete cache directory
                    Remove-Item -LiteralPath $cachePath -Recurse -Force -ErrorAction Stop
                    
                    $totalFreed += $cacheSize.Size
                    $totalFilesDeleted += $cacheSize.Count
                    Write-Log "    ✓ Deleted $($profile.Name)/$cacheDirName : $sizeStr ($($cacheSize.Count) files)"
                } catch {
                    $errorMsg = "    ✗ Failed to delete $($profile.Name)/$cacheDirName : $($_.Exception.Message)"
                    Write-Log $errorMsg
                    $errors += "$($profile.Name)/$cacheDirName : $($_.Exception.Message)"
                }
            }
        }
    }
} else {
    Write-Log "Profiles directory not found: $profilesDir"
}

# Summary
Write-Log "`n=== Summary ==="
$freedSizeStr = Format-Size $totalFreed
Write-Log "Containers/Partitions processed: $containersProcessed"
Write-Log "Total cache freed: $freedSizeStr"
Write-Log "Total files deleted: $totalFilesDeleted"

if ($errors.Count -gt 0) {
    Write-Log "`nErrors encountered: $($errors.Count)"
    foreach ($error in $errors) {
        Write-Log "  - $error"
    }
} else {
    Write-Log "No errors encountered."
}

Write-Log "`n=== Important Notes ==="
Write-Log "✓ Cookies and session data (localStorage, IndexedDB) are preserved."
Write-Log "✓ Login state should be maintained (no re-login required)."
Write-Log "✓ Only cache directories were deleted."
Write-Log ""
Write-Log "Note: If a site uses ServiceWorker for session management,"
Write-Log "      it may need to re-register, but cookies will restore the session."

Add-Content -Path $log -Value ("`nEnd: $(Get-Date -Format o)") -Encoding utf8
Write-Log "`nDone. Log saved to: $log"
