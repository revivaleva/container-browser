# Kameleo 版 Container Browser 仕様書 (KAMELEO_SPEC)

## 1. アーキテクチャ構成

Kameleo 版 Container Browser は、4つの役割層で構成されています。

```mermaid
graph TD
  A[CSP: 外部呼び出し側] -->|Internal API: 3001| B[Container Browser: 本アプリ]
  B -->|Profile API: 5050| C[Kameleo Local API / Service]
  B -->|CDP Connect / CDP Operations| D[Playwright (Chrome DevTools Protocol)]
  D -->|CDP Actions| C
```

| 層 | 役割 | 備考 |
| --- | --- | --- |
| **CSP** | ブラウザコンテナの作成、起動、操作を依頼。 | REST API 経由。 |
| **Container Browser** | コンテナ、DB、ウィンドウ管理、および Kameleo / Playwright の仲介。 | 本リポジトリの主要範囲。 |
| **Kameleo Local API** | ブラウザ指紋（Fingerprint）の管理、プロファイル作成、開始、停止。 | ローカル PC (localhost:5050) で稼働。 |
| **Playwright** | 実際にプロファイル内で行われる DOM 操作やナビゲーション。 | Kameleo が提供する CDP Websocket 経由で接続。 |

---

## 2. 実行モデル (Single-tab 制約)

本バージョンは、**1コンテナにつき 1ウィンドウかつ単一のタブ (Single Page) の操作**を前提としています。

- **理由**: Kameleo 側がブラウザ全体を制御し、Electron 側はそれを制御する「シェル」として機能するため、Electron の `BrowserView` 埋め込みによる高度なマルチタブ管理は現在行いません。
- **UI**: Electron のウィンドウは、制御バー（URL 入力、ステータス表示）を含む「シェル」のみ。実際のブラウザコンテンツは Kameleo 側で表示されます。

---

## 3. Profile 管理とライフサイクル

Kameleo プログラム（本アプリ）は、2つのプロファイル管理モードを持ちます。

### 3.1. プロファイル管理モード (`profileMode`)

| モード | 定義 | 停止ポリシー (`Stop Policy`) |
| --- | --- | --- |
| **`managed`** | (Default) コンテナ作成時、本アプリが Kameleo プロファイルを生成。 | **ウィンドウを閉じると自動停止する。** |
| **`attached`** | 既存の Kameleo プロファイル ID を本アプリのコンテナに紐付けた状態。 | **本プロセスで Start させた場合のみ停止する。** (StartedByThisProcess フラグで判定) |

### 3.2. 自動停止ロジック (Owner-based Stop Policy)
- `attached` プロファイルが既に外部（他プロセス）によって `running` 状態であった場合、本アプリでそのコンテナを「開く（アタッチ）」ことは可能ですが、ウィンドウを閉じても Kameleo 側での停止（`stopProfile`）は行いません。
- これにより、Cloud や Shared プロファイルを他ユーザーと共有して使い続ける運用を保護します。

---

## 4. プロキシ・指紋更新方針 (Proxy / Fingerprint Policy)

- **Managed モード**: 起動時に、DB に保存されている最新のプロキシ情報を Kameleo プロファイルに自動適用します。
- **Attached モード**: 意図しない設定変更を防ぐため、**自動更新を行いません。** 設定変更が必要な場合は、Kameleo 側または明示的な API 経由で操作することを想定しています。
- **更新条件**: プロキシの更新は、副作用を避けるために対象プロファイルが `stopped` 状態であるときのみ試行されます。

---

## 5. 内部 API (Port 3001)

詳細な API 仕様は **[docs/INTERNAL_API.md](INTERNAL_API.md)** を参照。

以下はアーキテクチャ上の概要。

### Kameleo ステータス・プロファイル
- `GET /internal/kameleo/status`: Kameleo Local API との疎通確認。
- `GET /internal/kameleo/profiles`: 利用可能なプロファイル一覧（Cloud/Local、状態、タグを含む）。

### コンテナ操作
- `POST /internal/containers/create`: コンテナ作成。`environment`: `{ deviceType, os, browser }` で指紋を指定。
- `POST /internal/containers/{id}/attach`: 既存のプロファイル ID をコンテナに紐付け（`attached` モード）。
- `POST /internal/containers/{id}/detach`: 紐付けを解除。`managed` モードに戻る。

### 実行操作 (`/internal/exec`)
Playwright (CDP) 経由でブラウザを操作する。対応コマンド: `navigate`, `click`, `clickAndType`, `type`, `eval`, `mouseMove`, `mouseClick`, `humanClick`, `cloudflareClick`, `setCookie`, `getCookies`, `solve_captcha`, `setFileInput`, `getElementRect`, `save_media`。

各コマンドの詳細・パラメータ・レスポンスは [INTERNAL_API.md](INTERNAL_API.md) を参照。

---

## 6. 環境構築の前提

- **Kameleo**: ローカル PC 上で **Kameleo が Port 5050 で稼働している必要があります。**
- **Git / Repo**: プロファイルの実体データ、DB ファイル、スクリーンショット、ログなどは `.gitignore` により除外される運用です。秘密情報やローカル固有パスをリポジトリに含めないでください。

---
