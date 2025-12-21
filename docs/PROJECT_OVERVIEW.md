## POST /internal/export-restored/close

### Purpose
Close an opened container (BrowserWindow + BrowserView) and release resources. Idempotent: closing an already-closed container returns success with `closed=false`.

### Request
```
POST /internal/export-restored/close
Body: JSON { "id": "<container-uuid>", "timeoutMs": 30000 } (timeoutMs optional)
```

### Responses
- `200 { "ok": true, "closed": true, "message": "closed" }` — closed successfully  
- `200 { "ok": true, "closed": false, "message": "not-open" }` — already closed / not open  
- `400 { "ok": false, "error": "missing id" }` — bad request  
- `404 { "ok": false, "error": "container not found" }` — unknown id  
- `500 { "ok": false, "error": "internal" }` — internal failure

### Behavior
- Validates container exists via `DB.getContainer(id)`.  
- If open, calls `closeContainer(id)` and waits for `waitForContainerClosed(id, timeoutMs)`.  
- Clears any internal export/exec locks for the id prior to closing.  
- Logs `runId`, `closedBy` (if provided via `x-requested-by`) and timestamp for audit.  
- Runs only on local binding (`127.0.0.1`) — do not expose publicly.

### Example
```
curl -X POST http://127.0.0.1:3001/internal/export-restored/close \
  -H "Content-Type: application/json" \
  -d '{"id":"489efb6c-7a56-4fc3-97c6-83a93971094e"}'
```

## POST /internal/exec

### Purpose
Remote DOM automation for a container view. Supports navigating, typing, evaluating arbitrary JS, saving media files from the page, and native mouse/keyboard input simulation.

### Request
```
POST /internal/exec
Body: {
  "contextId": "<containerId>",
  "command": "navigate" | "type" | "eval" | "save_media" | "click" | "clickAndType",
  "url": "<target url>",                   // when command === "navigate"
  "selector": "<css or xpath selector>",   // when command === "type" | "click" | "clickAndType"
  "text": "<text to inject>",              // when command === "type"
  "eval": "<js expression>",               // when command === "eval"
  "exprId": "<optional id for debugging>",
  "sourceSnippet": "<optional step text>",
  "options": {
    "timeoutMs": 10000,
    "waitForSelector": "article[data-testid=\"tweet\"]",
    "returnHtml": "trim" | "full" | true,
    "returnCookies": true,
    "screenshot": true,
    // when command === "save_media"
    "destination_folder": "./storage/media/threads",
    "folder_name": "nanogarden77203_123456789",
    "selectors": [
      {
        "selector": "article img[src*='http']",
        "type": "image"
      },
      {
        "selector": "article video",
        "type": "video"
      }
    ]
  }
}
```

### Features
- `navigate`: calls `wc.loadURL(url)` and optionally waits for a selector.  
- `type`: focuses the selector, sets `.value = text`, and dispatches `input`.  
- `click`: executes DOM `click()` on a selector with focus. Triggers native click event via `element.focus()` and `element.click()`.  
- `clickAndType`: executes `click`, waits 50ms, then injects a random alphabet key (A-Z) via Electron `sendInputEvent()` (keyDown → char → keyUp). Provides system-level keyboard input simulation on the focused element.  
- `eval`: takes a JSON-stringified expression (client should `JSON.stringify(expr)`), runs it directly via `wc.executeJavaScript(exprStr, true)`, and returns `result`.  
- `save_media`: extracts image/video URLs from the page using CSS selectors, downloads them to a local directory, and returns download results. Supports `<img>`, `<video>`, and `<source>` tags. Maximum 100 files per request, 500MB per file limit.  
- All commands share options: `timeoutMs`, `waitForSelector`, HTML/cookie/screenshot collection.  
- HTML sanitization removes styles/scripts/comments, clears `data:` URLs, strips `class`/`style` attributes, and (in `trim` mode) returns `<body>` innerHTML up to 64KB while logging length.  
- Errors include `errorDetail` with `message`, `stack`, `line`, `column`, `snippet`, `context`, `exprId`, and `sourceSnippet`.
- HMAC protection via `REMOTE_EXEC_HMAC` and `x-remote-hmac` header when configured.

### Authorization / Idempotency
- Each `contextId` is locked per request (`locks` set), preventing simultaneous re-use.  
- On error, locks are cleared to avoid deadlocks.

