param(
  [string]$RunJson = 'logs/s3root_run.json'
)

$r = Get-Content -Raw -Path $RunJson | ConvertFrom-Json
Write-Host "run html_url: $($r.html_url)"
Write-Host "logs_url: $($r.logs_url)"
Write-Host "check_suite_url: $($r.check_suite_url)"
Write-Host "artifacts_url: $($r.artifacts_url)"



