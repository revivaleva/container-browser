param(
  [Parameter(Mandatory=$true)][string]$Version,                # 例: 0.2.2
  [Parameter(Mandatory=$true)][string]$DistributionId,         # 例: E1Q66ASB5AODYF
  [string]$Bucket        = 'container-browser-updates',
  [string]$Region        = 'ap-northeast-1',
  [string]$PublicBase    = 'https://updates.threadsbooster.jp',
  [switch]$SkipBuild,
  [switch]$NoInvalidate,
  [switch]$DryRun
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_REGION         = $Region
$env:AWS_DEFAULT_REGION = $Region

# --- logging ---
$ts = (Get-Date).ToString('yyyyMMdd_HHmmss')
$log = "release_web_$ts.log"
function Log([string]$m){ $t=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$t $m" | Out-File -FilePath $log -Append -Encoding utf8; Write-Host $m }

Log "START release-web version=$Version region=$Region bucket=$Bucket dryRun=$($DryRun.IsPresent)"

# --- guard: git 状態だけ確認（コミット/プッシュはしない） ---
try {
  $st = (git status --porcelain) -join "`n"
  if ($st) { Log "[WARN] git is dirty (local only). Proceeding anyway." }
  else     { Log "[OK] git clean" }
} catch { Log "[WARN] git not available? $_" }

# --- 1) version bump（package.json） ---
try {
  $pkgPath = Join-Path $PSScriptRoot '..\package.json' | Resolve-Path
} catch { $pkgPath='package.json' }
$raw = Get-Content -Raw $pkgPath
$new = $raw -replace '"version"\s*:\s*"\d+\.\d+\.\d+"', "`"version`": `"$Version`""
if (-not $SkipBuild) {
  Set-Content -Encoding utf8 $pkgPath $new
  Log "[OK] package.json version -> $Version"
} else {
  Log "[SKIP] version bump (SkipBuild)"
}

# --- 2) build & publish (electron-builder -> S3) ---
if (-not $SkipBuild) {
  if ($DryRun) { Log "[DRYRUN] npm ci / electron-builder"; }
  else {
    Log "[STEP] npm ci"
    npm ci | Tee-Object -FilePath $log -Append | Out-Null

    Log "[STEP] npx electron-builder --win --x64 -p always"
    npx electron-builder --win --x64 -p always | Tee-Object -FilePath $log -Append | Out-Null
  }
} else {
  Log "[SKIP] build/publish (SkipBuild)"
}

# --- 3) CloudFront invalidation for latest.yml ---
if (-not $NoInvalidate) {
  if ($DryRun) { Log "[DRYRUN] aws cloudfront create-invalidation /latest.yml"; }
  else {
    Log "[STEP] Invalidate /latest.yml"
    aws cloudfront create-invalidation --distribution-id $DistributionId --paths "/latest.yml" `
      | Tee-Object -FilePath $log -Append | Out-Null
  }
} else {
  Log "[SKIP] invalidation (NoInvalidate)"
}

# --- 4) Verify: public & protected ---
function HeadCode([string]$url){
  try { (Invoke-WebRequest -Method Head $url -ErrorAction Stop).StatusCode }
  catch { try { [int]$_.Exception.Response.StatusCode.value__ } catch { 0 } }
}

$latest = "$PublicBase/latest.yml"
$priv   = "$PublicBase/private-check.txt"

$codeLatest = HeadCode $latest
$codePriv   = HeadCode $priv

Log "[VERIFY] $latest -> $codeLatest (expect 200)"
Log "[VERIFY] $priv   -> $codePriv (expect 403)"

# --- 5) installer path hint ---
$exe = Get-ChildItem -Recurse -Path (Join-Path $PSScriptRoot '..\dist') -Filter "*Setup*.exe" -ErrorAction SilentlyContinue `
       | Sort-Object LastWriteTime -Desc | Select-Object -First 1
if ($exe) { Log "[HINT] Setup EXE: $($exe.FullName)" }

Log "END release-web"
Write-Host "`n==== SUMMARY ===="
Write-Host "latest.yml HEAD: $codeLatest (200 expected)"
Write-Host "private-check HEAD: $codePriv (403 expected)"
Write-Host "Log: $log"

# 保存後の実行コマンド例（実行はまだしないで表示だけ）
# 例: 0.2.2 を公開＆検証
# powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-web.ps1 `
#   -Version 0.2.2 `
#   -DistributionId E1Q66ASB5AODYF `
#   -Bucket container-browser-updates `
#   -PublicBase https://updates.threadsbooster.jp





