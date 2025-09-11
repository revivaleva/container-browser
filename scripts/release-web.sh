#!/usr/bin/env bash
set -euo pipefail

UPDATES_BUCKET="container-browser-updates"
PUBLIC_BUCKET="container-browser-public"
CF_DISTRIBUTION_ID="E1Q66ASB5AODYF"

# 1) build
npm ci
npx electron-builder -w nsis-web --publish never

# 2) detect artifacts
VER=$(node -p "require('./package.json').version")
WEB_EXE="dist/Container Browser Web Setup ${VER}.exe"
PKG_7Z=$(ls "dist"/*"${VER}.nsis.7z")
PKG_MAP="${PKG_7Z}.blockmap"
LATEST_YML="dist/latest.yml"

test -f "$WEB_EXE" && test -f "$PKG_7Z" && test -f "$PKG_MAP" && test -f "$LATEST_YML"

# 3) upload: public web installer
aws s3 cp "$WEB_EXE" "s3://${PUBLIC_BUCKET}/" --acl public-read --content-type application/vnd.microsoft.portable-executable --cache-control "public,max-age=31536000,immutable"

# 4) upload: updates
aws s3 cp "$LATEST_YML" "s3://${UPDATES_BUCKET}/latest.yml" --content-type text/yaml --cache-control "no-store"
aws s3 cp "$PKG_7Z"   "s3://${UPDATES_BUCKET}/"            --content-type application/octet-stream --cache-control "no-store"
aws s3 cp "$PKG_MAP"  "s3://${UPDATES_BUCKET}/"            --content-type application/octet-stream --cache-control "no-store"

# 5) CloudFront invalidation
aws cloudfront create-invalidation --distribution-id "${CF_DISTRIBUTION_ID}" --paths "/latest.yml" "/*.nsis.7z" "/*.nsis.7z.blockmap"

echo "Done. Public EXE URL:"
aws s3 presign "s3://${PUBLIC_BUCKET}/$(basename "$WEB_EXE")" --expires-in 3600 || true


