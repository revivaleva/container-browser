$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
New-Item -ItemType Directory -Force -Path logs | Out-Null

function TailOrNA($p, $n=200){ if(Test-Path $p){ Get-Content $p -Tail $n } else { "NA: $p" } }

Write-Host "## npm cache logs (latest) ##"
$cache = Join-Path $env:LOCALAPPDATA "npm-cache\_logs"
$latest = Get-ChildItem $cache -Filter *.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if($latest){
  Write-Host "PATH: $($latest.FullName)"
  Get-Content $latest.FullName -Tail 200
  "`n-- grep (ERR!/fatal/gyp/builder/install-app-deps/EAI/ECONNRESET/EPERM) --"
  Get-Content $latest.FullName | Select-String -Pattern 'ERR!|fatal|gyp|builder|install-app-deps|EAI|ECONNRESET|EPERM' -SimpleMatch
}else{
  Write-Host "no npm cache logs found under $cache"
}

"`n## local logs tail ##"
"`n--- logs/npm_ci.err (tail) ---";  TailOrNA "logs\npm_ci.err" 200
"`n--- logs/build_only.err (tail) ---"; TailOrNA "logs\build_only.err" 200





