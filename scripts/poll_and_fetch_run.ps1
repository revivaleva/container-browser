param(
  [string]$RunId = '17940666385',
  [int]$TimeoutMin = 10
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'

New-Item -ItemType Directory -Force -Path logs | Out-Null
$token = $null
try { $token = (Get-Content -Raw 'scripts/.github_token').Trim() } catch { Write-Host 'Failed to read scripts/.github_token'; exit 2 }
$api = "https://api.github.com/repos/revivaleva/container-browser/actions/runs/$RunId"
$deadline = (Get-Date).AddMinutes($TimeoutMin)
Write-Host "Polling run $RunId until completed (timeout: $TimeoutMin min)"
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-RestMethod -Uri $api -Headers @{ Authorization = 'Bearer ' + $token; Accept = 'application/vnd.github+json' } -ErrorAction Stop
  } catch {
    Write-Host "API error: $($_.Exception.Message)"
    Start-Sleep -Seconds 10
    continue
  }
  Write-Host ("Status: {0}  Conclusion: {1}" -f $r.status, $r.conclusion)
  if ($r.status -eq 'completed') {
    Write-Host 'Run completed — fetching logs now.'
    try {
      & pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\fetch_run_logs_for.ps1 -RunId $RunId
      exit 0
    } catch {
      Write-Host "Failed to fetch logs: $($_.Exception.Message)"
      exit 3
    }
  }
  Start-Sleep -Seconds 10
}
Write-Host "Timeout waiting for run $RunId to complete"
exit 1




