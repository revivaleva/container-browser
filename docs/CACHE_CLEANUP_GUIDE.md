# キャッシュ・データクリーンアップガイド

PCの空き領域が少ない場合、container-browser のキャッシュやデータが原因の可能性があります。以下の手順で確認・クリーンアップを行ってください。

## 1. データ保存場所の確認

container-browser は以下の場所にデータを保存しています：

### メインデータディレクトリ
- **場所**: `%APPDATA%\container-browser` (通常は `C:\Users\<ユーザー名>\AppData\Roaming\container-browser`)
- **内容**:
  - `profiles/` - 各コンテナのプロファイル（キャッシュ含む）
  - `Partitions/` - セッションキャッシュ（Cache, Code Cache, GPUCache など）
  - `temp/` - 一時ファイル
  - `data.db` - データベース（通常は小さい）

### アップデーターキャッシュ
- **場所**: `%LOCALAPPDATA%\container-browser-updater` (通常は `C:\Users\<ユーザー名>\AppData\Local\container-browser-updater`)
- **内容**: アプリケーション更新ファイルのキャッシュ

### 一時ファイル（Squirrel）
- **場所**: `%LOCALAPPDATA%\SquirrelTemp` (通常は `C:\Users\<ユーザー名>\AppData\Local\SquirrelTemp`)
- **内容**: アップデーターの一時ファイル（container-browser 関連のみ）

## 2. 手動でサイズを確認する方法

### 方法A: エクスプローラーで確認

1. `Win + R` を押して「ファイル名を指定して実行」を開く
2. 以下のパスを入力して Enter:
   ```
   %APPDATA%\container-browser
   ```
3. 各フォルダーを右クリック → 「プロパティ」でサイズを確認
4. 特に大きい可能性のあるフォルダー:
   - `profiles` フォルダー内の各コンテナフォルダー
   - `Partitions` フォルダー内の各パーティションフォルダー
   - 各フォルダー内の `Cache`, `Code Cache`, `GPUCache`, `Media Cache`, `ShaderCache` など

### 方法B: PowerShell で確認（簡易版）

以下のコマンドを PowerShell で実行すると、主要ディレクトリのサイズを確認できます：

```powershell
$appData = $env:APPDATA
$base = Join-Path $appData 'container-browser'

# メインディレクトリの確認
if (Test-Path $base) {
    Write-Host "=== Main Data Directories ==="
    $dirs = @('profiles', 'Partitions', 'temp')
    foreach ($d in $dirs) {
        $p = Join-Path $base $d
        if (Test-Path $p) {
            Write-Host "Checking: $d ..." -NoNewline
            $size = (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | 
                     Measure-Object -Property Length -Sum).Sum
            $sizeMB = [math]::Round($size / 1MB, 2)
            Write-Host " $sizeMB MB"
        }
    }
}

# アップデーターキャッシュの確認
$updater = Join-Path $env:LOCALAPPDATA 'container-browser-updater'
if (Test-Path $updater) {
    Write-Host "`n=== Updater Cache ==="
    Write-Host "Checking: container-browser-updater ..." -NoNewline
    $size = (Get-ChildItem $updater -Recurse -File -ErrorAction SilentlyContinue | 
             Measure-Object -Property Length -Sum).Sum
    $sizeMB = [math]::Round($size / 1MB, 2)
    Write-Host " $sizeMB MB"
}
```

**注意**: ファイル数が多い場合は、このコマンドの実行に数分かかる場合があります。

## 3. クリーンアップ方法

### アプリケーション内の機能を使用（推奨）

1. **コンテナキャッシュのクリア**:
   - アプリケーションを開く
   - 各コンテナの「キャッシュクリア」ボタンをクリック
   - これにより HTTP キャッシュのみがクリアされます（Cookie やセッションデータは保持）

2. **コンテナデータの完全削除**（注意: データが失われます）:
   - 不要なコンテナを削除する
   - これによりプロファイルとパーティションのデータが削除されます

### 手動でクリーンアップする方法

#### 3.1 アップデーターキャッシュの削除（安全）

アプリケーションを閉じてから以下を実行：

```powershell
# アップデーターキャッシュをバックアップしてから削除
$updater = Join-Path $env:LOCALAPPDATA 'container-browser-updater'
if (Test-Path $updater) {
    $backup = $updater + '.' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.bak'
    Move-Item -LiteralPath $updater -Destination $backup
    Write-Host "Moved to: $backup"
}
```

#### 3.2 SquirrelTemp の削除（安全）

```powershell
# container-browser 関連のみを削除
$squirrelTemp = Join-Path $env:LOCALAPPDATA 'SquirrelTemp'
if (Test-Path $squirrelTemp) {
    $items = Get-ChildItem -LiteralPath $squirrelTemp -Recurse -Force -ErrorAction SilentlyContinue | 
             Where-Object { $_.FullName -like '*container-browser*' }
    if ($items) {
        $items | Remove-Item -Recurse -Force
        Write-Host "Removed container-browser files from SquirrelTemp"
    }
}
```

#### 3.3 プロファイル/パーティションのキャッシュを削除（注意が必要）

**重要な注意**: 以下の操作を行う前に、アプリケーションを完全に閉じてください。

```powershell
$appData = $env:APPDATA
$base = Join-Path $appData 'container-browser'

# 各プロファイルのキャッシュを削除
$profilesDir = Join-Path $base 'profiles'
if (Test-Path $profilesDir) {
    $cacheDirs = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache')
    Get-ChildItem $profilesDir -Directory | ForEach-Object {
        $profile = $_.FullName
        foreach ($cacheDir in $cacheDirs) {
            $cachePath = Join-Path $profile $cacheDir
            if (Test-Path $cachePath) {
                Remove-Item $cachePath -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "Removed: $cachePath"
            }
        }
    }
}

# 各パーティションのキャッシュを削除
$partitionsDir = Join-Path $base 'Partitions'
if (Test-Path $partitionsDir) {
    $cacheDirs = @('Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache')
    Get-ChildItem $partitionsDir -Directory | ForEach-Object {
        $partition = $_.FullName
        foreach ($cacheDir in $cacheDirs) {
            $cachePath = Join-Path $partition $cacheDir
            if (Test-Path $cachePath) {
                Remove-Item $cachePath -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "Removed: $cachePath"
            }
        }
    }
}
```

#### 3.4 一時ファイルの削除（安全）

```powershell
$appData = $env:APPDATA
$tempDir = Join-Path (Join-Path $appData 'container-browser') 'temp'
if (Test-Path $tempDir) {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed temp directory"
}
```

## 4. 自動クリーンアップスクリプト

`scripts/check_data_size.ps1` を実行すると、詳細な調査レポートが生成されます。

**注意**: ファイル数が多い場合、スクリプトの実行に時間がかかる場合があります。

## 5. 予防策

1. **定期的なキャッシュクリア**: アプリケーション内の機能を使用して定期的にキャッシュをクリアする
2. **不要なコンテナの削除**: 使用していないコンテナは削除する
3. **エクスポート機能の使用**: 重要なデータはエクスポート機能でバックアップを取る

## 6. トラブルシューティング

### アプリケーションが起動しない

1. すべての container-browser プロセスを終了する
2. 一時ファイルを削除する（上記 3.4）
3. アプリケーションを再起動する

### データが失われた

1. エクスポートファイルがあれば、インポート機能で復元する
2. `profiles` や `Partitions` フォルダーのバックアップがあれば、それを使用する

## 7. お問い合わせ

問題が解決しない場合は、ログファイル（`logs/check_data_size.log`）とともに報告してください。
