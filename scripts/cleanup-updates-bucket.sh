#!/usr/bin/env bash
set -euo pipefail
UPDATES_BUCKET="container-browser-updates"

echo "[DRY-RUN] show would-be-deleted:"
aws s3 ls "s3://${UPDATES_BUCKET}/" | grep -E "Web Setup|\.exe$" || true

read -p "Delete above from ${UPDATES_BUCKET}? (yes/no) " yn
if [ "$yn" = "yes" ]; then
  aws s3 rm "s3://${UPDATES_BUCKET}/" --recursive --exclude "*" --include "*Web Setup*.exe"
fi


