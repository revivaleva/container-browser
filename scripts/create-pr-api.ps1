$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

# Usage: .\scripts\create-pr-api.ps1 <owner> <repo> <head-branch> [base-branch]
if ($args.Count -ge 3) {
  $RepoOwner = $args[0]
  $RepoName  = $args[1]
  $HeadBranch = $args[2]
  if ($args.Count -ge 4) { $BaseBranch = $args[3] } else { $BaseBranch = 'main' }
} else {
  Write-Error 'Required parameters missing. Usage: .\scripts\create-pr-api.ps1 <owner> <repo> <head-branch> [base-branch]'
  exit 2
}

# Optional: Title and Body can be provided via environment variables or use defaults
$Title = $env:PR_TITLE
if (-not $Title) { $Title = 'Automated PR' }
$Body = $env:PR_BODY
if (-not $Body) { $Body = 'Created by script' }
$Draft = $false
if ($env:PR_DRAFT -and $env:PR_DRAFT -eq '1') { $Draft = $true }

$PatEnvVar = 'GITHUB_TOKEN'

# Ensure logs directory exists
New-Item -ItemType Directory -Force -Path logs | Out-Null

# Read PAT from environment (default: GITHUB_TOKEN)
$envItem = Get-Item -Path ("Env:" + $PatEnvVar) -ErrorAction SilentlyContinue
if (-not $envItem) {
  Write-Error "Environment variable $PatEnvVar not set. Please set it (e.g. `$env:$PatEnvVar = 'ghp_xxx') and retry."
  exit 3
}
$pat = $envItem.Value

# Build request URL and payload
$apiUrl = "https://api.github.com/repos/" + $RepoOwner + "/" + $RepoName + "/pulls"
$payload = @{
  title = $Title
  head  = $HeadBranch
  base  = $BaseBranch
  body  = $Body
  draft = $Draft
}

$headers = @{
  Authorization = "token " + $pat
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'container-browser-agent'
}

Write-Host ("Creating PR -> " + $RepoOwner + "/" + $RepoName + ": " + $HeadBranch + " -> " + $BaseBranch)

try {
  $resp = Invoke-RestMethod -Uri $apiUrl -Method Post -Headers $headers -Body ($payload | ConvertTo-Json -Depth 10) -ContentType 'application/json'
  $resp | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 logs\create_pr_response.json
  if ($resp.html_url) {
    Write-Host "PR created: $($resp.html_url)"
    if ($env:OS -like '*Windows*') { Start-Process $resp.html_url }
    exit 0
  } else {
    Write-Error "PR API succeeded but response missing html_url: $($resp | ConvertTo-Json -Depth 3)"
    exit 1
  }
} catch {
  Write-Error "Failed to create PR: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    try {
      $stream = $_.Exception.Response.GetResponseStream()
      $reader = New-Object IO.StreamReader($stream)
      $body = $reader.ReadToEnd()
      $body | Out-File -Encoding utf8 logs\create_pr_error.json
      Write-Host "Response body saved to logs/create_pr_error.json"
    } catch { }
  }
  exit 1
}