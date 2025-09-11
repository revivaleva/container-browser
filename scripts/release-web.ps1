param()

$UPDATES_BUCKET = "container-browser-updates"
$PUBLIC_BUCKET = "container-browser-public"
$CF_DISTRIBUTION_ID = "E1Q66ASB5AODYF"

Set-StrictMode -Version Latest
npm ci
npx electron-builder -w nsis-web --publish never

$pkg = Get-Content package.json | ConvertFrom-Json
$VER = $pkg.version
$WEB_EXE = "dist/Container Browser Web Setup $VER.exe"
$PKG_7Z = (Get-ChildItem -Path dist -Filter "*$VER.nsis.7z" | Select-Object -First 1).FullName
$PKG_MAP = "$PKG_7Z.blockmap"
$LATEST_YML = "dist/latest.yml"

if (-not (Test-Path $WEB_EXE)) { throw "Missing $WEB_EXE" }
if (-not (Test-Path $PKG_7Z)) { throw "Missing $PKG_7Z" }
if (-not (Test-Path $PKG_MAP)) { throw "Missing $PKG_MAP" }
if (-not (Test-Path $LATEST_YML)) { throw "Missing $LATEST_YML" }

# upload public
aws s3 cp $WEB_EXE "s3://$PUBLIC_BUCKET/" --acl public-read --content-type "application/vnd.microsoft.portable-executable" --cache-control "public,max-age=31536000,immutable"

# upload updates
aws s3 cp $LATEST_YML "s3://$UPDATES_BUCKET/latest.yml" --content-type "text/yaml" --cache-control "no-store"
aws s3 cp $PKG_7Z   "s3://$UPDATES_BUCKET/"            --content-type "application/octet-stream" --cache-control "no-store"
aws s3 cp $PKG_MAP  "s3://$UPDATES_BUCKET/"            --content-type "application/octet-stream" --cache-control "no-store"

# invalidation
aws cloudfront create-invalidation --distribution-id $CF_DISTRIBUTION_ID --paths "/latest.yml" "/*.nsis.7z" "/*.nsis.7z.blockmap"

Write-Host "Done. Public EXE URL:"
aws s3 presign "s3://$PUBLIC_BUCKET/$(Split-Path $WEB_EXE -Leaf)" --expires-in 3600 | Write-Host


