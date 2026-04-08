import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { sendAlert } from './telegram';
import { recordSL, recordTP } from './riskGuard';
import { config } from './config';
import { logTrade } from './tradeLog';
import type { Asset } from './config';

const TRACKER_FILE = path.join(process.cwd(), 'positions-tracker.json');

interface TrackedPosition {
  asset:           string;
  side:            'long' | 'short';
  entryPrice:      number;
  size:            number;
  tpPrice?:        number;
  slPrice?:        number;
  openedAt:        number;
  positionPubkey?: string;
}

interface TrackerState {
  positions: Record<string, TrackedPosition>;
}

function readTracker(): TrackerState {
  if (!fs.existsSync(TRACKER_FILE)) return { positions: {} };
  try { return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8')); }
  catch { return { positions: {} }; }
}

function writeTracker(state: TrackerState) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2));
}

// ─── Detect close reason ──────────────────────────────────────────────────────
//
// STRATEGY: gunakan MIDPOINT antara entry dan TP/SL sebagai decision boundary.
//
// Kenapa midpoint, bukan exact price?
// - Posisi bisa close saat agent tidak jalan → market price sudah bergerak
// - Kita tahu entry, TP, SL dengan pasti
// - Kalau close reason adalah TP: harga sempat menyentuh TP, lalu mungkin balik
//   → exit price akan cenderung dekat TP (di atas midpoint TP)
// - Kalau close reason adalah SL: harga menyentuh SL
//   → exit price akan cenderung dekat SL (di bawah midpoint SL)
//
// Decision boundary = midpoint antara entry dan SL / entry dan TP

function detectCloseReason(
  pos: TrackedPosition,
  exitPrice: number   // market price saat deteksi — bisa 0 kalau tidak tersedia
): { closeReason: 'TP' | 'SL' | 'UNKNOWN'; pnlUsd: number } {

  const { collateralUsdc, leverage } = config.trading;
  const entry = pos.entryPrice;
  const sl    = pos.slPrice;
  const tp    = pos.tpPrice;

  // Fallback PnL kalau tidak bisa hitung
  const fallbackLoss = -(collateralUsdc * 0.015);

  if (!sl || !tp || entry <= 0) {
    logger.warn(`${pos.asset} missing SL/TP/entry — cannot determine close reason`);
    return { closeReason: 'UNKNOWN', pnlUsd: fallbackLoss };
  }

  const calcPnL = (exitAt: number): number => {
    const pct = pos.side === 'long'
      ? ((exitAt - entry) / entry) * 100 * leverage
      : ((entry - exitAt) / entry) * 100 * leverage;
    return (collateralUsdc * pct) / 100;
  };

  // ── Strategy 1: exact hit ────────────────────────────────────────────────
  // Harga masih di luar range SL-TP → jelas kena salah satu
  if (exitPrice > 0) {
    if (pos.side === 'long') {
      if (exitPrice >= tp)  return { closeReason: 'TP', pnlUsd: calcPnL(tp) };
      if (exitPrice <= sl)  return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
    } else {
      if (exitPrice <= tp)  return { closeReason: 'TP', pnlUsd: calcPnL(tp) };
      if (exitPrice >= sl)  return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
    }
  }

  // ── Strategy 2: midpoint decision ────────────────────────────────────────
  // Harga sudah balik ke range → gunakan midpoint sebagai boundary
  //
  // LONG:  midpointTP = (entry + tp) / 2
  //        kalau exitPrice > midpointTP → TP pernah hit
  //        kalau exitPrice < midpointSL = (entry + sl) / 2 → SL hit
  //
  // SHORT: kebalikannya

  if (exitPrice > 0) {
    const midTp = (entry + tp) / 2;
    const midSl = (entry + sl) / 2;

    if (pos.side === 'long') {
      if (exitPrice > midTp) {
        logger.info(`${pos.asset} LONG close → TP via midpoint (exit:${exitPrice.toFixed(2)} midTP:${midTp.toFixed(2)})`);
        return { closeReason: 'TP', pnlUsd: calcPnL(tp) };
      }
      if (exitPrice < midSl) {
        logger.info(`${pos.asset} LONG close → SL via midpoint (exit:${exitPrice.toFixed(2)} midSL:${midSl.toFixed(2)})`);
        return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
      }
    } else {
      if (exitPrice < midTp) {
        logger.info(`${pos.asset} SHORT close → TP via midpoint (exit:${exitPrice.toFixed(2)} midTP:${midTp.toFixed(2)})`);
        return { closeReason: 'TP', pnlUsd: calcPnL(tp) };
      }
      if (exitPrice > midSl) {
        logger.info(`${pos.asset} SHORT close → SL via midpoint (exit:${exitPrice.toFixed(2)} midSL:${midSl.toFixed(2)})`);
        return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
      }
    }
  }

  // ── Strategy 3: pure proximity tanpa exit price ───────────────────────────
  // Kalau exitPrice = 0 (jup markets gagal), pakai distance TP vs SL dari entry
  // sebagai tiebreaker — tidak ideal tapi lebih baik dari UNKNOWN
  logger.warn(`${pos.asset} using fallback proximity (exitPrice:${exitPrice})`);

  // Hitung berapa % move dibutuhkan ke TP vs SL
  const pctToTp = Math.abs((tp - entry) / entry);
  const pctToSl = Math.abs((sl - entry) / entry);

  // Kalau SL lebih dekat dari TP secara struktural → lebih mungkin kena SL
  // Ini edge case — biasanya RR 2.0 jadi TP selalu 2x lebih jauh
  if (pctToSl <= pctToTp * 0.6) {
    return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
  }

  // Default: assume SL untuk safety (konservatif di risk guard)
  return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
}

