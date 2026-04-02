import axios from 'axios';
import { ATR } from 'technicalindicators';
import { config, type Asset, ASSETS } from '../utils/config';
import { logger } from '../utils/logger';

export type Signal = 'LONG' | 'SHORT' | 'HOLD';
export type MarketRegime = 'TRENDING' | 'SIDEWAYS';

export interface TAResult {
  asset: Asset;
  signal: Signal;
  reason: string;
  confidence: number;
  currentPrice: number;
  rsi15m: number;
  trend4h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  regime: MarketRegime;
  adx: number;
  suggestedSL: number;
  suggestedTP: number;
  slPct: number;
  tpPct: number;
  rrRatio: number;
}

interface Candle {
  time: number;
  open: number; high: number; low: number;
  close: number; volume: number;
}

// ─── Fetch OHLCV — CryptoCompare (works on GitHub Actions) ───────────────────

async function fetchOHLCV(asset: Asset, tf: '30m' | '4h', limit = 50): Promise<Candle[]> {
  const endpoint  = tf === '30m' ? 'histominute' : 'histohour';
  const aggregate = tf === '30m' ? 30 : 4;

  const { data } = await axios.get(
    `https://min-api.cryptocompare.com/data/${endpoint}`,
    {
      params: { fsym: asset, tsym: 'USD', limit, aggregate, extraParams: 'gpt-trade-agent' },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    }
  );

  if (data.Response === 'Error') throw new Error(data.Message);
  return (data.Data || []).map((k: any) => ({
    time:   k.time * 1000,
    open:   k.open,
    high:   k.high,
    low:    k.low,
    close:  k.close,
    volume: k.volumefrom,
  }));
}

// ─── 1. MACRO FILTER (4H) — Market Structure HH/HL vs LH/LL ─────────────────

