import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const LOG_FILE = path.join(process.cwd(), 'trade-log.json');

export interface TradeRecord {
  id:          string;       // timestamp-asset-side
  agent:       'claude' | 'gpt';
  asset:       string;
  side:        'long' | 'short';
  entryPrice:  number;
  exitPrice:   number;
  entryTime:   string;       // ISO
  exitTime:    string;       // ISO
  durationMin: number;
  slPrice:     number | null;
  tpPrice:     number | null;
  closeReason: 'TP' | 'SL' | 'MANUAL' | 'UNKNOWN';
  pnlUsd:      number;
  collateral:  number;
  leverage:    number;
}

interface LogState {
  trades:    TradeRecord[];
  updatedAt: string;
}

function readLog(): LogState {
  if (!fs.existsSync(LOG_FILE)) return { trades: [], updatedAt: new Date().toISOString() };
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); }
  catch { return { trades: [], updatedAt: new Date().toISOString() }; }
}

function writeLog(state: LogState) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(LOG_FILE, JSON.stringify(state, null, 2));
}

// ─── Append satu trade ke log ─────────────────────────────────────────────────

export function logTrade(trade: TradeRecord): void {
  const state = readLog();

  // Deduplicate — jangan double-log trade yang sama
  const exists = state.trades.some(t => t.id === trade.id);
  if (exists) {
    logger.debug(`Trade ${trade.id} already logged, skip`);
    return;
  }

  state.trades.push(trade);
  writeLog(state);
  logger.info(`Trade logged: ${trade.agent.toUpperCase()} ${trade.side.toUpperCase()} ${trade.asset} ${trade.closeReason} ${trade.pnlUsd >= 0 ? '+' : ''}$${trade.pnlUsd.toFixed(3)}`);
}

// ─── Summary stats ────────────────────────────────────────────────────────────

export interface TradeSummary {
  agent:        string;
  totalTrades:  number;
  wins:         number;
  losses:       number;
  winRate:      number;
  totalPnl:     number;
  avgWin:       number;
  avgLoss:      number;
  avgDuration:  number;
  bestTrade:    number;
  worstTrade:   number;
  byAsset:      Record<string, { trades: number; pnl: number; wins: number }>;
}

export function getSummary(agent?: 'claude' | 'gpt'): TradeSummary[] {
  const state  = readLog();
  const agents = agent ? [agent] : ['claude', 'gpt'] as const;

  return agents.map(a => {
    const trades = state.trades.filter(t => t.agent === a);
    if (trades.length === 0) {
      return {
        agent: a, totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        totalPnl: 0, avgWin: 0, avgLoss: 0, avgDuration: 0,
        bestTrade: 0, worstTrade: 0, byAsset: {},
      };
    }

    const wins   = trades.filter(t => t.pnlUsd > 0);
    const losses = trades.filter(t => t.pnlUsd <= 0);
    const totalPnl   = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const avgWin     = wins.length   ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : 0;
    const avgLoss    = losses.length ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length : 0;
    const avgDuration = trades.reduce((s, t) => s + t.durationMin, 0) / trades.length;
    const bestTrade  = Math.max(...trades.map(t => t.pnlUsd));
    const worstTrade = Math.min(...trades.map(t => t.pnlUsd));

    // Per asset breakdown
    const byAsset: Record<string, { trades: number; pnl: number; wins: number }> = {};
    for (const t of trades) {
      if (!byAsset[t.asset]) byAsset[t.asset] = { trades: 0, pnl: 0, wins: 0 };
      byAsset[t.asset].trades++;
      byAsset[t.asset].pnl += t.pnlUsd;
      if (t.pnlUsd > 0) byAsset[t.asset].wins++;
    }

    return {
      agent: a,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: (wins.length / trades.length) * 100,
      totalPnl, avgWin, avgLoss, avgDuration,
      bestTrade, worstTrade, byAsset,
    };
  });
}

export function getAllTrades(agent?: 'claude' | 'gpt'): TradeRecord[] {
  const state = readLog();
  return agent ? state.trades.filter(t => t.agent === agent) : state.trades;
}
