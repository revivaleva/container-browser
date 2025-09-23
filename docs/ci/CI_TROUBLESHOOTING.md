## publish-windows ワークフローに関するトラブルシュート記録

目的: 同じ CI エラーが再発したときに迅速に対応できるよう、発生した原因と確実な修正手順を記録する。

- 発生日時: 2025-09-17
- 関連ワークフロー: `.github/workflows/publish-windows.yml` （ジョブ: `build_publish_windows`）

---

1) 問題の概要
- ビルドが Windows コード署名関連で失敗する（`Env WIN_CSC_LINK is not correct`、electron-builder が `false` をモジュールとして解決しようとする等）。
- また `workflow_dispatch` を使った手動実行で PAT の権限不足（Workflows: Read & write が必要）により dispatch に失敗するケースがあった。

2) 根本原因
- ジョブレベルやステップレベルで署名に関する環境変数（`CSC_LINK`, `WIN_CSC_LINK`, `CSC_KEY_PASSWORD` 等）を空文字でセットしていると、`electron-builder` やスクリプトがその値を解釈して想定外の動作をする。
- 一時的に `-c.win.sign=false` のようなビルド引数を渡す実装が、内部で `'false'` をモジュール/ファイルパスとして扱われる状況を引き起こした。

3) 永続的な修正手順（必ず順に実行）

- ワークフロー側の修正
  - ジョブ／ステップの `env` に `CSC_LINK` / `CSC_KEY_PASSWORD` 等を設定しない（完全に削除する）。
  - `workflow_dispatch` 用に `BUCKET` / `DIST` 等の値が入力されないトリガーでも動くよう、ワークフロー内部でデフォルトフォールバックを実装する。

- スクリプト側の修正
  - スクリプト内で署名を無効化する必要がある場合は、`Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue` のように環境変数を**削除**する。空文字代入（`$env:WIN_CSC_LINK = ''`）は避ける。
  - `-c.win.sign=false` のように boolean を明示的に渡す実装は避け、環境変数の削除で署名を回避する方針に統一する。

- AWS / GitHub 権限の確認
  - dispatch に使う PAT は `workflows` scope の `Read & write` を付与すること（UI トリガーとは別）。
  - S3 配布用 IAM ポリシーは最低でも `s3:PutObject`, `s3:DeleteObject`, `s3:GetObject` を `arn:aws:s3:::<bucket>/*` に対して許可すること。
  - CloudFront の無効化を行う場合は `cloudfront:CreateInvalidation` が必要。
  - CloudFront の無効化を行う場合は `cloudfront:CreateInvalidation` が必要。

8) 2025-09-18 - 適用した修正（今回の対応）

- **スクリプト: `scripts/dispatch_publish.ps1`**
  - ローカルのトークンファイル（`scripts/.github_token` や `../.secrets/github_token`）を優先して読み取るように変更し、環境変数のみ依存しない運用を可能にしました。
- **スクリプト: `scripts/update-release.ps1`**
  - ビルド開始前に署名環境変数を削除し、空文字や存在するが不正なパスが原因で electron-builder が失敗する問題を回避する処理を強化しました。
  - 署名処理を明示的に無効化する `-c.win.sign=false` を一時的に追加しました（短期的対策。長期的には正しい証明書管理を推奨）。
  - `npm run build` による事前ビルドを試行する処理を追加し、`out/main/index.js` がない場合の早期検出と自動ビルドを行います。
  - electron-builder の実行方法を改善し、環境変数の反映と ExitCode の正確な取得を行うようにしました。
- **ワークフロー: `.github/workflows/publish-windows.yml`**
  - `Publish nsis-web via script` ステップの先頭で署名用環境変数を削除するコマンドを追加しました（確実に空文字や誤設定が渡らないようにするため）。
- **CI ルール: `.cursor/rules/project_rules.mdc`**
  - CI 修正時は必ず `docs/ci/CI_TROUBLESHOOTING.md` を参照・更新することをルール化しました。

