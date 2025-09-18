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

$base = "https://api.github.com/repos/$Owner/$Repo/actions/secrets"
Write-Output "Fetching repository secrets from $Owner/$Repo"
try {
  $resp = Invoke-RestMethod -Uri $base -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop
} catch {
  Write-Error "Failed to list secrets: $($_.Exception.Message)"; exit 2
}

$names = $resp.secrets | ForEach-Object { $_.name }
if (-not $names) { Write-Output 'No repository secrets found.'; exit 0 }

Write-Output 'Repository secrets:'
$names | ForEach-Object { Write-Output " - $_" }

# Find targets matching CSC_LINK or WIN_CSC_LINK (case-insensitive)
$targets = $names | Where-Object { $_ -match '(?i)^(WIN_)?CSC_LINK$' }
if (-not $targets -or $targets.Count -eq 0) { Write-Output 'No matching secrets (CSC_LINK / WIN_CSC_LINK) found.'; exit 0 }

Write-Output 'Secrets to delete:'
$targets | ForEach-Object { Write-Output " - $_" }

foreach ($s in $targets) {
  try {
    $delUri = "$base/$s"
    Write-Output "Deleting $s..."
    Invoke-RestMethod -Method Delete -Uri $delUri -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop
    Write-Output "Deleted $s"
  } catch {
    $msg = $_.Exception.Message
    Write-Error ("Failed to delete {0}: {1}" -f $s, $msg)
  }
}

Write-Output 'Done.'

