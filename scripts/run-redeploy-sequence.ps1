[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)] [string]$Bucket,
  [Parameter(Mandatory=$true)] [string]$DistributionId,
  [Parameter(Mandatory=$true)] [string]$Cdn,
  [switch]$RunSyntaxCheck
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# === Guardrails / 事前チェック ===
$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot  = Split-Path -Parent $scriptDir
Set-Location $repoRoot
if (!(Test-Path 'logs')) { New-Item -ItemType Directory -Path 'logs' | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$summaryPath = "logs\redeploy_summary_$stamp.out"

Start-Transcript -Path "logs\run_redeploy_sequence_$stamp.log" -Append | Out-Null

Write-Host "== ENV =="
Write-Host "PSVersion: $($PSVersionTable.PSVersion)"
Write-Host "PWD      : $(Get-Location)"

# オプション: 構文チェック（要求時のみ）
if ($RunSyntaxCheck) {
  if (Test-Path 'tools\Test-Ps1Syntax.ps1') {
    Write-Host "`n== SYNTAX CHECK =="
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\Test-Ps1Syntax.ps1 `
      -Path scripts\redeploy-and-test.ps1, scripts\update-release.ps1, scripts\offline-release.ps1
  } else {
    Write-Warning "tools\Test-Ps1Syntax.ps1 が見つかりません。スキップします。"
  }
}

# === 再配布～試験（既存スクリプト呼び出し） ===
Write-Host "`n== REDEPLOY & TEST START =="
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\redeploy-and-test.ps1 `
  -Bucket $Bucket `
  -DistributionId $DistributionId `
  -Cdn $Cdn

# === メインログ末尾200行 ===
$redeployMain = Get-ChildItem logs\redeploy_*.main.out -ErrorAction SilentlyContinue `
  | Sort-Object LastWriteTime -Desc | Select-Object -First 1
"`n== REDEPLOY MAIN (tail) ==" | Tee-Object -FilePath $summaryPath -Append | Out-Null
if ($redeployMain) {
  Get-Content $redeployMain.FullName -Tail 200 `
    | Tee-Object -FilePath $summaryPath -Append | Out-Null
} else {
  "logs\redeploy_*.main.out が見つかりません" `
    | Tee-Object -FilePath $summaryPath -Append | Out-Null
}

# === CDN健全性チェック（HEAD=200 / Range=206） ===
"`n== CDN HEALTH CHECK ==" | Tee-Object -FilePath $summaryPath -Append | Out-Null
if (Test-Path 'scripts\check-cdn-health.ps1') {
  try {
    powershell -NoProfile -ExecutionPolicy Bypass `
      -File scripts\check-cdn-health.ps1 -Cdn $Cdn `
      | Tee-Object -FilePath $summaryPath -Append | Out-Null
  } catch {
    "check-cdn-health.ps1 の実行に失敗: $($_.Exception.Message)" `
      | Tee-Object -FilePath $summaryPath -Append | Out-Null
  }
} else {
  "scripts\check-cdn-health.ps1 が見つかりません。スキップ。" `
    | Tee-Object -FilePath $summaryPath -Append | Out-Null
}

# === インストーラログ末尾 ===
$installLog = Get-ChildItem logs\nsis_install_*.log -ErrorAction SilentlyContinue `
  | Sort-Object LastWriteTime -Desc | Select-Object -First 1
"`n== INSTALL LOG (tail) ==" | Tee-Object -FilePath $summaryPath -Append | Out-Null
if ($installLog) {
  Get-Content $installLog.FullName -Tail 120 `
    | Tee-Object -FilePath $summaryPath -Append | Out-Null
} else {
  "logs\nsis_install_*.log が見つかりません" `
    | Tee-Object -FilePath $summaryPath -Append | Out-Null
}

# === インストール先のEXE / ProductVersion / app-update.yml のURL確認 ===
function Get-InstallPath {
  $cands = @(
    "$env:LOCALAPPDATA\Programs\Container Browser",
    "$env:LOCALAPPDATA\Programs\ContainerBrowser",
    "C:\Program Files\Container Browser",
    "C:\Program Files\ContainerBrowser"
  )
  foreach ($p in $cands) { if (Test-Path $p) { return $p } }
  return $null
}

$exePath = $null
$prodVersion = $null
$appUpdatePath = $null
$appUpdateUrl = $null

$instDir = Get-InstallPath
"`n== INSTALLED ARTIFACTS ==" | Tee-Object -FilePath $summaryPath -Append | Out-Null
if ($instDir) {
  "InstallDir: $instDir" | Tee-Object -FilePath $summaryPath -Append | Out-Null

  $exeCands = @(
    (Join-Path $instDir "Container Browser.exe"),
    (Join-Path $instDir "ContainerBrowser.exe")
  )
  foreach ($exe in $exeCands) {
    if (Test-Path $exe) { $exePath = $exe; break }
  }
  if ($exePath) {
    try {
      $vi = (Get-Item $exePath).VersionInfo
      $prodVersion = $vi.ProductVersion
      "EXE: $exePath"        | Tee-Object -FilePath $summaryPath -Append | Out-Null
      "ProductVersion: $prodVersion" | Tee-Object -FilePath $summaryPath -Append | Out-Null
    } catch {
      "EXEのVersionInfo取得に失敗: $($_.Exception.Message)" | Tee-Object -FilePath $summaryPath -Append | Out-Null
    }
  } else {
    "EXEが見つかりません" | Tee-Object -FilePath $summaryPath -Append | Out-Null
  }

  # app-update.yml 探索（exe直下 / resources 直下）
  $ymlCands = @(
    (Join-Path $instDir "app-update.yml"),
    (Join-Path $instDir "resources\app-update.yml")
  )
  foreach ($y in $ymlCands) {
    if (Test-Path $y) { $appUpdatePath = $y; break }
  }

  if ($appUpdatePath) {
    "app-update.yml: $appUpdatePath" | Tee-Object -FilePath $summaryPath -Append | Out-Null
    try {
      $apLines = Get-Content $appUpdatePath
      $appUpdateUrl = ($apLines | ForEach-Object {
        if ($_ -match '^\s*url:\s*(.+)$') { $matches[1] }
      } | Select-Object -First 1)
      if ($appUpdateUrl) {
        "url: $appUpdateUrl" | Tee-Object -FilePath $summaryPath -Append | Out-Null
      } else {
        "url 行が見つかりませんでした" | Tee-Object -FilePath $summaryPath -Append | Out-Null
      }
    } catch {
      "app-update.yml 読み取り失敗: $($_.Exception.Message)" | Tee-Object -FilePath $summaryPath -Append | Out-Null
    }
  } else {
    "app-update.yml が見つかりません" | Tee-Object -FilePath $summaryPath -Append | Out-Null
  }
} else {
  "インストールディレクトリが見つかりません（初回インストールに失敗？）" `
    | Tee-Object -FilePath $summaryPath -Append | Out-Null
}

# === fixed URLs ===
"`n== FIXED URLS ==" | Tee-Object -FilePath $summaryPath -Append | Out-Null
"Offline: $($Cdn.TrimEnd('/'))/nsis-web/ContainerBrowser-Offline-Setup.exe" `
  | Tee-Object -FilePath $summaryPath -Append | Out-Null
"Online (Web-Setup): $($Cdn.TrimEnd('/'))/nsis-web/ContainerBrowser-Web-Setup.exe" `
  | Tee-Object -FilePath $summaryPath -Append | Out-Null

# === まとめ（短報フォーマット） ===
"`n== SUMMARY ==" | Tee-Object -FilePath $summaryPath -Append | Out-Null
$verOut = if ($prodVersion) { $prodVersion } else { "(unknown)" }
"バージョン: $verOut" | Tee-Object -FilePath $summaryPath -Append | Out-Null
"固定URL(Offline): $($Cdn.TrimEnd('/'))/nsis-web/ContainerBrowser-Offline-Setup.exe" | Tee-Object -FilePath $summaryPath -Append | Out-Null
"Online(Web-Setup): $($Cdn.TrimEnd('/'))/nsis-web/ContainerBrowser-Web-Setup.exe"   | Tee-Object -FilePath $summaryPath -Append | Out-Null
"app-update.yml url: $appUpdateUrl" | Tee-Object -FilePath $summaryPath -Append | Out-Null
"`n== Completed. See: $summaryPath" | Tee-Object -FilePath $summaryPath -Append | Out-Null

Stop-Transcript | Out-Null
