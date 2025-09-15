param()

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'

New-Item -ItemType Directory -Force -Path logs | Out-Null
function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -File logs\package_fix_build.log -Append | Out-Null }

Log "== START package-json-fix-and-build =="

$p = 'package.json'
Write-Host "git status:"; git status --porcelain

try{
  $b = [IO.File]::ReadAllBytes($p)
  $hb = ($b[0..([Math]::Min(15,$b.Length-1))] | ForEach-Object { $_.ToString('X2') }) -join ' '
  Write-Host "HEX: $hb"
}catch{
  Write-Host "Failed reading bytes: $($_.Exception.Message)"
}

function TestJson(){
  try{
    $t = [IO.File]::ReadAllText($p)
    $null = $t | ConvertFrom-Json
    return $true
  }catch{
    Write-Host "JSON parse error: $($_.Exception.Message)"
    return $false
  }
}

$ok = TestJson
if(-not $ok){
  Log "Attempting to rewrite $p as UTF-8 (no BOM)"
  $bytes = [IO.File]::ReadAllBytes($p)
  if($bytes.Length -ge 2 -and $bytes[0]-eq 0xFF -and $bytes[1]-eq 0xFE){ $txt = [Text.Encoding]::Unicode.GetString($bytes) }
  elseif($bytes.Length -ge 2 -and $bytes[0]-eq 0xFE -and $bytes[1]-eq 0xFF){ $txt = [Text.Encoding]::BigEndianUnicode.GetString($bytes) }
  else{ $txt = [Text.Encoding]::UTF8.GetString($bytes) }
  [IO.File]::WriteAllText($p,$txt,[Text.UTF8Encoding]::new($false))
  if(TestJson){
    Log "Rewrote as UTF-8(no BOM) & JSON OK"
  }else{
    Log "Still parse error after rewrite — restoring from git checkout -- package.json"
    git checkout -- package.json
    Log "Restored package.json from HEAD"
    if(-not (TestJson)){
      Log "Restored file still invalid. Aborting."
      Write-Host "RESTORE_FAILED"
      exit 2
    }
  }
}

# Run install-app-deps and capture logs
New-Item -ItemType Directory -Force -Path logs | Out-Null
$NPX = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if(-not $NPX){ $NPX = "C:\Program Files\nodejs\npx.cmd" }
Log "Running install-app-deps via $NPX"
$p = Start-Process -FilePath $NPX -ArgumentList @('electron-builder','install-app-deps') -NoNewWindow -Wait -PassThru -RedirectStandardOutput logs\install_app_deps.out -RedirectStandardError logs\install_app_deps.err
Write-Host "install-app-deps EXIT:$($p.ExitCode)"
Get-Content logs\install_app_deps.err -Tail 200 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }

# If install-app-deps succeeded, run build
if($p.ExitCode -eq 0){
  Log "install-app-deps succeeded, running build"
  $p2 = Start-Process -FilePath $NPX -ArgumentList @('electron-builder','--win','--x64','--publish','never') -NoNewWindow -Wait -PassThru -RedirectStandardOutput logs\build_only.out -RedirectStandardError logs\build_only.err
  Write-Host "build EXIT:$($p2.ExitCode)"
  if(Test-Path dist){ Get-ChildItem dist -Recurse -Include *.exe,*.yml,*.blockmap | Sort-Object LastWriteTime -Descending | ForEach-Object { Write-Host $_.FullName } } else { Write-Host 'no dist' }
  if(Test-Path logs\build_only.err){ Write-Host '--- build_only.err (tail) ---'; Get-Content logs\build_only.err -Tail 200 }
}else{
  Write-Host 'Skipping build because install-app-deps failed.'
}

Log "== DONE package-json-fix-and-build =="
exit 0





