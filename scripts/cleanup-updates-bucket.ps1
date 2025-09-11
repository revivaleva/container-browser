param()

$UPDATES_BUCKET = "container-browser-updates"

Write-Host "[DRY-RUN] show would-be-deleted:"
aws s3 ls "s3://$UPDATES_BUCKET/" | Select-String -Pattern "Web Setup|\.exe$" | ForEach-Object { Write-Host $_ }

$yn = Read-Host "Delete above from $UPDATES_BUCKET? (yes/no)"
if ($yn -eq 'yes') {
  aws s3 rm "s3://$UPDATES_BUCKET/" --recursive --exclude "*" --include "*Web Setup*.exe"
}


