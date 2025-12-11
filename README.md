# Container Browser (Electron + TypeScript) — v2
- **Restore last session tabs**: opens each previous tab as its own window (simple baseline; you can later replace with BrowserViews for true tabs).
- **Per-origin auto-fill ON/OFF UI**: Site preferences (autoFill/autoSaveForms) can be set in the main UI; `autoFill` governs whether credentials are auto-filled in container windows.

## Dev
```bash
npm i   # or pnpm i
# Rebuild native deps for Electron
npx electron-rebuild -f -w better-sqlite3 -w keytar
npm run dev
```
On Windows you may need VS Build Tools + Python:
```bash
npm config set msvs_version 2022 --global
```

## Notes
- Credentials are stored via **keytar** (OS keychain). Database only stores a reference key.
- Site preferences default to **off** (no auto-fill) until you enable them per origin.

## データ移行

コンテナデータを別のPCに移行する機能を提供しています。

### クイックスタート

**ファイルベースの移行（推奨）:**
1. 元のPCで `%APPDATA%\container-browser` フォルダ全体をコピー
2. 新しいPCで同じ場所に貼り付け
3. 異なるユーザー名の場合は、パス更新を実行:
   ```bash
   node scripts/migrate_containers.cjs "C:\Users\olduser\AppData\Roaming\container-browser" "C:\Users\newuser\AppData\Roaming\container-browser"
   ```
4. アプリを起動し、認証情報をインポート（開発者ツールのコンソールで `migrationAPI` を使用）

### 認証情報の移行

**エクスポート（元のPC）:**
```javascript
// 開発者ツール（F12）のコンソールで実行
const result = await migrationAPI.exportCredentials();
if (result.ok) {
  // JSONファイルとして保存
  const dataStr = JSON.stringify(result.credentials, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'container-browser-credentials.json';
  a.click();
}
```

**インポート（新しいPC）:**
```javascript
// JSONファイルを読み込んでインポート
const credentials = /* JSONファイルから読み込み */;
await migrationAPI.importCredentials({ credentials });
```

### 利用可能なAPI

- `migrationAPI.exportCredentials()` - 認証情報をエクスポート
- `migrationAPI.importCredentials({ credentials })` - 認証情報をインポート
- `migrationAPI.updatePaths({ oldBasePath, newBasePath })` - コンテナパスを更新
- `migrationAPI.getUserDataPath()` - 現在のuserDataパスを取得

### 詳細ドキュメント

詳細な手順は [移行ガイド](docs/migration_guide.md) を参照してください。

## コンテナ管理API

コンテナの取得・設定を行うAPIを提供しています。開発者ツール（F12）のコンソールから `window.containersAPI` を使用してアクセスできます。

### 主なAPI

- `containersAPI.list()` - 全コンテナを取得
- `containersAPI.get({ id })` - IDでコンテナを取得
- `containersAPI.getByName({ name })` - 名前でコンテナを取得
- `containersAPI.update(payload)` - コンテナを更新（プロキシ、ステータス、メモなど）
- `containersAPI.setNote({ id, note })` - メモのみを設定

### 詳細ドキュメント

詳細なAPI仕様は [プロジェクト概要](docs/PROJECT_OVERVIEW.md#コンテナ管理api) を参照してください。
