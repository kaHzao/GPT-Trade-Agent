#!/bin/bash
# ─── GPT Trade Agent — One-Time Setup & Auto-Start ───────────────────────────
# Jalankan SEKALI: bash setup.sh
# Bot akan jalan otomatis setiap 15 menit, bahkan setelah restart server

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "════════════════════════════════════════════════"
echo "  GPT Trade Agent — Setup & Auto-Start"
echo "════════════════════════════════════════════════"

# 1. Pull kode terbaru
echo "[1/4] Pulling latest code..."
git pull origin main

# 2. Install dependencies
echo "[2/4] Installing dependencies..."
npm install --silent

# 3. Install PM2 kalau belum ada
if ! command -v pm2 &> /dev/null; then
  echo "[3/4] Installing PM2..."
  npm install -g pm2 --silent
else
  echo "[3/4] PM2 already installed ✓"
fi

# 4. Stop instance lama kalau ada, lalu start ulang
echo "[4/4] Starting bot with PM2..."
pm2 delete gpt-trade-agent 2>/dev/null || true
pm2 start ecosystem.config.js

# Simpan agar auto-start setelah reboot
pm2 save

echo ""
echo "════════════════════════════════════════════════"
echo "  ✅ Bot berjalan otomatis setiap 15 menit"
echo ""
echo "  Lihat log  : pm2 logs gpt-trade-agent"
echo "  Status     : pm2 status"
echo "  Stop       : pm2 stop gpt-trade-agent"
echo "════════════════════════════════════════════════"
