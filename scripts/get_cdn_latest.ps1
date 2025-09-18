$ErrorActionPreference='Stop'
$curl = "$env:SystemRoot\System32\curl.exe"
Write-Host '--- HTTP HEAD latest.yml ---'
& $curl -I 'https://updates.threadsbooster.jp/latest.yml' | Select-String '^HTTP/' | ForEach-Object { Write-Host $_.Line }
Write-Host ''
Write-Host '--- latest.yml content ---'
& $curl -sS 'https://updates.threadsbooster.jp/latest.yml' | Out-Host



