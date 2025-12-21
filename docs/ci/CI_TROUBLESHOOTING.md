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
  - S3 の運用方針を `root` ベースに統一しました: `latest.yml` と実ファイル（`.exe` / `.7z`）は S3 ルートに配置し、`nsis-web/` プレフィックス運用は廃止します。
  - `latest.yml` 内の `path`/`file`/`url` は CDN ルート（`https://updates.threadsbooster.jp/<name>`）を指すようにスクリプトで変換されます。

### アプリ側: 新機能追加メモ (2025-09-25)

実装済み:
- 起動時に自動でアップデートをチェックし、利用可能であればダウンロード→自動インストールを行う（`electron-updater` の初期化）。
- トレイメニューに「Check for updates」「Show version」を追加。
- Renderer から `appAPI.getVersion()` / `appAPI.checkForUpdates()` / `appAPI.exit()` を呼べるように preload 経由で公開。

確認手順（ユーザ向け）:
1. アプリを起動するとバックグラウンドで更新チェックが行われます（ログ: `[auto-updater] checking for update`）。
2. 手動で更新を確認するにはトレイアイコン右クリック → `Check for updates` を選択するか、renderer から `window.appAPI.checkForUpdates()` を呼んでください。
3. バージョン確認はトレイメニューの `Show version` で確認可能。または `window.appAPI.getVersion()` を呼んで取得できます。


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

---

## 2025-09-25 - 最終対応と運用手順の確定

状況: クライアント側でのインストールが成功したため、本件は収束しました。原因は `latest.yml` の参照先が一部 S3 直リンクを指していたことと、CloudFront のキャッシュ/署名設定の不整合でした。

今回確立した運用手順（必ず順に実行）:

1. ビルド
   - ローカルまたは CI で `electron-builder --win nsis-web --x64 --publish never` を実行して `nsis-web` アーティファクトを生成する。

2. マニフェスト書換えとアップロード
   - `scripts/update-release.ps1 -Bucket <bucket> -DistributionId <dist> -Cdn <cdn>` を実行する。
   - スクリプトは `latest.yml` の `url`/`path`/`file` を CDN の絶対 URL に書き換える（installer は `nsis-web/`、package は CDN ルート）。

3. CloudFront invalidation
   - スクリプトが invalidation を作成する。手動で行う場合は `scripts/run_invalidate_and_check.ps1` を使用して `/latest.yml` と `/*` の invalidation を作成し、完了を待つ。

4. 検証（必須）
   - `Invoke-WebRequest -Uri "https://<cdn>/latest.yml" -OutFile logs/cdn_latest.yml` で manifest を取得し、中身の `url` が CDN を指していることを確認する。
   - `curl -I https://<cdn>/<pkg>.nsis.7z` → 200
   - `curl -A 'INetC/1.0' -r 0-1048575 -D - -o NUL https://<cdn>/<pkg>.nsis.7z` → 206

5. クライアント側対応
   - ローカルキャッシュを削除して再試行する（`%LOCALAPPDATA%\container-browser-updater*` と `SquirrelTemp`）。

6. トラブル発生時の優先フロー
   - まず CDN 上の `latest.yml` の中身確認 → `url` が CDN を指しているかを最優先で確認。
   - 次に CloudFront の DefaultCacheBehavior/CacheBehaviors の `TrustedKeyGroups` / `TrustedSigners` を確認し、不要な署名要求がないかを確認。
   - 必要なら DefaultCacheBehavior の `TrustedKeyGroups` を一時的に無効化して配信を回復し、invalidaton を実行する。

付記: 今回の対応では `latest.yml` の書換えと CloudFront 側の設定調整で解決しました。将来のリリース時も上記手順に従ってください。

---

## 2025-12-21 - .nsis.7z ファイルの配置場所問題

### 問題の概要
インストーラー実行時に「Access Denied (403)」エラーが発生し、`.nsis.7z` パッケージファイルのダウンロードに失敗する。

**エラーメッセージ例:**
```
Unable to download application package from 
https://updates.threadsbooster.jp/nsis-web/container-browser-0.5.3-x64.nsis.7z 
(status: Access Forbidden (403))
```

### 根本原因
- インストーラー（`.exe`）は、自分と同じディレクトリ（`nsis-web/`）から `.nsis.7z` パッケージファイルを探す
- しかし、デプロイスクリプトは `.nsis.7z` を S3 ルートに配置していた
- そのため、インストーラーが `nsis-web/container-browser-0.5.3-x64.nsis.7z` にアクセスしようとして 403 エラーが発生

### 修正内容
`scripts/update-release.ps1` を修正し、`.nsis.7z` ファイルも `nsis-web/` ディレクトリに配置するように変更：

**変更前:**
- `.nsis.7z` → S3 ルート (`s3://container-browser-updates/container-browser-0.5.3-x64.nsis.7z`)
- `.exe` → `nsis-web/` (`s3://container-browser-updates/nsis-web/Container-Browser-Web-Setup-0.5.3.exe`)

**変更後:**
- `.nsis.7z` → `nsis-web/` (`s3://container-browser-updates/nsis-web/container-browser-0.5.3-x64.nsis.7z`)
- `.exe` → `nsis-web/` (`s3://container-browser-updates/nsis-web/Container-Browser-Web-Setup-0.5.3.exe`)

### ファイル配置の最終的な方針
**すべてのインストーラー関連ファイルは `nsis-web/` ディレクトリに配置:**
- `.exe` ファイル（インストーラー）
- `.nsis.7z` ファイル（パッケージ）
- `latest.yml` は S3 ルートに配置（CDN ルートからアクセス可能）

**理由:**
- インストーラーは自分と同じディレクトリからパッケージファイルを探すため、両方を同じ場所に配置する必要がある
- `latest.yml` は CDN ルートからアクセス可能にする必要があるため、S3 ルートに配置

### トラブルシューティング
もし同様のエラーが発生した場合：

1. **S3 の配置を確認:**
   ```powershell
   aws s3 ls s3://container-browser-updates/nsis-web/ | Select-String -Pattern "0.5.3"
   ```

2. **CDN 経由でのアクセステスト:**
   ```powershell
   curl -I https://updates.threadsbooster.jp/nsis-web/container-browser-0.5.3-x64.nsis.7z
   ```
   - HTTP 200 OK が返ってくることを確認

3. **CloudFront キャッシュの無効化:**
   ```powershell
   aws cloudfront create-invalidation --distribution-id E1Q66ASB5AODYF --paths "/nsis-web/container-browser-0.5.3-x64.nsis.7z" "/latest.yml"
   ```

4. **手動でファイルをコピー（緊急時）:**
   ```powershell
   aws s3 cp s3://container-browser-updates/container-browser-0.5.3-x64.nsis.7z s3://container-browser-updates/nsis-web/container-browser-0.5.3-x64.nsis.7z --content-type 'application/octet-stream' --cache-control 'public,max-age=300'
   ```

### 今後のリリース時の注意事項
- デプロイスクリプト（`update-release.ps1`）は既に修正済みのため、通常のデプロイ手順に従えば問題は発生しない
- GitHub Actions の自動デプロイでも正しく動作するはず
- 手動デプロイの場合も、修正済みのスクリプトを使用すれば問題なし


