try {
  $token = (Get-Content -Raw 'scripts/.github_token').Trim()
} catch {
  Write-Error 'Failed to read scripts/.github_token'
  exit 1
}
if (-not $token) { Write-Error 'Empty token'; exit 1 }

$uri = 'https://api.github.com/repos/revivaleva/container-browser/pulls?state=open'
try {
  $prs = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop
} catch {
  Write-Error "Failed to list PRs: $($_.Exception.Message)"; exit 2
}

if (-not $prs -or $prs.Count -eq 0) { Write-Output 'No open PRs' ; exit 0 }

foreach ($p in $prs) {
  Write-Output ("#{0} {1} -> {2} (head={3})" -f $p.number, $p.title, $p.html_url, $p.head.ref)
}


