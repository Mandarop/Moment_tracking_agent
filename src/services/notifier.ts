// ============================================================
// before-move: Alert Notifier Service
//
// Delivers signals to your phone/desktop via:
//   1. Telegram Bot API (primary — instant mobile push)
//   2. Discord Webhook (secondary)
//   3. Console (always — for local monitoring)
//
// A systems engineer never makes a network call without:
//   - Retry logic
//   - Timeout handling
//   - Graceful degradation (if Telegram is down, still log it)
// ============================================================

import { logger } from '../utils/logger.js';
import type { Signal } from '../types.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

/** Format a signal into a clean Telegram/Discord message */
function formatSignalMessage(signal: Signal): string {
  const urgencyEmoji: Record<string, string> = {
    LOW: '🟢',
    MEDIUM: '🟡',
    HIGH: '🟠',
    CRITICAL: '🔴',
  };

  const directionEmoji: Record<string, string> = {
    BULLISH: '📈',
    BEARISH: '📉',
    NEUTRAL: '➡️',
  };

  const lines = [
    `${urgencyEmoji[signal.urgency]} **${signal.urgency}** | ${directionEmoji[signal.direction]} ${signal.direction}`,
    ``,
    signal.message,
    ``,
    `💰 Price: $${signal.price.toLocaleString()}`,
    `⏰ ${new Date(signal.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
  ];

  // Add metadata
  if (Object.keys(signal.metadata).length > 0) {
    lines.push('', '📊 Metrics:');
    for (const [key, value] of Object.entries(signal.metadata)) {
      const formatted = typeof value === 'number'
        ? (Math.abs(value) > 1_000_000 ? `$${(value / 1_000_000).toFixed(2)}M` : value.toFixed(4))
        : value;
      lines.push(`  • ${key}: ${formatted}`);
    }
  }

  return lines.join('\n');
}

/** Send with retry logic */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries: number = MAX_RETRIES
): Promise<Response | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) return response;
      logger.warn('NOTIFY', `Attempt ${attempt}/${retries} failed: HTTP ${response.status}`);
    } catch (err) {
      logger.warn('NOTIFY', `Attempt ${attempt}/${retries} error: ${err}`);
    }

    if (attempt < retries) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  return null;
}

export class Notifier {
  private telegramBotToken?: string;
  private telegramChatId?: string;
  private discordWebhookUrl?: string;

  /** Track sent signals for dedup and history */
  private signalHistory: Signal[] = [];

  constructor(options: {
    telegramBotToken?: string;
    telegramChatId?: string;
    discordWebhookUrl?: string;
  }) {
    this.telegramBotToken = options.telegramBotToken;
    this.telegramChatId = options.telegramChatId;
    this.discordWebhookUrl = options.discordWebhookUrl;

    if (this.telegramBotToken && this.telegramChatId) {
      logger.info('NOTIFY', '✅ Telegram notifications enabled');
    } else {
      logger.warn('NOTIFY', 'Telegram not configured — signals will only print to console');
    }

    if (this.discordWebhookUrl) {
      logger.info('NOTIFY', '✅ Discord notifications enabled');
    }
  }

  /** Send a signal to all configured channels */
  async send(signal: Signal): Promise<void> {
    this.signalHistory.push(signal);

    const message = formatSignalMessage(signal);

    // Always log to console
    console.log('\n' + '='.repeat(60));
    console.log(message);
    console.log('='.repeat(60) + '\n');

    // Fire Telegram and Discord in parallel
    const promises: Promise<void>[] = [];

    if (this.telegramBotToken && this.telegramChatId) {
      promises.push(this.sendTelegram(message));
    }

    if (this.discordWebhookUrl) {
      promises.push(this.sendDiscord(message));
    }

    await Promise.allSettled(promises);
  }

  /** Send via Telegram Bot API */
  private async sendTelegram(message: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`;
    const body = {
      chat_id: this.telegramChatId,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    };

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response) {
      logger.info('NOTIFY', '✅ Telegram message sent');
    } else {
      logger.error('NOTIFY', '❌ Failed to send Telegram message after all retries');
    }
  }

  /** Send via Discord Webhook */
  private async sendDiscord(message: string): Promise<void> {
    if (!this.discordWebhookUrl) return;

    const body = {
      content: message,
      username: 'Before Move 🔥',
    };

    const response = await fetchWithRetry(this.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response) {
      logger.info('NOTIFY', '✅ Discord message sent');
    } else {
      logger.error('NOTIFY', '❌ Failed to send Discord message after all retries');
    }
  }

  /** Get recent signal history */
  getHistory(): Signal[] {
    return this.signalHistory;
  }
}
