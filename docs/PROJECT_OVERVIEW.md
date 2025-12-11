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
Remote DOM automation for a container view. Supports navigating, typing, and evaluating arbitrary JS (!click / scroll commands were removed in favor of `eval` scripts).

### Request
```
POST /internal/exec
Body: {
  "contextId": "<containerId>",
  "command": "navigate" | "type" | "eval",
  "url": "<target url>",                   // when command === "navigate"
  "selector": "<css or xpath selector>",   // when command === "type"
  "text": "<text to inject>",              // when command === "type"
  "eval": "<js expression>",               // when command === "eval"
  "exprId": "<optional id for debugging>",
  "sourceSnippet": "<optional step text>",
  "options": {
    "timeoutMs": 10000,
    "waitForSelector": "article[data-testid=\"tweet\"]",
    "returnHtml": "trim" | "full" | true,
    "returnCookies": true,
    "screenshot": true
  }
}
```

### Features
- `navigate`: calls `wc.loadURL(url)` and optionally waits for a selector.  
- `type`: focuses the selector, sets `.value = text`, and dispatches `input`.  
- `eval`: takes a JSON-stringified expression (client should `JSON.stringify(expr)`), runs it directly via `wc.executeJavaScript(exprStr, true)`, and returns `result`.  
- All commands share options: `timeoutMs`, `waitForSelector`, HTML/cookie/screenshot collection.  
- HTML sanitization removes styles/scripts/comments, clears `data:` URLs, strips `class`/`style` attributes, and (in `trim` mode) returns `<body>` innerHTML up to 64KB while logging length.  
- Errors include `errorDetail` with `message`, `stack`, `line`, `column`, `snippet`, `context`, `exprId`, and `sourceSnippet`.
- HMAC protection via `REMOTE_EXEC_HMAC` and `x-remote-hmac` header when configured.

### Authorization / Idempotency
- Each `contextId` is locked per request (`locks` set), preventing simultaneous re-use.  
- On error, locks are cleared to avoid deadlocks.

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



