import dotenv from 'dotenv';
dotenv.config();

export type Asset = 'SOL' | 'BTC' | 'ETH';
export const ASSETS: Asset[] = ['SOL', 'BTC', 'ETH'];

export const config = {
  binance: {
    baseUrl: 'https://api.binance.com',
    symbols: {
      SOL: 'SOLUSDT',
      BTC: 'BTCUSDT',
      ETH: 'ETHUSDT',
    } as Record<Asset, string>,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  trading: {
    collateralUsdc: parseFloat(process.env.COLLATERAL_USDC || '10'),
    leverage: parseFloat(process.env.LEVERAGE || '2'),
    dryRun: process.env.DRY_RUN !== 'false',
  },
  ta: {
    // EMA (upgraded to 20/50 — smoother, less noise)
    emaFast: 20,
    emaSlow: 50,

    // RSI
    rsiPeriod: 14,
    rsiBuyMin: 45,       // LONG entry RSI min
    rsiBuyMax: 65,       // LONG entry RSI max
    rsiShortMin: 35,     // SHORT entry RSI min
    rsiShortMax: 55,     // SHORT entry RSI max
    rsiSellMin: 72,      // Overbought trigger

    // ATR
    atrPeriod: 14,
    atrMultiplier: 1.5,

    // ADX (regime detection)
    adxThreshold: 20,           // ADX > 20 = trending
    atrSidewaysThreshold: 1.0,  // ATR% > 1 = enough movement

    // Bollinger Bands
    bbPeriod: 20,
    bbStdDev: 2,

    // General
    volumeMultiplier: 1.3,
    swingLookback: 10,
    minRR: 2.0,          // R:R 1:2 (aligned with GPT suggestion)
    minConfidence: 60,
  },
};
