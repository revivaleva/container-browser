# Container Browser (Kameleo Edition)

本リポジトリには2つの主要な系統があります：
- **`main`**: 従来の Chrome / Electron 直接操作（BrowserView 使用）の系統です。
- **`kameleo-main`**: 現在の Kameleo Local API + Playwright 統合版の本流です。今後 Kameleo 版の修正はこちらに行われます。
- **`feature/kameleo-backend`**: 初期実装時の履歴保持用ブランチです。

Kameleo 版のアーキテクチャや API 仕様については [Kameleo 仕様書 (docs/KAMELEO_SPEC.md)](docs/KAMELEO_SPEC.md) を参照してください。

## 主な特徴 (Kameleo 版)
- **Kameleo 統合**: Kameleo の指紋偽装プロファイルを利用した高度なブラウザ操作。
- **Playwright 連携**: CDP (Chrome DevTools Protocol) 経由で Kameleo プロファイルを自動操作。
- **プロファイル管理モード**: `managed`（アプリが生成・破棄）と `attached`（既存プロファイルの紐付け）の使い分け。
- **Single-tab 制約**: 1コンテナ = 1ウィンドウ = 1ページ（タブ）のシンプルな運用モデル。

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

## Kameleo 統合 (Internal API)

本アプリは Kameleo Local API と連携し、ブラウザの指紋偽装と Playwright による自動操作を提供します。

### プロファイル管理モード (`profileMode`)
- **`managed` (デフォルト)**: コンテナ作成時に Kameleo プロファイルを自動生成します。ウィンドウを閉じると自動的に停止します。
- **`attached`**: 既存の Kameleo プロファイル ID をコンテナに紐付けます。他プロセスで起動中のプロファイルを共用する場合、本アプリ終了時にプロファイルを停止しません。

### 内部 API エンドポイント (Port 3001)

- `GET /internal/kameleo/status`: Kameleo との接続状態を確認。
- `GET /internal/kameleo/profiles`: 利用可能な Kameleo プロファイル一覧を取得。
- `POST /internal/containers/create`:
  - `name`: コンテナ名
  - `environment`: `{ deviceType, os, browser }` を指定して特定の指紋でプロファイルを生成。
- `POST /internal/containers/{id}/attach`:
  - `profileId`: 紐付ける Kameleo プロファイル ID。バリデーション（存在確認）が行われます。
- `POST /internal/containers/{id}/detach`: 紐付けを解除し、`managed` モードに戻します。

### 注意事項
- **動作環境**: ローカルの Port 5050 で Kameleo が動作している必要があります。
- **Single-tab 制約**: 現在のバージョンは 1 コンテナにつき 1 タブ (Single Window/Single Page) の操作を前提としています。`switchTab` などのマルチタブ操作 API は現在対応していません。
- **プロキシ更新**: `managed` プロファイルは起動時に DB 設定に基づいて自動更新されますが、`attached` プロファイルは意図しない設定変更を防ぐため自動更新を行いません。

## 詳細ドキュメント

詳細な手順は [移行ガイド](docs/migration_guide.md) を参照してください。
