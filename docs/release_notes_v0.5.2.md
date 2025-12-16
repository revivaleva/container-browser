# Release Notes — v0.5.2

リリース日: 2025-01-XX

## 新機能

### Media Download API (`save_media` コマンド)

`/internal/exec` エンドポイントに新しい `save_media` コマンドを追加しました。Webページから画像・動画を抽出し、ローカルにダウンロード・保存できます。

#### 主な機能

- **CSS セレクタベースの抽出**: 指定したセレクタで画像・動画要素を抽出
  - `<img>` タグの `src` 属性
  - `<video>` タグの `poster` または `src` 属性
  - `<source>` タグの `src` 属性
- **自動ダウンロード**: 抽出したURLからファイルを自動ダウンロード
- **ファイル管理**: 
  - 指定したディレクトリに自動的にフォルダを作成
  - ファイル名は `media_0.jpg`, `media_1.mp4` のように自動付与
  - URLから拡張子を自動判定（フォールバック: 画像は `.jpg`, 動画は `.mp4`）
- **詳細な結果レポート**: 
  - 各ファイルのダウンロード結果（成功/失敗）
  - ファイルサイズ、MIMEタイプ
  - エラーメッセージ（失敗時）
  - 成功したファイルのパス一覧

#### 使用例

```bash
curl -X POST http://127.0.0.1:3001/internal/exec \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "container-id",
    "command": "save_media",
    "options": {
      "destination_folder": "./storage/media/threads",
      "folder_name": "nanogarden77203_123456789",
      "selectors": [
        {"selector": "article img[src*=\"http\"]", "type": "image"},
        {"selector": "article video", "type": "video"}
      ],
      "timeoutMs": 60000
    }
  }'
```

#### 制限事項

- 最大ファイル数: 100ファイル/リクエスト
- 最大ファイルサイズ: 500MB/ファイル
- タイムアウト: デフォルト60秒（設定可能）
- HTTP/HTTPS URLのみ対応（相対URLは非対応）

#### レスポンス例

**成功時:**
```json
{
  "ok": true,
  "folder_path": "./storage/media/threads/nanogarden77203_123456789",
  "files": [
    {
      "index": 0,
      "type": "image",
      "filename": "media_0.jpg",
      "local_path": "./storage/media/threads/nanogarden77203_123456789/media_0.jpg",
      "file_size": 245632,
      "media_type": "image/jpeg",
      "success": true
    }
  ],
  "summary": {
    "total": 1,
    "succeeded": 1,
    "failed": 0,
    "paths_comma_separated": "./storage/media/threads/nanogarden77203_123456789/media_0.jpg",
    "total_bytes": 245632
  }
}
```

**部分失敗時:**
一部のファイルのダウンロードが失敗した場合でも、成功したファイルは保存され、`ok: false` で詳細な結果が返されます。

## ドキュメント更新

- `PROJECT_OVERVIEW.md` に `save_media` コマンドの詳細な説明を追加
- リクエスト/レスポンスの例を追加
- エラーハンドリングの説明を追加

## 技術的改善

- メディアダウンロード用のユーティリティ関数を追加
- ファイルサイズとMIMEタイプの自動検出
- URL検証と重複排除の実装
- エラーハンドリングの強化（部分失敗対応）

## 既知の制限

- リダイレクトは最大5回まで
- 同一 `contextId` への並列 `save_media` リクエストは排他制御により409エラーを返します

## 次回予定

- ダウンロード進捗のリアルタイム通知
- リトライ機能の追加
- より詳細なログ出力

