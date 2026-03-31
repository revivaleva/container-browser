# Internal API 仕様書

Container Browser (Kameleo Edition) が Port **3001** で提供する内部 REST API の仕様。

外部プロセス（自動化スクリプト等）からコンテナの操作・管理を行うために使用する。

---

## 共通仕様

- **Base URL**: `http://127.0.0.1:3001`
- **Content-Type**: `application/json`（POST の場合）
- **同時実行制御**: コンテナ単位でロックあり。同一コンテナへの重複リクエストは `409 Conflict` を返す

### 共通レスポンス形式

```json
{ "ok": true,  ... }   // 成功
{ "ok": false, "error": "メッセージ" }  // 失敗
```

---

## エンドポイント一覧

| Method | Path | 概要 |
|--------|------|------|
| GET | `/health` | 死活確認 |
| GET | `/internal/containers` | コンテナ一覧 |
| GET | `/internal/containers/active` | 現在開いているコンテナ ID 一覧 |
| POST | `/internal/containers/create` | コンテナ作成 |
| POST | `/internal/containers/update` | コンテナ情報更新 |
| POST | `/internal/containers/delete` | コンテナ削除 |
| POST | `/internal/containers/set-proxy` | プロキシ変更 |
| POST | `/internal/containers/{id}/attach` | Kameleo プロファイル紐付け |
| POST | `/internal/containers/{id}/detach` | Kameleo プロファイル紐付け解除 |
| POST | `/internal/export-restored` | コンテナを開いて認証注入 |
| POST | `/internal/export-restored/close` | コンテナを閉じる |
| DELETE/POST | `/internal/export-restored/delete` | コンテナを閉じて削除 |
| POST | `/internal/cookies/set_native` | Electron セッションへネイティブ Cookie 注入 |
| GET | `/internal/kameleo/status` | Kameleo 接続状態確認 |
| GET | `/internal/kameleo/profiles` | Kameleo プロファイル一覧 |
| POST | `/internal/containers/activate` | コンテナウィンドウをフォーカス・前面化 |
| POST | `/internal/containers/cache/clear` | コンテナの HTTP キャッシュをクリア |
| POST | `/internal/exec` | **ブラウザ操作コマンド実行**（後述） |

---

## コンテナ管理

### `GET /internal/containers`
コンテナ一覧を返す。

**レスポンス例**
```json
{ "ok": true, "containers": [ { "id": "...", "name": "...", ... } ] }
```

---

### `GET /internal/containers/active`
現在ウィンドウが開いているコンテナの ID 配列を返す。

**レスポンス例**
```json
{ "ok": true, "activeIds": ["abc123", "def456"] }
```

---

### `POST /internal/containers/create`
新規コンテナを作成し、Kameleo プロファイルを生成する。

**リクエスト**
```json
{
  "name": "my-container",
  "environment": {
    "deviceType": "desktop",
    "os": "windows",
    "browser": "chrome"
  },
  "proxy": {
    "server": "http://host:port",
    "username": "user",
    "password": "pass"
  }
}
```

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `name` | string | ○ | コンテナ名（重複不可） |
| `environment.deviceType` | string | - | `desktop`（デフォルト） |
| `environment.os` | string | - | `windows`（デフォルト） |
| `environment.browser` | string | - | `chrome`（デフォルト） |
| `proxy` | object | - | プロキシ設定 |

---

### `POST /internal/containers/update`
コンテナのメタ情報（プロキシ、メモ等）を更新する。

**リクエスト**
```json
{
  "id": "コンテナID",
  "proxy": { "server": "http://host:port", "username": "u", "password": "p" },
  "note": "備考"
}
```

---

### `POST /internal/containers/delete`
コンテナを削除する（開いている場合は先に閉じてから削除）。

**リクエスト**
```json
{ "id": "コンテナID" }
```

---

### `POST /internal/containers/set-proxy`
コンテナのプロキシ設定のみを変更する。

**リクエスト**
```json
{
  "id": "コンテナID",
  "proxy": { "server": "socks5://host:port", "username": "u", "password": "p" }
}
```
`proxy: null` を指定するとプロキシを削除する。

---

### `POST /internal/containers/{id}/attach`
既存の Kameleo プロファイルをコンテナに紐付ける（`attached` モード）。

**リクエスト**
```json
{ "profileId": "kameleo-profile-uuid" }
```

---

