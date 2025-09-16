$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs | Out-Null
function Log([string]$m){ $ts=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); "$ts $m" | Tee-Object -FilePath logs\start_portable.log -Append | Out-Null }

Log "== START start-portable =="

try{
  $exe = Get-ChildItem -Path 'dist' -Recurse -Filter '*Container*Browser*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Setup' } | Select-Object -First 1
}catch{ $exe = $null }

if ($null -ne $exe) {
  Log "Found exe: $($exe.FullName)"
  try{
    $p = Start-Process -FilePath $exe.FullName -PassThru -ErrorAction Stop
    Log "Started PID=$($p.Id)"
    Start-Sleep -Seconds 2
    Get-Process -Name 'Container Browser' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | Out-File -Encoding utf8 logs\process_list.txt
    Get-Content -Encoding utf8 logs\process_list.txt | Out-Host
  } catch { Log "Failed to start exe: $_"; Write-Host 'Failed to start exe'; }
} else {
  Log "portable exe not found"
  Write-Host 'portable exe not found'
}

Log "== END start-portable =="
exit 0




