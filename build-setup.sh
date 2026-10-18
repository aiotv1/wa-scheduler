#!/usr/bin/env bash
# يبني ملف تثبيت واحد للهاتف: dist/wa-scheduler-setup.sh
cd "$(dirname "$0")"
mkdir -p dist
OUT=dist/wa-scheduler-setup.sh
cat > "$OUT" <<'HEAD'
#!/data/data/com.termux/files/usr/bin/bash
# WA Scheduler — ملف التثبيت. شغّله داخل Termux:  bash wa-scheduler-setup.sh
set -e
APP="$HOME/wa-scheduler"
echo "==> فك ملفات التطبيق في $APP"
[ -x "$APP/bin/wa" ] && bash "$APP/bin/wa" stop >/dev/null 2>&1 || true
mkdir -p "$APP"
sed -n '/^__PAYLOAD_BELOW__$/,$p' "$0" | tail -n +2 | base64 -d | tar xzf - -C "$APP"
bash "$APP/install.sh"
exit 0
__PAYLOAD_BELOW__
HEAD
tar czf - server.js package.json package-lock.json run.sh install.sh bin public | base64 >> "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
