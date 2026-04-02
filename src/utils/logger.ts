type Level = 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'DEBUG';

function log(level: Level, msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  const extra = data ? ` | ${JSON.stringify(data)}` : '';
  console.log(`[${ts}] [${level}] ${msg}${extra}`);
}

export const logger = {
  info:  (msg: string, data?: unknown) => log('INFO', msg, data),
  warn:  (msg: string, data?: unknown) => log('WARN', msg, data),
  error: (msg: string, data?: unknown) => log('ERROR', msg, data),
  trade: (msg: string, data?: unknown) => log('TRADE', msg, data),
  debug: (msg: string, data?: unknown) => log('DEBUG', msg, data),
};
