import { ATR } from 'technicalindicators';
import { config, type Asset, ASSETS } from '../utils/config';
import { logger } from '../utils/logger';

export type Signal       = 'LONG' | 'SHORT' | 'HOLD';
export type MarketRegime = 'TRENDING' | 'SIDEWAYS';

export interface TAResult {
  asset:        Asset;
  signal:       Signal;
  reason:       string;
  confidence:   number;
  currentPrice: number;
  rsi15m:       number;
  trend4h:      'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trend1h:      'BULLISH' | 'BEARISH' | 'NEUTRAL';
  regime:       MarketRegime;
  adx:          number;
  suggestedSL:  number;
  suggestedTP:  number;
  slPct:        number;
  tpPct:        number;
  rrRatio:      number;
}

interface Candle {
  time:   number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

// ─── OKX symbol map ───────────────────────────────────────────────────────────

const OKX_SYMBOL: Record<string, string> = {
  SOL:  'SOL-USDT',
  BTC:  'BTC-USDT',
  WBTC: 'BTC-USDT',
  ETH:  'ETH-USDT',
};

// ─── Fetch OHLCV dari OKX ─────────────────────────────────────────────────────

async function fetchOHLCV(asset: Asset, tf: '30m' | '1h' | '4h', limit = 60): Promise<Candle[]> {
  const instId = OKX_SYMBOL[asset];
  if (!instId) throw new Error(`Unknown asset: ${asset}`);

  const bar = tf === '30m' ? '30m' : tf === '1h' ? '1H' : '4H';
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit + 1}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OKX API error: ${res.status}`);

  const json = await res.json();
  if (json.code !== '0') throw new Error(`OKX error: ${json.msg}`);

  // OKX: terbaru → terlama, reverse + buang candle live
  const candles = (json.data as string[][])
    .reverse()
    .slice(0, -1)
    .map(k => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

  return candles;
}

// ─── 1. MACRO BIAS — swing high/low dari N candle 4h ─────────────────────────

function getMacroBias(c4h: Candle[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  const n = config.ta.swingLookback;
  if (c4h.length < n + 2) return 'NEUTRAL';

  const recent = c4h.slice(-(n + 1));
  const prev   = c4h.slice(-(n * 2 + 1), -(n + 1));

  if (recent.length < 3 || prev.length < 3) return 'NEUTRAL';

  const recentHigh = Math.max(...recent.map(c => c.high));
  const prevHigh   = Math.max(...prev.map(c => c.high));
  const recentLow  = Math.min(...recent.map(c => c.low));
  const prevLow    = Math.min(...prev.map(c => c.low));

  const hh = recentHigh > prevHigh;
  const hl  = recentLow  > prevLow;
  const lh  = recentHigh < prevHigh;
  const ll  = recentLow  < prevLow;

  if (hh && hl)  return 'BULLISH';
  if (lh && ll)  return 'BEARISH';
  return 'NEUTRAL';
}

// ─── 2. TREND STRENGTH ────────────────────────────────────────────────────────

function getTrendStrength(c4h: Candle[], bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): number {
  if (bias === 'NEUTRAL') return 0;
  const recent = c4h.slice(-config.ta.swingLookback);
  const aligned = recent.filter(c =>
    bias === 'BULLISH' ? c.close > c.open : c.close < c.open
  );
  return aligned.length / recent.length;
}

// ─── 3. ATR ───────────────────────────────────────────────────────────────────

function getATR(candles: Candle[]): number {
  const arr = ATR.calculate({
    period: config.ta.atrPeriod,
    high:   candles.map(c => c.high),
    low:    candles.map(c => c.low),
    close:  candles.map(c => c.close),
  });
  return arr.length ? arr[arr.length - 1] : candles[candles.length - 1].close * 0.01;
}

// ─── 4. VOLATILITY FILTER (30m ATR%) ─────────────────────────────────────────

function isValidVolatility(atr30m: number, price: number): { ok: boolean; reason: string } {
  const pct = atr30m / price;
  if (pct < config.ta.volMinPct) return { ok: false, reason: `Vol terlalu rendah (${(pct*100).toFixed(3)}% < ${config.ta.volMinPct*100}%) — chop` };
  if (pct > config.ta.volMaxPct) return { ok: false, reason: `Vol terlalu tinggi (${(pct*100).toFixed(3)}% > ${config.ta.volMaxPct*100}%) — spike` };
  return { ok: true, reason: '' };
}

// ─── 5. ENTRY SIGNAL — breakout 30m + strong body ────────────────────────────

function getEntrySignal(c30m: Candle[]): { signal: Signal; reason: string; breakoutPct: number } {
  if (c30m.length < 5) return { signal: 'HOLD', reason: 'Insufficient data', breakoutPct: 0 };

  const curr = c30m[c30m.length - 1];
  const prev = c30m[c30m.length - 2];

  const avgBody  = c30m.slice(-10).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 10;
  const body     = Math.abs(curr.close - curr.open);
  const strongBody = body >= avgBody * config.ta.bodyMultiplier;

  const bullBreak = curr.close > prev.high;
  const bearBreak = curr.close < prev.low;

  const bullPct = bullBreak ? ((curr.close - prev.high) / prev.high) * 100 : 0;
  const bearPct = bearBreak ? ((prev.low - curr.close) / prev.low)  * 100 : 0;

  if (bullBreak && strongBody) {
    return {
      signal: 'LONG',
      reason: `Bullish breakout prev.high $${prev.high.toFixed(2)} (+${bullPct.toFixed(2)}%) | body ${body.toFixed(2)} vs avg ${avgBody.toFixed(2)}`,
      breakoutPct: bullPct,
    };
  }
  if (bearBreak && strongBody) {
    return {
      signal: 'SHORT',
      reason: `Bearish breakout prev.low $${prev.low.toFixed(2)} (-${bearPct.toFixed(2)}%) | body ${body.toFixed(2)} vs avg ${avgBody.toFixed(2)}`,
      breakoutPct: bearPct,
    };
  }

  return { signal: 'HOLD', reason: 'No breakout', breakoutPct: 0 };
}

// ─── 6. MACRO FILTER ─────────────────────────────────────────────────────────

function applyMacroFilter(signal: Signal, macro: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): Signal {
  if (macro === 'NEUTRAL') return 'HOLD';
  if (macro === 'BEARISH' && signal === 'LONG')  return 'HOLD';
  if (macro === 'BULLISH' && signal === 'SHORT') return 'HOLD';
  return signal;
}

// ─── 7. SL/TP — ATR dari 1h ──────────────────────────────────────────────────

function getSLTP(price: number, atr1h: number, signal: Signal) {
  const slDist = atr1h * config.ta.atrMultiplier;
  const tpDist = atr1h * config.ta.atrTpMultiplier;

  if (signal === 'LONG')  return { sl: price - slDist, tp: price + tpDist };
  if (signal === 'SHORT') return { sl: price + slDist, tp: price - tpDist };
  return { sl: 0, tp: 0 };
}

// ─── 8. CONFIDENCE ───────────────────────────────────────────────────────────

function getConfidence(
  macro:       'BULLISH' | 'BEARISH' | 'NEUTRAL',
  trendStr:    number,
  volValid:    boolean,
  breakoutPct: number,
  strongBody:  boolean,
): number {
  let score = 0;

  if (macro !== 'NEUTRAL') score += 30;
  score += Math.round(trendStr * 20);

  if (breakoutPct >= 0.3) score += 15;
  else if (breakoutPct >= 0.2) score += 10;
  else if (breakoutPct >= 0.1) score += 5;

  if (volValid)    score += 15;
  if (strongBody)  score += 10;

  return Math.min(100, score);
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    const c30m = await fetchOHLCV(asset, '30m', 60);
    await new Promise(r => setTimeout(r, 500));
    const c1h  = await fetchOHLCV(asset, '1h',  60);
    await new Promise(r => setTimeout(r, 500));
    const c4h  = await fetchOHLCV(asset, '4h',  30);

    if (c30m.length < 20 || c1h.length < 20 || c4h.length < config.ta.swingLookback * 2 + 2) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    // Pakai 1h close sebagai price reference — lebih stable dari 30m
    const price = c1h[c1h.length - 1].close;

    const macro    = getMacroBias(c4h);
    const trendStr = getTrendStrength(c4h, macro);
    const trend4h  = macro;
    const trend1h  = macro;

    const atr30m   = getATR(c30m);
    const volCheck = isValidVolatility(atr30m, price);
    const volPct   = (atr30m / price * 100).toFixed(3);

    if (!volCheck.ok) {
      logger.info(`${asset} → HOLD | ${volCheck.reason}`);
      return makeHold(asset, volCheck.reason, price, trend4h, trend1h, macro);
    }

    if (macro === 'NEUTRAL') {
      const reason = `Macro NEUTRAL — tidak ada struktur jelas`;
      logger.info(`${asset} → HOLD | ${reason}`);
      return makeHold(asset, reason, price, trend4h, trend1h, macro);
    }

    const { signal: rawSignal, reason: entryReason, breakoutPct } = getEntrySignal(c30m);
    const signal = applyMacroFilter(rawSignal, macro);
    const reason = signal !== rawSignal
      ? `${rawSignal} blocked — macro ${macro}, tidak searah`
      : entryReason;

    const curr       = c30m[c30m.length - 1];
    const avgBody    = c30m.slice(-10).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 10;
    const body       = Math.abs(curr.close - curr.open);
    const strongBody = body >= avgBody * config.ta.bodyMultiplier;

    const confidence = signal !== 'HOLD'
      ? getConfidence(macro, trendStr, volCheck.ok, breakoutPct, strongBody)
      : 0;

    logger.info(
      `${asset} → ${signal} | macro:${macro} | str:${(trendStr*100).toFixed(0)}% | ` +
      `vol:${volPct}% | break:${breakoutPct.toFixed(3)}% | conf:${confidence}%`
    );

    if (signal !== 'HOLD' && confidence < config.ta.minConfidence) {
      const r = `Confidence terlalu rendah (${confidence}% < ${config.ta.minConfidence}%)`;
      return makeHold(asset, r, price, trend4h, trend1h, macro, confidence);
    }

    if (signal === 'HOLD') {
      return makeHold(asset, reason, price, trend4h, trend1h, macro, confidence);
    }

    // ATR dari 1h — lebih lebar, hindari whipsaw
    const atr1h = getATR(c1h);
    const { sl, tp } = getSLTP(price, atr1h, signal);

    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(price - tp);

    if (slDist <= 0 || tpDist <= 0) {
      return makeHold(asset, 'Invalid SL/TP geometry', price, trend4h, trend1h, macro);
    }

    const rr    = tpDist / slDist;
    const slPct = (slDist / price) * 100;
    const tpPct = (tpDist / price) * 100;

    if (rr < config.ta.minRR) {
      return makeHold(asset, `R:R ${rr.toFixed(2)} < ${config.ta.minRR}`, price, trend4h, trend1h, macro, confidence);
    }

    return {
      asset, signal, reason, confidence, currentPrice: price,
      rsi15m: 50,
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

function makeHold(
  asset: Asset, reason: string, price: number,
  trend4h: 'BULLISH'|'BEARISH'|'NEUTRAL',
  trend1h: 'BULLISH'|'BEARISH'|'NEUTRAL',
  macro:   'BULLISH'|'BEARISH'|'NEUTRAL',
  confidence = 0
): TAResult {
  return {
    asset, signal: 'HOLD', reason, confidence, currentPrice: price,
    rsi15m: 50, trend4h, trend1h,
    regime: macro === 'NEUTRAL' ? 'SIDEWAYS' : 'TRENDING',
    adx: 0,
    suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
  };
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