### Example: type into an input
```
curl -s -X POST http://127.0.0.1:3001/internal/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "contextId":"335f2182-a060-4fc7-99e6-b873c8971d56",
    "command":"type",
    "selector":"input[name=\"q\"]",
    "text":"example search"
  }'
```

### Example: click on an element
```
curl -s -X POST http://127.0.0.1:3001/internal/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "contextId":"335f2182-a060-4fc7-99e6-b873c8971d56",
    "command":"click",
    "selector":"button.submit"
  }'
```

### Example: click and type random character
Focuses element via `click()`, then injects system-level keyboard input (random A-Z):
```
curl -s -X POST http://127.0.0.1:3001/internal/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "contextId":"335f2182-a060-4fc7-99e6-b873c8971d56",
    "command":"clickAndType",
    "selector":"input[type=\"text\"]"
  }'
```

**Response:**
```json
{
  "ok": true,
  "command": "clickAndType",
  "navigationOccurred": false,
  "url": "https://example.com",
  "title": "Example Page",
  "elapsedMs": 120
}
```

The `clickAndType` command:
1. Finds the element via CSS selector or XPath
2. Calls `element.focus()` and `element.click()` (DOM level)
3. Waits 50ms for focus to settle
4. Generates a random uppercase letter (A-Z)
5. Injects keyboard input via Electron `sendInputEvent()`:
   - `keyDown` with the character
   - `char` with lowercase variant (for proper input reception)
   - `keyUp` with the character
6. This simulates natural keyboard input at the system level, avoiding browser security restrictions

### Example: eval with HTML trim
```
curl -s -X POST http://127.0.0.1:3001/internal/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "contextId":"335f2182-a060-4fc7-99e6-b873c8971d56",
    "command":"eval",
    "eval":"document.title",
    "options":{"timeoutMs":15000,"returnHtml":"trim","waitForSelector":"article[data-testid=\"tweet\"]"}
  }'
```

### Example: save media files from page
```
curl -X POST http://127.0.0.1:3001/internal/exec \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "nanogarden77203",
    "command": "save_media",
    "options": {
      "destination_folder": "./storage/media/threads",
      "folder_name": "nanogarden77203_123456789",
      "selectors": [
        {"selector": "article img[src*=\"http\"]", "type": "image"},
        {"selector": "article video", "type": "video"},
        {"selector": "article video source[src*=\"http\"]", "type": "video"}
      ],
      "timeoutMs": 60000
    }
  }'
```

**Response (success):**
```json
{
  "ok": true,
  "folder_path": "./storage/media/threads/nanogarden77203_123456789",
  "files": [
    {
      "index": 0,
      "type": "image",
      "filename": "media_0.jpg",
      "local_path": "./storage/media/threads/nanogarden77203_123456789/media_0.jpg",
      "file_size": 245632,
      "media_type": "image/jpeg",
      "success": true
    }
  ],
  "summary": {
    "total": 1,
    "succeeded": 1,
    "failed": 0,
    "paths_comma_separated": "./storage/media/threads/nanogarden77203_123456789/media_0.jpg",
    "total_bytes": 245632
  }
}
```

**Response (partial failure):**
```json
{
  "ok": false,
  "folder_path": "./storage/media/threads/nanogarden77203_123456789",
  "files": [
    {
      "index": 0,
      "type": "image",
      "filename": "media_0.jpg",
      "local_path": "./storage/media/threads/nanogarden77203_123456789/media_0.jpg",
      "file_size": 245632,
      "media_type": "image/jpeg",
      "success": true
    },
    {
      "index": 1,
      "type": "video",
      "filename": "media_1.mp4",
      "local_path": null,
      "success": false,
      "error_message": "Connection timeout after 60000ms"
    }
  ],
  "summary": {
    "total": 2,
    "succeeded": 1,
    "failed": 1,
    "paths_comma_separated": "./storage/media/threads/nanogarden77203_123456789/media_0.jpg",
    "total_bytes": 245632
  }
}
```

**Notes:**
- Extracts URLs from `<img src>`, `<video poster>`, `<video src>`, and `<source src>` elements.
- Downloads files sequentially with timeout support (default 60s).
- Automatically determines file extensions from URLs or defaults to `.jpg` (image) / `.mp4` (video).
- Creates destination directory if it doesn't exist.
- Returns partial results even if some downloads fail.
- Maximum 100 files per request, 500MB per file.

## データ移行機能

### 概要

コンテナデータを別のPCに移行するためのIPC APIを提供しています。開発者ツール（F12）のコンソールから `migrationAPI` を使用してアクセスできます。

