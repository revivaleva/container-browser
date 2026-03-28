# 2Captcha reCAPTCHA/FunCaptcha 連携機能 API仕様書

このドキュメントでは、コンテナブラウザに実装される 2Captcha を用いたキャプチャ解除 API の使用方法について説明します。

## エンドポイント

*   **URL**: `http://localhost:[PORT]/internal/exec`
*   **Method**: `POST`
*   **Content-Type**: `application/json`

※ `[PORT]` は `config.json` で設定されたエクスポートサーバーのポート番号（デフォルト: 3001）です。

## リクエストパラメータ

`solve_captcha` コマンドを使用して、ターゲットコンテナ内でのキャプチャ解除を要求します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `contextId` | string | ○ | 操作対象のコンテナ ID |
| `command` | string | ○ | `solve_captcha` 固定 |
| `options` | object | - | 解除オプション |

### `options` オブジェクトの詳細

| プロパティ | 型 | デフォルト | 説明 |
| :--- | :--- | :--- | :--- |
| `type` | string | `"auto"` | `"auto"`, `"recaptcha"`, `"recaptcha_enterprise"`, `"funcaptcha"` |
| `url` | string | `null` | 指定された場合、カレントURLの代わりに `pageurl` として使用します。 |
| `sitekey` | string | `null` | 手動指定された `sitekey` / `publickey` を使用します。 |
| `action` | string | `null` | reCAPTCHA v3 / Enterprise 用の `action` パラメータ |
| `blob` | string | `null` | FunCaptcha 用の `data[blob]` パラメータ |
| `callbackName` | string | `null` | 注入後に実行するグローバル関数名（自動抽出に失敗する場合の予備） |
| `timeoutMs` | number | `90000` | 2Captcha への依頼から完了までのタイムアウト時間（推奨: 90s以上） |

## レスポンス形式

成功時と失敗時で以下の JSON が返却されます。

### 成功時 (HTTP 200)

```json
{
  "ok": true,
  "data": {
    "type": "recaptcha",
    "token": "03AFc... (取得したトークン)",
    "action": "injected & callback executed"
  }
}
```

### 失敗時 (HTTP 4xx / 5xx)

```json
{
  "ok": false,
  "error": "Captcha solve failed",
  "errorDetail": {
    "code": "ERROR_ZERO_BALANCE", // 2Captcha 固有のエラーコード
    "message": "Account has zero balance"
  }
}
```

#### 主なエラーコード
*   `ERROR_ZERO_BALANCE`: 残高不足
*   `ERROR_WRONG_USER_KEY`: APIキーが不正
*   `ERROR_CAPTCHA_UNSOLVABLE`: 解決不可
*   `ERROR_NO_SLOT_AVAILABLE`: サーバー混雑
*   `CAPCHA_NOT_READY`: 解決中（通常はAPI内部でハンドルされます）

## 利用例 (curl)

### reCAPTCHA を自動判別して解除する場合

```bash
curl -X POST http://localhost:3001/internal/exec \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "my-container-uuid",
    "command": "solve_captcha",
    "options": {
      "type": "auto"
    }
  }'
```

### 特定の要素をターゲットにして FunCaptcha を解除する場合

```bash
curl -X POST http://localhost:3001/internal/exec \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "my-container-uuid",
    "command": "solve_captcha",
    "options": {
      "type": "funcaptcha",
      "selector": "#arkose-container"
    }
  }'
```

## 事前準備

この API を使用するには、コンテナブラウザの `config.json` に以下の設定が必要です。設定画面（または手動編集）から 2Captcha の API キーを登録してください。

```jsonc
{
  "auth": {
    "twoCaptchaApiKey": "YOUR_2CAPTCHA_API_KEY"
  }
}
```
