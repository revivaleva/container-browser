param(
  [string]$Workflow = 'publish-windows.yml',
  [int64]$Keep = 0
)

# Resolve token: prefer GITHUB_TOKEN (provided by Actions), fallback to local scripts/.github_token
# Prefer GITHUB_TOKEN in Actions environment. If missing, try local scripts/.github_token.
$token = $env:GITHUB_TOKEN
if (-not $token) {
  try {
    $token = (Get-Content -Raw 'scripts/.github_token').Trim()
  } catch {
    Write-Warning 'GITHUB_TOKEN not set and scripts/.github_token missing; skipping cancel step.'
    # Do not fail the job if token isn't available; cancellation is best-effort.
    exit 0
  }
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

