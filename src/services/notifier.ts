// ============================================================
// before-move: Alert Notifier Service
//
// Delivers signals to your phone/desktop via:
//   1. Telegram Bot API (primary — instant mobile push)
//   2. Discord Webhook (secondary — now with rich embeds)
//   3. Console (always — for local monitoring)
//
// v2: Conviction-gated Discord embeds.
//     Only signals scoring ≥ DISCORD_THRESHOLD are sent.
//     Lower-conviction signals still log to console for review.
//
// A systems engineer never makes a network call without:
//   - Retry logic
//   - Timeout handling
//   - Graceful degradation (if Telegram is down, still log it)
// ============================================================

import { logger } from '../utils/logger.js';
import { DISCORD_THRESHOLD } from '../engine/convictionScorer.js';
import type { Signal } from '../types.js';
import type { PaperTrade } from '../trader/paperTrader.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

/** Format a signal into a clean Telegram/Console message (plain text) */
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
    `${urgencyEmoji[signal.urgency]} **${signal.urgency}** | ${directionEmoji[signal.direction]} ${signal.direction} | 🎯 ${signal.convictionScore}/10`,
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

/** Build a Discord embed object for a signal */
function buildDiscordEmbed(signal: Signal): object {
  const directionEmoji = signal.direction === 'BULLISH' ? '📈' : signal.direction === 'BEARISH' ? '📉' : '➡️';
  const urgencyEmoji = signal.urgency === 'CRITICAL' ? '🔴' : signal.urgency === 'HIGH' ? '🟠' : '🟡';
  
  // Green for bullish, red for bearish, grey for neutral
  const color = signal.direction === 'BULLISH' ? 0x00ff88 : signal.direction === 'BEARISH' ? 0xff4444 : 0x888888;

  const kingTag = signal.btcConfirmed ? '📈 Agrees ✅' : '⚠️ Diverging';

  // Build clean field list
  const fields: { name: string; value: string; inline: boolean }[] = [];

  const oiChange = Number(signal.metadata.oiChange4hPct || signal.metadata.priceChange24hPct || 0);
  if (oiChange !== 0) {
    fields.push({
      name: '📊 OI Build-Up',
      value: `**+${Math.abs(oiChange).toFixed(1)}%** (4H)`,
      inline: true,
    });
  }

  const priceMove = Number(signal.metadata.priceChange15mPct || 0);
  if (priceMove !== 0) {
    fields.push({
      name: '💥 Price Move',
      value: `**${priceMove >= 0 ? '+' : ''}${priceMove.toFixed(2)}%** (15m)`,
      inline: true,
    });
  }

  const bodyRatio = Number(signal.metadata.bodyRatio || 0);
  const deltaRatio = Number(signal.metadata.deltaRatio || 0);
  if (bodyRatio > 0 || deltaRatio > 0) {
    fields.push({
      name: '🕯️ Candle Quality',
      value: `Body: **${(bodyRatio * 100).toFixed(0)}%** | Delta: **${(deltaRatio * 100).toFixed(0)}%**`,
      inline: true,
    });
  }

  const funding = Number(signal.metadata.fundingRate || 0);
  const fundingLabel = funding === 0 ? 'Neutral' : funding > 0 ? 'Longs Pay' : 'Shorts Pay';
  const fundingIcon = funding === 0 ? '⚪' : (
    (signal.direction === 'BULLISH' && funding < 0) || (signal.direction === 'BEARISH' && funding > 0)
      ? '✅' : '⚠️'
  );
  fields.push({
    name: '💰 Funding',
    value: `${(funding * 100).toFixed(4)}% (${fundingLabel}) ${fundingIcon}`,
    inline: true,
  });

  // King's Permission (only for altcoins)
  if (signal.symbol !== 'BTCUSDT' && signal.symbol !== 'ETHUSDT') {
    fields.push({
      name: '👑 BTC Trend',
      value: kingTag,
      inline: true,
    });
  }

  return {
    embeds: [{
      title: `${urgencyEmoji} ${signal.urgency} | ${directionEmoji} ${signal.direction} | 🎯 ${signal.convictionScore}/10`,
      description: signal.message,
      color,
      fields,
      footer: {
        text: `💰 $${signal.price.toLocaleString()} | ${new Date(signal.timestamp).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
      },
      timestamp: new Date(signal.timestamp).toISOString(),
    }],
    username: 'Before Move 🔥',
  };
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
      logger.info('NOTIFY', `✅ Discord notifications enabled (threshold: ≥${DISCORD_THRESHOLD}/10)`);
    }
  }

  /** Send a signal to all configured channels */
  async send(signal: Signal): Promise<void> {
    this.signalHistory.push(signal);

    const message = formatSignalMessage(signal);

    // Always log to console (all conviction levels)
    console.log('\n' + '='.repeat(60));
    console.log(message);
    console.log('='.repeat(60) + '\n');

    // Fire Telegram and Discord in parallel
    const promises: Promise<void>[] = [];

    if (this.telegramBotToken && this.telegramChatId) {
      promises.push(this.sendTelegram(message));
    }

    // CONVICTION GATE: Only send to Discord if score meets threshold
    if (this.discordWebhookUrl && signal.convictionScore >= DISCORD_THRESHOLD) {
      promises.push(this.sendDiscord(signal));
    } else if (this.discordWebhookUrl && signal.convictionScore < DISCORD_THRESHOLD) {
      logger.info('NOTIFY', `⏭️ Skipping Discord for ${signal.symbol} (conviction: ${signal.convictionScore}/10, need ≥${DISCORD_THRESHOLD})`);
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

  /** Send via Discord Webhook (rich embed format) */
  private async sendDiscord(signal: Signal): Promise<void> {
    if (!this.discordWebhookUrl) return;

    const embed = buildDiscordEmbed(signal);

    const response = await fetchWithRetry(this.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embed),
    });

    if (response) {
      logger.info('NOTIFY', `✅ Discord embed sent (${signal.symbol} — ${signal.convictionScore}/10)`);
    } else {
      logger.error('NOTIFY', '❌ Failed to send Discord message after all retries');
    }
  }

  /** Send a paper trade alert to Discord */
  async sendTradeAlert(trade: PaperTrade, action: 'OPEN' | 'CLOSE'): Promise<void> {
    if (!this.discordWebhookUrl) return;

    const isOpen = action === 'OPEN';
    const isBullish = trade.direction === 'BULLISH';
    const color = isOpen
      ? (isBullish ? 0x00ff88 : 0xff4444)
      : (trade.status === 'WIN' ? 0x00ff88 : trade.status === 'BREAKEVEN' ? 0xffaa00 : 0xff4444);

    const statusEmoji = isOpen ? '📝' : (trade.status === 'WIN' ? '✅' : trade.status === 'BREAKEVEN' ? '🔄' : '❌');
    const dirEmoji = isBullish ? '📈' : '📉';
    const title = isOpen
      ? `${statusEmoji} PAPER TRADE OPENED | ${dirEmoji} ${trade.direction}`
      : `${statusEmoji} PAPER TRADE ${trade.status} | ${dirEmoji} ${trade.direction}`;

    const fields: { name: string; value: string; inline: boolean }[] = [
      { name: '🪙 Symbol', value: `**${trade.symbol}**`, inline: true },
      { name: '⏱️ Timeframe', value: `**${trade.timeframe}m**`, inline: true },
      { name: '🎯 Pattern', value: trade.pattern, inline: true },
      { name: '📊 Conviction', value: `${trade.convictionScore}/10`, inline: true },
      { name: '💰 Entry', value: `$${trade.entryPrice}`, inline: true },
      { name: '🛑 Stop Loss', value: `$${trade.stopLoss.toFixed(4)}`, inline: true },
      { name: '🎯 Take Profit', value: `$${trade.takeProfit.toFixed(4)}`, inline: true },
      { name: '💵 Position Size', value: `$${trade.positionSizeUsd.toFixed(0)}`, inline: true },
    ];

    if (!isOpen && trade.exitPrice !== null) {
      fields.push(
        { name: '🚪 Exit Price', value: `$${trade.exitPrice.toFixed(4)}`, inline: true },
        { name: '📈 P&L', value: `${trade.pnlPct!.toFixed(2)}% ($${trade.pnlUsd!.toFixed(2)})`, inline: true },
        { name: '⏱️ Duration', value: `${((trade.exitTime! - trade.entryTime) / 60_000).toFixed(0)} min`, inline: true },
      );
    }

    const embed = {
      embeds: [{
        title,
        color,
        fields,
        footer: { text: '🤖 Paper Trading Mode — No Real Money' },
        timestamp: new Date().toISOString(),
      }],
      username: 'Before Move 🤖',
    };

    const response = await fetchWithRetry(this.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embed),
    });

    if (response) {
      logger.info('NOTIFY', `✅ Discord trade alert sent (${trade.symbol} ${action})`);
    } else {
      logger.error('NOTIFY', `❌ Failed to send trade alert to Discord`);
    }
  }

  /** Get recent signal history */
  getHistory(): Signal[] {
    return this.signalHistory;
  }
}
