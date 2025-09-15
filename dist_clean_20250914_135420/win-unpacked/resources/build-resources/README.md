# build-resources

このフォルダにはインストーラーに使うリソース（アイコン等）を置きます。

必ず `icon.ico` を実際の ICO ファイルに置き換えてください。簡易的に PowerShell でダウンロードする例:

```powershell
Invoke-WebRequest -Uri "https://example.com/icon.ico" -OutFile "icon.ico"
```

アイコンを作成・変換するには ImageMagick やオンラインコンバータを使ってください。
