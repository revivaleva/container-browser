$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

# Ensure logs directory
New-Item -ItemType Directory -Force -Path logs | Out-Null

function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -FilePath logs\electron_vite_build.log -Append | Out-Null }

Log "== START electron-vite build =="

# Build via electron-vite
try {
  $npx = (Get-Command npx -ErrorAction Stop).Source
  Log "Found npx: $npx"
} catch {
  Write-Error "npx not found: $_"
  Log "npx not found"
  exit 20
}

$cmdLine = 'npx electron-vite build >logs\\evb_out.txt 2>logs\\evb_err.txt'
Log "Running via cmd.exe: $cmdLine"
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdLine -NoNewWindow -Wait
$exit = $LASTEXITCODE
Log "electron-vite build exit: $exit"
if ($exit -ne 0) { Write-Host "electron-vite build returned non-zero exit code: $exit" }

Log "== END electron-vite build =="
exit $exit
