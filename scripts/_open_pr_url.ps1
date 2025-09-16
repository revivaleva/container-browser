## Safe PR URL opener — uses settings required by project rules
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

$Branch = 'feat/web-installer-switch-v2'
try {
  $remote = (git remote get-url origin).Trim()
} catch {
  Write-Error "failed to get remote URL: $_"
  exit 1
}

if ($remote -match '^git@github\.com:(.+?)/(.+?)(\.git)?$') {
  $repo = "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))"
} elseif ($remote -match '^https?://github\.com/(.+?)/(.+?)(\.git)?$') {
  $repo = "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))"
} else {
  Write-Error "Unsupported remote: $remote"
  exit 1
}

$url = "$repo/compare/main...$Branch?expand=1"
Write-Host $url
if ($env:OS -like '*Windows*') { Start-Process $url }