### API

#### `migrationAPI.exportCredentials()`

認証情報をエクスポートします。

**Response:**
```typescript
{ 
  ok: boolean;
  credentials?: Array<{
    containerId: string;
    origin: string;
    username: string;
    password: string;
  }>;
  error?: string;
}
```

#### `migrationAPI.importCredentials({ credentials })`

認証情報をインポートします。

**Request:**
```typescript
{
  credentials: Array<{
    containerId: string;
    origin: string;
    username: string;
    password: string;
  }>;
}
```

**Response:**
```typescript
{
  ok: boolean;
  successCount?: number;
  errorCount?: number;
  error?: string;
}
```

#### `migrationAPI.updatePaths({ oldBasePath, newBasePath })`

コンテナのuserDataDirパスを一括更新します。

**Request:**
```typescript
{
  oldBasePath: string;
  newBasePath: string;
}
```

**Response:**
```typescript
{
  ok: boolean;
  updatedCount?: number;
  error?: string;
}
```

#### `migrationAPI.getUserDataPath()`

現在のuserDataパスを取得します。

**Response:**
```typescript
{
  ok: boolean;
  path?: string;
  error?: string;
}
```

### 使用方法

詳細は [移行ガイド](migration_guide.md) を参照してください。

### コマンドライン移行スクリプト

```bash
# パスを確認
node scripts/migrate_containers.cjs --show-path

# 移行を実行
node scripts/migrate_containers.cjs <元のパス> <新しいパス>
```

## コンテナ管理API

### 概要

コンテナの取得・設定を行うIPC APIを提供しています。レンダラープロセス（メインUI）から `window.containersAPI` を使用してアクセスできます。

### 取得API

#### `containersAPI.list()`

全コンテナの一覧を取得します。

**Response:**
```typescript
Promise<Container[]>
```

**例:**
```javascript
const containers = await window.containersAPI.list();
console.log(containers); // Container[] の配列
```

#### `containersAPI.get({ id })`

IDでコンテナを個別取得します。

**Request:**
```typescript
{
  id: string; // コンテナID（UUID）
}
```

**Response:**
```typescript
Promise<Container>
```

**エラー:**
- コンテナが見つからない場合: `Error('container not found')`

**例:**
```javascript
const container = await window.containersAPI.get({ 
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e' 
});
console.log(container.name); // コンテナ名
console.log(container.proxy); // プロキシ設定
console.log(container.status); // ステータス
console.log(container.note); // メモ
```

#### `containersAPI.getByName({ name })`

名前でコンテナを個別取得します。

**Request:**
```typescript
{
  name: string; // コンテナ名
}
```

**Response:**
```typescript
Promise<Container>
```

**エラー:**
- コンテナが見つからない場合: `Error('container not found')`

**例:**
```javascript
const container = await window.containersAPI.getByName({ 
  name: 'テストコンテナ' 
});
```

### 設定API

#### `containersAPI.update(payload)`

コンテナの任意のフィールドを更新します。プロキシ、ステータス、メモ、名前、指紋設定など、すべてのフィールドを更新可能です。

**Request:**
```typescript
{
  id: string; // 必須: コンテナID
  name?: string; // コンテナ名
  status?: ContainerStatus; // '未使用' | '稼働中' | '停止'
  note?: string | null; // メモ（nullで削除）
  proxy?: ProxyConfig | null; // プロキシ設定（nullで削除）
  fingerprint?: Fingerprint; // 指紋設定
  // ... その他Container型の全フィールド
}
```

**Response:**
```typescript
Promise<Container> // 更新後のコンテナ
```

**エラー:**
- コンテナが見つからない場合: `Error('container not found')`

**例: プロキシを設定**
```javascript
const updated = await window.containersAPI.update({
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e',
  proxy: {
    server: 'http://proxy.example.com:8080',
    username: 'user',
    password: 'pass'
  }
});
```

**例: ステータスを更新**
```javascript
const updated = await window.containersAPI.update({
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e',
  status: '稼働中'
});
```

**例: メモを設定**
```javascript
const updated = await window.containersAPI.update({
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e',
  note: 'これはテスト用のコンテナです'
});
```

**例: 複数フィールドを同時に更新**
```javascript
const updated = await window.containersAPI.update({
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e',
  status: '稼働中',
  note: '更新しました',
  proxy: {
    server: 'socks5://proxy.example.com:1080'
  }
});
```

