// ============================================================
// before-move: Structured Logger
// A systems engineer never uses console.log with bare strings.
// Every log line is structured, timestamped, and tagged.
// ============================================================

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SIGNAL';

const COLORS: Record<LogLevel, string> = {
  DEBUG:  '\x1b[90m',   // gray
  INFO:   '\x1b[36m',   // cyan
  WARN:   '\x1b[33m',   // yellow
  ERROR:  '\x1b[31m',   // red
  SIGNAL: '\x1b[35m',   // magenta (stands out)
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 23);
}

function log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
  const color = COLORS[level];
  const prefix = `${color}${BOLD}[${level}]${RESET}`;
  const ts = `\x1b[90m${formatTimestamp()}${RESET}`;
  const comp = `\x1b[94m[${component}]${RESET}`;

  const parts = [ts, prefix, comp, message];

  if (data) {
    const dataStr = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toLocaleString() : v}`)
      .join(' ');
    parts.push(`\x1b[90m${dataStr}${RESET}`);
  }

  console.log(parts.join(' '));
}

export const logger = {
  debug: (component: string, message: string, data?: Record<string, unknown>) =>
    log('DEBUG', component, message, data),
  info: (component: string, message: string, data?: Record<string, unknown>) =>
    log('INFO', component, message, data),
  warn: (component: string, message: string, data?: Record<string, unknown>) =>
    log('WARN', component, message, data),
  error: (component: string, message: string, data?: Record<string, unknown>) =>
    log('ERROR', component, message, data),
  signal: (component: string, message: string, data?: Record<string, unknown>) =>
    log('SIGNAL', component, message, data),
};
