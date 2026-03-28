# Antigravity Workspace Policy

## 目的
通常版 Container Browser の開発において、Antigravity（AI アシスタント）が安全かつ効率的に作業を行うためのルールを定めます。
特に Kameleo 版との並列運用において、リポジトリの整合性を保ち、誤操作を防ぐことを目的とします。

## ワークスペース構成
- **通常版 (Main)**: `C:\Users\Administrator\workspace\container-browser`
- **Kameleo 版**: `C:\Users\Administrator\workspace\container-browser-for-kameleo`
- これらは別のリポジトリとして扱い、相互に影響を与えないようにします。

## 自動実行してよい作業
以下については、Antigravity が自律的に実行することを原則として許可します。
- ファイルの参照・検索
- 通常のソースコード・ドキュメント編集
- Git の確認系操作（`status`, `diff`, `log`, `branch`, `fetch`, `pull --ff-only`）
- 依存関係のインストール（`npm install`）
- ビルド・テスト（`npm run build`, `npm test`）
- 開発用サーバーの起動確認（`npm run dev`）
- ローカル用設定テンプレートの作成（`.env.example` 等）

## 自動実行してはいけない作業
以下の破壊的、またはセキュリティ上の懸念がある操作は、Antigravity 単独では行わず、必ず明示的な指示または承認を得るものとします。
- 破壊的な Git 操作（`push --force`, `reset --hard`, `clean -fd`, ブランチ削除）
- リモートリポジトリの破壊的変更
- 実認証情報（Credential）、実プロキシ、実 API キーのコミット
- 本番用認証・インフラ設定の変更
- `Kameleo 版` Repo への予期せぬ変更

## Git 運用ルール
- **コミット前確認**: `git status` と `git diff --cached` で変更内容を常に確認します。
- **データ秘匿**: Secrets、Proxy 実値、トークン、プロファイルデータ、ローカル DB は `.gitignore` に含め、コミットしません。
- **整合性の維持**: コード変更と併せて、必要に応じてドキュメント (`docs/`) を更新し、実装とドキュメントの乖離を防ぎます。
- **Checkpoint Commit**: 意味のある作業単位ごとに適切なメッセージと共にコミットを残します。

## docs 更新ルール
- 新機能の追加、仕様変更、運用方法の変更時には、関連するドキュメントを即座に更新または新規作成します。
- 作業ログ (`docs/logs/YYYY-MM.md`) を記録し、履歴を追跡可能にします。

## 変更後の報告ルール
変更後は必ず以下のフォーマットで報告します。
1. 変更サマリ
2. 変更ファイル一覧
3. 確認方法
4. 残課題

## 起動前確認項目
- 依存関係が最新か (`npm install`)
- 必要なローカル設定ファイル (`.env`, `settings.local.json`) が存在するか
- Kameleo 版とポート等 (`5173` / `5174` 等) が衝突していないか
- データ保存先パスが適切に設定されているか

## 主要スクリプト (通常版)
- **起動 (Dev)**: `npm run dev` (Port 5173 をデフォルトとするが、必要に応じて 5174 等に変更)
- **ビルド**: `npm run build`
- **MCP Bridge**: `npm run mcp`
