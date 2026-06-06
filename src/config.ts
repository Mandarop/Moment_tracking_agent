// ============================================================
// before-move: System Configuration
//
// Symbols are now auto-discovered by the discovery service.
// This config only holds global system-level settings.
// Per-symbol thresholds are generated dynamically based on
// each coin's 24h volume tier.
// ============================================================

export interface GlobalConfig {
  /** How many 1-minute buckets to keep in memory per symbol */
  rollingWindowMinutes: number;
  /** How often to poll Binance OI from REST API (ms) */
  oiPollIntervalMs: number;
  /** Telegram bot token */
  telegramBotToken?: string;
  /** Telegram chat ID */
  telegramChatId?: string;
  /** Discord webhook URL */
  discordWebhookUrl?: string;
  /** Cooldown between duplicate signals of same type+symbol (ms) */
  signalCooldownMs: number;
}

const config: GlobalConfig = {
  /** Keep 60 minutes of 1-minute buckets in memory */
  rollingWindowMinutes: 60,

  /** Poll Binance OI every 10 seconds (rate limit safe for 50 symbols) */
  oiPollIntervalMs: 10_000,

  /** Telegram config — set via environment variables */
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  /** Discord webhook — alternative to Telegram */
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1512535776410472539/Es01ymcVai_TAVBGJpTDyEdHMv4HUrBqUlZaTi8Y4bZASzrQuuLgnKNeEB4Ah-a_94S4',

  /** Don't fire duplicate signal for same type+symbol+direction within 15 minutes */
  signalCooldownMs: 15 * 60 * 1000,
};

export default config;
