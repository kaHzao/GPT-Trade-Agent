import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { logger } from './logger';

let bot: TelegramBot | null = null;

function getBot(): TelegramBot | null {
  if (!config.telegram.botToken) return null;
  if (!bot) bot = new TelegramBot(config.telegram.botToken);
  return bot;
}

export async function sendAlert(message: string): Promise<void> {
  const b = getBot();
  if (!b || !config.telegram.chatId) {
    logger.warn('Telegram not configured');
    return;
  }
  try {
    await b.sendMessage(config.telegram.chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('Telegram failed', err);
  }
}
