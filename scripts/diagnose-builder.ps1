param()

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"
$ConfirmPreference     = "None"

New-Item -ItemType Directory -Force -Path logs | Out-Null
function Log([string]$m){ $ts=(Get-Date).ToString("yyyy-MM-dd HH:mm:ss"); "$ts $m" | Tee-Object -File logs\diagnose.log -Append | Out-Null }

Log "== START diagnose-builder (npm.cmd / npx.cmd) =="

# 実体の npm/npx を解決（PowerShell ラッパー *.ps1 を避ける）
$NPM = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $NPM) { $NPM = "C:\\Program Files\\nodejs\\npm.cmd" }
$NPX = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if (-not $NPX) { $NPX = "C:\\Program Files\\nodejs\\npx.cmd" }

# 参考情報
try { $nodeV = (& node -v) 2>$null } catch { $nodeV = "unknown" }
try { $npmV  = (& $NPM -v) 2>$null }  catch { $npmV  = "unknown" }
try { $npxV  = (& $NPX -v) 2>$null }  catch { $npxV  = "unknown" }
Log "[env] node=$nodeV npm=$npmV npx=$npxV OS64=$([Environment]::Is64BitOperatingSystem)"

# 1) 依存をクリーンインストール
Log "[1] npm ci starting..."
$p = Start-Process -FilePath $NPM -ArgumentList @('ci','--foreground-scripts') -NoNewWindow -Wait -PassThru `
     -RedirectStandardOutput logs\npm_ci.out -RedirectStandardError logs\npm_ci.err
Log "[1] npm ci exit=$($p.ExitCode)"
if ($p.ExitCode -ne 0) { throw "npm ci failed (exit=$($p.ExitCode))" }

# 2) electron-builder 実体を解決（ローカル優先）
$EB = Join-Path (Resolve-Path .).Path "node_modules\\.bin\\electron-builder.cmd"
$useNpx = $false
if (-not (Test-Path $EB)) {
  $useNpx = $true
  Log "[2] local electron-builder not found -> use npx electron-builder"
}

# 3) ビルド（公開はしない）
New-Item -ItemType Directory -Force -Path logs | Out-Null
Log "[3] build start..."
if ($useNpx) {
  $args = @('electron-builder','--win','--x64','--publish','never')
  $p = Start-Process -FilePath $NPX -ArgumentList $args -NoNewWindow -Wait -PassThru `
       -RedirectStandardOutput logs\build_only.out -RedirectStandardError logs\build_only.err
} else {
  $args = @('--win','--x64','--publish','never')
  $p = Start-Process -FilePath $EB  -ArgumentList $args -NoNewWindow -Wait -PassThru `
       -RedirectStandardOutput logs\build_only.out -RedirectStandardError logs\build_only.err
}
Log "[3] build exit=$($p.ExitCode)"
if ($p.ExitCode -ne 0) { throw "electron-builder failed (exit=$($p.ExitCode))" }

# 4) 生成物確認
Log "[4] dist listing..."
$art = Get-ChildItem dist -Recurse -Include *.exe,*.yml,*.blockmap -ErrorAction SilentlyContinue
if ($art) { $art | Sort-Object LastWriteTime -Descending | Tee-Object -File logs\dist_listing.txt | Out-Null ; Log "[4] artifacts found: $($art.Count)" }
else { Log "[4] no artifacts"; }

Log "== DONE =="
exit 0