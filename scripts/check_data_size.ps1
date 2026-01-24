<#
調査: container-browser のデータサイズ
キャッシュ、プロファイル、一時ファイルなどの使用量を確認します
#>
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

New-Item -ItemType Directory -Force -Path logs | Out-Null
$log = Join-Path 'logs' 'check_data_size.log'
$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Set-Content -Path $log -Value "=== Container Browser データサイズ調査 ===`n開始時刻: $timestamp`n" -Encoding utf8

function Get-DirectorySize {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    try {
        $items = Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | 
            Where-Object { $_.PSIsContainer -eq $false }
        $totalSize = ($items | Measure-Object -Property Length -Sum).Sum
        return @{
            Exists = $true
            Size = $totalSize
            Count = $items.Count
        }
    } catch {
        return @{
            Exists = $true
            Size = 0
            Count = 0
            Error = $_.Exception.Message
        }
    }
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -eq $null -or $Bytes -lt 0) { return "N/A" }
    $units = @('B', 'KB', 'MB', 'GB', 'TB')
    $index = 0
    $size = [double]$Bytes
    while ($size -ge 1024 -and $index -lt $units.Length - 1) {
        $size = $size / 1024
        $index++
    }
    return "{0:N2} {1}" -f $size, $units[$index]
}

function Write-Result {
    param([string]$Name, [string]$Path, [object]$Result)
    if ($Result -eq $null -or -not $Result.Exists) {
        $msg = "$Name : 存在しません ($Path)"
        Write-Host $msg
        Add-Content -Path $log -Value $msg
        return
    }
    $sizeStr = Format-Size $Result.Size
    $msg = "$Name : $sizeStr ($($Result.Count) ファイル) - $Path"
    if ($Result.Error) {
        $msg += " [エラー: $($Result.Error)]"
    }
    Write-Host $msg
    Add-Content -Path $log -Value $msg
    return @{
        Name = $Name
        Path = $Path
        Size = $Result.Size
        Count = $Result.Count
    }
}

Write-Host "`n=== Container Browser データサイズ調査 ===" -ForegroundColor Cyan
Write-Host "開始時刻: $timestamp`n"

$results = @()

# 1. メインの userData ディレクトリ
Write-Host "`n--- メインデータディレクトリ ---" -ForegroundColor Yellow
$appData = $env:APPDATA
if (-not $appData) {
    $appData = Join-Path $env:USERPROFILE 'AppData\Roaming'
}
$userDataBase = Join-Path $appData 'container-browser'
$results += Write-Result "userData (全体)" $userDataBase (Get-DirectorySize $userDataBase)

# 2. データベース
Write-Host "`n--- データベース ---" -ForegroundColor Yellow
$dbPath = Join-Path $userDataBase 'data.db'
if (Test-Path -LiteralPath $dbPath) {
    $dbInfo = Get-Item -LiteralPath $dbPath
    $sizeStr = Format-Size $dbInfo.Length
    $msg = "data.db : $sizeStr - $dbPath"
    Write-Host $msg
    Add-Content -Path $log -Value $msg
    $results += @{ Name = "data.db"; Path = $dbPath; Size = $dbInfo.Length; Count = 1 }
} else {
    $msg = "data.db : 存在しません - $dbPath"
    Write-Host $msg
    Add-Content -Path $log -Value $msg
}

# 3. プロファイルディレクトリ（全体と詳細）
Write-Host "`n--- プロファイルディレクトリ ---" -ForegroundColor Yellow
$profilesDir = Join-Path $userDataBase 'profiles'
$profilesResult = Get-DirectorySize $profilesDir
$results += Write-Result "profiles (全体)" $profilesDir $profilesResult

if ($profilesResult -and $profilesResult.Exists -and (Test-Path -LiteralPath $profilesDir)) {
    $profileDirs = Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue
    Write-Host "  プロファイル詳細:"
    foreach ($profileDir in $profileDirs) {
        $profileSize = Get-DirectorySize $profileDir.FullName
        if ($profileSize) {
            $sizeStr = Format-Size $profileSize.Size
            $msg = "    - $($profileDir.Name) : $sizeStr ($($profileSize.Count) ファイル)"
            Write-Host $msg
            Add-Content -Path $log -Value $msg
            
            # キャッシュディレクトリの詳細
            $cacheDirs = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache', 'Service Worker')
            foreach ($cacheDirName in $cacheDirs) {
                $cachePath = Join-Path $profileDir.FullName $cacheDirName
                if (Test-Path -LiteralPath $cachePath) {
                    $cacheSize = Get-DirectorySize $cachePath
                    if ($cacheSize) {
                        $cacheSizeStr = Format-Size $cacheSize.Size
                        $cacheMsg = "      └─ $cacheDirName : $cacheSizeStr ($($cacheSize.Count) ファイル)"
                        Write-Host $cacheMsg -ForegroundColor Gray
                        Add-Content -Path $log -Value $cacheMsg
                    }
                }
            }
        }
    }
}

# 4. Partitions ディレクトリ
Write-Host "`n--- Partitions ディレクトリ ---" -ForegroundColor Yellow
$partitionsDir = Join-Path $userDataBase 'Partitions'
$partitionsResult = Get-DirectorySize $partitionsDir
$results += Write-Result "Partitions (全体)" $partitionsDir $partitionsResult

