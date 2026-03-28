# 2Captcha reCAPTCHA 解除機能の導入に向けた調査報告書

このドキュメントでは、コンテナブラウザに 2Captcha のサービスを用いた reCAPTCHA 解除機能を実装するための調査結果と設計案をまとめます。

## 現状の解析

*   **制御 API**: 現在、`src/main/exportServer.ts` にて `/internal/exec` エンドポイントが提供されており、外部からコンテナ内のブラウザを操作（クリック、入力、ナビゲート、JS実行等）できるようになっています。
*   **ブラウザ操作**: 各コンテナの `webContents` に対して `executeJavaScript` や `sendInputEvent` を用いて操作を行っています。
*   **2Captcha の既存実装**: 現在のコードベースには 2Captcha 関連の実装は含まれておらず、新規実装となります。

## 2Captcha API による解除の流れ

### reCAPTCHA (v2/v3 / Enterprise)
1.  **情報の取得**: ページ内の要素から `sitekey` を取得します。Enterprise版の場合は `enterprise: 1` フラグが必要です。v3 の場合は `action` パラメータも抽出します。
2.  **リクエスト**: `in.php` に必要なパラメータ（`sitekey`, `pageurl`, `enterprise`, `action` 等）を送信します。
3.  **ポーリング**: `res.php` で `token` の返却を待ちます。
4.  **注入**: `g-recaptcha-response` に `token` を設定し、`data-callback` または `___grecaptcha_cfg` から特定したコールバックを実行します。

### Arkose Labs (FunCaptcha)
1.  **情報の取得**: ページ内の要素から `publickey` (pkey) と `surl` を取得します。必要に応じて `blob` (data[blob]) データも抽出します。
2.  **リクエスト**: `in.php` に `publickey`, `surl`, `pageurl`, `data[blob]` 等を送信します。
3.  **ポーリング**: `res.php` で `token` の返却を待ちます。
4.  **注入**: `#fc-token` 要素に取得した `token` を設定します。

## キャプチャの自動判別とコールバック抽出

*   **自動判別**: `enterprise.js` の読み込みや `grecaptcha.enterprise` オブジェクトの有無で Enterprise 版を判別します。
*   **コールバック抽出**: `data-callback` 属性を優先し、見つからない場合は `___grecaptcha_cfg.clients` を走査して `callback` プロパティを探索します。

## 設計案: `solve_captcha` コマンドの強化

```json
POST /internal/exec
{
  "contextId": "container-id",
  "command": "solve_captcha",
  "options": {
    "type": "auto", // "recaptcha", "funcaptcha" または "auto" (デフォルト)
    "selector": ".g-recaptcha", // ヒントとしての位置要素
    "timeoutMs": 60000
  }
}
```
*APIキーはコンテナブラウザの設定ファイル (`config.json`) に保存されているものを使用します。*

### 実装の詳細

1.  **位置要素の指定 (`selector`)**:
    *   指定されたセレクタの要素（またはその子要素）から `data-sitekey` 属性を探します。
    *   指定がない場合は、ページ全体から reCAPTCHA の iframe や要素を検索します。
2.  **2Captcha との通信**:
    *   Node.js の `fetch` を用いて 2Captcha API と通信します。
    *   API キーはリクエストに含めるか、アプリの設定（`config.json`）に保持するようにします。
3.  **完了・失敗の通知**:
    *   解除に成功した場合は、取得した `token` を返します。
    *   失敗（タイムアウト、APIエラー、リキャプチャが見つからない等）した場合は、エラーメッセージを返します。

## 検討事項

1.  **「位置要素の指定」の意図確認**:
    *   上記設計では、`selector` は `sitekey` を特定するためのヒントとして扱います。
    *   もし「画像をクリックする座標」を 2Captcha から取得してクリックする（座標指定型）を想定されている場合は、実装がより複雑になりますが対応可能です。通常はトークン注入方式が推奨されます。
2.  **API キーの管理**:
    *   リクエスト毎に送信するか、アプリの設定画面で一度登録する形にするかを確認したいです。
3.  **コールバックの自動実行**:
    *   reCAPTCHA には解除後に実行される JS コールバック（`data-callback`）が設定されている場合があります。これを見つけて自動で呼び出すロジックも組み込む必要があります。

## 次のステップ

*   ユーザー様による設計案の確認
*   詳細な実装計画（Implementation Plan）の作成
*   実装の開始
