// ============================================================
// before-move: Trading Agent Orchestrator
//
// The main trading agent that ties together:
//   - Watchlist (tracks coins with recent breakouts)
//   - EMA Calculator (fetches klines, computes 9/15 EMA)
//   - Pullback Detector (finds confirmation candles at EMA)
//   - Paper Trader (simulates trades with SL/TP/trailing)
//
// Runs a polling loop every 60 seconds to check for setups
// and manage open positions.
// ============================================================

import { logger } from '../utils/logger.js';
import { WatchlistManager } from './watchlist.js';
import { getEMADataBatch } from './emaCalculator.js';
import { detectPullback } from './pullbackDetector.js';
import { PaperTrader } from './paperTrader.js';
import type { PaperTrade } from './paperTrader.js';
import type { Signal } from '../types.js';
import type { Storage } from '../db/storage.js';

/** How often to check for pullback setups and manage positions (ms) */
const POLL_INTERVAL_MS = 60_000; // 1 minute

/** How often to print the trading status report (ms) */
const STATUS_INTERVAL_MS = 5 * 60_000; // 5 minutes

export class TradingAgent {
  private watchlist: WatchlistManager;
  private paperTrader: PaperTrader;
  private storage: Storage;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private onTradeCallback: ((trade: PaperTrade, action: 'OPEN' | 'CLOSE') => void) | null = null;

  constructor(storage: Storage) {
    this.watchlist = new WatchlistManager();
    this.paperTrader = new PaperTrader();
    this.storage = storage;

    logger.info('TRADER', '🤖 Paper Trading Agent initialized');
    logger.info('TRADER', '   Strategy: EMA Pullback (9/15 EMA on 15m chart)');
    logger.info('TRADER', '   Balance: $10,000 | Risk: 2% per trade | R:R 1:2');
    logger.info('TRADER', '   Mode: PAPER TRADING (no real money)');
  }

  /**
   * Register a callback for trade events (used by notifier to send Discord alerts).
   */
  onTrade(cb: (trade: PaperTrade, action: 'OPEN' | 'CLOSE') => void): void {
    this.onTradeCallback = cb;
  }

  /**
   * Process a signal from the anomaly detector.
   * High-conviction breakouts are added to the watchlist.
   */
  onSignal(signal: Signal): void {
    this.watchlist.processSignal(signal);
  }

  /**
   * Start the polling loop.
   */
  start(): void {
    logger.info('TRADER', '▶️ Trading agent started — polling every 60s for pullback setups');

    // Main polling loop
    this.pollTimer = setInterval(() => {
      this.tick().catch(err => {
        logger.error('TRADER', 'Tick error', { error: String(err) });
      });
    }, POLL_INTERVAL_MS);

    // Status report loop
    this.statusTimer = setInterval(() => {
      this.printStatus();
    }, STATUS_INTERVAL_MS);
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    logger.info('TRADER', '⏹️ Trading agent stopped');
  }

