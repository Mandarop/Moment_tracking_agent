// ============================================================
// before-move: Trend Watchlist Manager
//
// Maintains a list of coins that have recently triggered a
// high-conviction breakout. The trading agent monitors these
// coins for EMA pullback entries.
//
// Each entry has a 24-hour TTL. If no pullback trade fires
// within 24h, the trend is considered stale and removed.
// ============================================================

import { logger } from '../utils/logger.js';
import type { Signal, SignalDirection } from '../types.js';

/** Minimum conviction score to add a coin to the trading watchlist */
export const TRADE_CONVICTION_THRESHOLD = 8;

export interface WatchlistEntry {
  symbol: string;
  direction: SignalDirection;
  breakoutPrice: number;
  convictionScore: number;
  signalId: string;
  addedAt: number;
  expiresAt: number;
}

/** How long a coin stays on the watchlist before being removed (24 hours) */
const WATCHLIST_TTL_MS = 24 * 60 * 60 * 1000;

export class WatchlistManager {
  /** Active trend watchlist keyed by `symbol:direction` */
  private watchlist: Map<string, WatchlistEntry> = new Map();

  /**
   * Process a signal from the anomaly detector.
   * Only COILED_SPRING signals with conviction >= threshold are added.
   */
  processSignal(signal: Signal): WatchlistEntry | null {
    // Only trade breakout signals, not exhaustion/reversal
    if (signal.type !== 'COILED_SPRING') return null;

    // Must meet trading conviction threshold
    if (signal.convictionScore < TRADE_CONVICTION_THRESHOLD) {
      logger.debug('WATCHLIST', `Skipping ${signal.symbol} — conviction ${signal.convictionScore}/10 < ${TRADE_CONVICTION_THRESHOLD}`);
      return null;
    }

    const key = `${signal.symbol}:${signal.direction}`;
    const now = Date.now();

    // If already on watchlist with same direction, update timestamp
    if (this.watchlist.has(key)) {
      const existing = this.watchlist.get(key)!;
      existing.addedAt = now;
      existing.expiresAt = now + WATCHLIST_TTL_MS;
      existing.breakoutPrice = signal.price;
      existing.convictionScore = signal.convictionScore;
      logger.info('WATCHLIST', `🔄 Updated ${signal.symbol} ${signal.direction} on watchlist (conviction: ${signal.convictionScore}/10)`);
      return existing;
    }

    const entry: WatchlistEntry = {
      symbol: signal.symbol,
      direction: signal.direction,
      breakoutPrice: signal.price,
      convictionScore: signal.convictionScore,
      signalId: signal.id,
      addedAt: now,
      expiresAt: now + WATCHLIST_TTL_MS,
    };

    this.watchlist.set(key, entry);
    logger.info('WATCHLIST', `✅ Added ${signal.symbol} ${signal.direction} to watchlist (conviction: ${signal.convictionScore}/10, expires in 24h)`);

    return entry;
  }

  /**
   * Remove expired entries from the watchlist.
   * Called periodically by the trading agent.
   */
  pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.watchlist) {
      if (now > entry.expiresAt) {
        this.watchlist.delete(key);
        logger.info('WATCHLIST', `⏰ Removed ${entry.symbol} ${entry.direction} — 24h TTL expired without pullback trade`);
      }
    }
  }

  /**
   * Remove a specific coin from the watchlist (e.g., after a trade is opened).
   */
  remove(symbol: string, direction: SignalDirection): void {
    const key = `${symbol}:${direction}`;
    this.watchlist.delete(key);
  }

  /**
   * Get all active watchlist entries.
   */
  getAll(): WatchlistEntry[] {
    return Array.from(this.watchlist.values());
  }

  /**
   * Get a specific entry.
   */
  get(symbol: string, direction: SignalDirection): WatchlistEntry | undefined {
    return this.watchlist.get(`${symbol}:${direction}`);
  }

  /**
   * Get the number of active entries.
   */
  get size(): number {
    return this.watchlist.size;
  }
}
