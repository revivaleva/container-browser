# Clear cache for a specific container by name
# Usage: .\scripts\clear_container_cache.ps1 -ContainerName "SMatirx11747"
param(
    [Parameter(Mandatory=$true)]
    [string]$ContainerName
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'

New-Item -ItemType Directory -Force -Path logs | Out-Null
$log = Join-Path 'logs' "clear_container_cache_$($ContainerName -replace '[^\w]', '_').log"
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

Write-Log "=== Container Browser Cache Cleanup (Single Container) ==="
Write-Log "Target container: $ContainerName"
Write-Log ""
Write-Log "IMPORTANT: This script preserves:"
Write-Log "  - Cookies (login state will be maintained)"
Write-Log "  - LocalStorage (site preferences and data)"
Write-Log "  - IndexedDB (application data)"
Write-Log ""
Write-Log "Only cache directories are deleted (HTTP cache, Code cache, GPU cache, etc.)"

$appData = $env:APPDATA
if (-not $appData) {
    $appData = Join-Path $env:USERPROFILE 'AppData\Roaming'
}
$userDataBase = Join-Path $appData 'container-browser'
$dbPath = Join-Path $userDataBase 'data.db'

if (-not (Test-Path -LiteralPath $userDataBase)) {
    Write-Log "Error: userData directory not found: $userDataBase"
    exit 1
}

if (-not (Test-Path -LiteralPath $dbPath)) {
    Write-Log "Error: Database not found: $dbPath"
    exit 1
}

# Read container info from database using SQLite3 command line tool
Write-Log "`n--- Reading container info from database ---"

# Try to find sqlite3.exe in common locations
$sqlite3Paths = @(
    'sqlite3.exe',
    'C:\Program Files\SQLite\sqlite3.exe',
    'C:\Windows\System32\sqlite3.exe',
    (Join-Path $PSScriptRoot '..\node_modules\.bin\sqlite3.cmd')
)

$sqlite3 = $null
foreach ($path in $sqlite3Paths) {
    if (Get-Command $path -ErrorAction SilentlyContinue) {
        $sqlite3 = $path
        break
    }
}

if (-not $sqlite3) {
    # Fallback: Try to use node with a simple SQLite reader
    Write-Log "SQLite3 command line tool not found. Trying alternative method..."
    
    # Try to find partition by scanning Partitions directory and matching by container name pattern
    # This is a fallback method that works without database access
    $partitionsDir = Join-Path $userDataBase 'Partitions'
    if (Test-Path -LiteralPath $partitionsDir) {
        Write-Log "Scanning Partitions directory to find matching container..."
        $partitions = Get-ChildItem -LiteralPath $partitionsDir -Directory -ErrorAction SilentlyContinue
        
        $foundPartition = $null
        foreach ($partition in $partitions) {
            # Check if this partition might belong to the container
            # We'll look for a pattern or use the first partition if only one exists
            # This is a heuristic approach
            $foundPartition = $partition
            Write-Log "  Found partition: $($partition.Name)"
            break
        }
        
        if ($foundPartition) {
            $partitionDirName = $foundPartition.Name
            Write-Log "Using partition: $partitionDirName"
            Write-Log "Note: This is a heuristic match. For exact match, use SQLite3 or app's built-in feature."
        } else {
            Write-Log "Error: No partitions found. Cannot determine partition for container."
            exit 1
        }
    } else {
        Write-Log "Error: Partitions directory not found. Cannot determine partition."
        Write-Log "Please use the app's built-in cache clear feature or install SQLite3 command line tool."
        exit 1
    }
} else {
    # Use SQLite3 command line tool
    try {
        $query = "SELECT id, name, partition FROM containers WHERE name = '$ContainerName'"
        $result = & $sqlite3 $dbPath $query 2>&1
        
        if ($LASTEXITCODE -ne 0 -or -not $result) {
            Write-Log "Error: Container '$ContainerName' not found in database."
            exit 1
        }
        
        $fields = $result -split '\|'
        if ($fields.Count -lt 3) {
            Write-Log "Error: Invalid database result format."
            exit 1
        }
        
        $containerId = $fields[0]
        $containerName = $fields[1]
        $partition = $fields[2]
        
        Write-Log "Found container:"
        Write-Log "  ID: $containerId"
        Write-Log "  Name: $containerName"
        Write-Log "  Partition: $partition"
        
        # Extract partition directory name from partition string (persist:container-xxx -> container-xxx)
        if ($partition -match '^persist:(.+)$') {
            $partitionDirName = $matches[1]
            Write-Log "  Partition directory: $partitionDirName"
        } else {
            Write-Log "Error: Invalid partition format: $partition"
            exit 1
        }
    } catch {
        Write-Log "Error: Failed to read database: $($_.Exception.Message)"
        exit 1
    }
}

# Cache directories to clear
$cacheDirNames = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache', 'Service Worker', 'ServiceWorker', 'VideoDecodeStats')

$totalFreed = 0
$totalFilesDeleted = 0
$errors = @()

# Clear cache from Partitions directory
Write-Log "`n--- Clearing Cache from Partition ---"
$partitionsDir = Join-Path $userDataBase 'Partitions'
$partitionPath = Join-Path $partitionsDir $partitionDirName

if (Test-Path -LiteralPath $partitionPath) {
    Write-Log "Processing partition: $partitionDirName"
    
    foreach ($cacheDirName in $cacheDirNames) {
        $cachePath = Join-Path $partitionPath $cacheDirName
        if (Test-Path -LiteralPath $cachePath) {
            try {
                # Calculate size before deletion
                $cacheSize = Get-DirectorySize $cachePath
                $sizeStr = Format-Size $cacheSize.Size
                
                # Delete cache directory
                Remove-Item -LiteralPath $cachePath -Recurse -Force -ErrorAction Stop
                
                $totalFreed += $cacheSize.Size
                $totalFilesDeleted += $cacheSize.Count
                Write-Log "  ✓ Deleted $cacheDirName : $sizeStr ($($cacheSize.Count) files)"
            } catch {
                $errorMsg = "  ✗ Failed to delete $cacheDirName : $($_.Exception.Message)"
                Write-Log $errorMsg
                $errors += "$cacheDirName : $($_.Exception.Message)"
            }
        }
    }
} else {
    Write-Log "Warning: Partition directory not found: $partitionPath"
}

# Clear cache from profile directory (if exists)
Write-Log "`n--- Clearing Cache from Profile ---"
$profilesDir = Join-Path $userDataBase 'profiles'
$profilePath = Join-Path $profilesDir $container.id

if (Test-Path -LiteralPath $profilePath) {
    Write-Log "Processing profile: $($container.id)"
    
    foreach ($cacheDirName in $cacheDirNames) {
        $cachePath = Join-Path $profilePath $cacheDirName
        if (Test-Path -LiteralPath $cachePath) {
            try {
                # Calculate size before deletion
                $cacheSize = Get-DirectorySize $cachePath
                $sizeStr = Format-Size $cacheSize.Size
                
                # Delete cache directory
                Remove-Item -LiteralPath $cachePath -Recurse -Force -ErrorAction Stop
                
                $totalFreed += $cacheSize.Size
                $totalFilesDeleted += $cacheSize.Count
                Write-Log "  ✓ Deleted $cacheDirName : $sizeStr ($($cacheSize.Count) files)"
            } catch {
                $errorMsg = "  ✗ Failed to delete $cacheDirName : $($_.Exception.Message)"
                Write-Log $errorMsg
                $errors += "$cacheDirName : $($_.Exception.Message)"
            }
        }
    }
} else {
    Write-Log "Profile directory not found: $profilePath (this is normal if profile is not used)"
}

# Summary
Write-Log "`n=== Summary ==="
$freedSizeStr = Format-Size $totalFreed
Write-Log "Container: $ContainerName"
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

Add-Content -Path $log -Value ("`nEnd: $(Get-Date -Format o)") -Encoding utf8
Write-Log "`nDone. Log saved to: $log"
