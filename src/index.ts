import { config, ASSETS } from './utils/config';
import { logger } from './utils/logger';
import { sendAlert } from './utils/telegram';
import { analyzeAll } from './ta/index';
import { executeTrade, checkJupInstalled, getPositions, getMarketPrices } from './execution/jup';
import { canTrade, recordTradeOpened, getDailyStatus } from './utils/riskGuard';
import { detectClosedPositions, updateTrackedPositions } from './utils/positionTracker';

async function main() {
  logger.info('═══ Jupiter Perps Agent starting ═══');
  logger.info(`Mode: ${config.trading.dryRun ? '⚠️  DRY RUN' : '🔴 LIVE'}`);
  logger.info(`Pairs: ${ASSETS.join(', ')} | $${config.trading.collateralUsdc} | ${config.trading.leverage}x`);

  // ── Check jup CLI ──────────────────────────────────────────────────────────
  if (!checkJupInstalled()) {
    const msg = '❌ `jup` CLI not installed';
    logger.error(msg);
    await sendAlert(msg);
    process.exit(1);
  }

  // ── Log daily risk status ──────────────────────────────────────────────────
  logger.info(getDailyStatus());

  // ── Check open positions ───────────────────────────────────────────────────
  const openPositions = getPositions();
  const openAssets = new Set(openPositions.map((p: any) => p.asset as string));
  logger.info(`Open positions: ${openPositions.length}`);

  // ── Detect SL/TP closes (compare with last known positions) ───────────────
  await detectClosedPositions(openPositions);

  // ── Update tracker with current open positions ────────────────────────────
  updateTrackedPositions(openPositions);

  // ── Market prices ──────────────────────────────────────────────────────────
  const prices = getMarketPrices();
  if (Object.keys(prices).length) {
    logger.info('Market prices', prices);
  }

  // ── Run TA ────────────────────────────────────────────────────────────────
  const signals = await analyzeAll();

  let tradesOpened = 0;

  for (const ta of signals) {
    if (!ta) continue;

    if (openAssets.has(ta.asset)) {
      logger.info(`${ta.asset}: already in position, skipping`);
      continue;
    }

    if (ta.signal === 'HOLD') {
      logger.info(`${ta.asset}: HOLD | ${ta.regime} | conf:${ta.confidence}% | RSI:${ta.rsi15m.toFixed(1)}`);
      continue;
    }

    if (ta.confidence < config.ta.minConfidence) {
      logger.info(`${ta.asset}: ${ta.signal} confidence too low (${ta.confidence}% < ${config.ta.minConfidence}%)`);
      continue;
    }

    // ── Risk Guard ────────────────────────────────────────────────────────
    const guard = canTrade(ta.asset, ta.signal as 'LONG' | 'SHORT');
    if (!guard.allowed) {
      logger.warn(`${ta.asset}: BLOCKED — ${guard.reason}`);
      await sendAlert(`⛔ *${ta.asset} blocked*\n${guard.reason}`);
      continue;
    }

    // ── Execute ───────────────────────────────────────────────────────────
    logger.info(`🎯 ${ta.signal} ${ta.asset} | ${ta.reason}`);
    const result = await executeTrade(ta);

    if (result.success) {
      tradesOpened++;
      recordTradeOpened(ta.asset);

      const emoji = ta.signal === 'LONG' ? '🟢' : '🔴';
      await sendAlert(
        `${emoji} *${ta.signal} ${ta.asset}*${result.dryRun ? ' _(DRY RUN)_' : ''}\n` +
        `Price: \`$${ta.currentPrice.toLocaleString()}\`\n` +
        `Collateral: \`$${result.collateralUsdc} × ${result.leverage}x\`\n` +
        `SL: \`$${result.slPrice.toLocaleString()}\` (-${ta.slPct.toFixed(1)}%)\n` +
        `TP: \`$${result.tpPrice.toLocaleString()}\` (+${ta.tpPct.toFixed(1)}%)\n` +
        `R:R: \`${result.rrRatio.toFixed(1)}x\`\n` +
        `Regime: ${ta.regime} | ADX:${ta.adx.toFixed(0)} | Conf:${ta.confidence}%\n` +
        `Signal: ${ta.reason}`
      );
    } else {
      logger.error(`Trade failed: ${ta.asset}`, result.error);
      await sendAlert(`⚠️ *Trade failed: ${ta.asset}*\n${result.error}`);
    }
  }

  if (tradesOpened === 0) {
    logger.info('No trades opened this cycle');
  }

  logger.info('═══ Cycle complete ═══\n');
}

main().catch(async err => {
  logger.error('Fatal error', err);
  await sendAlert(`🚨 *Agent error*\n\`${err.message}\``);
  process.exit(1);
});
