# CloudFront key rotation - 実行ログ

日時: 2025-09-11T

目的: 新しい Key-Pair-Id (`K1LGK3C9516OZR`) と秘密鍵で署名した URL が CloudFront で受け入れられることを確認するためのローカル検証記録。

テストコマンド:
- 署名 URL 生成: `CF_KEYPAIR_ID=K1LGK3C9516OZR CF_PRIVATE_KEY_PATH=cf_sign_priv.pem CF_TEST_URL=https://updates.threadsbooster.jp/latest.yml npm run cf:sign:test`
- 未署名 HEAD: `curl -I https://updates.threadsbooster.jp/latest.yml`
- 署名付き HEAD: `curl -I "<signed url>"`

生成された署名 URL:

```
https://updates.threadsbooster.jp/latest.yml?Expires=1757586594&Policy=...&Signature=...&Key-Pair-Id=K1LGK3C9516OZR
```

HEAD リクエスト結果:

- 未署名 URL の HEAD: curl エラー: Could not resolve host: updates.threadsbooster.jp
- 署名付き URL の HEAD: curl エラー: Could not resolve host: updates.threadsbooster.jp

考察:
- 署名 URL はスクリプトで正常に生成されることを確認しました（`aws-cloudfront-sign` を利用）。
- ただし、本環境から `updates.threadsbooster.jp` の DNS 解決ができず、実際の HTTP ステータス（403/200）を確認できませんでした。これはローカルネットワーク／DNS 設定、または CI/環境のファイアウォールによる制約が原因の可能性があります。

次の手順（推奨）:
1. ネットワーク環境で `updates.threadsbooster.jp` の名前解決が可能なマシン（例：パブリックな Linux 環境、あるいは CI）で同様の HEAD テストを実行してください。
2. もし CloudFront の設定変更が直近で行われた場合、`aws cloudfront get-distribution --id E1Q66ASB5AODYF` の `Status` が `Deployed` であることを確認してください（`InProgress` の場合は反映待ち）。
3. 反映待ち/確認が不要であれば、本ドキュメントにテストの 403/200 の出力（日時付）を追記してください。

注記（旧鍵の扱い）:
- アカウント内の既存 Public Key の一覧は `aws cloudfront list-public-keys` で取得可能です。不要な公開鍵の削除は手動で行ってください（自動削除は行いません）。

署名ロジックの検出結果:
- `scripts/generate_cf_signed_url.ps1` が CloudFront 用の署名 URL を生成するスクリプトとして存在します。OpenSSL を利用してポリシーに署名し、`Policy`/`Signature`/`Key-Pair-Id` を付与する方式です。
- 他に `aws-cloudfront-sign` を使う Node スクリプトは本リポジトリ内では見つかりませんでした（`scripts/cf-sign-test.cjs` は今回の検証用に追加したものです）。

推奨する本番側切替方針:
- 既存 PowerShell スクリプトを使う場合は、`$KeyId` を `K1LGK3C9516OZR` に置換、またはスクリプトを改修して `KeyId` と `PrivateKeyPath` を環境変数/Secrets から読み込むようにしてください。
- CI/自動化で運用している場合は、Secrets の中身（PEM 改行をそのまま含む）を更新するだけで差し替え可能です。コード側は同じシークレット名を使う方針で中身を差し替えるのが安全です。

CI / Secrets チェックリスト（人手作業が必要）:
- **必要な Secret 名と内容（例）**:
  - `CF_KEYPAIR_ID`: `K1LGK3C9516OZR`
  - `CF_PRIVATE_KEY`: PEM 本文（先頭の `-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----` まで、改行を含む）
  - 代替: `CF_PRIVATE_KEY_SSM_PARAM`（SSM パラメータ名を格納して参照する方式）
- **確認項目**:
  - CI ワークフロー / スクリプトが `CF_PRIVATE_KEY` をどのように読み込むか（直接ファイル書き出し or 環境変数経由）を確認し、PEM 改行が保持される方法で登録する。
  - GitHub Actions 等で改行が壊れる場合は `|` を使ったマルチラインシークレットや Base64 エンコードで保存する方法を利用する。

ロールバック手順（PR に添付する簡易手順）:
1. 署名側（署名を生成するスクリプトまたは CI Secrets）の `CF_KEYPAIR_ID` を旧 Key-Pair-Id に戻す。
2. `CF_PRIVATE_KEY` を旧秘密鍵の PEM に戻す（改行を含む）。
3. 署名生成を行って問題が解消するか確認する（同一の CloudFront 設定であれば旧鍵でも受け入れられる）。

備考:
- 本検証では DNS 解決できなかったため HTTP レスポンスの 403/200 の確定的証跡は取得できていません。ネットワーク制約が解除できる環境で追試願います。



## Rotation check @ 2025-09-11 20:05:09 +09:00

**Unsigned** (https://updates.threadsbooster.jp/latest.yml)
```
curl.exe :   % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
At C:\Users\revival\projects\container-browser\scripts\cf-rotation-check.ps1:33 char:18
+ $HeadUnsigned = (curl.exe -I $env:CF_TEST_URL 2>&1 | Out-String)
+                  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (  % Total    % ...  Time  Current:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
                                 Dload  Upload   Total   Spent    Left  Speed

  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0curl: (6) Could not resolve host: updates.threadsbooster.jp
```

**Signed**
```
curl.exe :   % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
At C:\Users\revival\projects\container-browser\scripts\cf-rotation-check.ps1:37 char:16
+ $HeadSigned = (curl.exe -I "$SignedUrl" 2>&1 | Out-String)
+                ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (  % Total    % ...  Time  Current:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
                                 Dload  Upload   Total   Spent    Left  Speed

  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0curl: (6) Could not resolve host: updates.threadsbooster.jp
```

## Detailed 403 diagnosis @ 2025-09-11 20:23:21 +09:00




### 2025-09-11 22:58:32 +09:00
- Dist: E1Q66ASB5AODYF
- KG  : c119acbc-8c6f-4fac-b402-c3df3493ca89
- New : K3OBNT6H3SWSZM
- Old : K1LGK3C9516OZR
- CF  : HTTP/1.1 403 Forbidden / HTTP/1.1 200 OK
- ALIAS: HTTP/1.1 403 Forbidden / HTTP/1.1 200 OK
### 2025-09-12 05:42:52 +09:00
- Dist: E1Q66ASB5AODYF
- KG  : c119acbc-8c6f-4fac-b402-c3df3493ca89
- New : K3OBNT6H3SWSZM
- Old : K1LGK3C9516OZR
- CF  : HTTP/1.1 403 Forbidden / HTTP/1.1 200 OK
- ALIAS: HTTP/1.1 403 Forbidden / HTTP/1.1 200 OK
