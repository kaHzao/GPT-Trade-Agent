import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { sendAlert } from './telegram';
import type { Asset } from './config';

const GUARD_FILE = path.join(process.cwd(), 'risk-guard.json');

interface AssetGuard {
  // Daily stats
  tradesToday: number;
  lossToday: number;
  lastSLTime?: number;

  // Consecutive loss per direction
  longConsecLoss: number;
  shortConsecLoss: number;
  longBlockedUntil?: number;   // timestamp ms
  shortBlockedUntil?: number;
}

interface GuardState {
  date: string;
  assets: Record<string, AssetGuard>;
  totalLossToday: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export const COOLDOWN_HOURS       = 3;
export const MAX_TRADES_PER_DAY   = 3;
export const MAX_DAILY_LOSS       = 1.5;
export const MAX_LOSS_PER_ASSET   = 0.6;
export const MAX_CONSEC_LOSS      = 2;       // block after 2x SL berturut
export const CONSEC_BLOCK_HOURS   = 24;      // block selama 24 jam

// ─── Read / Write ─────────────────────────────────────────────────────────────

function readGuard(): GuardState {
  const today = new Date().toISOString().split('T')[0];
  if (!fs.existsSync(GUARD_FILE)) {
    return { date: today, assets: {}, totalLossToday: 0 };
  }
  try {
    const state = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf-8')) as GuardState;
    if (state.date !== today) {
      logger.info('New day — resetting daily risk guard stats');
      // Keep consecutive loss state across days (tidak reset per hari)
      const newAssets: Record<string, AssetGuard> = {};
      for (const [asset, g] of Object.entries(state.assets)) {
        newAssets[asset] = {
          tradesToday: 0,
          lossToday: 0,
          longConsecLoss: g.longConsecLoss || 0,
          shortConsecLoss: g.shortConsecLoss || 0,
          longBlockedUntil: g.longBlockedUntil,
          shortBlockedUntil: g.shortBlockedUntil,
        };
      }
      return { date: today, assets: newAssets, totalLossToday: 0 };
    }
    return state;
  } catch {
    return { date: today, assets: {}, totalLossToday: 0 };
  }
}

function writeGuard(state: GuardState) {
  fs.writeFileSync(GUARD_FILE, JSON.stringify(state, null, 2));
}

function getAsset(state: GuardState, asset: Asset): AssetGuard {
  if (!state.assets[asset]) {
    state.assets[asset] = {
      tradesToday: 0,
      lossToday: 0,
      longConsecLoss: 0,
      shortConsecLoss: 0,
    };
  }
  return state.assets[asset];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface GuardCheck {
  allowed: boolean;
  reason?: string;
}

export function canTrade(asset: Asset, signal: 'LONG' | 'SHORT'): GuardCheck {
  const state = readGuard();
  const g = getAsset(state, asset);
  const now = Date.now();

  // 1. Daily total loss limit
  if (state.totalLossToday >= MAX_DAILY_LOSS) {
    return { allowed: false, reason: `Daily loss limit hit ($${state.totalLossToday.toFixed(2)}/$${MAX_DAILY_LOSS}) — STOP` };
  }

  // 2. Max loss per asset per day
  if (g.lossToday >= MAX_LOSS_PER_ASSET) {
    return { allowed: false, reason: `Max loss for ${asset} today ($${g.lossToday.toFixed(2)}/$${MAX_LOSS_PER_ASSET})` };
  }

  // 3. Max trades per asset per day
  if (g.tradesToday >= MAX_TRADES_PER_DAY) {
    return { allowed: false, reason: `Max trades for ${asset} today (${g.tradesToday}/${MAX_TRADES_PER_DAY})` };
  }

  // 4. Consecutive loss block per direction (NEW)
  if (signal === 'LONG' && g.longBlockedUntil && now < g.longBlockedUntil) {
    const remaining = ((g.longBlockedUntil - now) / 3600000).toFixed(1);
    return { allowed: false, reason: `LONG ${asset} blocked after ${MAX_CONSEC_LOSS}x consecutive SL — ${remaining}h remaining` };
  }

  if (signal === 'SHORT' && g.shortBlockedUntil && now < g.shortBlockedUntil) {
    const remaining = ((g.shortBlockedUntil - now) / 3600000).toFixed(1);
    return { allowed: false, reason: `SHORT ${asset} blocked after ${MAX_CONSEC_LOSS}x consecutive SL — ${remaining}h remaining` };
  }

  // 5. Cooldown after any SL (3 jam)
  if (g.lastSLTime) {
    const hoursSinceSL = (now - g.lastSLTime) / 3600000;
    if (hoursSinceSL < COOLDOWN_HOURS) {
      const remaining = (COOLDOWN_HOURS - hoursSinceSL).toFixed(1);
      return { allowed: false, reason: `Cooldown ${asset}: ${remaining}h remaining after SL` };
    }
  }

  return { allowed: true };
}

// Record SL — update consecutive counter + daily loss
export async function recordSL(asset: Asset, signal: 'LONG' | 'SHORT', pnlUsd: number): Promise<void> {
  const state = readGuard();
  const g = getAsset(state, asset);
  const loss = Math.abs(pnlUsd);
  const now = Date.now();

  // Update daily loss
  g.lossToday = (g.lossToday || 0) + loss;
  g.lastSLTime = now;
  state.totalLossToday = (state.totalLossToday || 0) + loss;

  // Update consecutive loss counter
  if (signal === 'LONG') {
    g.longConsecLoss = (g.longConsecLoss || 0) + 1;
    logger.warn(`${asset} LONG consecutive SL: ${g.longConsecLoss}/${MAX_CONSEC_LOSS}`);

    if (g.longConsecLoss >= MAX_CONSEC_LOSS) {
      g.longBlockedUntil = now + CONSEC_BLOCK_HOURS * 3600000;
      g.longConsecLoss = 0;
      const msg = `⛔ *LONG ${asset} BLOCKED*\nReason: ${MAX_CONSEC_LOSS}x consecutive SL\nBlocked for: ${CONSEC_BLOCK_HOURS}h\nResumes: ${new Date(g.longBlockedUntil).toLocaleTimeString()}`;
      logger.warn(msg);
      await sendAlert(msg);
    }
  } else {
    g.shortConsecLoss = (g.shortConsecLoss || 0) + 1;
    logger.warn(`${asset} SHORT consecutive SL: ${g.shortConsecLoss}/${MAX_CONSEC_LOSS}`);

    if (g.shortConsecLoss >= MAX_CONSEC_LOSS) {
      g.shortBlockedUntil = now + CONSEC_BLOCK_HOURS * 3600000;
      g.shortConsecLoss = 0;
      const msg = `⛔ *SHORT ${asset} BLOCKED*\nReason: ${MAX_CONSEC_LOSS}x consecutive SL\nBlocked for: ${CONSEC_BLOCK_HOURS}h\nResumes: ${new Date(g.shortBlockedUntil).toLocaleTimeString()}`;
      logger.warn(msg);
      await sendAlert(msg);
    }
  }

  writeGuard(state);
  logger.warn(`SL recorded ${asset} ${signal}: -$${loss.toFixed(2)} | Total loss today: $${state.totalLossToday.toFixed(2)}`);
}

// Record TP — reset consecutive loss counter for that direction
export function recordTP(asset: Asset, signal: 'LONG' | 'SHORT'): void {
  const state = readGuard();
  const g = getAsset(state, asset);

  if (signal === 'LONG') {
    if (g.longConsecLoss > 0) {
      logger.info(`${asset} LONG TP — reset consecutive loss counter (was ${g.longConsecLoss})`);
      g.longConsecLoss = 0;
    }
  } else {
    if (g.shortConsecLoss > 0) {
      logger.info(`${asset} SHORT TP — reset consecutive loss counter (was ${g.shortConsecLoss})`);
      g.shortConsecLoss = 0;
    }
  }

  writeGuard(state);
}

// Record trade opened
export function recordTradeOpened(asset: Asset): void {
  const state = readGuard();
  const g = getAsset(state, asset);
  g.tradesToday = (g.tradesToday || 0) + 1;
  writeGuard(state);
  logger.info(`Trade recorded ${asset}: ${g.tradesToday} trades today`);
}

// Daily status summary
export function getDailyStatus(): string {
  const state = readGuard();
  const now = Date.now();
  const lines = [`Daily Status (${state.date}) | Total loss: $${state.totalLossToday.toFixed(2)}/$${MAX_DAILY_LOSS}`];

  for (const [asset, g] of Object.entries(state.assets)) {
    const longBlock  = g.longBlockedUntil && now < g.longBlockedUntil
      ? `LONG blocked ${((g.longBlockedUntil - now)/3600000).toFixed(1)}h` : '';
    const shortBlock = g.shortBlockedUntil && now < g.shortBlockedUntil
      ? `SHORT blocked ${((g.shortBlockedUntil - now)/3600000).toFixed(1)}h` : '';
    const blocks = [longBlock, shortBlock].filter(Boolean).join(' | ');

    lines.push(
      `${asset}: ${g.tradesToday} trades | loss $${(g.lossToday||0).toFixed(2)} | ` +
      `L-streak:${g.longConsecLoss||0} S-streak:${g.shortConsecLoss||0}` +
      (blocks ? ` | ${blocks}` : '')
    );
  }

  return lines.join('\n');
}
