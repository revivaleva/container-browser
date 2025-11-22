# Release Notes — v0.3.9

リリース日: 2025-11-22

## 重要な変更点
- `POST /internal/exec` の処理を強化し、ナビゲーション完了待ち (`waitForNavigationComplete`) を導入、`timeoutMs` に加えて `options.navigationTimeoutMs` を任意で指定できるようにしたことで、Auto-navigation 後のDOM取得と選択子待機が安定しました。また評価 (`eval`) は JSON 文字列化された式も解釈でき、実行結果を `result` として返しつつ、`errorDetail` に stack/line/column/snippet/context を含めることで調査しやすくなっています。HTML 取得ではスタイル・スクリプト・data:URL を削除し、`returnHtml: "trim"` 時は `<body>` 内だけを 64KB 以内に切り詰めるサニタイズを実装。クッキー注入も `set-cookie-parser` で配列化した cookie ヘッダーを正しく扱うようになりました。
- `openContainerWindow` と `startExportServer` は API 経由でコンテナを開く際、`singleTab` オプションを使って余分な `BrowserView` を作成せず、restore 時も最初のタブのみ再現することで shell 側のタブインデックスと整合性を保ちます。`containerShell` 側では DevTools タブを検出して専用ラベル＋アイコン表示し、DevTools の開閉イベントで UI を更新するようになりました。
- `docs/PROJECT_OVERVIEW.md` を全面的に書き換え、`/internal/export-restored/close` と `/internal/exec` のリクエスト/レスポンス/オプション/例を順に記載して API 仕様を一括で参照できるようにしました。
- 開発時 `npm run dev` は環境変数 `PORT=5174` を設定し、レンダラー側の Vite サーバーも同ポートを使うよう `electron.vite.config.ts` に明示的なポート設定を追加しました。これにより `dev` とレンダラーのホットリロードが同じポートで動作します。

## バグ修正
- `type` コマンドで入力前にセレクターを検証し、`input` イベントを発火させるようにしたことでマクロ実行後の form 処理が安定。`command === 'type'` の場合欠損セレクターで 400 を返すよう明示化。
- `locks` を通じて `contextId` ごとの同時実行を防ぐロック周辺を明示的にログ出力対応し、Busy 状態 (`409`) の発見がつきやすくなりました。

## 既知の注意点
- `/internal/exec` は依然として `REMOTE_EXEC_HMAC` の設定 or local binding (`127.0.0.1`) でのみ動作し、`options.returnHtml` で trim を指定した場合、スクリプト/コメント/スタイル/クラス属性は全削除される点に留意してください。

## 開発者向けメモ
- Electron の `postinstall` スクリプト実行は `npm install` 時に `electron-builder install-app-deps` が走ります。ローカル検証時にビルド済みバイナリを再利用するためには `npm install --ignore-scripts` や`npm ci --ignore-scripts` で調整してください。

## 次回予定
- Remote exec の `screenshot` オプション出力を増やし、ヘッドレス API からスクロールやページ全体のサムネイルを取得できるようにする。

