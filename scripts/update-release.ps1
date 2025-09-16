$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

$argsCount = $args.Count
$Bucket = if($argsCount -ge 1) { $args[0] } else { 'container-browser-updates' }
$DistributionId = if($argsCount -ge 2) { $args[1] } else { 'E1Q66ASB5AODYF' }
$Cdn = if($argsCount -ge 3) { $args[2] } else { 'https://updates.threadsbooster.jp' }
$SourceDir = if($argsCount -ge 4) { $args[3] } else { '' }
$SkipBuild = if($argsCount -ge 5) { [bool]$args[4] } else { $false }

New-Item -Type Directory -Force logs | Out-Null
$ts   = Get-Date -Format yyyyMMdd_HHmmss
$tag  = "upd_$ts"
$logB = "logs\$tag.build"
$logM = "logs\$tag.main"

# 0) 掴みそうなプロセス停止
'Container Browser','electron','electron.exe','app-builder','electron-builder','node' |
  ForEach-Object { if($_){ Get-Process -Name $_ -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } }

# 1) package.json の健全性
if(!(Test-Path package.json)){ throw "package.json がありません" }
try{
  $pj = Get-Content package.json -Raw | ConvertFrom-Json
  "package.json version: $($pj.version)" | Tee-Object -FilePath "$logM.out" -Append | Out-Host
}catch{
  throw "package.json が壊れています: $($_.Exception.Message)"
}

# 2) nsis-web 生成物の用意
$nsisDir = $null
if($SourceDir){ $nsisDir = $SourceDir }

if(-not $nsisDir -and -not $SkipBuild){
  $npx = (Get-Command npx.cmd).Source
  $outDir = "dist_update_$ts"
  $arg = ('electron-builder --win nsis-web --x64 --publish never -c.directories.output="{0}" -c.win.target="nsis-web"' -f $outDir)
  $p = Start-Process -FilePath $npx -ArgumentList $arg -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput "$logB.out" -RedirectStandardError "$logB.err"
  if($p.ExitCode -ne 0){
    "`n== BUILD OUT (tail) =="; Get-Content "$logB.out" -Tail 120
    "`n== BUILD ERR (tail) =="; Get-Content "$logB.err" -Tail 120
    throw "nsis-web ビルド失敗: ExitCode=$($p.ExitCode)"
  }
  $nsisDir = Join-Path $outDir 'nsis-web'
}

if(-not $nsisDir){
  # フォールバック：直近の dist_update_* の nsis-web
  $nsisDir = Get-ChildItem -Directory dist_update_* -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Desc |
    ForEach-Object { Join-Path $_.FullName 'nsis-web' } |
    Where-Object { Test-Path (Join-Path $_ 'latest.yml') } |
    Select-Object -First 1
}

if(-not $nsisDir -or -not (Test-Path (Join-Path $nsisDir 'latest.yml'))){
  throw "nsis-web 生成物が見つかりません（latest.yml が無い）: $nsisDir"
}

"NSIS_DIR: $nsisDir" | Tee-Object -FilePath "$logM.out" -Append | Out-Host
Get-ChildItem $nsisDir | Tee-Object -FilePath "$logM.out" -Append | Out-Host

# 3) S3 反映
aws s3 cp (Join-Path $nsisDir 'latest.yml') "s3://$Bucket/latest.yml" --no-progress | Out-Null
aws s3 cp  $nsisDir "s3://$Bucket/nsis-web/" --recursive --no-progress --cache-control "public,max-age=300" | Out-Null

# 4) CloudFront 失効
$inv = @{ Paths=@{ Quantity=2; Items=@('/latest.yml','/nsis-web/*') }; CallerReference="autoupd-$ts" } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_$ts.json",$inv,[Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://logs/inv_$ts.json | Out-Null

# 5) 配信検証（200/206）
$cdnLatest = "logs\cdn_latest.yml"
curl.exe -sSLo $cdnLatest "$Cdn/latest.yml" | Out-Null
$y   = Get-Content $cdnLatest -Raw
$pkg = ([regex]::Matches($y,'(?im)[\w\-.]+\.nsis\.7z') | Select-Object -Last 1).Value
if([string]::IsNullOrWhiteSpace($pkg)){ throw "latest.yml から .nsis.7z 名を抽出できません" }
"PKG: $pkg" | Tee-Object -FilePath "$logM.out" -Append | Out-Host

curl.exe -I "$Cdn/latest.yml"     | Select-String '^HTTP/' | Tee-Object -FilePath "$logM.out" -Append | Out-Host
curl.exe -I "$Cdn/nsis-web/$pkg"  | Select-String '^HTTP/' | Tee-Object -FilePath "$logM.out" -Append | Out-Host
curl.exe -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$Cdn/nsis-web/$pkg" | Select-String '^HTTP/' | Tee-Object -FilePath "$logM.out" -Append | Out-Host

"`n== Web Setup (固定URL) =="        | Tee-Object -FilePath "$logM.out" -Append | Out-Host
"$Cdn/nsis-web/ContainerBrowser-Web-Setup.exe" | Tee-Object -FilePath "$logM.out" -Append | Out-Host
"`n== Offline Setup (参考) =="        | Tee-Object -FilePath "$logM.out" -Append | Out-Host
"$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Tee-Object -FilePath "$logM.out" -Append | Out-Host

"`n完了。ログ: $logM.out / $logB.out / $logB.err" | Out-Host
