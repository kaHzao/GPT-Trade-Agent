import { getSummary, getAllTrades } from './utils/tradeLog';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

async function sendTelegram(msg: string) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log(msg); return; }
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId, text: msg, parse_mode: 'Markdown',
  });
}

function pnl(v: number) { return `${v >= 0 ? '+' : ''}$${v.toFixed(3)}`; }

async function main() {
  const summaries = getSummary();
  const lines: string[] = [];

  lines.push(`📊 *Performance Summary*`);
  lines.push(`📅 ${new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' })}`);
  lines.push('');

  for (const s of summaries) {
    const agentLabel = s.agent === 'claude' ? '🔵 Claude Agent' : '🟡 GPT Agent';
    lines.push(`*${agentLabel}*`);

    if (s.totalTrades === 0) {
      lines.push(`_Belum ada trade tercatat_`);
      lines.push('');
      continue;
    }

    lines.push(`Trades: \`${s.totalTrades}\` | Win: \`${s.wins}\` | Loss: \`${s.losses}\``);
    lines.push(`Win rate: \`${s.winRate.toFixed(1)}%\``);
    lines.push(`Net PnL: \`${pnl(s.totalPnl)}\``);
    lines.push(`Avg win: \`${pnl(s.avgWin)}\` | Avg loss: \`${pnl(s.avgLoss)}\``);
    lines.push(`Best: \`${pnl(s.bestTrade)}\` | Worst: \`${pnl(s.worstTrade)}\``);
    lines.push(`Avg duration: \`${Math.round(s.avgDuration)} min\``);

    // Per asset
    const assetLines = Object.entries(s.byAsset).map(([asset, d]) =>
      `  ${asset}: ${d.trades} trade | ${pnl(d.pnl)} | ${((d.wins/d.trades)*100).toFixed(0)}% win`
    );
    if (assetLines.length) lines.push(assetLines.join('\n'));
    lines.push('');
  }

  // Recent 5 trades
  const recent = getAllTrades().slice(-5).reverse();
  if (recent.length) {
    lines.push(`*5 Trade Terakhir*`);
    for (const t of recent) {
      const emoji = t.pnlUsd > 0 ? '✅' : '❌';
      const agent = t.agent === 'claude' ? '🔵' : '🟡';
      lines.push(`${agent} ${emoji} ${t.side.toUpperCase()} ${t.asset} \`${pnl(t.pnlUsd)}\` (${t.closeReason}) ${t.durationMin}min`);
    }
  }

  await sendTelegram(lines.join('\n'));
  console.log('[summary] Done.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
