$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

$argsCount = $args.Count
$Bucket = if($argsCount -ge 1) { $args[0] } else { 'container-browser-updates' }
$DistributionId = if($argsCount -ge 2) { $args[1] } else { 'E1Q66ASB5AODYF' }
$Cdn = if($argsCount -ge 3) { $args[2] } else { 'https://updates.threadsbooster.jp' }
$Exe = if($argsCount -ge 4) { $args[3] } else { '' }
$SkipBuild = if($argsCount -ge 5) { [bool]$args[4] } else { $false }

New-Item -Type Directory -Force logs | Out-Null
$ts   = Get-Date -Format yyyyMMdd_HHmmss
$tag  = "offline_$ts"
$logB = "logs\$tag.build"
$logM = "logs\$tag.main"

# 0) 掴みそうなプロセスを停止（失敗は無視）
'Container Browser','electron','electron.exe','app-builder','electron-builder','node' |
  ForEach-Object { if($_){ Get-Process -Name $_ -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } }

# 1) EXEの決定
$selected = $null
if($Exe -and (Test-Path $Exe)){ $selected = Get-Item $Exe }

if(-not $selected -and -not $SkipBuild){
  # 新規ビルド
  $npx = (Get-Command npx.cmd).Source
  $out = "dist_offline_$ts"
  # prepare argument list for Start-Process to avoid complex quoting
  $argList = @(
    'electron-builder',
    '--win', 'nsis',
    '--x64',
    '--publish', 'never',
    ('-c.directories.output=' + $out),
    '-c.nsis.oneClick=true',
    '-c.nsis.perMachine=false',
    '-c.nsis.artifactName=ContainerBrowser-Offline-Setup.exe'
  )
  $p = Start-Process -FilePath $npx -ArgumentList $argList -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput "$logB.out" -RedirectStandardError "$logB.err"
  if($p.ExitCode -ne 0){
    "`n== BUILD OUT (tail) =="; Get-Content "$logB.out" -Tail 120
    "`n== BUILD ERR (tail) =="; Get-Content "$logB.err" -Tail 120
    throw "オフラインビルド失敗: ExitCode=$($p.ExitCode)"
  }

  if(Test-Path $out){
    $selected = Get-ChildItem "$out\*.exe" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch 'Web-Setup' } |
      Sort-Object LastWriteTime -Desc | Select-Object -First 1
  }
}

if(-not $selected){
  # フォールバック：直近の dist_offline_* を走査
  $selected = Get-ChildItem -Directory dist_offline_* -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Desc |
    ForEach-Object {
      Get-ChildItem $_ -File -Filter *.exe |
        Where-Object { $_.Name -notmatch 'Web-Setup' } |
        Sort-Object LastWriteTime -Desc | Select-Object -First 1
    } | Select-Object -First 1
}

if(-not $selected){ throw "オフラインEXEが見つかりません（ビルド or -Exe で指定してください）" }

$selPath = $selected.FullName
$logMOut = $logM + '.out'
$logBOut = $logB + '.out'
$logBErr = $logB + '.err'

"SELECTED: $selPath" | Out-File -FilePath $logMOut -Encoding utf8 -Append
("SHA256 : {0}" -f (Get-FileHash $selPath -Algorithm SHA256).Hash) | Out-File -FilePath $logMOut -Encoding utf8 -Append
("Size   : {0} bytes" -f (Get-Item $selPath).Length) | Out-File -FilePath $logMOut -Encoding utf8 -Append

Write-Host "SELECTED: $selPath"
Write-Host ("SHA256 : " + (Get-FileHash $selPath -Algorithm SHA256).Hash)
Write-Host ("Size   : " + (Get-Item $selPath).Length + " bytes")

# 2) S3へ固定名でアップロード
aws s3 cp $selPath "s3://$Bucket/nsis-web/ContainerBrowser-Offline-Setup.exe" --no-progress --content-type application/octet-stream --metadata-directive REPLACE --cache-control 'public,max-age=300' | Out-Null

# 3) CloudFront 無効化（単体＋ディレクトリ）
$inv = @{
  Paths = @{ Quantity = 2; Items = @('/nsis-web/ContainerBrowser-Offline-Setup.exe','/nsis-web/*') }
  CallerReference = "offline-$ts"
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_off_$ts.json",$inv,[Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://logs/inv_off_$ts.json | Out-Null

# 4) HEAD検証
$head = & curl.exe -I "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" 2>&1
[IO.File]::AppendAllText($logMOut, $head + "`n", [System.Text.Encoding]::UTF8)
Write-Host $head

Write-Host ""; Write-Host "完了。固定URL:"; Write-Host "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe"; Write-Host "ログ: $logMOut / $logBOut / $logBErr"