**例: プロキシを削除**
```javascript
const updated = await window.containersAPI.update({
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e',
  proxy: null
});
```

#### `containersAPI.setNote({ id, note })`

メモのみを設定します（専用API）。

**Request:**
```typescript
{
  id: string; // コンテナID
  note: string | null; // メモ（nullで削除）
}
```

**Response:**
```typescript
Promise<{ ok: boolean; error?: string }>
```

**エラー:**
- コンテナが見つからない場合: `{ ok: false, error: 'container not found' }`

**例:**
```javascript
const result = await window.containersAPI.setNote({
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e',
  note: 'メモを設定しました'
});

if (result.ok) {
  console.log('メモを設定しました');
}
```

### データ型

#### `Container`

```typescript
type Container = {
  id: string;
  name: string;
  note?: string;            // メモ
  status?: ContainerStatus;  // ステータス: '未使用' | '稼働中' | '停止'
  userDataDir: string;      // プロファイル保存先
  partition: string;        // 'persist:container-<id>'
  userAgent?: string;
  locale?: string;
  timezone?: string;
  fingerprint?: Fingerprint; // 指紋設定
  proxy?: ProxyConfig | null; // プロキシ設定
  createdAt: number;        // 作成日時（Unixタイムスタンプ）
  updatedAt: number;        // 更新日時（Unixタイムスタンプ）
  lastSessionId?: string | null;
};
```

#### `ProxyConfig`

```typescript
type ProxyConfig = {
  server: string;           // プロキシサーバー（例: 'http://proxy.example.com:8080' または 'socks5://proxy.example.com:1080'）
  username?: string;         // 認証ユーザー名（オプション）
  password?: string;         // 認証パスワード（オプション）
};
```

#### `ContainerStatus`

```typescript
type ContainerStatus = '停止' | '稼働中' | '未使用';
```

### 使用例

#### コンテナのプロキシを確認・設定

```javascript
// 取得
const container = await window.containersAPI.get({ 
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e' 
});

console.log('現在のプロキシ:', container.proxy);

// 設定
const updated = await window.containersAPI.update({
  id: container.id,
  proxy: {
    server: 'http://new-proxy.example.com:8080',
    username: 'user',
    password: 'pass'
  }
});

console.log('更新後のプロキシ:', updated.proxy);
```

#### コンテナのステータスを確認・更新

```javascript
// 取得
const container = await window.containersAPI.get({ 
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e' 
});

console.log('現在のステータス:', container.status);

// 更新
const updated = await window.containersAPI.update({
  id: container.id,
  status: '稼働中'
});

console.log('更新後のステータス:', updated.status);
```

#### コンテナのメモを確認・設定

```javascript
// 取得
const container = await window.containersAPI.get({ 
  id: '489efb6c-7a56-4fc3-97c6-83a93971094e' 
});

console.log('現在のメモ:', container.note);

// 設定（update APIを使用）
const updated = await window.containersAPI.update({
  id: container.id,
  note: '新しいメモ'
});

// または専用APIを使用
await window.containersAPI.setNote({
  id: container.id,
  note: '新しいメモ'
});
```

#### 名前でコンテナを検索して更新

```javascript
// 名前で取得
const container = await window.containersAPI.getByName({ 
  name: 'テストコンテナ' 
});

// プロキシ、ステータス、メモを一括更新
const updated = await window.containersAPI.update({
  id: container.id,
  status: '稼働中',
  note: '更新済み',
  proxy: {
    server: 'socks5://proxy.example.com:1080'
  }
});
```

## デプロイ手順

### 概要

Container Browser のインストーラーを S3/CDN にアップロードして、URL からダウンロード可能にする手順です。

### 前提条件

- AWS CLI がインストール・設定済み
- S3 バケット `container-browser-updates` へのアクセス権限
- CloudFront Distribution ID `E1Q66ASB5AODYF` への無効化権限
- ビルド済みのインストーラー（`dist/nsis-web/` ディレクトリ）

### 自動デプロイ（GitHub Actions）

**推奨方法**: main ブランチへの push で自動的にデプロイが実行されます。

1. コードをコミット・プッシュ
2. GitHub Actions が自動的にビルド・デプロイを実行
3. デプロイ完了後、以下の URL からダウンロード可能:
   - `https://updates.threadsbooster.jp/nsis-web/ContainerBrowser-Web-Setup.exe` (固定URL)
   - `https://updates.threadsbooster.jp/nsis-web/Container-Browser-Web-Setup-{version}.exe` (バージョン付き)

