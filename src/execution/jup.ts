import { execSync } from 'child_process';
import { config, type Asset } from '../utils/config';
import { logger } from '../utils/logger';
import type { TAResult } from '../ta/index';
import path from 'path';
import os from 'os';

// ─── Find jup binary path ─────────────────────────────────────────────────────

function getJupPath(): string {
  // Try direct command first
  try {
    execSync('jup --version', { encoding: 'utf-8', timeout: 5000 });
    return 'jup';
  } catch {}

  // Windows: npm global bin
  const npmGlobal = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'jup.cmd');
  try {
    execSync(`"${npmGlobal}" --version`, { encoding: 'utf-8', timeout: 5000 });
    return `"${npmGlobal}"`;
  } catch {}

  // npx fallback
  return 'npx @jup-ag/cli';
}

const JUP = getJupPath();

export interface TradeResult {
  success: boolean;
  dryRun: boolean;
  asset: Asset;
  side: 'long' | 'short';
  collateralUsdc: number;
  leverage: number;
  entryPrice?: number;
  slPrice: number;
  tpPrice: number;
  rrRatio: number;
  signature?: string;
  error?: string;
}

function jupCmd(args: string): string {
  const cmd = `${JUP} ${args} -f json`;
  logger.debug(`Running: ${cmd}`);
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30_000 });
  } catch (err: any) {
    throw new Error(err.stdout || err.stderr || err.message);
  }
}

export function checkJupInstalled(): boolean {
  try {
    const result = execSync(`${JUP} --version`, { encoding: 'utf-8', timeout: 5000 });
    logger.info(`jup CLI found: ${result.trim()}`);
    return true;
  } catch {
    return false;
  }
}

export async function executeTrade(ta: TAResult): Promise<TradeResult> {
  const side = ta.signal === 'LONG' ? 'long' : 'short';
  const { collateralUsdc, leverage, dryRun } = config.trading;

  // Round SL/TP per asset
  const decimals = ta.asset === 'BTC' ? 0 : ta.asset === 'ETH' ? 1 : 2;
  const sl = parseFloat(ta.suggestedSL.toFixed(decimals));
  const tp = parseFloat(ta.suggestedTP.toFixed(decimals));

  const args = [
    `perps open`,
    `--asset ${ta.asset}`,
    `--side ${side}`,
    `--amount ${collateralUsdc}`,
    `--input USDC`,
    `--leverage ${leverage}`,
    `--tp ${tp}`,
    `--sl ${sl}`,
    dryRun ? '--dry-run' : '',
  ].join(' ');

  logger.trade(`${dryRun ? '[DRY RUN] ' : ''}${ta.signal} ${ta.asset} | SL:${sl} TP:${tp} R:R:${ta.rrRatio.toFixed(1)}x`);

  try {
    const raw = jupCmd(args);
    const parsed = JSON.parse(raw);
    return {
      success: true, dryRun, asset: ta.asset, side,
      collateralUsdc, leverage,
      entryPrice: parsed.entryPriceUsd ?? ta.currentPrice,
      slPrice: sl, tpPrice: tp, rrRatio: ta.rrRatio,
      signature: parsed.signature,
    };
  } catch (err: any) {
    return {
      success: false, dryRun, asset: ta.asset, side,
      collateralUsdc, leverage,
      slPrice: sl, tpPrice: tp, rrRatio: ta.rrRatio,
      error: err.message,
    };
  }
}

export function getPositions(): any[] {
  try {
    const raw = jupCmd('perps positions');
    return JSON.parse(raw)?.positions || [];
  } catch { return []; }
}

export function getMarketPrices(): Record<string, number> {
  try {
    const raw = jupCmd('perps markets');
    const markets: any[] = JSON.parse(raw);
    return Object.fromEntries(markets.map(m => [m.asset, m.priceUsd]));
  } catch { return {}; }
}
