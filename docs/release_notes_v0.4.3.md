# Release Notes — v0.4.3

リリース日: 2025-11-27

## 重要な変更点

### Export Server 機能拡張
- Export Server の設定 UI を実装し、サーバーの有効/無効やポート設定が Main UI から操作できるようになりました。
- Settings ウィンドウをレンダラーメニューから独立した新規ウィンドウとして開くよう改善。

### IPC & ウィンドウ管理強化
- `open-settings` シグナルを IPC 経由で堅牢に実装し、Settings ウィンドウの表示がより安定しました。
- ウィンドウロード後に `open-settings` を送信し、レンダラー側で確実に受け取るよう整改。

### インストーラ・ビルド設定
- Windows NSIS インストーラの設定を最適化（`installer.nsh`）。
- 開発環境での Vite サーバーポート設定を明示化（`electron.vite.config.ts` に PORT 設定追加）。

## バグ修正
- レンダラー Settings ウィンドウの JSX ラッピングエラーを修正。
- Dev モード時に Settings ウィンドウが正しいパスで開くよう修正。

## 既知の注意点
- Export Server 設定は local binding (`127.0.0.1`) のみで動作。

## 次回予定
- Remote exec の screenshot オプション出力の拡張。