### 手動デプロイ

ローカルから直接デプロイする場合：

```powershell
# 既にビルド済みの dist/nsis-web を使用してデプロイ
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update-release.ps1 `
  -Bucket container-browser-updates `
  -DistributionId E1Q66ASB5AODYF `
  -Cdn https://updates.threadsbooster.jp `
  -SourceDir "dist/nsis-web" `
  -SkipBuild
```

### ファイル配置の仕様

デプロイスクリプトは以下のようにファイルを配置します：

| ファイル | S3 パス | CDN URL |
|---------|---------|---------|
| **インストーラー (.exe)** | `s3://container-browser-updates/nsis-web/Container-Browser-Web-Setup-{version}.exe` | `https://updates.threadsbooster.jp/nsis-web/Container-Browser-Web-Setup-{version}.exe` |
| **固定名インストーラー** | `s3://container-browser-updates/nsis-web/ContainerBrowser-Web-Setup.exe` | `https://updates.threadsbooster.jp/nsis-web/ContainerBrowser-Web-Setup.exe` |
| **パッケージ (.nsis.7z)** | `s3://container-browser-updates/nsis-web/container-browser-{version}-x64.nsis.7z` | `https://updates.threadsbooster.jp/nsis-web/container-browser-{version}-x64.nsis.7z` |
| **マニフェスト** | `s3://container-browser-updates/latest.yml` | `https://updates.threadsbooster.jp/latest.yml` |

**重要**: `.exe` と `.nsis.7z` は同じ `nsis-web/` ディレクトリに配置されます。これは、インストーラーが自分と同じディレクトリからパッケージファイルを探すためです。

### トラブルシューティング

#### インストーラー実行時に「Access Denied (403)」エラー

**症状:**
```
Unable to download application package from 
https://updates.threadsbooster.jp/nsis-web/container-browser-0.5.3-x64.nsis.7z 
(status: Access Forbidden (403))
```

**原因:**
- `.nsis.7z` ファイルが `nsis-web/` ディレクトリに配置されていない
- CloudFront のキャッシュが古い

**解決方法:**

1. **S3 の配置を確認:**
   ```powershell
   aws s3 ls s3://container-browser-updates/nsis-web/ | Select-String -Pattern "0.5.3"
   ```

2. **ファイルが存在しない場合、手動でコピー:**
   ```powershell
   aws s3 cp s3://container-browser-updates/container-browser-0.5.3-x64.nsis.7z s3://container-browser-updates/nsis-web/container-browser-0.5.3-x64.nsis.7z --content-type 'application/octet-stream' --cache-control 'public,max-age=300'
   ```

3. **CloudFront キャッシュを無効化:**
   ```powershell
   aws cloudfront create-invalidation --distribution-id E1Q66ASB5AODYF --paths "/nsis-web/container-browser-0.5.3-x64.nsis.7z" "/latest.yml"
   ```

4. **アクセス確認:**
   ```powershell
   curl -I https://updates.threadsbooster.jp/nsis-web/container-browser-0.5.3-x64.nsis.7z
   ```
   - HTTP 200 OK が返ってくることを確認

**根本的な解決:**
- デプロイスクリプト（`update-release.ps1`）は既に修正済みのため、通常のデプロイ手順に従えば問題は発生しません
- 詳細は `docs/ci/CI_TROUBLESHOOTING.md` を参照してください

### 検証手順

デプロイ完了後、以下を確認してください：

1. **マニフェストの確認:**
   ```powershell
   curl -s https://updates.threadsbooster.jp/latest.yml
   ```
   - バージョンが正しいか
   - URL が CDN を指しているか（S3 直リンクではないか）

2. **インストーラーのダウンロード確認:**
   ```powershell
   curl -I https://updates.threadsbooster.jp/nsis-web/Container-Browser-Web-Setup-0.5.3.exe
   ```
   - HTTP 200 OK が返ってくることを確認

3. **パッケージファイルのダウンロード確認:**
   ```powershell
   curl -I https://updates.threadsbooster.jp/nsis-web/container-browser-0.5.3-x64.nsis.7z
   ```
   - HTTP 200 OK が返ってくることを確認

### 関連ドキュメント

- 詳細なトラブルシューティング: `docs/ci/CI_TROUBLESHOOTING.md`
- リリースチェックリスト: `docs/release_checklist.md`



