# エクスポート進捗表示ガイド

## 概要

エクスポート処理の進捗をリアルタイムで確認できるようになりました。

## 使用方法

### 開発者ツールのコンソールから実行

1. **アプリを起動**
2. **開発者ツールを開く**（`F12`）
3. **コンソールタブを開く**
4. **進捗リスナーを設定:**

```javascript
// 進捗イベントを受け取るリスナーを設定
const unsubscribe = window.migrationAPI.onExportProgress((progress) => {
  const timestamp = new Date(progress.timestamp).toLocaleTimeString();
  if (progress.progress) {
    const { current, total, percent } = progress.progress;
    console.log(`[${timestamp}] ${progress.message} (${current}/${total}, ${percent}%)`);
  } else {
    console.log(`[${timestamp}] ${progress.message}`);
  }
});

// エクスポート実行
const exportResult = await window.migrationAPI.exportComplete({ includeProfiles: true });

// 進捗リスナーを解除（オプション）
unsubscribe();
```

### 進捗表示の例

```
[14:30:15] エクスポート開始: 5個のコンテナを処理します
[14:30:15] データベースデータをZIPに追加中...
[14:30:16] コンテナ処理中: Container 1 (1/5)
[14:30:16]   プロファイル追加中: container-id-1
[14:30:16]   ファイル処理中... 1件
[14:30:17]   Partition追加中: container-container-id-1
[14:30:17]   ファイル処理中... 100件
[14:30:18] コンテナ処理中: Container 2 (2/5)
[14:30:18]   プロファイル追加中: container-id-2
[14:30:19]   ファイル処理中... 200件
[14:30:20] アーカイブ中... 45.67 MB / 245.67 MB
[14:30:25] コンテナ処理完了: プロファイル 5件, Partitions 5件
[14:30:26] アーカイブ中... 245.67 MB / 245.67 MB (100%)
[14:30:26] エクスポート完了
```

## 進捗情報の内容

### メッセージ

- `エクスポート開始: N個のコンテナを処理します` - エクスポート開始
- `データベースデータをZIPに追加中...` - DBデータの追加
- `コンテナ処理中: <名前> (N/M)` - 各コンテナの処理状況
- `プロファイル追加中: <container-id>` - プロファイルの追加
- `Partition追加中: <partition-name>` - Partitionの追加
- `ファイル処理中... N件` - 処理済みファイル数（100件ごと）
- `アーカイブ中... X MB / Y MB` - アーカイブの進捗（サイズ）
- `エクスポート完了` - 完了

### 進捗オブジェクト（オプション）

```typescript
{
  current: number;  // 現在の処理数
  total: number;    // 合計数
  percent: number;  // パーセンテージ（0-100）
}
```

## 実装の詳細

### 進捗イベントの送信

メインプロセス（`src/main/ipc.ts`）から以下のタイミングで進捗を送信：

1. **エクスポート開始時** - コンテナ数の通知
2. **各コンテナ処理時** - コンテナ名と進捗（N/M）
3. **プロファイル/Partition追加時** - 追加中の通知
4. **ファイル処理時** - 100件ごとに通知
5. **アーカイブ進捗** - archiverの`progress`イベントから取得
6. **完了時** - 完了通知

### 進捗イベントの受信

レンダラープロセス（開発者ツールのコンソール）で：

```javascript
window.migrationAPI.onExportProgress((progress) => {
  // 進捗情報を処理
  console.log(progress.message);
  if (progress.progress) {
    console.log(`進捗: ${progress.progress.percent}%`);
  }
});
```

## トラブルシューティング

### 進捗が表示されない

**確認事項:**
- 進捗リスナーが正しく設定されているか
- 開発者ツールのコンソールが開いているか

**対処:**
```javascript
// リスナーを再設定
const unsubscribe = window.migrationAPI.onExportProgress((progress) => {
  console.log(progress);
});
```

### 進捗が途中で止まる

**原因:**
- 大きなファイルの処理中
- ディスクI/Oの負荷

**対処:**
- しばらく待つ（処理が続いている可能性）
- コンソールでエラーメッセージを確認

### メモリ使用量が増える

**原因:**
- 進捗イベントが大量に送信される場合

**対処:**
- 進捗表示を簡略化（100件ごとの通知のみ表示）
- 完了後にリスナーを解除

## カスタマイズ例

### 進捗バーを表示（簡易版）

```javascript
let lastPercent = 0;
const unsubscribe = window.migrationAPI.onExportProgress((progress) => {
  if (progress.progress) {
    const percent = progress.progress.percent;
    if (percent !== lastPercent) {
      const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
      console.log(`[${bar}] ${percent}%`);
      lastPercent = percent;
    }
  } else {
    console.log(progress.message);
  }
});

await window.migrationAPI.exportComplete({ includeProfiles: true });
unsubscribe();
```

### 時間の経過を表示

```javascript
const startTime = Date.now();
const unsubscribe = window.migrationAPI.onExportProgress((progress) => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[${elapsed}s] ${progress.message}`);
});

await window.migrationAPI.exportComplete({ includeProfiles: true });
unsubscribe();
```

## 関連ドキュメント

- `EXPORT_GUIDE.md` - エクスポート手順
- `EXPORT_OPTIMIZATION.md` - エクスポート最適化の詳細

