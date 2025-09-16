param()

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
New-Item -ItemType Directory -Force -Path logs | Out-Null

function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -File logs\workaround.log -Append | Out-Null }

# npm/npx は PowerShell ラッパーではなく cmd 実体を使う
$NPM = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source; if(-not $NPM){ $NPM = "C:\Program Files\nodejs\npm.cmd" }
$NPX = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source; if(-not $NPX){ $NPX = "C:\Program Files\nodejs\npx.cmd" }

try { $nodeV=(& node -v) 2>$null } catch { $nodeV="unknown" }
try { $npmV =(& $NPM -v) 2>$null } catch { $npmV ="unknown" }
try { $npxV =(& $NPX -v) 2>$null } catch { $npxV ="unknown" }
Log "[env] node=$nodeV npm=$npmV npx=$npxV"

# 1) 依存を scripts 無効で入れる
Log "[1] npm ci --ignore-scripts"
$p = Start-Process -FilePath $NPM -ArgumentList @('ci','--ignore-scripts','--foreground-scripts') -NoNewWindow -Wait -PassThru `
     -RedirectStandardOutput logs\npm_ci_ignore.out -RedirectStandardError logs\npm_ci_ignore.err
Log "[1] exit=$($p.ExitCode)"; if($p.ExitCode -ne 0){ throw "npm ci --ignore-scripts failed" }

# 2) install-app-deps を手動実行
Log "[2] npx electron-builder install-app-deps"
$p = Start-Process -FilePath $NPX -ArgumentList @('electron-builder','install-app-deps') -NoNewWindow -Wait -PassThru `
     -RedirectStandardOutput logs\install_app_deps.out -RedirectStandardError logs\install_app_deps.err
Log "[2] exit=$($p.ExitCode)"; if($p.ExitCode -ne 0){ throw "install-app-deps failed" }

# 3) ビルド（公開なし）
Log "[3] build"
$p = Start-Process -FilePath $NPX -ArgumentList @('electron-builder','--win','--x64','--publish','never') -NoNewWindow -Wait -PassThru `
     -RedirectStandardOutput logs\build_only.out -RedirectStandardError logs\build_only.err
Log "[3] exit=$($p.ExitCode)"; if($p.ExitCode -ne 0){ throw "build failed" }

# 4) 生成物確認
Log "[4] dist listing"
if(Test-Path dist){
  Get-ChildItem dist -Recurse -Include *.exe,*.yml,*.blockmap | Sort-Object LastWriteTime -Descending |
    Tee-Object -File logs\dist_listing.txt | Out-Null
}else{
  Log "[4] dist not found"
}
Log "DONE"
exit 0





