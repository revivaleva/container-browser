param(
  [string]$Branch = 'ci/remove-signing-env',
  [string]$Title  = 'ci: neutralize signing env, add concurrency and cancel step, update CI docs',
  [string]$Body   = "This PR neutralizes signing environment variables used by CI and adds concurrency and cancellation to prevent parallel publish runs. It also updates CI troubleshooting docs."
)

try {
  $token = (Get-Content -Raw 'scripts/.github_token').Trim()
} catch {
  Write-Error 'Failed to read scripts/.github_token'; exit 1
}

if (-not $token) { Write-Error 'PAT is empty'; exit 1 }

Write-Output "Pushing branch $Branch to origin using PAT..."
$url = "https://$token@github.com/revivaleva/container-browser.git"
try {
  git push $url "HEAD:refs/heads/$Branch" -u
} catch {
  Write-Error "git push failed: $($_.Exception.Message)"; exit 2
}

Write-Output 'Creating Pull Request via GitHub API'
$prBody = @{ title = $Title; head = $Branch; base = 'main'; body = $Body } | ConvertTo-Json
try {
  $resp = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/revivaleva/container-browser/pulls' -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -Body $prBody -ContentType 'application/json' -ErrorAction Stop
  Write-Output $resp.html_url
} catch {
  Write-Error "Create PR failed: $($_.Exception.Message)"; exit 3
}


