$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -Type Directory -Force logs | Out-Null
$ts  = Get-Date -Format yyyyMMdd_HHmmss
$log = "logs\resume_$ts"

# 0) つかんでいそうなプロセス停止（安全版）
$procs = @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')
foreach($name in $procs){
  if([string]::IsNullOrWhiteSpace($name)){ continue }
  try {
    Get-Process -Name $name -ErrorAction Stop | Stop-Process -Force -ErrorAction SilentlyContinue
  } catch { }  # 存在しなければ無視
}

# 1) package.json 健全性チェック
if(!(Test-Path package.json)){ throw "package.json がありません" }
try{
  $pj = Get-Content package.json -Raw | ConvertFrom-Json
  "package.json version: $($pj.version)" | Tee-Object -FilePath "$log.out" -Append | Out-Host
}catch{
  throw "package.json が壊れています: $($_.Exception.Message)"
}

# 2) nsis-web ビルド（出力は dist_update_yyyymmdd_hhmmss/）
$npx = (Get-Command npx.cmd).Source
$out = "dist_update_$ts"
$arg = ('electron-builder --win nsis-web --x64 --publish never ' +
        '-c.directories.output="{0}" -c.win.target="nsis-web"' -f $out)
$p = Start-Process -FilePath $npx -ArgumentList $arg -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput "$log.build.out" -RedirectStandardError "$log.build.err"
if($p.ExitCode -ne 0){
  Write-Host "`n== BUILD OUT (tail) =="; Get-Content "$log.build.out" -Tail 120
  Write-Host "`n== BUILD ERR (tail) =="; Get-Content "$log.build.err" -Tail 120
  throw "ビルド失敗: ExitCode=$($p.ExitCode)"
}

# 3) 生成物確認
$nsisDir = Join-Path $out 'nsis-web'
if(!(Test-Path $nsisDir)){ throw "nsis-web 生成物が見つかりません: $nsisDir" }
Get-ChildItem $nsisDir | Tee-Object -FilePath "$log.out" -Append | Out-Host

# 4) 配布（S3 アップロード  CloudFront 無効化）
$BUCKET='container-browser-updates'
$DISTID='E1Q66ASB5AODYF'
$CDN='https://updates.threadsbooster.jp'

aws s3 cp (Join-Path $nsisDir 'latest.yml') "s3://$BUCKET/latest.yml" --no-progress | Out-Null
aws s3 cp  $nsisDir "s3://$BUCKET/nsis-web/" --recursive --no-progress --cache-control "public,max-age=300" | Out-Null

$inv = @{ Paths=@{ Quantity=2; Items=@('/latest.yml','/nsis-web/*') }; CallerReference="resume-$ts" } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_$ts.json",$inv,[Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DISTID --invalidation-batch file://logs/inv_$ts.json | Out-Null

# 5) CDN 検証（latest.yml 突合 & 200/206）
$yPath="logs\cdn_latest.yml"
& "$env:SystemRoot\System32\curl.exe" -sSLo $yPath "$CDN/latest.yml"
$y   = Get-Content $yPath -Raw
$pkg = ([regex]::Matches($y,'(?im)[\w\-.]+\.nsis\.7z') | Select-Object -Last 1).Value
"PKG: $pkg" | Tee-Object -FilePath "$log.out" -Append | Out-Host

& "$env:SystemRoot\System32\curl.exe" -I "$CDN/nsis-web/$pkg" | Select-String '^HTTP/' | Tee-Object -FilePath "$log.out" -Append | Out-Host
& "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$CDN/nsis-web/$pkg" | Select-String '^HTTP/' | Tee-Object -FilePath "$log.out" -Append | Out-Host

Write-Host "`n再開完了。ログ: $log.*"