9) 短期的な運用手順（今回のワークフロー実行用）

- リポジトリにトークンをコミットしないでください。`scripts/.github_token` を作成し、PAT をそこに貼り付けて実行してください。テンプレートは `scripts/.github_token.template` を参照。
- ワークフロー再実行は私（自動実行者）に依頼するか、あなたがローカルで `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dispatch_publish.ps1 -Ref 'main'` を実行して Actions run URL を共有してください。

※ 以上の修正は再発防止と暫定的な回避策を目的としています。署名や証明書周りは本運用での安全確保を優先し、長期的には CI の Secrets 管理／署名フローの見直しを推奨します。

4) デバッグ手順（再発時に実行）

- まずワークフロー実行ページを開き、失敗したジョブの該当ステップのログを確認する（`Env WIN_CSC_LINK` や `electron-builder` のエラーメッセージを探す）。
- 必要に応じて、手元で手動実行して同じエラーを再現する:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -Command "./scripts/dispatch_publish.ps1 -Token '<PAT>' -Ref 'ci/s3-root-copy'"
  ```
- 成功の指標:
  - ワークフローが正常終了し、artifacts（nsis 7z / exe）が生成されること。
  - S3 の `nsis-web/` に期待するファイルが存在すること（`latest.yml` は S3 ルートに配置するが、`path`/`file`/`url` は必ず `nsis-web/<name>` を指す）。
  - ルートに `.exe` や `.7z` を置かない運用にする（クライアントは常に `nsis-web/` を参照する）。

5) 既知の関連コミット／変更
- 2025-09-17: ジョブ env 削除・`update-release.ps1` の署名引数削除 を適用（参照: `ci/s3-root-copy` ブランチのコミット）。

6) 連絡方法
- このファイルを更新する場合はコミットメッセージに `docs(ci): update CI_TROUBLESHOOTING` を付けること。

---

※ 追加すべき情報や手順が分かったらこのファイルを追記してください。

7) 追加した緩和策（実装済み）
- `scripts/update-release.ps1` の CloudFront 無効化処理を try/catch で包み、`cloudfront:CreateInvalidation` の権限がない場合はワーニングを出力して処理を継続するようにしました。これにより、無効化権限の不足でリリース全体が失敗することを防ぎます。

10) 2025-09-20 - 手動対応と追加の検証スクリプト

- **手動 root latest.yml 上書きと CloudFront invalidation**
  - 問題が発生しているルート直下の 403 を即時回避するため、`nsis-web` に含まれる v0.3.0 の `latest.yml` を手動で S3 ルートに上書きし、CloudFront invalidation を発行しました。これにより CDN 上の `/latest.yml` は v0.3.0 に更新されました。

- **CloudFront CacheBehavior 追加の試行**
  - ルート直下へ未署名でアクセスできるように `PathPattern=*.nsis.7z` のキャッシュビヘイビアを追加する試行をスクリプト `scripts/cf_add_behavior.ps1` で実施しましたが、IAM 権限不足（`cloudfront:UpdateDistribution`）のため適用されませんでした。権限を持つアカウントでの適用が必要です。

- **Web Setup のバイナリ検査**
  - `scripts/inspect_web_setup.ps1` を追加し Web Setup (`Container Browser Web Setup 0.3.0.exe`) をダウンロードして内部の文字列を検査しました。結果、`latest.yml` や CDN の直接 URL（`updates.threadsbooster.jp`）や `.nsis.7z` 参照は実行ファイル内に埋め込まれておらず、インストーラはランタイムで `latest.yml` を参照してパッケージを決定することを確認しました。

注: 今後はこのような手動修正・検証を行った際に必ずこのドキュメントを更新してください。

※ 長期的には CI 用の IAM ユーザーに `cloudfront:CreateInvalidation` を付与することを推奨します（再配布の即時性が必要なため）。