function getMacroBias(candles: Candle[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (candles.length < 3) return 'NEUTRAL';
  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const hh = curr.high > prev.high;
  const hl  = curr.low  > prev.low;
  const lh  = curr.high < prev.high;
  const ll  = curr.low  < prev.low;

  if (hh && hl) return 'BULLISH';
  if (lh && ll) return 'BEARISH';
  return 'NEUTRAL';
}

// ─── 2. VOLATILITY FILTER (30m ATR) ──────────────────────────────────────────

function getATR(candles: Candle[]): number {
  const arr = ATR.calculate({
    period: 14,
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
  return arr.length ? arr[arr.length - 1] : candles[candles.length - 1].close * 0.01;
}

function isValidVolatility(atr: number, price: number): boolean {
  const vol = atr / price;
  if (vol < 0.003) return false;  // terlalu sepi = chop
  if (vol > 0.02)  return false;  // terlalu liar = spike
  return true;
}

// ─── 3. ENTRY LOGIC (30m Structure + Momentum) ───────────────────────────────

function getEntrySignal(candles: Candle[]): { signal: Signal; reason: string } {
  if (candles.length < 5) return { signal: 'HOLD', reason: 'Insufficient data' };

  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const avgBody = candles.slice(-10).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 10;
  const body    = Math.abs(curr.close - curr.open);

  const bullishBreak     = curr.close > prev.high;
  const bearishBreak     = curr.close < prev.low;
  const strongBullCandle = curr.close > curr.open && body > avgBody;
  const strongBearCandle = curr.close < curr.open && body > avgBody;

  if (bullishBreak && strongBullCandle) {
    return { signal: 'LONG',  reason: `Bullish breakout $${prev.high.toFixed(2)} | strong bull candle` };
  }
  if (bearishBreak && strongBearCandle) {
    return { signal: 'SHORT', reason: `Bearish breakout $${prev.low.toFixed(2)} | strong bear candle` };
  }
  return { signal: 'HOLD', reason: 'No breakout structure' };
}

// ─── 4. MACRO DIRECTION FILTER ────────────────────────────────────────────────

function applyMacroFilter(signal: Signal, macro: string): Signal {
  if (macro === 'BEARISH' && signal === 'LONG')  return 'HOLD';
  if (macro === 'BULLISH' && signal === 'SHORT') return 'HOLD';
  return signal;
}

// ─── 5. SL/TP ATR-based RR 2.2 ───────────────────────────────────────────────

function getSLTP(price: number, atr: number, signal: Signal) {
  const slDist = atr * 1.2;
  const tpDist = slDist * 2.2;

  if (signal === 'LONG')  return { sl: price - slDist, tp: price + tpDist, rr: 2.2 };
  if (signal === 'SHORT') return { sl: price + slDist, tp: price - tpDist, rr: 2.2 };
  return { sl: 0, tp: 0, rr: 0 };
}

// ─── 6. CONFIDENCE ───────────────────────────────────────────────────────────

function getConfidence(macro: string, volValid: boolean, signal: Signal, c4hAgree: number): number {
  let score = 40;
  if (macro !== 'NEUTRAL') score += 20;
  score += Math.min(c4hAgree * 5, 15);
  if (volValid)            score += 15;
  if (signal !== 'HOLD')   score += 10;
  return Math.min(score, 95);
}

// ─── Main Analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    const c30m = await fetchOHLCV(asset, '30m', 50);
    await new Promise(r => setTimeout(r, 1000));
    const c4h  = await fetchOHLCV(asset, '4h',  20);

    if (c30m.length < 20 || c4h.length < 5) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    const price = c30m[c30m.length - 1].close;

    // Macro bias from 4h structure
    const macro  = getMacroBias(c4h);
    const trend4h: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = macro;
    const trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = macro;

    // Count agreeing 4h candles
    let c4hAgree = 0;
    for (let i = c4h.length - 5; i < c4h.length - 1; i++) {
      if (macro === 'BULLISH' && c4h[i].close > c4h[i].open) c4hAgree++;
      if (macro === 'BEARISH' && c4h[i].close < c4h[i].open) c4hAgree++;
    }

    // Volatility filter
    const atr      = getATR(c30m);
    const volValid = isValidVolatility(atr, price);
    const volPct   = (atr / price * 100).toFixed(2);

    if (!volValid) {
      const reason = atr / price < 0.003 ? 'Volatility too low (chop)' : 'Volatility too high (spike)';
      logger.info(`${asset} → HOLD | ${reason} | vol:${volPct}%`);
      return {
        asset, signal: 'HOLD', reason,
        confidence: 20, currentPrice: price,
        rsi15m: 50, trend4h, trend1h,
        regime: 'SIDEWAYS', adx: 0,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
      };
    }

    // Entry signal
    const { signal: rawSignal, reason: entryReason } = getEntrySignal(c30m);

    // Apply macro filter
    const signal = applyMacroFilter(rawSignal, macro);
    const reason = signal !== rawSignal
      ? `${rawSignal} blocked by macro (${macro})`
      : entryReason;

    // Confidence
    const confidence = getConfidence(macro, volValid, signal, c4hAgree);

    logger.info(
      `${asset} → ${signal} | macro:${macro} | vol:${volPct}% | conf:${confidence}% | 4h:${trend4h}`
    );

    if (signal === 'HOLD') {
      return {
        asset, signal: 'HOLD', reason,
        confidence, currentPrice: price,
        rsi15m: 50, trend4h, trend1h,
        regime: macro === 'NEUTRAL' ? 'SIDEWAYS' : 'TRENDING', adx: 0,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
      };
    }

    // Confidence gate
    if (confidence < config.ta.minConfidence) {
      return {
        asset, signal: 'HOLD',
        reason: `Confidence too low (${confidence}% < ${config.ta.minConfidence}%)`,
        confidence, currentPrice: price,
        rsi15m: 50, trend4h, trend1h,
        regime: 'TRENDING', adx: 0,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
      };
    }

    // SL/TP
    const { sl, tp, rr } = getSLTP(price, atr, signal);
    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(price - tp);
    const slPct  = (slDist / price) * 100;
    const tpPct  = (tpDist / price) * 100;

    if (rr < config.ta.minRR) {
      return {
        asset, signal: 'HOLD',
        reason: `R:R too low (${rr.toFixed(1)} < ${config.ta.minRR})`,
        confidence, currentPrice: price,
        rsi15m: 50, trend4h, trend1h,
        regime: 'TRENDING', adx: 0,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: rr,
      };
    }

    return {
      asset, signal, reason, confidence,
      currentPrice: price, rsi15m: 50,
      trend4h, trend1h,
      regime: 'TRENDING', adx: 0,
      suggestedSL: sl, suggestedTP: tp,
      slPct, tpPct, rrRatio: rr,
    };

  } catch (err: any) {
    logger.error(`${asset} analysis failed: ${err.message}`);
    return null;
  }
}

export async function analyzeAll(): Promise<TAResult[]> {
  const results: TAResult[] = [];
  for (const asset of ASSETS) {
    const r = await analyzeAsset(asset).catch(() => null);
    if (r) results.push(r);
    await new Promise(res => setTimeout(res, 3000));
  }
  return results;
}
