# エクスポート処理の最適化

## 問題

エクスポートデータが50GB以上になり、数時間かかっていた問題を解決しました。

## 原因

Chromium/Electronのプロファイルディレクトリには、以下のような巨大なキャッシュファイルが含まれていました：

1. **Cache** - ブラウザキャッシュ（数GBになることがある）
2. **Code Cache** - JavaScriptコードキャッシュ
3. **GPUCache** - GPUキャッシュ
4. **Service Worker** - Service Workerキャッシュ
5. **Media Cache** - メディアキャッシュ
6. **ShaderCache** - シェーダーキャッシュ
7. **VideoDecodeStats** - 動画デコード統計
8. **History** - ブラウザ履歴（巨大になることがある）

これらは**ログイン状態を維持するために不要**です。

## 解決策

エクスポート処理に**除外フィルタ**を追加しました。

### 除外されるディレクトリ/ファイル

- `Cache/` - ブラウザキャッシュ
- `Code Cache/` - JavaScriptコードキャッシュ
- `GPUCache/` - GPUキャッシュ
- `Service Worker/` - Service Workerキャッシュ
- `ServiceWorker/` - Service Workerキャッシュ（別形式）
- `Media Cache/` - メディアキャッシュ
- `ShaderCache/` - シェーダーキャッシュ
- `VideoDecodeStats/` - 動画デコード統計
- `History*` - ブラウザ履歴
- `Top Sites*` - トップサイト
- `Favicons*` - ファビコン
- `SingletonLock`, `LOCK`, `lockfile` - ロックファイル
- `*.tmp`, `*.temp`, `*.log` - 一時ファイル・ログファイル
- `Current Session`, `Current Tabs`, `Last Session`, `Last Tabs` - セッションファイル
- `Preferences.bak`, `Secure Preferences.bak` - バックアップファイル

### 含まれる重要なデータ

以下のデータは**含まれます**（ログイン状態維持に必要）：

- `Cookies` - Cookieデータ（最重要）
- `Local Storage/` - LocalStorageデータ
- `IndexedDB/` - IndexedDBデータ
- `Session Storage/` - SessionStorageデータ
- `Preferences` - 設定ファイル
- `Secure Preferences` - セキュア設定ファイル
- その他の重要な設定ファイル

## 実装内容

### ファイル1: `src/main/profileExporter.ts`

**追加:**
- `EXCLUDE_PATTERNS` - 除外パターンの定義
- `shouldExclude()` - ファイル/ディレクトリが除外対象かどうかを判定
- `addDirectoryFiltered()` - ディレクトリを再帰的に追加（フィルタリング適用）

**変更:**
- `zipProfiles()` 関数で `archive.directory()` の代わりに `addDirectoryFiltered()` を使用

### ファイル2: `src/main/ipc.ts`

**追加:**
- `migration.exportComplete` ハンドラーにも同じ除外フィルタを適用
- `addDirectoryFiltered()` 関数を追加

## 期待される効果

### エクスポートサイズの削減

- **Before**: 50GB以上（キャッシュを含む）
- **After**: 数百MB〜数GB程度（キャッシュを除外）

### エクスポート時間の短縮

- **Before**: 数時間
- **After**: 数分〜数十分（データサイズに応じて）

### ログイン状態の維持

- ✅ Cookie、LocalStorage、IndexedDBは含まれるため、ログイン状態は維持される
- ✅ キャッシュは除外されるが、次回アクセス時に再生成される

## 検証方法

### エクスポートサイズの確認

```javascript
// エクスポート実行
const exportResult = await window.migrationAPI.exportComplete({ includeProfiles: true });
console.log('Export file size:', (exportResult.fileSize / 1024 / 1024).toFixed(2), 'MB');
```

### エクスポート内容の確認

PowerShellで確認:

```powershell
# ZIPを展開
$zipPath = "C:\path\to\export.zip"
$extractPath = "C:\temp\export-check"
Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

# キャッシュディレクトリが除外されているか確認
Test-Path "$extractPath\Partitions\container-*\Cache"
# 期待: False

# Cookiesファイルが含まれているか確認
Test-Path "$extractPath\Partitions\container-*\Cookies"
# 期待: True
```

## 注意事項

1. **キャッシュの再生成**
   - エクスポート時にキャッシュを除外するため、インポート後はキャッシュが空の状態になります
   - 次回アクセス時に自動的に再生成されます
   - ログイン状態には影響しません

2. **履歴の復元**
   - ブラウザ履歴は除外されます
   - 履歴を復元したい場合は、除外パターンから `History*` を削除してください

3. **カスタム除外パターン**
   - 必要に応じて、`EXCLUDE_PATTERNS` をカスタマイズできます

## トラブルシューティング

### 問題1: エクスポートサイズがまだ大きい

**確認事項:**
- IndexedDBに巨大なデータが保存されている可能性
- 特定のサイトが大量のデータを保存している可能性

**対処:**
- エクスポートログを確認して、どのディレクトリが大きいか確認
- 必要に応じて、特定のIndexedDBデータベースを除外

### 問題2: ログイン状態が維持されない

**確認事項:**
- Cookiesファイルが含まれているか
- LocalStorage/IndexedDBが含まれているか

**対処:**
- エクスポートZIPの内容を確認
- 除外パターンが正しく適用されているか確認

## 今後の改善案

1. **選択的エクスポート**
   - ユーザーがエクスポート対象を選択できる機能

2. **圧縮レベルの調整**
   - 現在は `zlib: { level: 6 }` ですが、必要に応じて調整可能

3. **進捗表示**
   - エクスポート処理の進捗を表示する機能

4. **サイズ見積もり**
   - エクスポート前にサイズを見積もる機能

