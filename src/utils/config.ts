import dotenv from 'dotenv';
dotenv.config();

export type Asset = 'SOL' | 'BTC' | 'ETH';
export const ASSETS: Asset[] = ['SOL', 'BTC', 'ETH'];

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId:   process.env.TELEGRAM_CHAT_ID   || '',
  },

  trading: {
    collateralUsdc: parseFloat(process.env.COLLATERAL_USDC || '10'),
    leverage:       parseFloat(process.env.LEVERAGE        || '2'),
    dryRun:         process.env.DRY_RUN !== 'false',
  },

  ta: {
    // ── ATR ──────────────────────────────────────────────────────────────────
    atrPeriod:       14,
    atrMultiplier:   1.5,   // SL = ATR(1h) × 1.5  ← FIX: pakai 1h
    atrTpMultiplier: 3.3,   // TP = ATR(1h) × 3.3  → RR ~2.2

    // ── Volatility filter (pakai ATR% dari 30m) ───────────────────────────
    volMinPct: 0.003,  // terlalu sepi = skip
    volMaxPct: 0.025,  // terlalu liar = skip

    // ── Market structure ──────────────────────────────────────────────────
    swingLookback: 3,   // bar kiri+kanan untuk swing detection (TV default: 3–5)

    // ── Breakout candle filter ────────────────────────────────────────────
    bodyMultiplier: 1.0,  // body candle >= avg × 1.0 (tidak terlalu ketat)

    // ── Confidence & R:R ─────────────────────────────────────────────────
    minConfidence: 65,   // naik dari 60
    minRR:         2.0,
  },
};
