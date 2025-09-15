$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'
$env:AWS_PAGER = ''

function W($m){ Write-Host $m -ForegroundColor Cyan }

$branchFeature = 'feat/web-installer-switch-v2'
$branchMain = 'main'

W "Step 1: check working tree status"
$status = git status --porcelain
if ($status.Trim().Length -gt 0) {
  W "Working tree is dirty; stashing changes"
  $stashMsg = "temp: before merge-to-main $(Get-Date -Format yyyyMMdd-HHmmss)"
  git stash push -u -m $stashMsg | Out-Null
  $stashed = $true
  W "Stashed: $stashMsg"
} else {
  $stashed = $false
  W "Working tree clean"
}

W "Step 2: checkout $branchMain"
git checkout $branchMain

W "Step 3: pull latest from origin/$branchMain"
git pull --ff-only origin $branchMain

W "Step 4: merge $branchFeature into $branchMain"
try {
  git merge --no-ff origin/$branchFeature -m "Merge $branchFeature into $branchMain"
} catch {
  Write-Error "Merge failed or conflicts detected: $($_.Exception.Message)"
  W "Current git status:"
  git status -sb
  if ($stashed) { W 'Attempting to restore stash to original branch'; git checkout - | Out-Null; git stash pop | Out-Null }
  exit 1
}

W "Step 5: push $branchMain to origin"
try {
  git push origin $branchMain
} catch {
  Write-Error "git push failed: $($_.Exception.Message)"
  if ($stashed) { Write-Host 'Restoring stash...'; git checkout - | Out-Null; git stash pop | Out-Null }
  exit 1
}

if ($stashed) {
  W "Step 6: return to previous branch and pop stash"
  try { git checkout - | Out-Null } catch {}
  try { git stash pop | Out-Null; W 'Stash popped' } catch { Write-Warning 'stash pop failed; resolve manually' }
}

W "Done. PR compare URL:"
$remote = (git remote get-url origin).Trim()
if ($remote -match '^git@github\.com:(.+?)/(.+?)(\.git)?$') { $repo = "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))" }
elseif ($remote -match '^https?://github\.com/(.+?)/(.+?)(\.git)?$') { $repo = "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))" }
else { Write-Error "Unsupported remote: $remote"; exit 1 }
$url = "$repo/compare/$branchMain...$branchFeature?expand=1"
Write-Host $url
if ($env:OS -like '*Windows*') { Start-Process $url }
Write-Host "EXIT:0"





