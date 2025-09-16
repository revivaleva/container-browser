$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force logs | Out-Null
$out = 'logs\installed_check.out'

"== INSTALLED BINARY CHECK ==" | Tee-Object -FilePath $out -Append
$exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "Container Browser.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if($exe){
  "EXE: $($exe.FullName)" | Tee-Object -FilePath $out -Append
  try { Get-FileHash -Algorithm SHA256 $exe.FullName | Format-List | Out-String | Tee-Object -FilePath $out -Append } catch { "Get-FileHash failed: $_" | Tee-Object -FilePath $out -Append }
} else {
  "EXE not found in LocalAppData\Programs" | Tee-Object -FilePath $out -Append
}

"`n== app.asar CHECK ==" | Tee-Object -FilePath $out -Append
$asar = Join-Path "$env:LOCALAPPDATA\Programs\container-browser\resources" 'app.asar'
if(Test-Path $asar){
  "app.asar: $asar" | Tee-Object -FilePath $out -Append
  try { Get-FileHash -Algorithm SHA256 $asar | Format-List | Out-String | Tee-Object -FilePath $out -Append } catch { "Get-FileHash failed: $_" | Tee-Object -FilePath $out -Append }
} else {
  "app.asar not found at $asar" | Tee-Object -FilePath $out -Append
}

"`n== app-update.yml ==" | Tee-Object -FilePath $out -Append
$y = Join-Path "$env:LOCALAPPDATA\Programs\container-browser\resources" 'app-update.yml'
if(Test-Path $y){ Get-Content $y -Raw | Tee-Object -FilePath $out -Append } else { "app-update.yml not found: $y" | Tee-Object -FilePath $out -Append }

"`n== electron-log main.log (tail 500) ==" | Tee-Object -FilePath $out -Append
$log = Join-Path $env:APPDATA 'Container Browser\logs\main.log'
if(Test-Path $log){ Get-Content -Tail 500 -Encoding utf8 $log | Tee-Object -FilePath $out -Append } else { "electron-log main.log not found: $log" | Tee-Object -FilePath $out -Append }

Write-Host "WROTE: $out"


