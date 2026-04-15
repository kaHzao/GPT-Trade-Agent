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

interface SwingPoint {
  index:  number;
  price:  number;
  type:   'HIGH' | 'LOW';
}

interface OrderBlock {
  top:    number;
  bottom: number;
  type:   'BULLISH' | 'BEARISH'; // bullish OB = demand, bearish OB = supply
  index:  number;
}

interface SMCBias {
  bias:           'BULLISH' | 'BEARISH' | 'NEUTRAL';
  lastBOS:        'UP' | 'DOWN' | null;
  lastCHoCH:      'UP' | 'DOWN' | null;
  orderBlock:     OrderBlock | null;
  inOBZone:       boolean;
  structureLabel: string; // e.g. "HH/HL", "LH/LL" — untuk debug vs TradingView
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

  const json = await res.json() as any;
  if (json.code !== '0') throw new Error(`OKX error: ${json.msg}`);

  return (json.data as string[][])
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
}

// ─── ATR ──────────────────────────────────────────────────────────────────────

function getATR(candles: Candle[]): number {
  const arr = ATR.calculate({
    period: config.ta.atrPeriod,
    high:   candles.map(c => c.high),
    low:    candles.map(c => c.low),
    close:  candles.map(c => c.close),
  });
  return arr.length ? arr[arr.length - 1] : candles[candles.length - 1].close * 0.01;
}

// ─── Volatility filter ────────────────────────────────────────────────────────

function isValidVolatility(atr30m: number, price: number): boolean {
  const pct = atr30m / price;
  return pct >= config.ta.volMinPct && pct <= config.ta.volMaxPct;
}

// ─── SMC: Detect swing highs and lows ────────────────────────────────────────
// Swing high = candle high STRICTLY lebih tinggi dari N candle kiri dan kanan
// Swing low  = candle low STRICTLY lebih rendah dari N candle kiri dan kanan
// strength=3 → sama dengan TV SMC indicator default (length=3)

function detectSwingPoints(candles: Candle[], strength = config.ta.swingLookback): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const curr = candles[i];

    // Pakai < (strict) bukan <= agar tidak ada duplikat swing di harga yang sama
    const isSwingHigh = candles.slice(i - strength, i).every(c => c.high < curr.high) &&
                        candles.slice(i + 1, i + strength + 1).every(c => c.high < curr.high);
    if (isSwingHigh) {
      swings.push({ index: i, price: curr.high, type: 'HIGH' });
    }

    const isSwingLow = candles.slice(i - strength, i).every(c => c.low > curr.low) &&
                       candles.slice(i + 1, i + strength + 1).every(c => c.low > curr.low);
    if (isSwingLow) {
      swings.push({ index: i, price: curr.low, type: 'LOW' });
    }
  }

  return swings.sort((a, b) => a.index - b.index);
}

// ─── SMC: Detect BOS dan CHoCH ───────────────────────────────────────────────
// BOS   = Break of Structure → break SEARAH trend (konfirmasi continuation)
// CHoCH = Change of Character → break BERLAWANAN trend (sinyal reversal)
//
// Logika benar (sesuai TradingView SMC):
//   UPTREND   (HH+HL): BOS UP   = close > lastHigh | CHoCH DOWN = close < lastLow
//   DOWNTREND (LH+LL): BOS DOWN = close < lastLow  | CHoCH UP   = close > lastHigh

