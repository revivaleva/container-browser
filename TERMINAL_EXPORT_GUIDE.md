# Terminalからのエクスポート手順

## 概要

Terminal（コマンドライン）からエクスポートを実行できるスクリプトを作成しました。

**特徴:**
- キャッシュファイルを除外してサイズを削減
- ログイン状態維持に必要なデータ（Cookies、LocalStorage、IndexedDB）は含まれる
- アプリを起動する必要がない

## 前提条件

### 必要なパッケージ

```bash
npm install archiver better-sqlite3
```

**注意:** `better-sqlite3` がElectron用にビルドされている場合、通常のNode.jsでは動作しません。その場合は、アプリ内のエクスポート機能を使用してください。

## 使用方法

### 基本的な使用方法

```powershell
# プロジェクトルートディレクトリで実行
cd C:\Users\revival\projects\container-browser

# エクスポート実行
node scripts/export_optimized.cjs export.zip
```

### 出力パスを指定

```powershell
# 絶対パスで指定
node scripts/export_optimized.cjs C:\backup\container-export.zip

# 日付を含むファイル名（PowerShell）
$date = Get-Date -Format 'yyyyMMdd'
node scripts/export_optimized.cjs "C:\backup\container-export-$date.zip"
```

### ヘルプの表示

```powershell
node scripts/export_optimized.cjs --help
```

## 実行例

### PowerShellでの実行

```powershell
# プロジェクトルートに移動
cd C:\Users\revival\projects\container-browser

# エクスポート実行
node scripts/export_optimized.cjs export.zip

# 実行結果の例:
# ============================================================
# 最適化されたエクスポートを開始します
# ============================================================
# 出力ファイル: C:\Users\revival\projects\container-browser\export.zip
# 
# データベースデータをエクスポート中...
# ✓ DBデータをエクスポートしました
#   - コンテナ: 5件
#   - セッション: 10件
#   - タブ: 25件
#   - ブックマーク: 3件
#   - サイト設定: 2件
#   - 認証情報: 1件（パスワードは別途移行が必要）
# 
# プロファイルとPartitionsをエクスポート中...
# （キャッシュファイルは除外されます）
# 
#   ✓ プロファイル追加: container-id-1
#   ✓ Partition追加: container-container-id-1
#   ✓ プロファイル追加: container-id-2
#   ✓ Partition追加: container-container-id-2
# 
# ============================================================
# ✓ エクスポート完了！
# ============================================================
# ファイル: C:\Users\revival\projects\container-browser\export.zip
# サイズ: 245.67 MB
# プロファイル: 5件
# Partitions: 5件
```

## エクスポートされるデータ

### データベースデータ（`data.json`）

- コンテナ情報
- セッション情報
- タブ情報
- ブックマーク
- サイト設定
- 認証情報（パスワードは含まれない - Windows Credential Managerに保存）

### プロファイルデータ

#### `profiles/${containerId}/`
- プロファイル設定ファイル（キャッシュは除外）

#### `Partitions/container-${containerId}/`
- **Cookies** - Cookieデータ（ログイン状態維持に必要）
- **Local Storage/** - LocalStorageデータ
- **IndexedDB/** - IndexedDBデータ
- **Session Storage/** - SessionStorageデータ
- **Preferences** - 設定ファイル
- **Secure Preferences** - セキュア設定ファイル

### 除外されるデータ

以下のデータは**除外されます**（ログイン状態維持に不要）：

- `Cache/` - ブラウザキャッシュ
- `Code Cache/` - JavaScriptコードキャッシュ
- `GPUCache/` - GPUキャッシュ
- `Service Worker/` - Service Workerキャッシュ
- `Media Cache/` - メディアキャッシュ
- `ShaderCache/` - シェーダーキャッシュ
- `VideoDecodeStats/` - 動画デコード統計
- `History*` - ブラウザ履歴
- ロックファイル、一時ファイル、ログファイル

## トラブルシューティング

### 問題1: `better-sqlite3` のエラー

**エラーメッセージ:**
```
better-sqlite3がElectron用にビルドされている可能性があります。
```

**原因:**
- `better-sqlite3` がElectron用にビルドされているため、通常のNode.jsでは動作しない

**対処:**
1. **アプリ内のエクスポート機能を使用**（推奨）
   - アプリを起動して、開発者ツール（F12）のコンソールで実行
   - `await window.migrationAPI.exportComplete({ includeProfiles: true })`

2. **better-sqlite3を再ビルド**（上級者向け）
   ```bash
   npm rebuild better-sqlite3
   ```

### 問題2: `archiver` が見つからない

**エラーメッセージ:**
```
エラー: archiverパッケージが必要です。
```

**対処:**
```bash
npm install archiver
```

### 問題3: データベースファイルが見つからない

**エラーメッセージ:**
```
エラー: データベースファイルが見つかりません
```

**確認:**
```powershell
# デフォルトのuserDataパスを確認
$appdata = $env:APPDATA
$dbPath = "$appdata\container-browser\data.db"
Test-Path $dbPath
```

**対処:**
- アプリを一度起動して、データベースファイルが作成されているか確認
- カスタムのuserDataパスを使用している場合は、スクリプトを修正

### 問題4: エクスポートサイズが大きい

**確認事項:**
- IndexedDBに巨大なデータが保存されている可能性
- 特定のサイトが大量のデータを保存している可能性

**対処:**
- エクスポートログを確認して、どのコンテナが大きいか確認
- 必要に応じて、特定のコンテナのみをエクスポートする機能を追加（将来の改善）

## アプリ内エクスポートとの違い

| 項目 | Terminalスクリプト | アプリ内エクスポート |
|------|-------------------|-------------------|
| 実行方法 | `node scripts/export_optimized.cjs` | 開発者ツール（F12）のコンソール |
| アプリ起動 | 不要 | 必要 |
| ファイル選択ダイアログ | なし（コマンドライン引数で指定） | あり |
| 認証情報（パスワード） | 含まれない | 含まれる（keytar経由） |
| 進捗表示 | コンソール出力 | なし（将来追加予定） |

## インポート手順

エクスポートしたZIPファイルをインポートする手順:

### アプリ内からインポート

```javascript
// 開発者ツール（F12）のコンソールで実行
const importResult = await window.migrationAPI.importComplete();
console.log('Import result:', importResult);
```

詳細は `CONTAINER_RESTORE_GUIDE.md` を参照してください。

## 関連ドキュメント

- `EXPORT_GUIDE.md` - アプリ内エクスポート手順
- `EXPORT_OPTIMIZATION.md` - エクスポート最適化の詳細
- `CONTAINER_RESTORE_GUIDE.md` - コンテナ復元ガイド