// ─── Normalize asset key ──────────────────────────────────────────────────────
// FIX: Jupiter markets return 'BTC' tapi posisi tracker simpan 'WBTC'
function getExitPrice(asset: string, marketPrices: Record<string, number>): number {
  if (marketPrices[asset]) return marketPrices[asset];
  // Fallback aliases
  const aliases: Record<string, string> = {
    'WBTC': 'BTC',
    'BTC':  'WBTC',
    'WETH': 'ETH',
    'ETH':  'WETH',
  };
  const alt = aliases[asset];
  return alt ? (marketPrices[alt] ?? 0) : 0;
}

// ─── Detect closed positions ──────────────────────────────────────────────────

export async function detectClosedPositions(
  currentPositions: any[],
  marketPrices: Record<string, number> = {}
): Promise<void> {
  const state    = readTracker();
  const prevKeys = Object.keys(state.positions);
  if (prevKeys.length === 0) return;

  const currentKeys = new Set(
    currentPositions.map((p: any) => p.positionPubkey || p.asset)
  );

  for (const key of prevKeys) {
    if (currentKeys.has(key)) continue;

    const pos = state.positions[key];
    logger.info(`Position closed detected: ${pos.asset} ${pos.side}`);

    // Coba dapat exit price — normalize key WBTC/BTC
    const exitPrice = getExitPrice(pos.asset, marketPrices);
    const { closeReason, pnlUsd } = detectCloseReason(pos, exitPrice);

    const now         = new Date();
    const duration    = Math.round((now.getTime() - pos.openedAt) / 60_000);
    const pnlStr      = `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(3)}`;
    const pnlEmoji    = pnlUsd >= 0 ? '✅' : '❌';
    const sideEmoji   = pos.side === 'long' ? '🟢' : '🔴';
    const reasonEmoji = closeReason === 'TP' ? '🎯' : closeReason === 'SL' ? '🛑' : '📋';

    await sendAlert(
      `${sideEmoji} *CLOSED: ${pos.asset} _(GPT)_ ${pos.side.toUpperCase()}*\n` +
      `${reasonEmoji} Reason: \`${closeReason}\`\n` +
      `Entry: \`$${pos.entryPrice.toLocaleString()}\`\n` +
      (exitPrice > 0 ? `Exit ~: \`$${exitPrice.toLocaleString()}\`\n` : '') +
      `TP: \`$${pos.tpPrice?.toLocaleString() ?? '—'}\`  SL: \`$${pos.slPrice?.toLocaleString() ?? '—'}\`\n` +
      `PnL: \`${pnlStr}\` ${pnlEmoji}\n` +
      `Duration: \`${duration} min\``
    );

    // Log ke trade-log.json
    logTrade({
      id:          `${pos.openedAt}-${pos.asset}-${pos.side}`,
      agent:       'gpt',
      asset:       pos.asset,
      side:        pos.side,
      entryPrice:  pos.entryPrice,
      exitPrice:   exitPrice || (closeReason === 'TP' ? (pos.tpPrice ?? 0) : (pos.slPrice ?? 0)),
      entryTime:   new Date(pos.openedAt).toISOString(),
      exitTime:    now.toISOString(),
      durationMin: duration,
      slPrice:     pos.slPrice ?? null,
      tpPrice:     pos.tpPrice ?? null,
      closeReason,
      pnlUsd,
      collateral:  config.trading.collateralUsdc,
      leverage:    config.trading.leverage,
    });

    const signal = pos.side === 'long' ? 'LONG' : 'SHORT';
    if (closeReason === 'TP') {
      recordTP(pos.asset as Asset, signal);
      logger.info(`TP recorded: ${pos.asset} ${signal} ${pnlStr}`);
    } else {
      await recordSL(pos.asset as Asset, signal, Math.abs(pnlUsd));
      logger.warn(`SL recorded: ${pos.asset} ${signal} ${pnlStr}`);
    }

    delete state.positions[key];
  }

  writeTracker(state);
}

// ─── Update tracker ───────────────────────────────────────────────────────────

export function updateTrackedPositions(currentPositions: any[]): void {
  const state = readTracker();

  for (const pos of currentPositions) {
    const key = pos.positionPubkey || pos.asset;
    if (state.positions[key]) continue;

    const tpPrice = pos.tpsl?.find((t: any) => t.type === 'tp')?.triggerPriceUsd;
    const slPrice = pos.tpsl?.find((t: any) => t.type === 'sl')?.triggerPriceUsd;

    state.positions[key] = {
      asset:          pos.asset,
      side:           pos.side,
      entryPrice:     pos.entryPriceUsd ?? pos.markPriceUsd ?? 0,
      size:           pos.sizeUsd ?? 0,
      tpPrice,
      slPrice,
      openedAt:       Date.now(),
      positionPubkey: pos.positionPubkey,
    };

    logger.debug(`Tracking ${pos.asset} ${pos.side} | entry:${state.positions[key].entryPrice} TP:${tpPrice} SL:${slPrice}`);
  }

  writeTracker(state);
}
