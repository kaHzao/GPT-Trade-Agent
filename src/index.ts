import { config, ASSETS } from './utils/config';
import { logger } from './utils/logger';
import { sendAlert } from './utils/telegram';
import { analyzeAll } from './ta/index';
import { executeTrade, checkJupInstalled, getPositions, getMarketPrices } from './execution/jup';
import { canTrade, recordTradeOpened, getDailyStatus } from './utils/riskGuard';
import { detectClosedPositions, updateTrackedPositions } from './utils/positionTracker';

async function main() {
  const startTime = Date.now();
  logger.info('═══ Jupiter Perps GPT Agent starting ═══');
  logger.info(`Mode: ${config.trading.dryRun ? '⚠️  DRY RUN' : '🔴 LIVE'}`);
  logger.info(`Pairs: ${ASSETS.join(', ')} | $${config.trading.collateralUsdc} | ${config.trading.leverage}x`);
  logger.info(`Confidence gate: ${config.ta.minConfidence}% | ATR mult: ${config.ta.atrMultiplier}× | RR min: ${config.ta.minRR}`);

  if (!checkJupInstalled()) {
    const msg = '❌ `jup` CLI not installed';
    logger.error(msg);
    await sendAlert(msg);
    process.exit(1);
  }

  logger.info(getDailyStatus());

  const openPositions = getPositions();
  const openAssets    = new Set(openPositions.map((p: any) => p.asset as string));
  logger.info(`Open positions: ${openPositions.length} (${[...openAssets].join(', ') || 'none'})`);

  const prices = getMarketPrices();
  if (Object.keys(prices).length) logger.info('Market prices', prices);

  // Detect closed + update tracker
  await detectClosedPositions(openPositions, prices);
  updateTrackedPositions(openPositions);

  // Skip TA kalau semua pair sudah ada posisi
  const availableAssets = ASSETS.filter(a => !openAssets.has(a));
  if (availableAssets.length === 0) {
    logger.info('All pairs in position — skipping TA this cycle');
    logger.info(`═══ Cycle complete (${Date.now() - startTime}ms) ═══\n`);
    return;
  }

  const signals = await analyzeAll();
  let tradesOpened = 0;

  for (const ta of signals) {
    if (!ta) continue;

    if (openAssets.has(ta.asset)) {
      logger.info(`${ta.asset}: already in position, skipping`);
      continue;
    }

    if (ta.signal === 'HOLD') {
      logger.info(`${ta.asset}: HOLD | conf:${ta.confidence}% | ${ta.reason}`);
      continue;
    }

    const guard = canTrade(ta.asset, ta.signal as 'LONG' | 'SHORT');
    if (!guard.allowed) {
      logger.warn(`${ta.asset}: BLOCKED — ${guard.reason}`);
      await sendAlert(`⛔ *${ta.asset} blocked* _(GPT)_\n${guard.reason}`);
      continue;
    }

    logger.info(`🎯 ${ta.signal} ${ta.asset} | conf:${ta.confidence}% | ${ta.reason}`);
    const result = await executeTrade(ta);

    if (result.success) {
      tradesOpened++;
      openAssets.add(ta.asset);
      recordTradeOpened(ta.asset);

      const emoji = ta.signal === 'LONG' ? '🟢' : '🔴';
      await sendAlert(
        `${emoji} *${ta.signal} ${ta.asset}* _(GPT)_${result.dryRun ? ' _(DRY RUN)_' : ''}\n` +
        `Price: \`$${ta.currentPrice.toLocaleString()}\`\n` +
        `Collateral: \`$${result.collateralUsdc} × ${result.leverage}x\`\n` +
        `SL: \`$${result.slPrice.toLocaleString()}\` (-${ta.slPct.toFixed(2)}%)\n` +
        `TP: \`$${result.tpPrice.toLocaleString()}\` (+${ta.tpPct.toFixed(2)}%)\n` +
        `R:R: \`${result.rrRatio.toFixed(2)}x\`\n` +
        `Macro: ${ta.trend4h} | Conf: ${ta.confidence}%\n` +
        `Signal: ${ta.reason}`
      );
    } else {
      logger.error(`Trade failed: ${ta.asset}`, result.error);
      await sendAlert(`⚠️ *Trade failed: ${ta.asset}* _(GPT)_\n${result.error}`);
    }
  }

  if (tradesOpened === 0) logger.info('No trades opened this cycle');
  logger.info(`═══ Cycle complete (${Date.now() - startTime}ms) ═══\n`);
}

main().catch(async err => {
  logger.error('Fatal error', err);
  await sendAlert(`🚨 *GPT Agent error*\n\`${err.message}\``);
  process.exit(1);
});
