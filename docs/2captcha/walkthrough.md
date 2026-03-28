# 2Captcha 解除機能 実装完了レポート

2Captcha サービスを利用した reCAPTCHA および FunCaptcha の自動解除機能を実装し、`feature/2captcha-solver` ブランチに反映しました。

## 実装内容のまとめ

### 1. 設定管理の拡張
[settings.ts](file:///c:/Users/Administrator/workspace/container-browser/src/main/settings.ts) に `twoCaptchaApiKey` フィールドを追加しました。
*   `config.json` の `auth.twoCaptchaApiKey` に値を保存できます。
*   環境変数 `TWO_CAPTCHA_API_KEY` による上書きも可能です。

### 2. 解除ロジックのコア実装
[exportServer.ts](file:///c:/Users/Administrator/workspace/container-browser/src/main/exportServer.ts) にキャプチャ解決用のヘルパー関数 `solveCaptcha` を追加しました。

*   **自動検知**: ページ内の DOM を解析し、reCAPTCHA (v2, v3, Enterprise) または FunCaptcha (Arkose Labs) を自動的に判別します。
*   **パラメータ抽出**: `sitekey`, `publickey`, `surl`, `enterprise` フラグ等を自動抽出します。
*   **柔軟なオーバーライド**: API 呼び出し時に `url`, `sitekey`, `action`, `blob`, `callbackName` を手動指定することで、自動抽出が困難なケースにも対応可能です。
*   **トークン注入と確定**:
    *   reCAPTCHA: `g-recaptcha-response` への注入に加え、`data-callback` や `___grecaptcha_cfg` 内の関数を自動実行します。
    *   FunCaptcha: `#fc-token` への注入と `input/change` イベントの発火を行います。

### 3. API エンドポイントの追加
`/internal/exec` に `solve_captcha` コマンドを追加しました。詳細は [API仕様書](file:///C:/Users/Administrator/.gemini/antigravity/brain/f10740a9-8b75-4900-9e69-92c6f8fb6da0/api_specification_2captcha.md) を参照してください。

---

## 検証方法

### 1. ビルド確認
`npm run build` を実行し、型チェックとビルドが正常に完了することを確認済みです。

### 2. 動作確認手順（推奨）
実際に 2Captcha の API キーをお持ちの場合、以下の手順で動作を確認いただけます。

1.  `config.json` に API キーを書き込む。
2.  アプリを起動し、reCAPTCHA 等があるページを開く。
3.  外部（Postman や `curl` 等）から以下のリクエストを送信する。
    ```bash
    curl -X POST http://localhost:3001/internal/exec \
      -H "Content-Type: application/json" \
      -d '{
        "contextId": "対象のコンテナID",
        "command": "solve_captcha",
        "options": { "type": "auto" }
      }'
    ```
4.  レスポンスに `ok: true` が返り、ブラウザ上のキャプチャが「解決済み」になることを確認してください。

## 考慮済みの懸念点
*   **タイムアウト**: 解決に時間がかかるケースを考慮し、デフォルトを 90 秒に設定しています。
*   **エラー詳細**: 残高不足 (`ERROR_ZERO_BALANCE`) 等の具体的なエラーコードを `errorDetail` に含めるようにしました。
*   **堅牢性**: コールバック関数の探索範囲を広げ、`___grecaptcha_cfg` を含めた広範囲な自動検索を実装しています。
