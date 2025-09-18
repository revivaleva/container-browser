param(
  [string]$Workflow = 'publish-windows.yml',
  [int64]$Keep = 0
)

try {
  $token = (Get-Content -Raw 'scripts/.github_token').Trim()
} catch {
  Write-Error 'Failed to read scripts/.github_token'
  exit 1
}

$owner = 'revivaleva'
$repo = 'container-browser'
$runsApi = "https://api.github.com/repos/$owner/$repo/actions/workflows/$Workflow/runs?per_page=100"
Write-Output "Fetching runs for $Workflow"
try { $runs = Invoke-RestMethod -Uri $runsApi -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop } catch { Write-Error "Failed to fetch runs: $($_.Exception.Message)"; exit 2 }

$canceled = @()
foreach($r in $runs.workflow_runs){
  if(($r.status -in @('in_progress','queued')) -and ($r.id -ne $Keep)){
    Write-Output "Cancelling run $($r.id) status=$($r.status)"
    try {
      Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$owner/$repo/actions/runs/$($r.id)/cancel" -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop
      $canceled += $r.id
    } catch {
      Write-Error "Failed to cancel $($r.id): $($_.Exception.Message)"
    }
  }
}

Write-Output "Canceled runs: $($canceled -join ', ')"

