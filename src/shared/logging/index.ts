type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getCurrentLevel(): LogLevel {
  const level = (process.env['LOG_LEVEL'] || 'info').toLowerCase() as LogLevel;
  return LEVELS[level] !== undefined ? level : 'info';
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const currentLevel = getCurrentLevel();
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const entry: Record<string, unknown> = {
    level,
    message,
    timestamp: new Date().toISOString(),
  };
  if (meta) {
    Object.assign(entry, meta);
  }

  const output = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
};
