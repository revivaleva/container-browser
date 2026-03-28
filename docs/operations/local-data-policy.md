# Local Data and Secret Handling Policy

## 目的
本リポジトリにおいて、機密情報（秘密鍵、パスワード、認証情報）や大容量のローカル専用データ（プロファイル、DB、ログ等）が Git に混入することを防ぐためのガイドラインを定めます。

## Git に含めないもの (Exclusion List)
以下は、`.gitignore` を通じて Git 追跡から常に除外されるべきものです。
- **機密情報 (Credentials)**:
  - 実 API キー、プロキシ実値、トークン、アクセストークン。
  - 実 Twilio アカウント設定、外部サービス認証情報。
- **個人情報 (PII)**:
  - ユーザー個人を特定できる情報、連絡先等。
- **実行データ (Running Data)**:
  - ローカル DB (`*.db`, `*.sqlite`, `*.sqlite3`)。
  - ブラウザプロファイルデータ (`profiles/`, `user-data/`, `session-data/`)。
  - プロキシログ、システムログ (`logs/`, `*.log`, `logs.txt`)。
  - ダウンロードファイル、キャッシュ、テンポラリーファイル (`cache/`, `tmp/`, `temp/`)。
  - スクリーンショット (`screenshots/`, `shots/`)。

## Git に含めてよいもの (Inclusion List)
- **コア実装**: ソースコード、各種設定ファイル (`package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`)。
- **共有ドキュメント**: 仕様書、運用マニュアル、作業ログ (`README.md`, `docs/`)。
- **設定テンプレート**: `.env.example`, `settings.example.json` などのテンプレート。
- **アセット**: UI に使用する共通アイコンや画像リソース（個人情報を含まないもの）。

## 推奨保存場所 (Best Practices)
- ローカル専用のデータは、可能な限りルート直下の `local/` 配下に集約し、このディレクトリを丸ごと Git の追跡から除外します。
- データの分離を徹底し、コード内でデータディレクトリを環境変数や設定ファイルで指定可能にします。

## Template / Example ファイルの扱い
- 共有すべき設定項目は、値（Value）を空または「REQUIRED_VALUE」等に書き換えた `example` ファイルとして作成し、リポジトリに含めます。
- 実際の値は、このファイルをコピーして作成した `local` 専用の設定ファイル (`.env`, `settings.local.json`) に記述します。

## コミット前チェック
コミットを確定する前に、以下のコマンド等を用いて不適切なデータが混入していないかを確認します。
- `git diff --cached`
- `rg "(password|apiKey|token|secret)"` (ripgrep を利用した機密キーワード検索)

## Secret 混入時の対応
万が一、機密情報を誤ってコミットした場合は、即座に該当の認証情報を無効化（Revoke / Re-issue）し、ブランチを修正した上で、コミット履歴の書き換えが必要な場合は慎重に検討・報告を行います。