  /**
   * One iteration of the polling loop.
   */
  private async tick(): Promise<void> {
    // 1. Prune expired watchlist entries
    this.watchlist.pruneExpired();

    const entries = this.watchlist.getAll();
    if (entries.length === 0 && this.paperTrader.openCount === 0) {
      return; // Nothing to do
    }

    // 2. Fetch EMA data for all watchlisted symbols + open positions
    const symbolsToCheck = new Set<string>();
    for (const entry of entries) {
      symbolsToCheck.add(entry.symbol);
    }
    for (const pos of this.paperTrader.getOpenPositions()) {
      symbolsToCheck.add(pos.symbol);
    }

    if (symbolsToCheck.size === 0) return;

    const emaResults = await getEMADataBatch(Array.from(symbolsToCheck));

    // 3. Check for pullback setups on watchlisted coins
    for (const entry of entries) {
      // Skip if we already have a position on this coin
      if (this.paperTrader.hasPosition(entry.symbol)) continue;

      const emaData = emaResults.get(entry.symbol);
      if (!emaData) continue;

      const pullback = detectPullback(emaData, entry.direction);
      if (!pullback) continue;

      // 🎯 Pullback detected! Open a paper trade
      const trade = this.paperTrader.openTrade(
        pullback,
        entry.signalId,
        entry.convictionScore
      );

      if (trade) {
        // Save to SQLite
        this.storage.savePaperTrade(trade);

        // Remove from watchlist (we've entered the trade)
        this.watchlist.remove(entry.symbol, entry.direction);

        // Notify
        if (this.onTradeCallback) {
          this.onTradeCallback(trade, 'OPEN');
        }
      }
    }

    // 4. Check open positions against current prices (SL/TP management)
    const currentPrices = new Map<string, number>();
    for (const [symbol, emaData] of emaResults) {
      if (emaData.currentCandle) {
        currentPrices.set(symbol, emaData.currentCandle.close);
      } else if (emaData.candles.length > 0) {
        currentPrices.set(symbol, emaData.candles[emaData.candles.length - 1].close);
      }
    }

    const closedTrades = this.paperTrader.checkPositions(currentPrices);

    // Save and notify closed trades
    for (const trade of closedTrades) {
      this.storage.updatePaperTrade(
        trade.id,
        trade.exitPrice!,
        trade.exitTime!,
        trade.pnlPct!,
        trade.pnlUsd!,
        trade.status
      );

      if (this.onTradeCallback) {
        this.onTradeCallback(trade, 'CLOSE');
      }
    }
  }

  /**
   * Print a periodic status report to the console.
   */
  private printStatus(): void {
    const watchlistEntries = this.watchlist.getAll();
    const openPositions = this.paperTrader.getOpenPositions();
    const stats = this.paperTrader.getStats();

    if (watchlistEntries.length === 0 && openPositions.length === 0 && stats.totalTrades === 0) {
      return; // Nothing to report
    }

    console.log('\n\x1b[90m' + '─'.repeat(60) + '\x1b[0m');
    logger.info('TRADER', '🤖 PAPER TRADING STATUS');
    console.log('\x1b[90m' + '─'.repeat(60) + '\x1b[0m');

    // Watchlist
    if (watchlistEntries.length > 0) {
      logger.info('TRADER', `📋 Watchlist (${watchlistEntries.length} coins):`);
      for (const entry of watchlistEntries) {
        const ttl = Math.round((entry.expiresAt - Date.now()) / 3600_000);
        logger.info('TRADER', `   ${entry.symbol} ${entry.direction} — conviction: ${entry.convictionScore}/10, TTL: ${ttl}h`);
      }
    }

    // Open positions
    if (openPositions.length > 0) {
      logger.info('TRADER', `📊 Open Positions (${openPositions.length}):`);
      for (const pos of openPositions) {
        const duration = Math.round((Date.now() - pos.entryTime) / 60_000);
        const trailing = pos.trailingActivated ? ' [TRAILING]' : '';
        logger.info('TRADER', `   ${pos.symbol} ${pos.direction} @ $${pos.entryPrice} — SL: $${pos.stopLoss.toFixed(4)} TP: $${pos.takeProfit.toFixed(4)} (${duration}m)${trailing}`);
      }
    }

    // Stats
    if (stats.totalTrades > 0) {
      const pnlColor = stats.totalPnlUsd >= 0 ? '\x1b[32m' : '\x1b[31m';
      logger.info('TRADER', `📈 Performance: ${stats.wins}W / ${stats.losses}L / ${stats.breakevens}BE | WR: ${stats.winRate.toFixed(0)}% | P&L: ${pnlColor}$${stats.totalPnlUsd.toFixed(2)}\x1b[0m`);
    }

    console.log('\x1b[90m' + '─'.repeat(60) + '\x1b[0m\n');
  }
}