### `POST /internal/containers/{id}/detach`
プロファイル紐付けを解除し、`managed` モードに戻す。

**リクエスト**
```json
{}
```

---

## コンテナ状態管理

### `POST /internal/containers/activate`
開いているコンテナをフォーカス・前面化する。

> **Kameleo モードの注意**: コンテナシェルウィンドウは常に非表示（`show: false`）で維持される。このエンドポイントはシェルウィンドウを表示しない。Kameleo ブラウザ自体を前面化したい場合は OS 側の操作（WinAPI 等）が必要。

**リクエスト**
```json
{ "id": "コンテナID" }
```

**レスポンス例**
```json
{ "ok": true, "activated": true, "message": "focused" }
```

コンテナが開いていない場合:
```json
{ "ok": false, "activated": false, "error": "not-open" }
```

---

### `POST /internal/containers/cache/clear`
コンテナの HTTP キャッシュをクリアする。

> **注意**: HTTP キャッシュのみクリアされる。Cookie・localStorage・IndexedDB・ServiceWorker キャッシュは保持される。完全なデータ消去はコンテナ削除（`/internal/export-restored/delete`）を使用すること。

**リクエスト**
```json
{ "id": "コンテナID" }
```

**レスポンス例**
```json
{ "ok": true, "message": "cache cleared" }
```

---

## コンテナ開閉

### `POST /internal/export-restored`
コンテナウィンドウを開く。オプションで認証トークンを取得してセッション Cookie を注入する。

**リクエスト**
```json
{
  "id": "コンテナID",
  "ensureAuth": true,
  "returnToken": false,
  "timeoutMs": 60000
}
```

| フィールド | 型 | デフォルト | 説明 |
|-----------|-----|-----------|------|
| `id` | string | 必須 | コンテナ ID |
| `ensureAuth` | boolean | `true` | 認証 API を呼んでセッション Cookie を注入するか |
| `returnToken` | boolean | `false` | レスポンスにトークンを含めるか |
| `timeoutMs` | number | `60000` | 全体タイムアウト |

**レスポンス例**
```json
{
  "ok": true,
  "lastSessionId": "...",
  "authInjected": true,
  "token": null,
  "cookieNames": ["session_token"]
}
```

---

### `POST /internal/export-restored/close`
コンテナウィンドウを閉じる（Kameleo プロファイルも managed の場合は停止）。

**リクエスト**
```json
{
  "id": "コンテナID",
  "timeoutMs": 30000
}
```

既に閉じている場合は `closed: false` で 200 を返す（冪等）。

**レスポンス例**
```json
{ "ok": true, "closed": true, "message": "closed" }
```

---

### `DELETE /internal/export-restored/delete`
コンテナを閉じてから DB レコードを削除する。

**リクエスト**
```json
{ "id": "コンテナID" }
```

---

## Cookie 操作

### `POST /internal/cookies/set_native`
Electron セッションレイヤーに直接 Cookie を注入する（Playwright を経由しない）。

**リクエスト**
```json
{
  "contextId": "コンテナID",
  "cookies": [
    {
      "name": "session",
      "value": "abc123",
      "domain": ".example.com",
      "path": "/",
      "secure": true,
      "httpOnly": true,
      "sameSite": "Lax",
      "expirationDate": 1999999999
    }
  ]
}
```

---

## Kameleo 状態確認

### `GET /internal/kameleo/status`
Kameleo Local API（Port 5050）との疎通を確認する。

### `GET /internal/kameleo/profiles`
Kameleo に登録されているプロファイル一覧を返す。

---

## ブラウザ操作: `/internal/exec`

`POST /internal/exec` は Playwright (CDP) 経由でブラウザを直接操作するコマンドエンドポイント。

### 共通リクエスト構造

```json
{
  "contextId": "コンテナID",
  "command": "コマンド名",
  "url": "...",
  "selector": "...",
  "text": "...",
  "eval": "...",
  "options": { }
}
```

### 共通オプション（`options` フィールド）

| オプション | 型 | デフォルト | 説明 |
|-----------|-----|-----------|------|
| `timeoutMs` | number | `30000` | コマンドタイムアウト（ms） |
| `waitForSelector` | string | - | コマンド実行前に待機するセレクタ |
| `returnHtml` | `"full"` / `"trim"` / `"none"` | `"none"` | レスポンスに HTML を含めるか |
| `returnCookies` | boolean | `false` | レスポンスにページ Cookie を含めるか |
| `screenshot` | boolean | `false` | 実行後にスクリーンショットを保存するか |

