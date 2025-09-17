#!/usr/bin/env bash
set -euo pipefail

CDN_URL="${1:-https://updates.threadsbooster.jp}"
BUCKET="${2:-container-browser-updates}"

mkdir -p logs
echo "diagnose run: $(date -u +%Y-%m-%dT%H:%M:%SZ)" > logs/summary.txt
echo "CDN=$CDN_URL" >> logs/summary.txt
echo "BUCKET=$BUCKET" >> logs/summary.txt

curl -sS "$CDN_URL/latest.yml" -o latest.yml || true
echo "--- latest.yml ---" > logs/latest.out
cat latest.yml >> logs/latest.out || true

# extract candidate keys (avoid complex nested quoting)
grep -Eo 'nsis-web/[^[:space:]\"]+' latest.yml | sort -u > logs/candidates.txt || true
if [ ! -s logs/candidates.txt ]; then
  grep -Eo '/nsis-web/[^[:space:]\"]+' latest.yml | sed 's%^/%%' | sort -u > logs/candidates.txt || true
fi

echo "Candidates:" >> logs/summary.txt
cat logs/candidates.txt >> logs/summary.txt || true

mkdir -p logs/tests
echo "Diagnosis run at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" > logs/tests/summary.txt
while IFS= read -r key; do
  [ -z "$key" ] && continue
  echo "=== $key ===" | tee -a logs/tests/summary.txt
  url="$CDN_URL/$key"
  echo "URL: $url" | tee -a logs/tests/summary.txt
  echo "HEAD response code:" >> logs/tests/summary.txt
  curl -IsS -o /dev/null -w "%{http_code}\n" "$url" | tee -a logs/tests/summary.txt || true
  echo "Range 0-1023 response headers:" >> logs/tests/summary.txt
  curl -sS -r 0-1023 -D - "$url" -o /dev/null | sed -n '1,20p' >> logs/tests/summary.txt || true
  if command -v aws >/dev/null 2>&1; then
    echo "S3 head-object for: $key" >> logs/tests/summary.txt
    aws s3api head-object --bucket "$BUCKET" --key "$key" 2>&1 | sed -n '1,20p' >> logs/tests/summary.txt || echo "head-object failed or missing" >> logs/tests/summary.txt
  else
    echo "aws cli not available" >> logs/tests/summary.txt
  fi
  echo "" >> logs/tests/summary.txt
done < logs/candidates.txt || true
echo "Logs saved to logs/tests/summary.txt" >> logs/summary.txt

exit 0


