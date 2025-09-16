$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'
$env:AWS_PAGER = ''

if (-not $env:GITHUB_TOKEN) {
  Write-Error 'GITHUB_TOKEN is not set. Set environment variable before running.'
  exit 1
}
$token = $env:GITHUB_TOKEN

$Base = 'main'
$Branch = 'feat/web-installer-switch-v2'
$Title = 'chore(cf): make latest.yml & nsis-web public via cache behaviors'
$BodyLines = @(
  '- CloudFront E1Q66ASB5AODYF: add public cache behaviors',
  '  - paths: latest.yml, nsis-web/*',
  '  - TrustedKeyGroups/Signers: disabled (other paths remain signed)',
  '  - CachePolicy: CachingOptimized, GET/HEAD, redirect-to-https, compress enabled',
  '- Verification:',
  '  - latest.yml unsigned -> 200',
  '  - protected path unsigned -> 403',
  '- docs: docs/cf-rotation-check.md updated',
  '- Rollback: remove public behaviors -> update -> invalidation'
)
$Body = $BodyLines -join "`n"

try {
  $remote = (git remote get-url origin).Trim()
} catch {
  Write-Error "Failed to get git remote URL: $_"
  exit 1
}

if ($remote -match '^git@github\.com:(.+?)/(.+?)(\.git)?$') {
  $owner = $Matches[1]; $repo = $Matches[2].TrimEnd('.git')
} elseif ($remote -match '^https?://github\.com/(.+?)/(.+?)(\.git)?$') {
  $owner = $Matches[1]; $repo = $Matches[2].TrimEnd('.git')
} else {
  Write-Error "Unsupported remote: $remote"
  exit 1
}

$apiUrl = "https://api.github.com/repos/$owner/$repo/pulls"
$payload = @{ title = $Title; head = $Branch; base = $Base; body = $Body; draft = $false }

$headers = @{ Authorization = "token $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'container-browser-agent' }

try {
  $resp = Invoke-RestMethod -Uri $apiUrl -Method Post -Headers $headers -Body ($payload | ConvertTo-Json -Depth 10) -ContentType 'application/json'
  if ($resp.html_url) {
    Write-Host "PR created: $($resp.html_url)"
    if ($env:OS -like '*Windows*') { Start-Process $resp.html_url }
    Write-Host 'EXIT:0'
    exit 0
  } else {
    Write-Error "API returned no html_url: $(ConvertTo-Json $resp -Depth 3)"
    Write-Host 'EXIT:1'
    exit 1
  }
} catch {
  Write-Error "Failed to create PR: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    try { $body = $_.Exception.Response.GetResponseStream() | %{ (New-Object IO.StreamReader($_)).ReadToEnd() }; Write-Host "Response body:`n$body" } catch {}
  }
  Write-Host 'EXIT:1'
  exit 1
}





