try {
  $token = (Get-Content -Raw 'scripts/.github_token').Trim()
} catch {
  Write-Error 'Failed to read scripts/.github_token'
  exit 1
}

$runApi = 'https://api.github.com/repos/revivaleva/container-browser/actions/runs/17824440819'
Write-Output "Fetching run info: $runApi"
$run = Invoke-RestMethod -Uri $runApi -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop
Write-Output ('run: id={0}, status={1}, conclusion={2}' -f $run.id,$run.status,$run.conclusion)

Write-Output 'Fetching jobs info'
$jobs = Invoke-RestMethod -Uri $run.jobs_url -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop
foreach($j in $jobs.jobs){
  Write-Output ('JOB: {0} -> {1} ({2})' -f $j.name, $j.conclusion, $j.html_url)
  foreach($s in $j.steps){ Write-Output ('  STEP: {0} -> {1}' -f $s.name, $s.conclusion) }
}

$logsZip = 'logs/run_17824440819_logs.zip'
Write-Output "Downloading logs to $logsZip"
Invoke-WebRequest -Uri $run.logs_url -Headers @{ Authorization = "Bearer $token" } -OutFile $logsZip -UseBasicParsing

if (Test-Path $logsZip) {
  if (Test-Path 'logs/run_17824440819') { Remove-Item -Recurse -Force 'logs/run_17824440819' }
  Expand-Archive -Force -LiteralPath $logsZip -DestinationPath 'logs/run_17824440819'
  Write-Output 'Extracted logs:'
  Get-ChildItem -Recurse -Path 'logs/run_17824440819' | Select-Object FullName | ForEach-Object { Write-Output $_.FullName }

  Write-Output 'Searching for error patterns in logs...'
  $patterns = '(?i)error|accessdenied|exitcode|failed|exception'
  $files = Get-ChildItem -Recurse -Path 'logs/run_17824440819' | Where-Object { $_.Length -gt 0 }
  foreach($f in $files){
    $txt = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($txt -and ($txt -match $patterns)){
      Write-Output '--- MATCH in:' $f.FullName
      $txtSplit = $txt -split "`n"
      $tail = $txtSplit[-200..-1] -join "`n"
      Write-Output $tail
    }
  }
} else {
  Write-Error "Logs zip not found: $logsZip"
}

Write-Output 'Done.'
param(
  [string]$Token,
  [string]$RunId
)
if(-not $Token){ Write-Error 'Token required'; exit 1 }
$owner='revivaleva'; $repo='container-browser'
$outDir = Join-Path -Path $PSScriptRoot -ChildPath ("run_$RunId")
if(-not (Test-Path (Join-Path $PSScriptRoot 'logs'))){ New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'logs') | Out-Null }
$zipPath = Join-Path -Path (Join-Path $PSScriptRoot 'logs') -ChildPath ("run_${RunId}_logs.zip")
$hdr = @{ Authorization = 'token ' + $Token; Accept = 'application/vnd.github+json' }
Write-Output "Downloading logs for run $RunId to $zipPath"
Invoke-WebRequest -Headers $hdr -Uri "https://api.github.com/repos/$owner/$repo/actions/runs/$RunId/logs" -OutFile $zipPath -UseBasicParsing
if(Test-Path $outDir){ Remove-Item -Recurse -Force $outDir }
Write-Output "Extracting to $outDir"
Expand-Archive -LiteralPath $zipPath -DestinationPath $outDir -Force
Write-Output 'Searching logs for failure indicators...'
$patterns = @('nsis-web build failed','Env WIN_CSC_LINK','WIN_CSC_LINK','cannot resolve','cannot find file','ExitCode','Error: Process completed with exit code','sign','Env CSC_LINK')
Get-ChildItem -Path $outDir -Recurse -File | ForEach-Object {
  $path = $_.FullName
  foreach($pat in $patterns){
    $matches = Select-String -Path $path -Pattern $pat -SimpleMatch -Context 0,5 -ErrorAction SilentlyContinue
    if($matches){
      Write-Output "---- Matches in: $path (pattern: $pat) ----"
      $matches | ForEach-Object { Write-Output $_.ToString() }
    }
  }
}
Write-Output 'Printing tail snippets of likely publish step logs...'
$candidates = Get-ChildItem -Path $outDir -Recurse -File | Where-Object { $_.Name -match 'update-release' -or $_.Name -match 'publish' -or $_.Name -match 'publish-nsis' } | Select-Object -First 5
if(-not $candidates){ $candidates = Get-ChildItem -Path $outDir -Recurse -File | Select-Object -First 3 }
foreach($f in $candidates){ Write-Output "--- Tail of $($f.FullName) ---"; Get-Content -LiteralPath $f.FullName -Tail 120 | ForEach-Object { Write-Output $_ } }
Write-Output 'Done.'


