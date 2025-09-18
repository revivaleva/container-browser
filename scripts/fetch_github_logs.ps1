# Fetch and extract GitHub Actions logs for the most recent Build & Publish run
param(
  [string]$Token
)

try {
  $pat = if ($Token) { $Token } else { $env:GITHUB_PAT }
  if ([string]::IsNullOrWhiteSpace($pat)) { throw 'GITHUB_PAT environment variable is not set and no Token argument provided' }

  $owner = 'revivaleva'
  $repo  = 'container-browser'
  $headers = @{ Authorization = 'token ' + $pat; Accept = 'application/vnd.github+json' }

  Write-Output 'Fetching workflow runs...'
  $runs = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$owner/$repo/actions/runs?per_page=100"
  $run = $runs.workflow_runs | Where-Object { $_.name -like '*Build & Publish*' } | Select-Object -First 1
  if (-not $run) { Write-Output 'No Build & Publish workflow run found.'; exit 0 }

  $rid = $run.id
  Write-Output "Found run: id=$rid, name='$($run.name)', status=$($run.status), conclusion=$($run.conclusion)"

  Write-Output 'Fetching jobs for run...'
  $jobs = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$owner/$repo/actions/runs/$rid/jobs"
  $job = $jobs.jobs | Where-Object { $_.name -match 'build_publish' } | Select-Object -First 1
  if (-not $job) { $job = $jobs.jobs | Select-Object -First 1 }
  $jid = $job.id
  Write-Output "Selected job: id=$jid, name='$($job.name)', status=$($job.status), conclusion=$($job.conclusion)"

  $outDir = Join-Path -Path $PSScriptRoot -ChildPath 'logs'
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
  $logzip = Join-Path -Path $outDir -ChildPath "run_${rid}_job_${jid}.zip"

  Write-Output "Downloading job logs to: $logzip"
  Invoke-WebRequest -Headers $headers -Uri "https://api.github.com/repos/$owner/$repo/actions/jobs/$jid/logs" -OutFile $logzip -UseBasicParsing

  $extractDir = Join-Path -Path $outDir -ChildPath "run_${rid}_job_${jid}"
  Write-Output "Extracting to: $extractDir"
  Expand-Archive -LiteralPath $logzip -DestinationPath $extractDir -Force

  Write-Output 'Scanning extracted logs for known failure patterns...'
  $patterns = @('nsis-web build failed','ExitCode','Env WIN_CSC_LINK','WIN_CSC_LINK','Error: Process completed with exit code','cannot resolve','cannot find file','failed to extract','sign')
  Get-ChildItem -Path $extractDir -Recurse -File | ForEach-Object {
    foreach ($pat in $patterns) {
      $matches = Select-String -Path $_.FullName -Pattern $pat -SimpleMatch -Context 0,5 -ErrorAction SilentlyContinue
      if ($matches) {
        Write-Output "---- Matches in: $($_.FullName) (pattern: $pat) ----"
        $matches | ForEach-Object { Write-Output $_.ToString() }
      }
    }
  }

  Write-Output 'Listing files extracted (for reference):'
  Get-ChildItem -Path $extractDir -Recurse -File | Select-Object FullName,Length | Format-Table -AutoSize
  Write-Output 'Fetch complete.'
} catch {
  Write-Error $_.Exception.Message
  exit 2
}


