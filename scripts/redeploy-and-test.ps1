param(
  [string]$Bucket         = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF',
  [string]$Cdn            = 'https://updates.threadsbooster.jp',
  [switch]$SkipOnline,
  [switch]$SkipOffline,
  [switch]$SkipInstallTest
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -Type Directory -Force logs | Out-Null
$ts   = Get-Date -Format yyyyMMdd_HHmmss
$tag  = "redeploy_$ts"
$logM = "logs\$tag.main.out"

function Note($m){ $m | Tee-Object -FilePath $logM -Append | Out-Host }
function Tail($path,$n=120){ if(Test-Path $path){ Get-Content $path -Tail $n } }

# 0) stop processes
foreach($n in @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')){
  try{ Get-Process -Name $n -ErrorAction Stop | Stop-Process -Force -ErrorAction SilentlyContinue }catch{}
}

# 1) current status
if(!(Test-Path package.json)){ throw "package.json がありません" }
try { $pj = Get-Content package.json -Raw | ConvertFrom-Json } catch { throw "package.json 破損: $($_.Exception.Message)" }
Note "package.json name=$($pj.name) version=$($pj.version)"

# CDN latest
$cdnYml = "logs\cdn_latest_$ts.yml"
try{ & "$env:SystemRoot\System32\curl.exe" -sSLo $cdnYml "$Cdn/latest.yml" }catch{}
if(Test-Path $cdnYml){
  $y = Get-Content $cdnYml -Raw
  $curPkg = ([regex]::Matches($y,'(?im)[\w\-.]+\.nsis\.7z') | Select-Object -Last 1).Value
  Note "CDN current: pkg=$curPkg"
}

# 2) online publish
if(-not $SkipOnline){
  if(Test-Path "scripts\update-release.ps1"){
    Note "== run: update-release.ps1"
    $p = Start-Process -FilePath powershell -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","scripts\update-release.ps1" -NoNewWindow -Wait -PassThru `
         -RedirectStandardOutput "logs\$tag.update.out" -RedirectStandardError "logs\$tag.update.err"
    if($p.ExitCode -ne 0){ Note "update-release: FAILED (ExitCode=$($p.ExitCode))"; Note "`n== update.err (tail) =="; Tail "logs\$tag.update.err" }
    else{ Note "update-release: OK" }
  } else { Note "scripts/update-release.ps1 が見つかりません（スキップ）" }
}

# 3) offline publish
if(-not $SkipOffline){
  if(Test-Path "scripts\offline-release.ps1"){
    Note "== run: offline-release.ps1"
    $p2 = Start-Process -FilePath powershell -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","scripts\offline-release.ps1" -NoNewWindow -Wait -PassThru `
          -RedirectStandardOutput "logs\$tag.offline.out" -RedirectStandardError "logs\$tag.offline.err"
    if($p2.ExitCode -ne 0){ Note "offline-release: FAILED (ExitCode=$($p2.ExitCode))"; Note "`n== offline.err (tail) =="; Tail "logs\$tag.offline.err" }
    else{ Note "offline-release: OK" }
  } else { Note "scripts/offline-release.ps1 が見つかりません（スキップ）" }
}

# 4) CDN health
$cdnY2 = "logs\cdn_latest_post_$ts.yml"
try{ & "$env:SystemRoot\System32\curl.exe" -sSLo $cdnY2 "$Cdn/latest.yml" }catch{}
if(Test-Path $cdnY2){
  $y2   = Get-Content $cdnY2 -Raw
  $pkg2 = ([regex]::Matches($y2,'(?im)[\w\-.]+\.nsis\.7z') | Select-Object -Last 1).Value
  Note "POST CDN pkg=$pkg2"
  & "$env:SystemRoot\System32\curl.exe" -I "$Cdn/latest.yml" | Select-String '^HTTP/' | Tee-Object -FilePath $logM -Append | Out-Host
  & "$env:SystemRoot\System32\curl.exe" -I "$Cdn/nsis-web/$pkg2" | Select-String '^HTTP/' | Tee-Object -FilePath $logM -Append | Out-Host
  & "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$Cdn/nsis-web/$pkg2" | Select-String '^HTTP/' | Tee-Object -FilePath $logM -Append | Out-Host
}

# 5) install test
if(-not $SkipInstallTest){
  $offUrl = "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe"
  $dl     = Join-Path $env:TEMP "ContainerBrowser-Offline-Setup_$ts.exe"
  Note "Download: $offUrl -> $dl"
  & "$env:SystemRoot\System32\curl.exe" -sSLo $dl $offUrl
  if(!(Test-Path $dl)){ throw "オフライン EXE のダウンロードに失敗: $offUrl" }
  Unblock-File -LiteralPath $dl
  $ilog = "logs\nsis_install_$ts.log"
  Note "Run installer with log: $ilog"
  Start-Process -FilePath $dl -ArgumentList "/LOG=`"$ilog`"" -Wait
  if(Test-Path $ilog){ Note "`n== INSTALL LOG (tail) =="; Tail $ilog 80 | Tee-Object -FilePath $logM -Append | Out-Host } else { Note "インストーラログが見つかりません: $ilog" }

  # installed check
  $cand = @("$env:LOCALAPPDATA\Programs\Container Browser","$env:LOCALAPPDATA\Programs\container-browser")
  $inst = $cand | Where-Object { Test-Path $_ } | Select-Object -First 1
  if(-not $inst){ throw "インストール先が見つかりません: $($cand -join ', ')" }
  $exePath = Join-Path $inst 'Container Browser.exe'
  if(!(Test-Path $exePath)){ $exePath = Join-Path $inst 'container-browser.exe' }
  if(Test-Path $exePath){
    $ver = (Get-Item $exePath).VersionInfo.ProductVersion
    Note "Installed EXE : $exePath"
    Note "ProductVersion: $ver"
  } else { Note "実行ファイルが見つかりません: $inst" }
  $updY = Join-Path (Join-Path $inst 'resources') 'app-update.yml'
  if(Test-Path $updY){ Note "`n== app-update.yml =="; Get-Content $updY -TotalCount 20 | Tee-Object -FilePath $logM -Append | Out-Host }
}

Note "`nDone. Main log: $logM"


