$zip = 'scripts/logs/run_17790673856_job_50566778843.zip'
if (-not (Test-Path $zip)) { Write-Output "Zip not found: $zip"; exit 0 }
$fi = Get-Item $zip
Write-Output ("Zip size: {0} bytes" -f $fi.Length)
$bytes = [System.IO.File]::ReadAllBytes($zip)
$len = $bytes.Length
$take = [math]::Min(1024,$len)
$first = [System.Text.Encoding]::UTF8.GetString($bytes,0,$take)
Write-Output '--- first bytes (as UTF8) ---'
Write-Output $first


