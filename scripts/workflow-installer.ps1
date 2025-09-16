param()
$ErrorActionPreference='Stop'
New-Item -Type Directory -Force logs | Out-Null

# 1) build
& "$PSScriptRoot\build-installer.ps1" | Tee-Object -FilePath 'logs\flow_step_build.txt'

# 2) try publish if AWS & S3 accessible; else run local
$canAws = $false
try { aws sts get-caller-identity | Out-Null; $canAws = $true } catch { $canAws = $false }
if($canAws){
  try { aws s3 ls 's3://container-browser-updates' | Out-Null } catch { $canAws = $false }
}

if($canAws){
  & "$PSScriptRoot\publish-installer.ps1" | Tee-Object -FilePath 'logs\flow_step_publish.txt'
} else {
  & "$PSScriptRoot\run-local-installer.ps1" | Tee-Object -FilePath 'logs\flow_step_runlocal.txt'
}

