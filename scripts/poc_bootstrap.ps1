# PoC bootstrap installer (PowerShell)
# Usage: Run as user (UAC will prompt when installer needs admin)
#   powershell -ExecutionPolicy Bypass -File .\scripts\poc_bootstrap.ps1 -ManifestUrl "https://your-cdn.example.com/latest.json" -DownloadDir "$env:TEMP\cb_bootstrap"

param(
    [Parameter(Mandatory=$true)]
    [string]$ManifestUrl,

    [string]$DownloadDir = "$env:TEMP\cb_bootstrap",

    [int]$RetryCount = 3
)

function Write-Log([string]$msg) {
    $t = (Get-Date).ToString('s')
    Write-Host "[$t] $msg"
}

function Get-Json([string]$url) {
    Try {
        $res = Invoke-WebRequest -Uri $url -UseBasicParsing -ErrorAction Stop
        return $res.Content | ConvertFrom-Json
    } Catch {
        throw "Failed to fetch JSON from $url : $($_.Exception.Message)"
    }
}

function Download-File([string]$url, [string]$outPath) {
    $attempt = 0
    while ($attempt -lt $RetryCount) {
        $attempt++
        Try {
            Write-Log "Downloading $url (attempt $attempt)"
            Invoke-WebRequest -Uri $url -OutFile $outPath -UseBasicParsing -ErrorAction Stop
            return
        } Catch {
            Write-Log "Download failed: $($_.Exception.Message)"
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
    throw "Download failed after $RetryCount attempts"
}

function Get-FileSha256([string]$path) {
    if (-not (Test-Path $path)) { throw "File not found: $path" }
    $sha = Get-FileHash -Algorithm SHA256 -Path $path
    return $sha.Hash.ToLowerInvariant()
}

# Main
Try {
    Write-Log "Bootstrap start. Manifest: $ManifestUrl"

    New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null

    $manifest = Get-Json $ManifestUrl
    # Expected manifest fields: version, url, sha256
    if (-not $manifest.url) { throw "Manifest missing 'url'" }
    if (-not $manifest.sha256) { throw "Manifest missing 'sha256'" }

    $installerUrl = $manifest.url
    $expectedSha = $manifest.sha256.ToLowerInvariant()

    $fileName = [System.IO.Path]::GetFileName([System.Uri]::UnescapeDataString($installerUrl))
    $outPath = Join-Path -Path $DownloadDir -ChildPath $fileName

    Download-File -url $installerUrl -outPath $outPath

    $actualSha = Get-FileSha256 $outPath
    Write-Log "Expected sha256: $expectedSha"
    Write-Log "Actual   sha256: $actualSha"

    if ($actualSha -ne $expectedSha) {
        throw "SHA256 mismatch; aborting."
    }

    Write-Log "Checksum OK. Launching installer: $outPath"

    # Launch installer (non-blocking). If UAC is required, user will be prompted.
    Start-Process -FilePath $outPath -Verb RunAs

    Write-Log "Bootstrap finished (installer launched)."
} Catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
}
