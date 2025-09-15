$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

Write-Host 'Searching for running Container Browser processes...'
$procs = Get-Process -Name 'Container Browser' -ErrorAction SilentlyContinue
if ($null -ne $procs) {
  foreach ($p in $procs) {
    try {
      Write-Host ("KILLING PID=$($p.Id) PROCESS=$($p.ProcessName)")
      Stop-Process -Id $p.Id -Force -ErrorAction Stop
    } catch {
      Write-Host ("Failed to kill PID=$($p.Id): $_")
    }
  }
} else {
  Write-Host 'No Container Browser processes found.'
}

Write-Host 'Done.'




