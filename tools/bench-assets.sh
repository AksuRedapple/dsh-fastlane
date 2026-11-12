#!/bin/bash
BASE=${1:-http://127.0.0.1:8781}; LABEL=${2:-run}
HTML=$(curl -sS "$BASE/")
TOTAL=0
for A in $(echo "$HTML" | grep -o -E '(src|href)="\./assets/[^"]+"' | sed -E 's/.*"\.\/(.*)"/\1/' | sort -u); do
  R=$(curl -sS -o /dev/null -H "Accept-Encoding: gzip" -w "%{size_download} %{http_code} %header{x-dshp-cache}" "$BASE/$A")
  SZ=$(echo $R | cut -d' ' -f1); ST=$(echo $R | cut -d' ' -f2); CA=$(echo $R | cut -d' ' -f3)
  TOTAL=$((TOTAL+SZ))
  printf "  %-28s %7dB %s %s\n" "$A" "$SZ" "$ST" "$CA"
done
echo "$LABEL: 首屏静态资源合计 $((TOTAL/1024)) KB"
