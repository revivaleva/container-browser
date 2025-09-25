Param(
  [Parameter(Mandatory=$true)][string]$FilePath,
  [int]$TimeoutSec = 60
)

# Run a PowerShell script in a child process and kill it if it exceeds timeout.
New-Item -ItemType Directory -Force -Path logs | Out-Null
$ts = Get-Date -Format yyyyMMdd_HHmmss
$log = "logs/run_with_timeout_$ts.log"
Write-Host "Running $FilePath with timeout ${TimeoutSec}s; log=$log"

$psi = New-Object System.Diagnostics.ProcessStartInfo 'powershell.exe'
$psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$FilePath`""
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false

$p = [Diagnostics.Process]::Start($psi)
if (-not $p.WaitForExit($TimeoutSec * 1000)) {
  Write-Host "Timeout reached (${TimeoutSec}s); attempting to kill process..."
  try { $p.Kill() } catch { Write-Host "Failed to kill process: $_" }
  "=== TIMEOUT ===`nProcess killed after ${TimeoutSec}s" | Out-File -FilePath $log -Append -Encoding utf8
} else {
  Write-Host "Process exited: ExitCode=$($p.ExitCode)"
}

$out = $p.StandardOutput.ReadToEnd()
$err = $p.StandardError.ReadToEnd()
$out | Out-File -FilePath $log -Append -Encoding utf8
if ($err) { "=== STDERR ===`n$err" | Out-File -FilePath $log -Append -Encoding utf8 }

if ($p.ExitCode -ne 0) { Write-Host "Child exit code: $($p.ExitCode) -- see $log" ; exit $p.ExitCode }
Write-Host "Done; log: $log"