if ($partitionsResult -and $partitionsResult.Exists -and (Test-Path -LiteralPath $partitionsDir)) {
    $partitionDirs = Get-ChildItem -LiteralPath $partitionsDir -Directory -ErrorAction SilentlyContinue
    Write-Host "  Partition詳細:"
    foreach ($partitionDir in $partitionDirs) {
        $partitionSize = Get-DirectorySize $partitionDir.FullName
        if ($partitionSize) {
            $sizeStr = Format-Size $partitionSize.Size
            $msg = "    - $($partitionDir.Name) : $sizeStr ($($partitionSize.Count) ファイル)"
            Write-Host $msg
            Add-Content -Path $log -Value $msg
            
            # キャッシュディレクトリの詳細
            $cacheDirs = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache', 'Service Worker')
            foreach ($cacheDirName in $cacheDirs) {
                $cachePath = Join-Path $partitionDir.FullName $cacheDirName
                if (Test-Path -LiteralPath $cachePath) {
                    $cacheSize = Get-DirectorySize $cachePath
                    if ($cacheSize) {
                        $cacheSizeStr = Format-Size $cacheSize.Size
                        $cacheMsg = "      └─ $cacheDirName : $cacheSizeStr ($($cacheSize.Count) ファイル)"
                        Write-Host $cacheMsg -ForegroundColor Gray
                        Add-Content -Path $log -Value $cacheMsg
                    }
                }
            }
        }
    }
}

# 5. 一時ファイルディレクトリ
Write-Host "`n--- 一時ファイル ---" -ForegroundColor Yellow
$tempDir = Join-Path $userDataBase 'temp'
$results += Write-Result "temp (全体)" $tempDir (Get-DirectorySize $tempDir)

# 6. 設定ファイル
Write-Host "`n--- 設定ファイル ---" -ForegroundColor Yellow
$configPath = Join-Path $userDataBase 'config.json'
if (Test-Path -LiteralPath $configPath) {
    $configInfo = Get-Item -LiteralPath $configPath
    $sizeStr = Format-Size $configInfo.Length
    $msg = "config.json : $sizeStr - $configPath"
    Write-Host $msg
    Add-Content -Path $log -Value $msg
}

# 7. アップデーターキャッシュ（LOCALAPPDATA）
Write-Host "`n--- アップデーターキャッシュ ---" -ForegroundColor Yellow
$updaterCache = Join-Path $env:LOCALAPPDATA 'container-browser-updater'
$results += Write-Result "container-browser-updater" $updaterCache (Get-DirectorySize $updaterCache)

# 8. SquirrelTemp（Electronのアップデーター一時ファイル）
Write-Host "`n--- SquirrelTemp ---" -ForegroundColor Yellow
$squirrelTemp = Join-Path $env:LOCALAPPDATA 'SquirrelTemp'
if (Test-Path -LiteralPath $squirrelTemp) {
    # container-browser 関連のみ
    $squirrelItems = Get-ChildItem -LiteralPath $squirrelTemp -Recurse -Force -ErrorAction SilentlyContinue | 
        Where-Object { $_.FullName -like '*container-browser*' }
    if ($squirrelItems) {
        $squirrelTotal = ($squirrelItems | Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum).Sum
        $squirrelSizeStr = Format-Size $squirrelTotal
        $squirrelCount = ($squirrelItems | Where-Object { -not $_.PSIsContainer }).Count
        $msg = "SquirrelTemp (container-browser関連) : $squirrelSizeStr ($squirrelCount ファイル) - $squirrelTemp"
        Write-Host $msg
        Add-Content -Path $log -Value $msg
        $results += @{ Name = "SquirrelTemp (container-browser)"; Path = $squirrelTemp; Size = $squirrelTotal; Count = $squirrelCount }
    } else {
        $msg = "SquirrelTemp : container-browser関連のファイルなし - $squirrelTemp"
        Write-Host $msg
        Add-Content -Path $log -Value $msg
    }
} else {
    $msg = "SquirrelTemp : 存在しません - $squirrelTemp"
    Write-Host $msg
    Add-Content -Path $log -Value $msg
}

# 9. サマリー
Write-Host "`n=== サマリー ===" -ForegroundColor Cyan
$totalSize = ($results | Where-Object { $_.Size -ne $null } | Measure-Object -Property Size -Sum).Sum
$totalSizeStr = Format-Size $totalSize
$msg = "`n合計サイズ: $totalSizeStr`n"
Write-Host $msg -ForegroundColor Green
Add-Content -Path $log -Value $msg

# サイズの大きい順にソート
Write-Host "サイズの大きい順:"
$sorted = $results | Where-Object { $_.Size -ne $null } | Sort-Object -Property Size -Descending
foreach ($item in $sorted) {
    $sizeStr = Format-Size $item.Size
    $percent = if ($totalSize -gt 0) { ($item.Size / $totalSize * 100).ToString('F1') } else { "0.0" }
    $msg = "  $($item.Name) : $sizeStr ($percent%)"
    Write-Host $msg
    Add-Content -Path $log -Value $msg
}

Add-Content -Path $log -Value "`n終了時刻: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "`nログファイル: $log" -ForegroundColor Gray
Write-Host "Done." -ForegroundColor Green
