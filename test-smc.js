// Test SMC detection vs TradingView
// Run: node test-smc.js

const SWING_STRENGTH = 3; // sama dengan TV length=3

const OKX = { SOL: 'SOL-USDT', BTC: 'BTC-USDT', ETH: 'ETH-USDT' };

async function fetchOHLCV(asset, tf, limit = 60) {
  const bar = tf === '30m' ? '30m' : tf === '1h' ? '1H' : '4H';
  const url = `https://www.okx.com/api/v5/market/candles?instId=${OKX[asset]}&bar=${bar}&limit=${limit + 1}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  return json.data
    .reverse().slice(0, -1)
    .map(k => ({
      time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
}

function detectSwings(candles, strength = SWING_STRENGTH) {
  const swings = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i];
    if (candles.slice(i - strength, i).every(x => x.high < c.high) &&
        candles.slice(i + 1, i + strength + 1).every(x => x.high < c.high)) {
      swings.push({ index: i, price: c.high, type: 'HIGH', time: c.time });
    }
    if (candles.slice(i - strength, i).every(x => x.low > c.low) &&
        candles.slice(i + 1, i + strength + 1).every(x => x.low > c.low)) {
      swings.push({ index: i, price: c.low, type: 'LOW', time: c.time });
    }
  }
  return swings.sort((a, b) => a.index - b.index);
}

function dt(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function fmt(n) { return n.toFixed(4); }

async function analyze(asset) {
  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  console.log(`  ${asset}/USDT  │  4H  │  swing strength = ${SWING_STRENGTH} bar`);
  console.log(line);

  const c4h = await fetchOHLCV(asset, '4h', 50);
  const last = c4h[c4h.length - 1];
  const price = last.close;

  console.log(`  Current price  : $${price}`);
  console.log(`  Last candle    : ${dt(last.time)}`);
  console.log(`                   O:${last.open} H:${last.high} L:${last.low} C:${last.close}`);

  const swings = detectSwings(c4h);
  const highs  = swings.filter(s => s.type === 'HIGH');
  const lows   = swings.filter(s => s.type === 'LOW');

  console.log(`\n  Swing HIGHs detected (${highs.length} total, showing last 5):`);
  highs.slice(-5).forEach(s => {
    console.log(`    [i=${String(s.index).padStart(2)}] ${dt(s.time)}  → $${fmt(s.price)}`);
  });
  console.log(`\n  Swing LOWs detected (${lows.length} total, showing last 5):`);
  lows.slice(-5).forEach(s => {
    console.log(`    [i=${String(s.index).padStart(2)}] ${dt(s.time)}  → $${fmt(s.price)}`);
  });

  if (highs.length < 2 || lows.length < 2) {
    console.log('\n  ⚠ Not enough swings to determine structure');
    return;
  }

  const lH = highs[highs.length - 1]; // last high
  const pH = highs[highs.length - 2]; // prev high
  const lL = lows[lows.length - 1];   // last low
  const pL = lows[lows.length - 2];   // prev low

  const highLabel = lH.price > pH.price ? 'HH' : lH.price < pH.price ? 'LH' : 'EH';
  const lowLabel  = lL.price > pL.price ? 'HL' : lL.price < pL.price ? 'LL' : 'EL';

  const isHH = lH.price > pH.price, isHL = lL.price > pL.price;
  const isLH = lH.price < pH.price, isLL = lL.price < pL.price;

  let trend = 'NEUTRAL';
  if      (isHH && isHL) trend = 'UPTREND';
  else if (isLH && isLL) trend = 'DOWNTREND';
  else if (isHH || isHL) trend = 'UPTREND (partial)';
  else if (isLH || isLL) trend = 'DOWNTREND (partial)';

  let bos = 'none', choch = 'none', bias = 'NEUTRAL';
  if (trend.startsWith('UPTREND')) {
    bias = 'BULLISH';
    if (price > lH.price)     { bos = 'UP'; }
    else if (price < lL.price) { choch = 'DOWN'; bias = 'BEARISH'; }
  } else if (trend.startsWith('DOWNTREND')) {
    bias = 'BEARISH';
    if (price < lL.price)     { bos = 'DOWN'; }
    else if (price > lH.price) { choch = 'UP'; bias = 'BULLISH'; }
  }

  console.log(`\n  ┌─ MARKET STRUCTURE ─────────────────────────────────┐`);
  console.log(`  │  Prev High : $${fmt(pH.price).padEnd(10)} @ ${dt(pH.time)}  │`);
  console.log(`  │  Last High : $${fmt(lH.price).padEnd(10)} @ ${dt(lH.time)}  [${highLabel}]  │`);
  console.log(`  │  Prev Low  : $${fmt(pL.price).padEnd(10)} @ ${dt(pL.time)}  │`);
  console.log(`  │  Last Low  : $${fmt(lL.price).padEnd(10)} @ ${dt(lL.time)}  [${lowLabel}]  │`);
  console.log(`  │                                                      │`);
  console.log(`  │  Structure : ${(highLabel+'/'+lowLabel).padEnd(6)} │ Trend: ${trend.padEnd(20)}│`);
  console.log(`  │  BOS       : ${bos.padEnd(39)}│`);
  console.log(`  │  CHoCH     : ${choch.padEnd(39)}│`);
  console.log(`  │  BIAS      : ${bias.padEnd(39)}│`);
  console.log(`  └──────────────────────────────────────────────────────┘`);

  // Price levels check
  console.log(`\n  Price check:`);
  console.log(`    $${price} vs lastHigh $${fmt(lH.price)} → ${price > lH.price ? 'ABOVE ↑ (potential BOS UP)' : 'below ↓'}`);
  console.log(`    $${price} vs lastLow  $${fmt(lL.price)} → ${price < lL.price ? 'BELOW ↓ (potential BOS DOWN)' : 'above ↑'}`);

  // Order Block
  const lookback = 15;
  const recent = c4h.slice(-lookback);
  let ob = null;

  const searchBullish = bias === 'BULLISH';
  for (let i = recent.length - 3; i >= 1; i--) {
    const c = recent[i], n1 = recent[i+1], n2 = recent[i+2];
    if (!n1 || !n2) continue;
    if (searchBullish) {
      if (c.close < c.open && n1.close > n1.open && n2.close > n2.open) {
        ob = { top: Math.max(c.open, c.close), bottom: Math.min(c.open, c.close), type: 'BULLISH (demand)', time: c.time };
        break;
      }
    } else {
      if (c.close > c.open && n1.close < n1.open && n2.close < n2.open) {
        ob = { top: Math.max(c.open, c.close), bottom: Math.min(c.open, c.close), type: 'BEARISH (supply)', time: c.time };
        break;
      }
    }
  }

  console.log(`\n  Order Block:`);
  if (ob) {
    const buf = (ob.top - ob.bottom) * 0.2;
    const inZone = price >= ob.bottom - buf && price <= ob.top + buf;
    console.log(`    Type    : ${ob.type}`);
    console.log(`    Zone    : $${fmt(ob.bottom)} – $${fmt(ob.top)}`);
    console.log(`    Time    : ${dt(ob.time)}`);
    console.log(`    In zone : ${inZone ? '✅ YES — price is in OB zone' : '❌ NO'}`);
  } else {
    console.log(`    None found`);
  }
}

(async () => {
  for (const asset of ['SOL', 'BTC', 'ETH']) {
    await analyze(asset).catch(e => console.error(`${asset} error:`, e.message));
    await new Promise(r => setTimeout(r, 700));
  }
})();
