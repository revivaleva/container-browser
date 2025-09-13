param()

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

Write-Host "[1/7] Fetching origin..."
try { git fetch origin } catch { Write-Host "git fetch failed"; exit 1 }

# stash if dirty
$dirty = (git status --porcelain).Trim().Length -gt 0
$stashed = $false
if ($dirty) {
  $msg = "temp: before rebase to main $(Get-Date -Format yyyyMMdd-HHmmss)"
  git stash push -u -m "$msg" | Out-Null
  $stashed = $true
  Write-Host "[2/7] Stashed local changes: $msg"
} else {
  Write-Host "[2/7] No local changes to stash"
}

$newBranch = 'feat/web-installer-switch-v2'
Write-Host "[3/7] Preparing branch $newBranch from origin/main..."
# check local branch
$localExists = $false
try { git rev-parse --verify refs/heads/$newBranch > $null 2>&1; $localExists = $true } catch { $localExists = $false }
if ($localExists) {
  try { git checkout $newBranch } catch { Write-Host "checkout $newBranch failed"; if ($stashed) { Write-Host "Restoring stash..."; git stash pop | Out-Null }; exit 1 }
  Write-Host "Checked out existing local $newBranch"
} else {
  # check remote
  $remoteExists = $false
  try { $out = git ls-remote --heads origin $newBranch; if ($out) { $remoteExists = $true } } catch { $remoteExists = $false }
  if ($remoteExists) {
    try { git checkout -b $newBranch origin/$newBranch } catch { Write-Host "create $newBranch from origin failed"; if ($stashed) { git stash pop | Out-Null }; exit 1 }
    Write-Host "Created local $newBranch from origin/$newBranch"
  } else {
    try { git checkout -b $newBranch origin/main } catch { Write-Host "create $newBranch from origin/main failed"; if ($stashed) { git stash pop | Out-Null }; exit 1 }
    Write-Host "Created $newBranch from origin/main"
  }
}

Write-Host "[4/7] Cherry-picking commits from origin/feat/web-installer-switch..."
$range = 'origin/main..origin/feat/web-installer-switch'
$commits = git rev-list --no-merges $range 2>$null
if (-not $commits) {
  Write-Host "No commits to cherry-pick; skipping." 
} else {
  try {
    git cherry-pick $range
    if ($LASTEXITCODE -ne 0) { throw "cherry-pick failed" }
    Write-Host "Cherry-pick completed."
  } catch {
    Write-Host "Cherry-pick failed or conflicts detected. Show status:"; git status --porcelain; Write-Host "Please resolve conflicts or abort cherry-pick (git cherry-pick --abort).";
    if ($stashed) { Write-Host "Attempting to return to original branch and restore stash..."; git checkout - | Out-Null; git stash pop | Out-Null }
    exit 1
  }
}

Write-Host "[5/7] Pushing branch to origin..."
try { git push -u origin $newBranch } catch { Write-Host "git push failed"; if ($stashed) { git checkout - | Out-Null; git stash pop | Out-Null }; exit 1 }

if ($stashed) {
  Write-Host "[6/7] Restoring stashed changes..."
  try { git checkout - | Out-Null } catch {}
  try { git stash pop | Out-Null; Write-Host "Stash popped" } catch { Write-Warning "stash pop failed; manual resolution may be required" }
} else {
  Write-Host "[6/7] No stash to restore"
}

# PR URL
$remote = (git remote get-url origin).Trim()
function ToHttpsUrl([string]$remote) {
  if ($remote -match '^git@github\.com:(.+?)/(.+?)(\.git)?$') { return "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))" }
  if ($remote -match '^https?://github\.com/(.+?)/(.+?)(\.git)?$') { return "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))" }
  throw "unsupported remote: $remote"
}
$repo = ToHttpsUrl $remote
$pr = "$repo/compare/main...$newBranch?expand=1"
Write-Host "[7/7] PR URL: $pr"
Write-Host "EXIT:0"
exit 0


