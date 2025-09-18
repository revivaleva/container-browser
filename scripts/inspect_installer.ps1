$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path logs | Out-Null
$path = 'logs/ContainerBrowser-Web-Setup.exe'
if (-not (Test-Path $path)) { Write-Host "ERROR: installer not present at $path"; exit 2 }
$f = Get-Item $path
$vi = $f.VersionInfo
Write-Host ('ProductVersion: {0}' -f $vi.ProductVersion)
Write-Host ('FileVersion: {0}' -f $vi.FileVersion)
Write-Host ('ProductName: {0}' -f $vi.ProductName)
Write-Host ''
Write-Host 'Searching for updates.threadsbooster.jp in ASCII view of binary...'
try {
  $bytes = [IO.File]::ReadAllBytes($path)
  $s = [System.Text.Encoding]::ASCII.GetString($bytes)
  if ($s.IndexOf('updates.threadsbooster.jp') -ge 0) { Write-Host 'Found updates.threadsbooster.jp in binary' } else { Write-Host 'No ascii updates.threadsbooster.jp in binary' }
} catch {
  Write-Host 'Binary read/search failed:' $_.Exception.Message
}
Write-Host ''
Write-Host 'Searching for package filenames and embedded latest.yml content (ascii)...'
try {
  $patterns = @('container-browser-0.3.0-x64.nsis.7z','container-browser-0.3.0','latest.yml')
  foreach($p in $patterns){
    $i = $s.IndexOf($p)
    if($i -ge 0){
      Write-Host "FOUND pattern '$p' at offset $i"
      $start = [Math]::Max(0,$i-80)
      $len = [Math]::Min(400,$s.Length-$start)
      $snip = $s.Substring($start,$len) -replace "[\x00-\x1F]","."
      Write-Host '---- snippet ----'
      Write-Host $snip
      Write-Host '---- end snippet ----'
    } else {
      Write-Host "pattern '$p' not found"
    }
  }
} catch {
  Write-Host 'Binary read/search failed for patterns:' $_.Exception.Message
}

Write-Host 'Done.'


