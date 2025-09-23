param(
  [string]$SourceCommit = 'ci/remove-signing-env',
  [string]$NewBranch = 'ci/clean-ci-fixes'
)

try { $token = (Get-Content -Raw 'scripts/.github_token').Trim() } catch { Write-Error 'Missing scripts/.github_token'; exit 1 }
if (-not $token) { Write-Error 'Empty PAT'; exit 1 }

Write-Output "Fetching origin/main and creating branch $NewBranch"
git fetch origin main
git checkout -B $NewBranch origin/main

Write-Output "Listing files changed in $SourceCommit"
$all = git show --name-only --pretty="" $SourceCommit | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

Write-Output "Filtering out large/generated files"
$keep = $all | Where-Object { 
  ($_ -notmatch '^(dist_update_|dist_update|dist_|logs/|scripts/logs/|.*\.zip$|.*\.exe$|.*\.7z$|.*/win-unpacked/|out/|node_modules/)')
}

if (-not $keep -or $keep.Count -eq 0) { Write-Output 'No suitable files to cherry-pick from source commit'; exit 0 }

Write-Output "Files to copy:"; $keep | ForEach-Object { Write-Output " - $_" }

foreach ($f in $keep) {
  mkdir (Split-Path $f) -ErrorAction SilentlyContinue | Out-Null
  git checkout $SourceCommit -- $f
}

git add $keep
if ((git diff --staged --name-only) -and (git diff --staged --name-only).Length -gt 0) {
  git commit -m "ci: apply CI fixes (remove signing env, concurrency, cancel step, doc updates)"
} else {
  Write-Output 'No staged changes to commit.'
}

Write-Output 'Pushing branch to origin'
$remote = "https://$token@github.com/revivaleva/container-browser.git"
try { git push $remote HEAD:refs/heads/$NewBranch -u } catch { Write-Error "git push failed: $($_.Exception.Message)"; exit 2 }

Write-Output 'Creating PR'
$body = @{ title = 'ci: apply CI fixes (remove signing env, concurrency, cancel step, docs)'; head = $NewBranch; base = 'main'; body = 'Apply CI fixes to avoid signing-related failures and prevent parallel publish runs.' } | ConvertTo-Json
try {
  $pr = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/revivaleva/container-browser/pulls' -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -Body $body -ContentType 'application/json' -ErrorAction Stop
  Write-Output $pr.html_url
} catch { Write-Error "Create PR failed: $($_.Exception.Message)"; exit 3 }