### 共通レスポンス（exec 系）

```json
{
  "ok": true,
  "command": "navigate",
  "url": "https://example.com",
  "title": "Example",
  "navigationOccurred": true,
  "html": null,
  "cookies": null,
  "screenshotPath": null,
  "elapsedMs": 1234
}
```

---

### コマンド一覧

#### `navigate` — ページ遷移

```json
{
  "contextId": "...",
  "command": "navigate",
  "url": "https://example.com",
  "options": {
    "navigationTimeoutMs": 30000,
    "waitForSelector": "#main-content"
  }
}
```

コンテナが未開の場合は自動で開く。

---

#### `click` — 要素クリック

```json
{
  "contextId": "...",
  "command": "click",
  "selector": "#submit-button",
  "options": { "waitForSelector": "#submit-button" }
}
```

セレクタは CSS または `xpath:` プレフィックス付き XPath が使用可能（全コマンド共通）。

---

#### `clickAndType` — クリック + テキスト入力

```json
{
  "contextId": "...",
  "command": "clickAndType",
  "selector": "input[name='username']",
  "text": "my_username"
}
```

クリック後、対象フィールドを `fill()` でテキスト入力する。

---

#### `type` — テキスト入力

```json
{
  "contextId": "...",
  "command": "type",
  "selector": "textarea#comment",
  "text": "Hello World"
}
```

---

#### `eval` — JavaScript 評価

```json
{
  "contextId": "...",
  "command": "eval",
  "eval": "document.title"
}
```

評価結果はレスポンスの `result` フィールドに含まれる。

---

#### `mouseMove` — マウス移動

```json
{
  "contextId": "...",
  "command": "mouseMove",
  "x": 640,
  "y": 400,
  "options": { "steps": 10 }
}
```

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `x`, `y` | number | 移動先座標（ビューポート絶対座標） |
| `options.steps` | number | 分割ステップ数（デフォルト: 1 = 即時） |

---

#### `mouseClick` — 座標クリック

```json
{
  "contextId": "...",
  "command": "mouseClick",
  "x": 640,
  "y": 400,
  "options": { "delayMs": 100 }
}
```

---

#### `humanClick` — セレクタ指定クリック

```json
{
  "contextId": "...",
  "command": "humanClick",
  "selector": "button.submit"
}
```

`page.click()` を使用。セレクタが示す要素の中央座標へ直線移動してクリックする。

> **注意**: 移動は直線のため Cloudflare 等のボット検知には不向き。Cloudflare チェックボックスには `cloudflareClick` を使用すること。

---

#### `cloudflareClick` — Cloudflare チェックボックス向け人間的クリック

Cloudflare Turnstile（チャレンジページのチェックボックス）を人間らしいマウス操作でクリックするための専用コマンド。

> **⚠️ `selector` はリクエストボディのトップレベルに置くこと**
> `options` の中に `selector` を入れても無視される。必ず `body.selector` として渡すこと。
> `options` に入れた場合はデフォルト selector（`iframe[src*="challenges.cloudflare.com"]`）が使われ、X 等のサービスでは 404 になる。

```json
{
  "contextId": "...",
  "command": "cloudflareClick",
  "selector": "iframe[src*=\"challenges.cloudflare.com\"]",
  "options": {
    "steps": 35,
    "jitter": 2
  }
}
```

**パラメータ**

| フィールド | 場所 | 型 | デフォルト | 説明 |
|-----------|------|-----|-----------|------|
| `selector` | **ボディ直下** | string | `iframe[src*="challenges.cloudflare.com"]` | 対象 iframe の CSS セレクタ |
| `options.steps` | options | number | `35`（最小20） | ベジェ曲線の分割ステップ数。多いほど滑らか |
| `options.jitter` | options | number | `2` | 各ステップに加える手ブレのランダム幅（px） |

**クリック座標のランダム化仕様**

| 軸 | 範囲 | 詳細 |
|-----|------|------|
| X 軸 | iframe 幅の **1/10〜1/3** の位置 | チェックボックスの視覚的な位置（左寄り）に合わせた範囲 |
| Y 軸 | iframe 高さの **1/3〜2/3** の位置（中央 1/3）| 縦方向は中央帯の中でランダム |

**マウス動作の詳細**

