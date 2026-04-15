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
  trend1d:      'BULLISH' | 'BEARISH' | 'NEUTRAL';
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

interface FVG {
  top:    number;
  bottom: number;
  type:   'BULLISH' | 'BEARISH';
  index:  number;
}

interface SMCBias {
  bias:            'BULLISH' | 'BEARISH' | 'NEUTRAL';
  lastBOS:         'UP' | 'DOWN' | null;
  lastCHoCH:       'UP' | 'DOWN' | null;
  orderBlock:      OrderBlock | null;
  inOBZone:        boolean;
  obMitigated:     boolean;
  fvg:             FVG | null;
  inFVGZone:       boolean;
  structureLabel:  string;
  premiumDiscount: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  pdPct:           number;
}

// ─── OKX symbol map ───────────────────────────────────────────────────────────

const OKX_SYMBOL: Record<string, string> = {
  SOL:  'SOL-USDT',
  BTC:  'BTC-USDT',
  WBTC: 'BTC-USDT',
  ETH:  'ETH-USDT',
};

// ─── Fetch OHLCV dari OKX ─────────────────────────────────────────────────────

async function fetchOHLCV(asset: Asset, tf: '30m' | '1h' | '4h' | '1d', limit = 60): Promise<Candle[]> {
  const instId = OKX_SYMBOL[asset];
  if (!instId) throw new Error(`Unknown asset: ${asset}`);

  const bar = tf === '30m' ? '30m' : tf === '1h' ? '1H' : tf === '4h' ? '4H' : '1D';
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

// ─── SMC: OB Mitigation check ─────────────────────────────────────────────────
// OB yang sudah pernah disentuh harga = "mitigated" = tidak valid lagi
// Jangan entry di OB bekas — smart money sudah tidak ada di sana

function isOBMitigated(candles: Candle[], ob: OrderBlock): boolean {
  for (let i = ob.index + 3; i < candles.length; i++) {
    const c = candles[i];
    if (c.low <= ob.top && c.high >= ob.bottom) return true;
  }
  return false;
}

// ─── SMC: Fair Value Gap (FVG) ────────────────────────────────────────────────
// FVG = imbalance 3 candle — harga bergerak terlalu cepat, meninggalkan "gap"
// Bullish FVG: candle[i+1].low > candle[i-1].high  (gap ke atas)
// Bearish FVG: candle[i+1].high < candle[i-1].low  (gap ke bawah)
// Cari FVG terbaru yang BELUM terisi (unfilled) sesuai arah bias

function detectFVG(candles: Candle[], bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): FVG | null {
  if (bias === 'NEUTRAL') return null;

  const lookback = Math.min(20, candles.length - 2);

  for (let i = candles.length - 2; i >= candles.length - lookback; i--) {
    if (i < 1) break;
    const c1 = candles[i - 1];
    const c3 = candles[i + 1];

    if (bias === 'BULLISH' && c3.low > c1.high) {
      // Bullish FVG: gap antara high c1 dan low c3
      const fvg: FVG = { top: c3.low, bottom: c1.high, type: 'BULLISH', index: i };
      let filled = false;
      for (let j = i + 2; j < candles.length; j++) {
        if (candles[j].low <= fvg.top && candles[j].high >= fvg.bottom) { filled = true; break; }
      }
      if (!filled) return fvg;
    }

    if (bias === 'BEARISH' && c3.high < c1.low) {
      // Bearish FVG: gap antara low c1 dan high c3
      const fvg: FVG = { top: c1.low, bottom: c3.high, type: 'BEARISH', index: i };
      let filled = false;
      for (let j = i + 2; j < candles.length; j++) {
        if (candles[j].high >= fvg.bottom && candles[j].low <= fvg.top) { filled = true; break; }
      }
      if (!filled) return fvg;
    }
  }

  return null;
}

// ─── SMC: Premium / Discount Zone ─────────────────────────────────────────────
// Bagi range harga (high-low) menjadi 3 zona:
//   PREMIUM  (atas 55%) = zona mahal  → hanya SELL
//   DISCOUNT (bawah 45%) = zona murah → hanya BUY
//   EQUILIBRIUM (45-55%) = zona tengah
// Entry LONG di PREMIUM atau SHORT di DISCOUNT = melawan value = probabilitas rendah

function getPremiumDiscountZone(
  price: number,
  swings: SwingPoint[],
): { zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM'; pct: number } {
  const highs = swings.filter(s => s.type === 'HIGH');
  const lows  = swings.filter(s => s.type === 'LOW');

  if (highs.length === 0 || lows.length === 0) return { zone: 'EQUILIBRIUM', pct: 50 };

  const rangeHigh = Math.max(...highs.slice(-3).map(s => s.price));
  const rangeLow  = Math.min(...lows.slice(-3).map(s => s.price));
  const range = rangeHigh - rangeLow;

  if (range <= 0) return { zone: 'EQUILIBRIUM', pct: 50 };

  const pct  = ((price - rangeLow) / range) * 100;
  const zone = pct >= 55 ? 'PREMIUM' : pct <= 45 ? 'DISCOUNT' : 'EQUILIBRIUM';

  return { zone, pct: Math.round(pct) };
}

// ─── SMC: 1D Macro Bias ───────────────────────────────────────────────────────
// Filter utama: hanya trade kalau 4H searah dengan trend harian (1D)
// Kalau 1D bullish tapi 4H bearish = kontra trend = skip atau kurangi confidence

async function get1DBias(asset: Asset): Promise<'BULLISH' | 'BEARISH' | 'NEUTRAL'> {
  const c1d = await fetchOHLCV(asset, '1d', 30);
  if (c1d.length < 8) return 'NEUTRAL';
  const swings = detectSwingPoints(c1d, 2); // strength=2 untuk daily (lebih lenient)
  const { bias } = detectBOSandCHoCH(c1d, swings);
  return bias;
}

// ─── SMC: Full analysis ───────────────────────────────────────────────────────

function analyzeSMC(candles4h: Candle[], currentPrice: number): SMCBias {
  const swings = detectSwingPoints(candles4h);
  const { lastBOS, lastCHoCH, bias, structureLabel } = detectBOSandCHoCH(candles4h, swings);
  const orderBlock   = detectOrderBlock(candles4h, bias);
  const obMitigated  = orderBlock ? isOBMitigated(candles4h, orderBlock) : false;
  const fvg          = detectFVG(candles4h, bias);
  const { zone: premiumDiscount, pct: pdPct } = getPremiumDiscountZone(currentPrice, swings);

  // OB zone hanya valid kalau belum mitigated
  const inOBZone  = !!(orderBlock && !obMitigated &&
                       currentPrice >= orderBlock.bottom && currentPrice <= orderBlock.top);
  const inFVGZone = !!(fvg && currentPrice >= fvg.bottom && currentPrice <= fvg.top);

  return { bias, lastBOS, lastCHoCH, orderBlock, inOBZone, obMitigated,
           fvg, inFVGZone, structureLabel, premiumDiscount, pdPct };
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

  // Volume konfirmasi — minimum 0.8x sebagai hard gate
  // Volume rendah = smart money tidak ikut = entry tidak valid
  const avgVol  = c1h.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
  const volRatio = avgVol > 0 ? curr.volume / avgVol : 0;
  const volOk    = volRatio >= 1.0;
  const volMin   = volRatio >= config.ta.volMinRatio; // hard gate

  if (!volMin) {
    return { triggered: false, reason: `Volume too low (${volRatio.toFixed(2)}x < ${config.ta.volMinRatio}x)`, strength: 0 };
  }

  if (bias === 'BULLISH') {
    const bullishCandle = curr.close > curr.open;
    const breakPrevHigh = curr.close > prev.high;
    const pullbackEntry = curr.low <= prev.close && curr.close > prev.close;

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
  smc:          SMCBias,
  entryStrength: number,
  volValid:     boolean,
  signal:       Signal,
  bias1d:       'BULLISH' | 'BEARISH' | 'NEUTRAL',
): number {
  let score = 0;

  // ── 1D alignment (±15 / -10) ──────────────────────────────────────────────
  if (bias1d !== 'NEUTRAL') {
    const aligned = (signal === 'LONG' && bias1d === 'BULLISH') ||
                    (signal === 'SHORT' && bias1d === 'BEARISH');
    score += aligned ? 15 : -10;
  }

  // ── 4H SMC structure ──────────────────────────────────────────────────────
  if (smc.bias !== 'NEUTRAL')  score += 20; // bias clear
  if (smc.lastBOS !== null)    score += 15; // BOS konfirmasi
  if (smc.lastCHoCH !== null)  score += 10; // CHoCH signal
  // Tidak ada BOS maupun CHoCH = entry belum terkonfirmasi = penalti besar
  if (smc.lastBOS === null && smc.lastCHoCH === null) score -= 15;

  // ── Order Block (fresh only) ──────────────────────────────────────────────
  if (smc.orderBlock && !smc.obMitigated) score += 10;
  if (smc.inOBZone)                       score += 10;

  // ── Fair Value Gap ────────────────────────────────────────────────────────
  if (smc.fvg)        score += 10; // FVG ada
  if (smc.inFVGZone)  score += 5;  // harga tepat di FVG = prime entry

  // ── Premium / Discount zone ───────────────────────────────────────────────
  const pdGood = (signal === 'LONG'  && smc.premiumDiscount === 'DISCOUNT') ||
                 (signal === 'SHORT' && smc.premiumDiscount === 'PREMIUM');
  const pdBad  = (signal === 'LONG'  && smc.premiumDiscount === 'PREMIUM') ||
                 (signal === 'SHORT' && smc.premiumDiscount === 'DISCOUNT');
  if (pdGood) score += 5;
  if (pdBad)  score -= 10;

  // ── Entry trigger dari 1h (0-20 pts) ─────────────────────────────────────
  score += Math.round(entryStrength * 0.2);

  return Math.min(100, Math.max(0, score));
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

    // Fetch semua timeframe — 1D untuk macro bias
    const c1d  = await fetchOHLCV(asset, '1d',  30).catch(() => [] as any[]);
    await new Promise(r => setTimeout(r, 400));
    const c4h  = await fetchOHLCV(asset, '4h',  50);
    await new Promise(r => setTimeout(r, 400));
    const c1h  = await fetchOHLCV(asset, '1h',  60);
    await new Promise(r => setTimeout(r, 400));
    const c30m = await fetchOHLCV(asset, '30m', 60);

    if (c4h.length < 20 || c1h.length < 20 || c30m.length < 20) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    const price = c1h[c1h.length - 1].close;

    // 1D macro bias
    let bias1d: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (c1d.length >= 8) {
      const sw1d = detectSwingPoints(c1d, 2);
      bias1d = detectBOSandCHoCH(c1d, sw1d).bias;
    }

    // Volatility filter dari 30m
    const atr30m   = getATR(c30m);
    const volValid = isValidVolatility(atr30m, price);

    if (!volValid) {
      const pct = (atr30m / price * 100).toFixed(3);
      logger.info(`${asset} → HOLD | Vol invalid: ${pct}%`);
      return makeHold(asset, `Vol invalid (${pct}%)`, price, bias1d, 'NEUTRAL', 'NEUTRAL');
    }

    // SMC 4H analysis
    const smc = analyzeSMC(c4h, price);

    logger.info(
      `${asset} | 1D:${bias1d} | struct:${smc.structureLabel} bias:${smc.bias} | ` +
      `BOS:${smc.lastBOS || '-'} CHoCH:${smc.lastCHoCH || '-'} | ` +
      `OB:${smc.orderBlock ? `${smc.orderBlock.type}${smc.obMitigated ? '[MIT]' : ''}` : '-'} inOB:${smc.inOBZone} | ` +
      `FVG:${smc.fvg ? smc.fvg.type : '-'} inFVG:${smc.inFVGZone} | ` +
      `PD:${smc.premiumDiscount}(${smc.pdPct}%)`
    );

    if (smc.bias === 'NEUTRAL') {
      return makeHold(asset, `SMC: No clear structure`, price, bias1d, 'NEUTRAL', 'NEUTRAL');
    }

    const signal: Signal = smc.bias === 'BULLISH' ? 'LONG' : 'SHORT';

    // ── Hard filter: Premium/Discount conflict ────────────────────────────────
    const pdConflict = (signal === 'LONG'  && smc.premiumDiscount === 'PREMIUM') ||
                       (signal === 'SHORT' && smc.premiumDiscount === 'DISCOUNT');
    if (pdConflict) {
      const reason = `P/D conflict: ${signal} in ${smc.premiumDiscount}(${smc.pdPct}%) — wrong zone`;
      logger.info(`${asset} → HOLD | ${reason}`);
      return makeHold(asset, reason, price, bias1d, smc.bias as any, smc.bias as any);
    }

    // Entry trigger dari 1h
    const entry = getEntryTrigger(c1h, smc.bias);

    if (!entry.triggered) {
      return makeHold(asset, `${smc.bias} | ${entry.reason}`, price,
        bias1d, smc.bias as any, smc.bias as any);
    }

    // Confidence dengan semua faktor baru
    const confidence = calcConfidence(smc, entry.strength, volValid, signal, bias1d);

    logger.info(
      `${asset} → ${signal} | conf:${confidence}% | 1D:${bias1d} | ` +
      `PD:${smc.premiumDiscount} | FVG:${smc.fvg ? 'YES' : 'no'} | ${entry.reason}`
    );

    if (confidence < config.ta.minConfidence) {
      return makeHold(asset, `Confidence ${confidence}% < ${config.ta.minConfidence}%`, price,
        bias1d, smc.bias as any, smc.bias as any, confidence);
    }

    // SL/TP dari ATR 1h
    const atr1h = getATR(c1h);
    const { sl, tp } = getSLTP(price, atr1h, signal);
    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(price - tp);

    if (slDist <= 0 || tpDist <= 0) {
      return makeHold(asset, 'Invalid SL/TP', price, bias1d, smc.bias as any, smc.bias as any);
    }

    const rr    = tpDist / slDist;
    const slPct = (slDist / price) * 100;
    const tpPct = (tpDist / price) * 100;

    if (rr < config.ta.minRR) {
      return makeHold(asset, `R:R ${rr.toFixed(2)} < ${config.ta.minRR}`, price,
        bias1d, smc.bias as any, smc.bias as any, confidence);
    }

    const fvgInfo = smc.fvg
      ? ` | FVG:${smc.fvg.type}[$${smc.fvg.bottom.toFixed(2)}-$${smc.fvg.top.toFixed(2)}]${smc.inFVGZone ? '[IN]' : ''}`
      : '';
    const obInfo = smc.orderBlock && !smc.obMitigated
      ? ` | OB:$${smc.orderBlock.bottom.toFixed(2)}-$${smc.orderBlock.top.toFixed(2)}${smc.inOBZone ? '[IN]' : ''}`
      : '';

    return {
      asset, signal,
      reason: `1D:${bias1d} SMC:${smc.structureLabel} ${smc.bias} BOS:${smc.lastBOS || '-'} CHoCH:${smc.lastCHoCH || '-'}${obInfo}${fvgInfo} PD:${smc.premiumDiscount} | ${entry.reason}`,
      confidence, currentPrice: price,
      rsi15m: 50,
      trend1d: bias1d,
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
  asset:   Asset,
  reason:  string,
  price:   number,
  trend1d: 'BULLISH'|'BEARISH'|'NEUTRAL' = 'NEUTRAL',
  trend4h: 'BULLISH'|'BEARISH'|'NEUTRAL' = 'NEUTRAL',
  trend1h: 'BULLISH'|'BEARISH'|'NEUTRAL' = 'NEUTRAL',
  confidence = 0
): TAResult {
  return {
    asset, signal: 'HOLD', reason, confidence, currentPrice: price,
    rsi15m: 50, trend1d, trend4h, trend1h,
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