function detectBOSandCHoCH(candles: Candle[], swings: SwingPoint[]): {
  lastBOS:        'UP' | 'DOWN' | null;
  lastCHoCH:      'UP' | 'DOWN' | null;
  bias:           'BULLISH' | 'BEARISH' | 'NEUTRAL';
  structureLabel: string;
} {
  const empty = { lastBOS: null as null, lastCHoCH: null as null, bias: 'NEUTRAL' as const, structureLabel: '??/??' };

  if (swings.length < 4) return empty;

  const highs = swings.filter(s => s.type === 'HIGH');
  const lows  = swings.filter(s => s.type === 'LOW');

  if (highs.length < 2 || lows.length < 2) return empty;

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow  = lows[lows.length - 1];
  const prevLow  = lows[lows.length - 2];

  // Ambil 5 close terakhir untuk scan BOS/CHoCH — lebih persistent
  // TradingView tetap tampilkan BOS walau harga sudah retrace kembali
  const recentCloses = candles.slice(-5).map(c => c.close);
  const currClose    = recentCloses[recentCloses.length - 1];

  // Label struktur swing — sama persis dengan label TradingView
  const highLabel = lastHigh.price > prevHigh.price ? 'HH'
                  : lastHigh.price < prevHigh.price ? 'LH' : 'EH';
  const lowLabel  = lastLow.price  > prevLow.price  ? 'HL'
                  : lastLow.price  < prevLow.price  ? 'LL' : 'EL';
  const structureLabel = `${highLabel}/${lowLabel}`;

  // Tentukan trend dominan dari struktur swing
  const isHH = lastHigh.price > prevHigh.price;
  const isHL  = lastLow.price  > prevLow.price;
  const isLH  = lastHigh.price < prevHigh.price;
  const isLL  = lastLow.price  < prevLow.price;

  let structureTrend: 'UPTREND' | 'DOWNTREND' | 'NEUTRAL' = 'NEUTRAL';
  if      (isHH && isHL)  structureTrend = 'UPTREND';   // HH+HL = uptrend penuh
  else if (isLH && isLL)  structureTrend = 'DOWNTREND'; // LH+LL = downtrend penuh
  else if (isHH || isHL)  structureTrend = 'UPTREND';   // partial bullish
  else if (isLH || isLL)  structureTrend = 'DOWNTREND'; // partial bearish

  let lastBOS:   'UP' | 'DOWN' | null = null;
  let lastCHoCH: 'UP' | 'DOWN' | null = null;
  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

  if (structureTrend === 'UPTREND') {
    bias = 'BULLISH';
    // Scan 5 candle terakhir — BOS tetap valid walau harga sudah retrace (sesuai TV)
    if (recentCloses.some(c => c > lastHigh.price)) {
      lastBOS = 'UP';
    }
    // CHoCH hanya pakai candle terbaru (reversal harus konfirmasi close sekarang)
    if (currClose < lastLow.price) {
      lastCHoCH = 'DOWN';
      bias = 'BEARISH';
    }
  } else if (structureTrend === 'DOWNTREND') {
    bias = 'BEARISH';
    if (recentCloses.some(c => c < lastLow.price)) {
      lastBOS = 'DOWN';
    }
    if (currClose > lastHigh.price) {
      lastCHoCH = 'UP';
      bias = 'BULLISH';
    }
  }

  return { lastBOS, lastCHoCH, bias, structureLabel };
}

// ─── SMC: Detect Order Block ──────────────────────────────────────────────────
// Order Block = candle terakhir sebelum impulse move yang kuat
// Bullish OB = bearish candle sebelum rally (demand zone)
// Bearish OB = bullish candle sebelum drop  (supply zone)
//
// Zone pakai HIGH dan LOW candle (full range) — sesuai LuxAlgo TradingView
// bukan hanya body (open/close) yang lebih sempit

function detectOrderBlock(candles: Candle[], bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): OrderBlock | null {
  if (bias === 'NEUTRAL' || candles.length < 10) return null;

  const lookback = 15;
  const recent = candles.slice(-lookback);

  if (bias === 'BULLISH') {
    for (let i = recent.length - 3; i >= 1; i--) {
      const c = recent[i];
      if (c.close >= c.open) continue; // harus bearish candle

      const next1 = recent[i + 1];
      const next2 = recent[i + 2];
      if (!next1 || !next2) continue;

      if (next1.close > next1.open && next2.close > next2.open) {
        return {
          top:    c.high,   // full range (wick atas) — sesuai LuxAlgo
          bottom: c.low,    // full range (wick bawah)
          type:   'BULLISH',
          index:  candles.length - lookback + i,
        };
      }
    }
  } else {
    for (let i = recent.length - 3; i >= 1; i--) {
      const c = recent[i];
      if (c.close <= c.open) continue; // harus bullish candle

      const next1 = recent[i + 1];
      const next2 = recent[i + 2];
      if (!next1 || !next2) continue;

      if (next1.close < next1.open && next2.close < next2.open) {
        return {
          top:    c.high,   // full range
          bottom: c.low,
          type:   'BEARISH',
          index:  candles.length - lookback + i,
        };
      }
    }
  }

  return null;
}

// ─── SMC: Full analysis ───────────────────────────────────────────────────────

function analyzeSMC(candles4h: Candle[], currentPrice: number): SMCBias {
  const swings = detectSwingPoints(candles4h); // pakai config.ta.swingLookback
  const { lastBOS, lastCHoCH, bias, structureLabel } = detectBOSandCHoCH(candles4h, swings);
  const orderBlock = detectOrderBlock(candles4h, bias);

  // Cek apakah harga sedang di dalam order block zone
  let inOBZone = false;
  if (orderBlock) {
    // OB zone sudah pakai full range (high/low) — tidak perlu tambah buffer lagi
    inOBZone = currentPrice >= orderBlock.bottom && currentPrice <= orderBlock.top;
  }

  return { bias, lastBOS, lastCHoCH, orderBlock, inOBZone, structureLabel };
}

