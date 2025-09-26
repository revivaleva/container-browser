Param()
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path logs | Out-Null
$tokenPath = 'scripts/.github_token'
if (-not (Test-Path $tokenPath)) { Write-Host 'token file not found'; exit 2 }
$token = (Get-Content -Raw $tokenPath).Trim()
if (-not $token) { Write-Host 'no token'; exit 3 }
$hdr = @{ Authorization = "token $token"; Accept = 'application/vnd.github+json' }
$url = 'https://api.github.com/repos/revivaleva/container-browser/actions/runs?branch=main&per_page=10'
try {
  $resp = Invoke-RestMethod -Uri $url -Headers $hdr -ErrorAction Stop
} catch {
  Write-Host "API request failed: $($_.Exception.Message)"
  exit 4
}
if (-not $resp.workflow_runs) { Write-Host 'no runs'; exit 5 }
$sha = (git rev-parse HEAD).Trim()
$run = $resp.workflow_runs | Where-Object { $_.head_sha -eq $sha } | Select-Object -First 1
if (-not $run) { $run = $resp.workflow_runs[0] }
$out = @{ url = $run.html_url; id = $run.id; status = $run.status; conclusion = ($run.conclusion -ne $null ? $run.conclusion : 'null') }
$out | ConvertTo-Json -Depth 5 | Out-File logs/last_actions_run.json -Encoding utf8
Write-Host $out.url
Write-Host $out.id
Write-Host $out.status
Write-Host $out.conclusion
