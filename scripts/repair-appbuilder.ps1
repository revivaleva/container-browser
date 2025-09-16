param()

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'

New-Item -ItemType Directory -Force -Path logs | Out-Null
function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -File logs\repair_appbuilder.log -Append | Out-Null }

Log "== START repair-appbuilder =="

# 環境表示
$os64 = [Environment]::Is64BitOperatingSystem
$pa   = $env:PROCESSOR_ARCHITECTURE
$nodeV = (& node -v) 2>$null
$nodeArch = (& node -p "process.arch") 2>$null
Log "[env] OS64=$os64 PA=$pa node=$nodeV arch=$nodeArch"

# app-builder.exe 検索（x64優先）
$exe = $null
$apps = Get-ChildItem node_modules\app-builder-bin\win -Recurse -Filter app-builder.exe -ErrorAction SilentlyContinue
if($apps){ $exe = ($apps | Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1) }
if(-not $exe -and $apps){ $exe = $apps | Select-Object -First 1 }

$broken = $false
if(-not $exe){
  Log "[1] app-builder.exe NOT FOUND"
  $broken = $true
}else{
  Log "[1] FOUND: $($exe.FullName) Size=$([math]::Round($exe.Length/1MB,2))MB"
  try{
    $zone = Get-Item "$($exe.FullName):Zone.Identifier" -ErrorAction SilentlyContinue
    if($zone){ Unblock-File $exe.FullName ; Log "[1] Unblocked Zone.Identifier" }
  }catch{}
  try{
    $fs=[System.IO.File]::OpenRead($exe.FullName)
    $b=New-Object byte[] 2; $null=$fs.Read($b,0,2); $fs.Dispose()
    if(!($b[0]-eq 0x4D -and $b[1]-eq 0x5A)){ Log "[1] Header not MZ -> BROKEN"; $broken=$true }
  }catch{ Log "[1] OpenRead failed: $($_.Exception.Message)"; $broken=$true }
  if(-not $broken){
    try{
      $out = & $exe.FullName --version 2>&1; $ec = $LASTEXITCODE
      Set-Content -Encoding utf8 logs\app-builder-version.after.txt ($out | Out-String)
      Log "[1] app-builder --version ec=$ec out=$out"
      if($ec -ne 0){ $broken=$true }
    }catch{ Log "[1] Run failed: $($_.Exception.Message)"; $broken=$true }
  }
}

if($broken){
  Log "[2] Cleanup caches and module"
  Remove-Item -Recurse -Force node_modules\app-builder-bin -ErrorAction SilentlyContinue
  $cache = Join-Path $env:LOCALAPPDATA 'electron-builder\app-builder'
  if(Test-Path $cache){ Remove-Item -Recurse -Force $cache }
  try{ & npm cache verify | Tee-Object -File logs\npm_cache_verify.log }catch{}
  try{ & npm cache clean --force | Tee-Object -File logs\npm_cache_clean.log }catch{}

  Log "[3] npm ci (reinstall) - invoking npm directly"
  try{
    & npm ci --foreground-scripts > (Join-Path $PSScriptROOT 'logs\npm_ci_repair.out') 2> (Join-Path $PSScriptRoot 'logs\npm_ci_repair.err')
    $ec = $LASTEXITCODE
    Log "[3] npm ci exit=$ec"
    if($ec -ne 0){ throw "npm ci failed (exit=$ec)" }
  }catch{
    Log "[3] ERROR: $($_.Exception.Message)"
    throw
  }

  # 再検証
  $apps = Get-ChildItem node_modules\app-builder-bin\win -Recurse -Filter app-builder.exe -ErrorAction SilentlyContinue
  if($apps){ $exe = ($apps | Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1) }
  if(-not $exe -and $apps){ $exe = $apps | Select-Object -First 1 }
  if(-not $exe){ throw "app-builder.exe still not found after reinstall" }

  try{
    $zone = Get-Item "$($exe.FullName):Zone.Identifier" -ErrorAction SilentlyContinue
    if($zone){ Unblock-File $exe.FullName ; Log "[3] Unblocked Zone.Identifier (after reinstall)" }
  }catch{}

  $out = & $exe.FullName --version 2>&1; $ec = $LASTEXITCODE
  Set-Content -Encoding utf8 logs\app-builder-version.after.txt ($out | Out-String)
  Log "[3] app-builder --version after reinstall ec=$ec out=$out"
  if($ec -ne 0){ throw "app-builder still not runnable (exit=$ec)" }
}

Log "== REPAIR_OK =="
exit 0


