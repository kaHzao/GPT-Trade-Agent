#!/bin/bash
# ─── GPT Trade Agent — Auto Runner ───────────────────────────────────────────
# Jalankan bot setiap 15 menit secara otomatis
# Usage: bash run-bot.sh
# Stop:  Ctrl+C

INTERVAL=900   # 15 menit dalam detik
LOG_FILE="bot.log"
DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$DIR"

echo "═══════════════════════════════════════════════"
echo "  GPT Trade Agent — Auto Runner"
echo "  Interval : setiap 15 menit"
echo "  Log file : $DIR/$LOG_FILE"
echo "  Stop     : Ctrl+C"
echo "═══════════════════════════════════════════════"
echo ""

# Pastikan dependencies terinstall
if [ ! -d "node_modules" ]; then
  echo "[SETUP] Installing dependencies..."
  npm install
fi

cycle=1
while true; do
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$TIMESTAMP] ── Cycle #$cycle starting ──"

  # Jalankan bot, output ke terminal DAN log file
  npm run trade 2>&1 | tee -a "$LOG_FILE"

  NEXT=$(date -d "+${INTERVAL} seconds" '+%H:%M:%S' 2>/dev/null || date -v "+${INTERVAL}S" '+%H:%M:%S' 2>/dev/null || echo "in 15 min")
  echo ""
  echo "[$(date '+%H:%M:%S')] Cycle #$cycle done. Next run at: $NEXT"
  echo "──────────────────────────────────────────────"

  cycle=$((cycle + 1))
  sleep $INTERVAL
done
