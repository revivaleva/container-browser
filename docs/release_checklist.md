今回のリリース運用チェックリスト（この順で実行・記録すればスムーズ）

- 1) バージョン更新
  - `package.json` の `version` をインクリメントしてコミットする。
  - 例: `git add package.json && git commit -m "chore(release): bump version to x.y.z"`

- 2) Git タグ作成
  - コミット後にタグを作成して push する: `git tag v<version> && git push origin HEAD && git push origin v<version>`

- 3) ビルド（ローカル / CI）
  - ローカル: `npm run build` を実行し、`out/` が生成されることを確認する。ログは `logs/build_YYYYMMDD_HHMMSS.log` に保存する。
  - CI: ビルド完了の Actions run URL を取得し共有する。

- 4) 配置スクリプト実行
  - スクリプトで配置する（推奨）: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-publish-steps.ps1`。
  - もしくは個別に: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\update-release.ps1 -Version <version> -DistributionId <id> -Bucket container-browser-updates`
  - スクリプト実行ログは `logs/` に必ず残す（例: `logs/run_publish_steps.log`）。

- 5) マニフェスト検証
  - `latest.yml` を取得して `files[0].url` と `packages.x64.path` が CDN（https://updates.threadsbooster.jp）を指していることを確認する。
  - コマンド例:
    - `curl -sSLo logs/cdn_latest.yml https://updates.threadsbooster.jp/latest.yml`
    - `grep -E "url:|path:" logs/cdn_latest.yml -n`

- 6) HEAD / Range 検証
  - 抽出した `.nsis.7z` に対してヘッダと部分取得を確認する:
    - `curl -I <cdn>/container-browser-<version>-x64.nsis.7z` → 200
    - `curl -A "INetC/1.0" -r 0-1048575 -D - -o NUL <cdn>/container-browser-<version>-x64.nsis.7z` → 206

- 7) インストーラ HEAD 検証
  - `curl -I https://updates.threadsbooster.jp/nsis-web/ContainerBrowser-Web-Setup-<version>.exe` → 200

- 8) CloudFront invalidation
  - スクリプトが invalidation を作成したら `logs/publish_inv_resp.txt` を保存し、Status が `Completed` になるまで待つ。
  - CLI 確認例: `aws cloudfront get-invalidation --distribution-id <id> --id <invalidation-id>`

- 9) 報告・保存
  - 実施したコマンド、主要ログパス（`logs/*`）、GitHub Actions run URL、作成したタグ名をリリースノート／チケットに記録する。

このチェックリストを `project_rules.mdc` と連動させ、以降のリリース作業ではこの `docs/release_checklist.md` を参照してください。


