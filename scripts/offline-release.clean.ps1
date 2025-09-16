$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

param(
  [string]$Bucket         = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF',
  [string]$Cdn            = 'https://updates.threadsbooster.jp'
)

New-Item -Type Directory -Force logs | Out-Null
$ts   = Get-Date -Format yyyyMMdd_HHmmss
$tag  = "offline_$ts"
$logB = "logs\$tag.build"
$logM = "logs\$tag.main"

# 0) stop processes that may lock files
$procs = @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')
foreach($name in $procs){ try { Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }

# 1) prefer existing offline exe
$exe = $null
$candidates = Get-ChildItem -Directory dist_offline_* -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Desc |
  ForEach-Object {
    Get-ChildItem $_ -File -Filter *.exe |
      Where-Object { $_.Name -notmatch 'Web-Setup' } |
      Sort-Object LastWriteTime -Desc | Select-Object -First 1
  }
if($candidates -and $candidates.Count -gt 0){ $exe = $candidates[0].FullName }

# 2) build if needed
if(-not $exe){
  $npx = (Get-Command npx.cmd).Source
  $out = "dist_offline_$ts"
  $args = @('electron-builder','--win','nsis','--x64','--publish','never','-c.directories.output=' + $out,'-c.nsis.oneClick=true','-c.nsis.perMachine=false','-c.nsis.artifactName=ContainerBrowser-Offline-Setup.exe')
  $p = Start-Process -FilePath $npx -ArgumentList $args -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$logB.out" -RedirectStandardError "$logB.err"
  if($p.ExitCode -ne 0){
    Write-Host "`n== BUILD OUT (tail) =="; Get-Content "$logB.out" -Tail 120
    Write-Host "`n== BUILD ERR (tail) =="; Get-Content "$logB.err" -Tail 120
    throw "オフラインビルド失敗: ExitCode=$($p.ExitCode)"
  }
  if(Test-Path $out){
    $exe = Get-ChildItem "$out\*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1 -ExpandProperty FullName
  }
}

if(-not $exe){
  # fallback scan
  $found = Get-ChildItem -Directory dist_offline_* -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Desc | ForEach-Object {
    Get-ChildItem $_ -File -Filter *.exe | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1
  } | Select-Object -First 1
  if($found){ $exe = $found.FullName }
}

if(-not $exe){ throw "オフラインインストーラが見つかりません。" }

# report
"SELECTED: $exe" | Tee-Object -FilePath "$logM.out" -Append | Out-Host
"SHA256 : $((Get-FileHash $exe -Algorithm SHA256).Hash)" | Tee-Object -FilePath "$logM.out" -Append | Out-Host
"Size   : $((Get-Item $exe).Length) bytes" | Tee-Object -FilePath "$logM.out" -Append | Out-Host

# upload
aws s3 cp $exe "s3://$Bucket/nsis-web/ContainerBrowser-Offline-Setup.exe" --no-progress --content-type application/octet-stream --metadata-directive REPLACE --cache-control "public,max-age=300" | Out-Null

# invalidation
$inv = @{ Paths = @{ Quantity = 2; Items = @('/nsis-web/ContainerBrowser-Offline-Setup.exe','/nsis-web/*') }; CallerReference = "offline-$ts" } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_off_$ts.json",$inv,[Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://logs/inv_off_$ts.json | Out-Null

# HEAD and RANGE check
& "$env:SystemRoot\System32\curl.exe" -I "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Select-String '^HTTP/' | Tee-Object -FilePath "$logM.out" -Append | Out-Host
& "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Select-String '^HTTP/' | Tee-Object -FilePath "$logM.out" -Append | Out-Host

"`n完了。固定URL:`n$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe`nログ: $logM.out / $logB.out / $logB.err" | Out-Host