// ─── Entry trigger dari 1h ────────────────────────────────────────────────────
// Konfirmasi entry di 1h setelah bias dari 4h SMC terbentuk

function getEntryTrigger(c1h: Candle[], bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): {
  triggered: boolean;
  reason: string;
  strength: number; // 0-100
} {
  if (bias === 'NEUTRAL') return { triggered: false, reason: 'No bias', strength: 0 };
  if (c1h.length < 5) return { triggered: false, reason: 'Insufficient data', strength: 0 };

  const curr = c1h[c1h.length - 1];
  const prev = c1h[c1h.length - 2];
  const prev2 = c1h[c1h.length - 3];

  const avgBody = c1h.slice(-10).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 10;
  const body = Math.abs(curr.close - curr.open);
  const strongBody = body >= avgBody * config.ta.bodyMultiplier;

  // Volume konfirmasi
  const avgVol = c1h.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
  const volRatio = avgVol > 0 ? curr.volume / avgVol : 0;
  const volOk = volRatio >= 1.0;

  if (bias === 'BULLISH') {
    // Entry trigger: bullish candle + close di atas prev high
    const bullishCandle = curr.close > curr.open;
    const breakPrevHigh = curr.close > prev.high;
    const pullbackEntry = curr.low <= prev.close && curr.close > prev.close; // pullback ke prev close lalu lanjut

    if ((breakPrevHigh || pullbackEntry) && bullishCandle && strongBody) {
      const strength = Math.min(100,
        (breakPrevHigh ? 40 : 20) +
        (strongBody ? 30 : 0) +
        (volOk ? 20 : 0) +
        (volRatio >= 1.5 ? 10 : 0)
      );
      return {
        triggered: true,
        reason: `Bullish entry: ${breakPrevHigh ? 'break prev high' : 'pullback entry'} | body:${body.toFixed(2)} | vol:${volRatio.toFixed(2)}x`,
        strength,
      };
    }
  } else {
    // Entry trigger: bearish candle + close di bawah prev low
    const bearishCandle = curr.close < curr.open;
    const breakPrevLow = curr.close < prev.low;
    const pullbackEntry = curr.high >= prev.close && curr.close < prev.close;

    if ((breakPrevLow || pullbackEntry) && bearishCandle && strongBody) {
      const strength = Math.min(100,
        (breakPrevLow ? 40 : 20) +
        (strongBody ? 30 : 0) +
        (volOk ? 20 : 0) +
        (volRatio >= 1.5 ? 10 : 0)
      );
      return {
        triggered: true,
        reason: `Bearish entry: ${breakPrevLow ? 'break prev low' : 'pullback entry'} | body:${body.toFixed(2)} | vol:${volRatio.toFixed(2)}x`,
        strength,
      };
    }
  }

  return { triggered: false, reason: 'No entry trigger on 1h', strength: 0 };
}

// ─── Confidence score ─────────────────────────────────────────────────────────

function calcConfidence(
  smc: SMCBias,
  entryStrength: number,
  volValid: boolean,
): number {
  let score = 0;

  // SMC bias strength
  if (smc.bias !== 'NEUTRAL') score += 25;

  // BOS konfirmasi (trend berlanjut)
  if (smc.lastBOS !== null) score += 20;

  // CHoCH (reversal signal — bonus kalau fresh)
  if (smc.lastCHoCH !== null) score += 10;

  // Order Block zone (high probability area)
  if (smc.orderBlock !== null) score += 15;
  if (smc.inOBZone) score += 10; // bonus kalau harga di OB zone

  // Entry trigger strength dari 1h
  score += Math.round(entryStrength * 0.2); // max 20 pts

  // Volatility ok
  if (volValid) score += 0; // sudah difilter sebelumnya

  return Math.min(100, score);
}

// ─── SL/TP dari ATR 1h ────────────────────────────────────────────────────────

