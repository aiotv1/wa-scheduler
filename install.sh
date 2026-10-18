#!/data/data/com.termux/files/usr/bin/bash
# تثبيت WA Scheduler داخل Termux
set -e
APP="$HOME/wa-scheduler"
cd "$APP"
echo "==> 1/5 تحديث Termux (قد يستغرق بضع دقائق)…"
yes | pkg update -y -o Dpkg::Options::="--force-confnew" >/dev/null 2>&1 || true
echo "==> 2/5 تثبيت Node.js…"
pkg install -y procps termux-api >/dev/null 2>&1 || true
pkg install -y nodejs-lts >/dev/null 2>&1 || pkg install -y nodejs
node -v
echo "==> 3/5 تثبيت المكتبات…"
npm install --omit=dev --legacy-peer-deps --no-audit --no-fund --loglevel=error
echo "==> 4/5 تنظيف الملفات المؤقتة لتوفير المساحة…"
npm cache clean --force >/dev/null 2>&1 || true
pkg clean >/dev/null 2>&1 || true
rm -rf "$HOME/.npm/_cacache" 2>/dev/null || true
echo "==> 5/5 التشغيل التلقائي…"
chmod +x run.sh bin/wa bin/watchdog
ln -sf "$APP/bin/wa" "$PREFIX/bin/wa"
# يعمل عند تشغيل الهاتف (يحتاج تطبيق Termux:Boot)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/wa-scheduler" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/bash
timeout 5 termux-wake-lock 2>/dev/null || true
sleep 20
bash "$HOME/wa-scheduler/bin/wa" start
BOOT
chmod +x "$HOME/.termux/boot/wa-scheduler"
# يعمل أيضاً كلما فتحت Termux إن كان متوقفاً
grep -q "wa-scheduler" "$HOME/.bashrc" 2>/dev/null || echo 'pgrep -f "wa-scheduler/run.sh" >/dev/null || bash "$HOME/wa-scheduler/bin/wa" start' >> "$HOME/.bashrc"
# مراقب كل 15 دقيقة من نظام أندرويد نفسه (يحتاج تطبيق Termux:API)
timeout 15 termux-job-scheduler --cancel --job-id 7 >/dev/null 2>&1 || true
timeout 15 termux-job-scheduler --job-id 7 --period-ms 900000 --network any --persisted true --script "$APP/bin/watchdog" >/dev/null 2>&1 || echo "تنبيه: ثبّت Termux:API من F-Droid لتفعيل المراقب"
bash bin/wa start
echo
echo "✅ انتهى التثبيت! افتح المتصفح على: http://localhost:8080"
du -sh "$APP" "$PREFIX" 2>/dev/null | sed 's/^/   المساحة: /'
