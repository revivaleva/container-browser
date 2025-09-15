$ErrorActionPreference = 'Stop'
# origin の URL から https を生成
$remote = (git remote get-url origin).Trim()
if ($remote -match '^git@github\.com:(.+?)/(.+?)(\.git)?$') {
  $repo = 'https://github.com/' + $Matches[1] + '/' + $Matches[2].TrimEnd('.git')
} elseif ($remote -match '^https?://github\.com/(.+?)/(.+?)(\.git)?$') {
  $repo = 'https://github.com/' + $Matches[1] + '/' + $Matches[2].TrimEnd('.git')
} else {
  throw 'Unsupported remote: ' + $remote
}
# 比較URL
$url = $repo + '/compare/main...feat/web-installer-switch-v2?expand=1'
Write-Host $url
Start-Process $url






