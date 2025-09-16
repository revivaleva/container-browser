$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function ToHttps($r){
  if($r -match '^git@github\.com:(.+?)/(.+?)(\.git)?$'){ return "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))" }
  if($r -match '^https?://github\.com/(.+?)/(.+?)(\.git)?$'){ return "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))" }
  throw "unsupported remote: $r"
}
$remote = (git remote get-url origin).Trim()
$repo   = ToHttps $remote
$branch = 'feat/web-installer-switch-v2'
$uri    = "$repo/compare/main...$branch?expand=1"
Write-Host "[OPEN] $uri"
Start-Process $uri