import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { logger } from './logger';
import { sendAlert } from './telegram';
import { recordSL, recordTP } from './riskGuard';
import type { Asset } from './config';

const TRACKER_FILE = path.join(process.cwd(), 'positions-tracker.json');

interface TrackedPosition {
  asset: string;
  side: string;
  entryPrice: number;
  size: number;
  tpPrice?: number;
  slPrice?: number;
  openedAt: number;
  positionPubkey?: string;
}

interface TrackerState {
  positions: Record<string, TrackedPosition>;
}

function getJupPath(): string {
  try { execSync('jup --version', { stdio: 'pipe', timeout: 5000 }); return 'jup'; } catch {}
  const win = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'jup.cmd');
  try { execSync(`"${win}" --version`, { stdio: 'pipe', timeout: 5000 }); return `"${win}"`; } catch {}
  return 'jup';
}
const JUP = getJupPath();

function jupCmd(args: string): any {
  try {
    const out = execSync(`${JUP} ${args} -f json`, { encoding: 'utf-8', timeout: 15000 });
    return JSON.parse(out);
  } catch { return null; }
}

function readTracker(): TrackerState {
  if (!fs.existsSync(TRACKER_FILE)) return { positions: {} };
  try { return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8')); }
  catch { return { positions: {} }; }
}

function writeTracker(state: TrackerState) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2));
}

// Fetch final PnL from jup perps history
async function getFinalPnL(asset: string, side: string, openedAt: number): Promise<{
  pnlUsd: number | null;
  closePrice: number | null;
  closeReason: 'TP' | 'SL' | 'MANUAL' | 'UNKNOWN';
}> {
  try {
    const history = jupCmd(`perps history --asset ${asset} --side ${side} --limit 5`);
    if (!history?.trades?.length) return { pnlUsd: null, closePrice: null, closeReason: 'UNKNOWN' };

    const closeTrade = history.trades.find((t: any) => {
      const tradeTime = new Date(t.time).getTime();
      return t.action === 'Decrease' && tradeTime >= openedAt;
    });

    if (!closeTrade) return { pnlUsd: null, closePrice: null, closeReason: 'UNKNOWN' };

    const pnlUsd     = closeTrade.pnlUsd ?? null;
    const closePrice = closeTrade.priceUsd ?? null;
    const closeReason: 'TP' | 'SL' | 'MANUAL' | 'UNKNOWN' =
      pnlUsd === null ? 'UNKNOWN' : pnlUsd > 0 ? 'TP' : 'SL';

    return { pnlUsd, closePrice, closeReason };
  } catch {
    return { pnlUsd: null, closePrice: null, closeReason: 'UNKNOWN' };
  }
}

// Detect closed positions + update risk guard
export async function detectClosedPositions(currentPositions: any[]): Promise<void> {
  const state = readTracker();
  const prevKeys = Object.keys(state.positions);
  if (prevKeys.length === 0) return;

  const currentKeys = new Set(currentPositions.map((p: any) => p.positionPubkey || p.asset));

  for (const key of prevKeys) {
    if (!currentKeys.has(key)) {
      const pos = state.positions[key];
      logger.info(`Position closed: ${pos.asset} ${pos.side}`);

      const { pnlUsd, closePrice, closeReason } = await getFinalPnL(pos.asset, pos.side, pos.openedAt);

      const duration  = Math.round((Date.now() - pos.openedAt) / 60000);
      const pnlStr    = pnlUsd !== null ? `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(3)}` : 'N/A';
      const pnlEmoji  = pnlUsd === null ? '❓' : pnlUsd >= 0 ? '✅' : '❌';
      const sideEmoji = pos.side === 'long' ? '🟢' : '🔴';
      const reasonEmoji = closeReason === 'TP' ? '🎯' : closeReason === 'SL' ? '🛑' : '📋';

      await sendAlert(
        `${sideEmoji} *CLOSED: ${pos.asset} ${pos.side.toUpperCase()}*\n` +
        `${reasonEmoji} Reason: \`${closeReason}\`\n` +
        `Entry: \`$${pos.entryPrice.toLocaleString()}\`\n` +
        (closePrice ? `Close: \`$${closePrice.toLocaleString()}\`\n` : '') +
        `TP: \`$${pos.tpPrice?.toLocaleString() ?? 'N/A'}\`\n` +
        `SL: \`$${pos.slPrice?.toLocaleString() ?? 'N/A'}\`\n` +
        `PnL: \`${pnlStr}\` ${pnlEmoji}\n` +
        `Duration: \`${duration} min\``
      );

      // Update risk guard based on result
      const signal = pos.side === 'long' ? 'LONG' : 'SHORT';
      if (closeReason === 'SL') {
        const loss = pnlUsd !== null ? Math.abs(pnlUsd) : 0.15;
        await recordSL(pos.asset as Asset, signal, loss);
      } else if (closeReason === 'TP') {
        recordTP(pos.asset as Asset, signal);
      }

      delete state.positions[key];
    }
  }

  writeTracker(state);
}

// Update tracker with current open positions
export function updateTrackedPositions(currentPositions: any[]): void {
  const state = readTracker();

  for (const pos of currentPositions) {
    const key = pos.positionPubkey || pos.asset;
    if (!state.positions[key]) {
      state.positions[key] = {
        asset: pos.asset,
        side: pos.side,
        entryPrice: pos.entryPriceUsd ?? pos.markPriceUsd ?? 0,
        size: pos.sizeUsd ?? 0,
        tpPrice: pos.tpsl?.find((t: any) => t.type === 'tp')?.triggerPriceUsd,
        slPrice: pos.tpsl?.find((t: any) => t.type === 'sl')?.triggerPriceUsd,
        openedAt: Date.now(),
        positionPubkey: pos.positionPubkey,
      };
      logger.debug(`Tracking: ${pos.asset} ${pos.side}`);
    }
  }

  writeTracker(state);
}
