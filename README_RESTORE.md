# Container Browser (Regular Edition) - Workspace Restore

## 概要
本ワークスペースは、Kameleo 版とは独立した「通常版（Electron + BrowserView システム）」の復元環境です。

## 配置先
- **通常版**: `C:\Users\Administrator\workspace\container-browser` (本リポジトリ)
- **Kameleo 版**: `C:\Users\Administrator\workspace\container-browser-for-kameleo`

## 復元・セットアップ手順
1. **Repository Clone**:
   ```bash
   git clone https://github.com/revivaleva/container-browser C:\Users\Administrator\workspace\container-browser
   ```
2. **Install**:
   ```bash
   npm install
   ```
3. **Local Settings**:
   - `.env.example` をコピーして `.env` を作成します。
   - `settings.example.json` を参考に、必要に応じて `%APPDATA%\container-browser\config.json` を調整してください。
   - **重要**: Kameleo 版と同時に起動する場合は、ポートの衝突にご注意ください。

## 起動手順
```bash
npm run dev
```
デフォルトでは Port `5173` で待機します。

## 運用ルール
- ローカルデータ（`local/`, `data/`, `profiles/`, `*.db`, `*.log` 等）は Git に含めないでください。
- 詳細は [Antigravity Workspace Policy](docs/operations/antigravity-workspace.md) および [Local Data Policy](docs/operations/local-data-policy.md) を参照してください。
