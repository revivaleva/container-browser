$ErrorActionPreference='Stop'
param([Parameter(Mandatory)][string]$Path)
if(-not (Test-Path $Path)) { Write-Host "not found: $Path"; exit 2 }
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
if($errors -and $errors.Count -gt 0){
  foreach($err in $errors){
    $loc = $err.Extent.StartLineNumber.ToString() + ':' + $err.Extent.StartColumnNumber.ToString()
    Write-Host ('{0}:{1}  {2}' -f $Path, $loc, $err.Message)
  }
  exit 1
} else {
  Write-Host "No syntax errors in $Path"
}

