$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

$cdn='https://updates.threadsbooster.jp/latest.yml'
$logdir='logs'
New-Item -ItemType Directory -Force -Path $logdir | Out-Null
Write-Host "Downloading $cdn"

# Fetch as string and normalize
$raw = (Invoke-WebRequest -Uri $cdn -UseBasicParsing).Content
if ($raw -is [byte[]]) { $raw = [System.Text.Encoding]::UTF8.GetString($raw) }
$remote = [string]$raw

# Ensure trailing newline
if (-not $remote.EndsWith("`n")) { $remote = $remote + "`n" }

# Prefix plain filenames for path/file/url with nsis-web/
$modified = [regex]::Replace($remote,
  '^(\s*(?:path|file|url):\s*)([^\r\n]+\.(?:exe|7z))$',
  '${1}nsis-web/${2}',
  'Multiline')

$out = Join-Path $logdir 'latest_modified.yml'
Set-Content -LiteralPath $out -Value $modified -Encoding UTF8
Write-Host "Wrote $out"
Write-Host '---START---'
Get-Content -LiteralPath $out -Raw | Write-Host
Write-Host '---END---'

Write-Host "Uploading to S3..."
aws s3 cp $out "s3://container-browser-updates/latest.yml" --region ap-northeast-1 --only-show-errors

Write-Host "Creating CloudFront invalidation..."
& .\scripts\run_cloudfront_invalidation.ps1 -DistributionId 'E1Q66ASB5AODYF' -Region 'ap-northeast-1'

# Extract first .nsis.7z package name
$match = [regex]::Match($modified,'([^\r\n]+\.nsis\.7z)')
if ($match.Success) {
  $pkg = $match.Groups[1].Value.Trim()
  Write-Host "pkg=$pkg"
  $curl = Join-Path $env:SystemRoot 'System32\\curl.exe'
  Write-Host "HEAD check:"
  & $curl -I ("https://updates.threadsbooster.jp/nsis-web/" + [System.Uri]::EscapeDataString($pkg)) | Select-String '^HTTP/'
  Write-Host "Range check:"
  & $curl -A 'INetC/1.0' -r 0-1048575 -s -S -D - -o NUL ("https://updates.threadsbooster.jp/nsis-web/" + [System.Uri]::EscapeDataString($pkg)) | Select-String '^HTTP/'
} else {
  Write-Host "No .nsis.7z pkg found in latest.yml"
  exit 2
}



