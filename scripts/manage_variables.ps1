param(
  [string]$Owner = 'revivaleva',
  [string]$Repo  = 'container-browser'
)

try {
  $token = (Get-Content -Raw 'scripts/.github_token').Trim()
} catch {
  Write-Error 'Failed to read scripts/.github_token'
  exit 1
}

$base = "https://api.github.com/repos/$Owner/$Repo/actions/variables"
Write-Output "Fetching repository variables from $Owner/$Repo"
try {
  $resp = Invoke-RestMethod -Uri $base -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop
} catch {
  Write-Error "Failed to list variables: $($_.Exception.Message)"; exit 2
}

$vars = $resp.variables | ForEach-Object { $_.name }
if (-not $vars) { Write-Output 'No repository variables found.'; exit 0 }

Write-Output 'Repository variables:'
$vars | ForEach-Object { Write-Output " - $_" }

# Find targets matching CSC_LINK or WIN_CSC_LINK (case-insensitive)
$targets = $vars | Where-Object { $_ -match '(?i)^(WIN_)?CSC_LINK$' }
if (-not $targets -or $targets.Count -eq 0) { Write-Output 'No matching variables (CSC_LINK / WIN_CSC_LINK) found.'; exit 0 }

Write-Output 'Variables to delete:'
$targets | ForEach-Object { Write-Output " - $_" }

foreach ($v in $targets) {
  try {
    $delUri = "$base/$v"
    Write-Output "Deleting variable $v..."
    Invoke-RestMethod -Method Delete -Uri $delUri -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop
    Write-Output "Deleted $v"
  } catch {
    $msg = $_.Exception.Message
    Write-Error ("Failed to delete {0}: {1}" -f $v, $msg)
  }
}

Write-Output 'Done.'
