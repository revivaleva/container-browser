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

4) デバッグ手順（再発時に実行）

- まずワークフロー実行ページを開き、失敗したジョブの該当ステップのログを確認する（`Env WIN_CSC_LINK` や `electron-builder` のエラーメッセージを探す）。
- 必要に応じて、手元で手動実行して同じエラーを再現する:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -Command "./scripts/dispatch_publish.ps1 -Token '<PAT>' -Ref 'ci/s3-root-copy'"
  ```
- 成功の指標:
  - ワークフローが正常終了し、artifacts（nsis 7z / exe）が生成されること。
  - S3 の `nsis-web/` と root に期待するファイルが存在すること（`latest.yml` が新しいバージョンを指す）。

5) 既知の関連コミット／変更
- 2025-09-17: ジョブ env 削除・`update-release.ps1` の署名引数削除 を適用（参照: `ci/s3-root-copy` ブランチのコミット）。

6) 連絡方法
- このファイルを更新する場合はコミットメッセージに `docs(ci): update CI_TROUBLESHOOTING` を付けること。

---

※ 追加すべき情報や手順が分かったらこのファイルを追記してください。

7) 追加した緩和策（実装済み）
- `scripts/update-release.ps1` の CloudFront 無効化処理を try/catch で包み、`cloudfront:CreateInvalidation` の権限がない場合はワーニングを出力して処理を継続するようにしました。これにより、無効化権限の不足でリリース全体が失敗することを防ぎます。

※ 長期的には CI 用の IAM ユーザーに `cloudfront:CreateInvalidation` を付与することを推奨します（再配布の即時性が必要なため）。


