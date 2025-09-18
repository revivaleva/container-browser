$uri = 'https://api.github.com/repos/revivaleva/container-browser/actions/runs?branch=main'
try {
  $r = Invoke-RestMethod -Uri $uri -Headers @{ Accept='application/vnd.github+json' } -ErrorAction Stop
  $run = $r.workflow_runs | Sort-Object created_at -Descending | Select-Object -First 1
  if ($run) {
    Write-Output $run.html_url
    Write-Output $run.id
    Write-Output $run.status
    Write-Output $run.conclusion
  } else {
    Write-Output 'No run found'
  }
} catch {
  Write-Error "Failed to query runs: $($_.Exception.Message)"
  exit 2
}