function getSLTP(price: number, atr1h: number, signal: Signal) {
  const slDist = atr1h * config.ta.atrMultiplier;
  const tpDist = atr1h * config.ta.atrTpMultiplier;

  if (signal === 'LONG')  return { sl: price - slDist, tp: price + tpDist };
  if (signal === 'SHORT') return { sl: price + slDist, tp: price - tpDist };
  return { sl: 0, tp: 0 };
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    const c4h  = await fetchOHLCV(asset, '4h',  50);
    await new Promise(r => setTimeout(r, 500));
    const c1h  = await fetchOHLCV(asset, '1h',  60);
    await new Promise(r => setTimeout(r, 500));
    const c30m = await fetchOHLCV(asset, '30m', 60);

    if (c4h.length < 20 || c1h.length < 20 || c30m.length < 20) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    const price = c1h[c1h.length - 1].close;

    // Volatility filter dari 30m
    const atr30m   = getATR(c30m);
    const volValid = isValidVolatility(atr30m, price);

    if (!volValid) {
      const pct = (atr30m / price * 100).toFixed(3);
      logger.info(`${asset} → HOLD | Vol invalid: ${pct}%`);
      return makeHold(asset, `Vol invalid (${pct}%)`, price, 'NEUTRAL', 'NEUTRAL');
    }

    // SMC analysis dari 4h
    const smc = analyzeSMC(c4h, price);

    logger.info(
      `${asset} | struct:${smc.structureLabel} bias:${smc.bias} | ` +
      `BOS:${smc.lastBOS || 'none'} | CHoCH:${smc.lastCHoCH || 'none'} | ` +
      `OB:${smc.orderBlock ? smc.orderBlock.type : 'none'} | inOB:${smc.inOBZone}`
    );

    if (smc.bias === 'NEUTRAL') {
      const reason = `SMC: No clear structure — waiting for BOS/CHoCH`;
      logger.info(`${asset} → HOLD | ${reason}`);
      return makeHold(asset, reason, price, 'NEUTRAL', 'NEUTRAL');
    }

    // Entry trigger dari 1h
    const entry = getEntryTrigger(c1h, smc.bias);

    if (!entry.triggered) {
      const reason = `SMC bias:${smc.bias} | ${entry.reason}`;
      logger.info(`${asset} → HOLD | ${reason}`);
      return makeHold(asset, reason, price,
        smc.bias as 'BULLISH' | 'BEARISH' | 'NEUTRAL',
        smc.bias as 'BULLISH' | 'BEARISH' | 'NEUTRAL'
      );
    }

    const signal: Signal = smc.bias === 'BULLISH' ? 'LONG' : 'SHORT';

    // Confidence
    const confidence = calcConfidence(smc, entry.strength, volValid);

    logger.info(`${asset} → ${signal} | conf:${confidence}% | ${entry.reason}`);

    if (confidence < config.ta.minConfidence) {
      const reason = `Confidence too low (${confidence}% < ${config.ta.minConfidence}%)`;
      return makeHold(asset, reason, price,
        smc.bias as 'BULLISH'|'BEARISH'|'NEUTRAL',
        smc.bias as 'BULLISH'|'BEARISH'|'NEUTRAL',
        confidence
      );
    }

    // SL/TP dari ATR 1h
    const atr1h = getATR(c1h);
    const { sl, tp } = getSLTP(price, atr1h, signal);

    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(price - tp);

    if (slDist <= 0 || tpDist <= 0) {
      return makeHold(asset, 'Invalid SL/TP', price,
        smc.bias as 'BULLISH'|'BEARISH'|'NEUTRAL',
        smc.bias as 'BULLISH'|'BEARISH'|'NEUTRAL'
      );
    }

    const rr    = tpDist / slDist;
    const slPct = (slDist / price) * 100;
    const tpPct = (tpDist / price) * 100;

    if (rr < config.ta.minRR) {
      return makeHold(asset, `R:R ${rr.toFixed(2)} < ${config.ta.minRR}`, price,
        smc.bias as 'BULLISH'|'BEARISH'|'NEUTRAL',
        smc.bias as 'BULLISH'|'BEARISH'|'NEUTRAL',
        confidence
      );
    }

    const obInfo = smc.orderBlock
      ? ` | OB:${smc.orderBlock.type} $${smc.orderBlock.bottom.toFixed(2)}-$${smc.orderBlock.top.toFixed(2)}${smc.inOBZone ? ' [IN ZONE]' : ''}`
      : '';

    return {
      asset, signal,
      reason: `SMC ${smc.bias} | BOS:${smc.lastBOS || '-'} CHoCH:${smc.lastCHoCH || '-'}${obInfo} | ${entry.reason}`,
      confidence, currentPrice: price,
      rsi15m: 50,
      trend4h: smc.bias as 'BULLISH'|'BEARISH'|'NEUTRAL',
      trend1h: smc.bias as 'BULLISH'|'BEARISH'|'NEUTRAL',
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
  trend4h: 'BULLISH'|'BEARISH'|'NEUTRAL' = 'NEUTRAL',
  trend1h: 'BULLISH'|'BEARISH'|'NEUTRAL' = 'NEUTRAL',
  confidence = 0
): TAResult {
  return {
    asset, signal: 'HOLD', reason, confidence, currentPrice: price,
    rsi15m: 50, trend4h, trend1h,
    regime: 'SIDEWAYS', adx: 0,
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
