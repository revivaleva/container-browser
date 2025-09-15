$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

# Resolve paths
$scriptDir = $PSScriptRoot
$repoRoot = Split-Path $scriptDir -Parent
$exe = Join-Path $repoRoot 'node_modules\app-builder-bin\win\x64\app-builder.exe'
$logDir = Join-Path $repoRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$out = Join-Path $logDir 'app-builder.out'
$err = Join-Path $logDir 'app-builder.err'

if (-not (Test-Path $exe)) {
  "MISSING: $exe" | Out-File -Encoding utf8 $err -Force
  Write-Host "MISSING: $exe"
  exit 2
}

# Run app-builder.exe and capture output
$p = Start-Process -FilePath $exe -ArgumentList '--version' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Write-Host 'EXIT=' + $p.ExitCode

# Print logs
if (Test-Path $err) { Write-Host '== ERR ==' ; Get-Content -Tail 200 -Encoding utf8 $err | Out-Host }
if (Test-Path $out) { Write-Host '== OUT ==' ; Get-Content -Tail 200 -Encoding utf8 $out | Out-Host }
