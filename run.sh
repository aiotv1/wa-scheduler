#!/data/data/com.termux/files/usr/bin/bash
# يبقي السيرفر يعمل: إذا توقف لأي سبب يعيد تشغيله بعد 5 ثوانٍ
cd "$(dirname "$(readlink -f "$0")")"
mkdir -p data
command -v termux-wake-lock >/dev/null && timeout 5 termux-wake-lock
while true; do
  if [ -f data/console.log ] && [ "$(stat -c %s data/console.log 2>/dev/null || echo 0)" -gt 1000000 ]; then
    mv -f data/console.log data/console.log.1
  fi
  echo "=== start $(date) ===" >> data/console.log
  node server.js >> data/console.log 2>&1
  echo "=== stopped (code $?) $(date) — restart in 5s ===" >> data/console.log
  sleep 5
done
