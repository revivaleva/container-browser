$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

# Ensure logs directory
New-Item -ItemType Directory -Force -Path logs | Out-Null

function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -FilePath logs\local_build_run.log -Append | Out-Null }

Log "== START local-build-run =="

# Build (electron-builder) without publishing
try {
  $npx = (Get-Command npx -ErrorAction Stop).Source
  Log "Found npx: $npx"
} catch {
  Write-Error "npx not found: $_"
  Log "npx not found"
  exit 20
}

 $builderArgs = @('electron-builder','--win','--x64','--publish','never')
 $cmdLine = 'npx ' + ($builderArgs -join ' ' ) + ' >logs\\build_only.out 2>logs\\build_only.err'
 Log "Running via cmd.exe: $cmdLine"
 Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdLine -NoNewWindow -Wait
 $exit = $LASTEXITCODE
 Log "build exit code: $exit"
 if ($exit -ne 0) { Write-Host "Build returned non-zero exit code: $exit" }

# Show tail of stderr
if (Test-Path 'logs\build_only.err') { Get-Content 'logs\build_only.err' -Tail 60 | Tee-Object -FilePath logs\build_only_err_tail.txt | Out-Host } else { Write-Host 'No build error log found' }

# List dist artifacts
if (Test-Path dist) {
  Get-ChildItem dist -Recurse -Include *.exe,*.yml,*.nsis.7z,*.blockmap | Sort-Object LastWriteTime -Descending | Select-Object LastWriteTime,Length,FullName | Tee-Object -FilePath logs\dist_listing.txt | Format-Table -Auto | Out-Host
} else {
  Write-Host 'dist not found'
}

# Attempt to run portable exe (non-Setup)
try {
  $exe = Get-ChildItem dist -Recurse -Filter '*Container*Browser*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Setup' } | Select-Object -First 1
} catch {
  $exe = $null
}
if ($exe) {
  Write-Host 'STARTING:' $exe.FullName
  Log "Starting exe: $($exe.FullName)"
  Start-Process $exe.FullName
  Log "Started exe"
} else {
  Write-Host 'portable exe not found'
  Log "portable exe not found"
}

Log "== END local-build-run =="
exit 0
