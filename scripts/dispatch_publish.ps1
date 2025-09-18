param(
  [string]$Ref = 'ci/s3-root-copy'
)

# Token resolution: 1) local token files, 2) GITHUB_TOKEN env
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Build candidate paths explicitly to avoid parser ambiguity
$c1 = Join-Path $scriptDir '.github_token'
$c2 = Join-Path $scriptDir '.pat'
$parent = Split-Path $scriptDir -Parent
$c3 = Join-Path (Join-Path $parent '.secrets') 'github_token'
$candidates = @($c1, $c2, $c3)
$paramToken = $null
foreach ($p in $candidates) { if (Test-Path $p) { $paramToken = (Get-Content $p -Raw).Trim(); break } }
if (-not $paramToken) { $paramToken = $env:GITHUB_TOKEN }
if (-not $paramToken) { Write-Error 'GITHUB_TOKEN env var or local token file required'; exit 1 }
$owner = 'revivaleva'
$repo  = 'container-browser'
$uri   = "https://api.github.com/repos/$owner/$repo/actions/workflows/publish-windows.yml/dispatches"
$body  = @{ ref = $Ref } | ConvertTo-Json
Write-Output "Dispatching publish-windows.yml -> ref=$Ref"
Invoke-RestMethod -Method Post -Uri $uri -Headers @{ Authorization = 'token ' + $paramToken; Accept = 'application/vnd.github+json' } -Body $body -ContentType 'application/json'
Write-Output 'First dispatch complete.'

# Use the same token for the second dispatch
$uri = 'https://api.github.com/repos/revivaleva/container-browser/actions/workflows/publish-windows.yml/dispatches'
$body = @{ ref = 'main' } | ConvertTo-Json

try {
  Invoke-RestMethod -Uri $uri -Method Post -Headers @{ Authorization = 'Bearer ' + $paramToken; Accept = 'application/vnd.github+json' } -Body $body -ContentType 'application/json' -ErrorAction Stop
  Write-Output 'Second dispatch complete.'
} catch {
  Write-Error "Dispatch failed: $($_.Exception.Message)"
  exit 3
}

Start-Sleep -Seconds 3

$runsUri = 'https://api.github.com/repos/revivaleva/container-browser/actions/workflows/publish-windows.yml/runs?branch=main'
$runs = Invoke-RestMethod -Uri $runsUri -Headers @{ Authorization = 'Bearer ' + $paramToken; Accept = 'application/vnd.github+json' } -ErrorAction Stop
$run = $runs.workflow_runs | Sort-Object created_at -Descending | Select-Object -First 1
if ($run) { Write-Output $run.html_url } else { Write-Output 'No run found' }