1. 画面下側のランダムな点（開始位置）から目標へ **3次ベジェ曲線** で移動
2. 移動速度に **ease-in-out** を適用（開始・終端が遅く、中間が速い）
3. 各ステップに **±jitter px** のランダム手ブレを付加
4. クリック直前に **40〜100ms** の微停止（人間の構えを再現）
5. `mousedown` → **80〜160ms** のランダム押下 → `mouseup`
6. クリック後 **400〜800ms** 待機（DOM 遷移確認）

**レスポンス例**
```json
{ "ok": true, "clickX": 47, "clickY": 38 }
```
`clickX` / `clickY` は実際にクリックした座標（デバッグ用）。

**使用例**
```bash
# 最小構成（デフォルト selector を使用）
curl -X POST http://localhost:3001/internal/exec \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "コンテナID",
    "command": "cloudflareClick"
  }'

# selector を明示指定（X / Twitter など独自 ID の場合）
curl -X POST http://localhost:3001/internal/exec \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "コンテナID",
    "command": "cloudflareClick",
    "selector": "#AOzYg6",
    "options": {
      "steps": 40,
      "jitter": 2
    }
  }'
```

> **X（Twitter）の場合**: `iframe[src*="challenges.cloudflare.com"]` は不一致。
> 事前に `getElementRect` や `eval` で実際の iframe の ID/セレクタを調べてから指定すること。

---

#### `setCookie` — Cookie セット（Playwright 経由）

```json
{
  "contextId": "...",
  "command": "setCookie",
  "name": "session_id",
  "value": "abc123",
  "domain": ".example.com",
  "path": "/",
  "secure": true,
  "httpOnly": false,
  "sameSite": "Lax",
  "expires": 1999999999
}
```

---

#### `getCookies` / `get_cookies` — Cookie 取得

```json
{
  "contextId": "...",
  "command": "getCookies",
  "urls": ["https://example.com"]
}
```

**レスポンス例**
```json
{ "ok": true, "result": [ { "name": "session", "value": "...", ... } ] }
```

---

#### `solve_captcha` — キャプチャ自動解除（2Captcha 連携）

詳細は [`docs/2captcha/api_specification_2captcha.md`](2captcha/api_specification_2captcha.md) を参照。

```json
{
  "contextId": "...",
  "command": "solve_captcha",
  "options": {
    "type": "funcaptcha",
    "sitekey": "publickey",
    "blob": "base64-data",
    "timeoutMs": 120000
  }
}
```

| `type` 値 | 対象 |
|-----------|------|
| `"auto"` | DOM を解析して自動判別 |
| `"recaptcha"` | reCAPTCHA v2 |
| `"recaptcha_enterprise"` | reCAPTCHA Enterprise |
| `"funcaptcha"` | FunCaptcha（Arkose Labs） |

事前に `config.json` の `auth.twoCaptchaApiKey` への API キー設定が必要。

---

#### `setFileInput` — ファイルアップロード

```json
{
  "contextId": "...",
  "command": "setFileInput",
  "selector": "input[type='file']",
  "fileUrl": "https://example.com/image.jpg",
  "fileName": "upload.jpg"
}
```

URL からファイルをダウンロードして input に設定する。

---

#### `getElementRect` — 要素の座標取得

```json
{
  "contextId": "...",
  "command": "getElementRect",
  "selector": "#target-element"
}
```

**レスポンス例**
```json
{
  "ok": true,
  "rect": { "x": 100, "y": 200, "width": 300, "height": 50 }
}
```

---

#### `save_media` — スクリーンショット / PDF 保存

```json
{
  "contextId": "...",
  "command": "save_media",
  "mediaType": "image",
  "selector": "#article"
}
```

| `mediaType` | 説明 |
|-------------|------|
| `"image"` | PNG スクリーンショット（セレクタ指定で部分キャプチャ可） |
| `"pdf"` | PDF（A4） |

**レスポンス例**
```json
{ "ok": true, "path": "C:\\...\\media\\media-abc-123.png", "fileName": "media-abc-123.png" }
```

---

## エラーコード

| HTTP | 意味 |
|------|------|
| 200 | 成功 |
| 400 | パラメータ不足・不正 |
| 404 | コンテナ・セレクタ・プロファイルが見つからない |
| 409 | 同一コンテナへの同時リクエスト（ロック中） |
| 500 | 内部エラー |
| 504 | タイムアウト |
