param(
  [Parameter(Mandatory=$true)][string]$RunId
)

try {
  $token = (Get-Content -Raw 'scripts/.github_token').Trim()
} catch {
  Write-Error 'Failed to read scripts/.github_token'
  exit 1
}

$runApi = "https://api.github.com/repos/revivaleva/container-browser/actions/runs/$RunId"
Write-Output "Fetching run info: $runApi"
try { $run = Invoke-RestMethod -Uri $runApi -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop } catch { Write-Error "Failed to fetch run: $($_.Exception.Message)"; exit 2 }
Write-Output ('run: id={0}, status={1}, conclusion={2}' -f $run.id,$run.status,$run.conclusion)

Write-Output 'Fetching jobs info'
try { $jobs = Invoke-RestMethod -Uri $run.jobs_url -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop } catch { Write-Error "Failed to fetch jobs: $($_.Exception.Message)"; exit 3 }
foreach($j in $jobs.jobs){
  Write-Output ('JOB: {0} -> {1} ({2})' -f $j.name, $j.conclusion, $j.html_url)
  foreach($s in $j.steps){ Write-Output ('  STEP: {0} -> {1}' -f $s.name, $s.conclusion) }
}

$logsZip = "logs/run_${RunId}_logs.zip"
Write-Output "Downloading logs to $logsZip"
try { Invoke-WebRequest -Uri $run.logs_url -Headers @{ Authorization = "Bearer $token" } -OutFile $logsZip -UseBasicParsing -ErrorAction Stop } catch { Write-Error "Failed to download logs: $($_.Exception.Message)"; exit 4 }

if (Test-Path $logsZip) {
  $outDir = "logs/run_$RunId"
  if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
  Expand-Archive -Force -LiteralPath $logsZip -DestinationPath $outDir
  Write-Output 'Extracted logs:'
  Get-ChildItem -Recurse -Path $outDir | Select-Object FullName | ForEach-Object { Write-Output $_.FullName }

  Write-Output 'Searching for error patterns in logs...'
  $patterns = '(?i)error|accessdenied|exitcode|failed|exception|Env WIN_CSC_LINK|cannot resolve|not a file'
  $files = Get-ChildItem -Recurse -Path $outDir | Where-Object { $_.Length -gt 0 }
  foreach($f in $files){
    $txt = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($txt -and ($txt -match $patterns)){
      Write-Output '--- MATCH in:' $f.FullName
      $lines = $txt -split "`n"
      $start = [Math]::Max(0, $lines.Length - 200)
      $tail = $lines[$start..($lines.Length-1)] -join "`n"
      Write-Output $tail
    }
  }
} else {
  Write-Error "Logs zip not found: $logsZip"
}

Write-Output 'Done.'

