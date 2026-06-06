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
import { getEMADataBatch, ALL_TIMEFRAMES } from './emaCalculator.js';
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
    logger.info('TRADER', '   Strategy: EMA Pullback (9/15 EMA on 3m, 5m, and 15m charts)');
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
    const openPositions = this.paperTrader.getOpenPositions();

    if (entries.length === 0 && openPositions.length === 0) {
      return; // Nothing to do
    }

    // Map to accumulate the latest prices of symbols (across checked timeframes) for checking positions
    const currentPrices = new Map<string, number>();

    // 2. Process each timeframe independently
    for (const timeframe of ALL_TIMEFRAMES) {
      const symbolsToCheck = new Set<string>();

      // Watchlisted symbols that haven't triggered a trade on this timeframe yet
      for (const entry of entries) {
        const triggered = entry.triggeredTimeframes || [];
        if (!triggered.includes(timeframe) && !this.paperTrader.hasPosition(entry.symbol, timeframe)) {
          symbolsToCheck.add(entry.symbol);
        }
      }

      // Symbols with active positions on this timeframe
      for (const pos of openPositions) {
        if (pos.timeframe === timeframe) {
          symbolsToCheck.add(pos.symbol);
        }
      }

      if (symbolsToCheck.size === 0) continue;

      logger.debug('TRADER', `Fetching klines & EMAs for ${symbolsToCheck.size} symbols on ${timeframe}m chart...`);
      const emaResults = await getEMADataBatch(Array.from(symbolsToCheck), timeframe);

      // Check setups for watchlisted coins
      for (const entry of entries) {
        const triggered = entry.triggeredTimeframes || [];
        if (triggered.includes(timeframe)) continue;
        if (this.paperTrader.hasPosition(entry.symbol, timeframe)) continue;

        const emaData = emaResults.get(entry.symbol);
        if (!emaData) continue;

        const pullback = detectPullback(emaData, entry.direction);
        if (!pullback) continue;

        // 🎯 Pullback detected on this timeframe! Open a paper trade
        const trade = this.paperTrader.openTrade(
          pullback,
          entry.signalId,
          entry.convictionScore
        );

        if (trade) {
          // Save to SQLite
          this.storage.savePaperTrade(trade);

          // Mark as triggered for this watchlist entry
          entry.triggeredTimeframes = triggered;
          entry.triggeredTimeframes.push(timeframe);

          // If triggered on all 3 timeframes, remove from watchlist
          if (entry.triggeredTimeframes.length === ALL_TIMEFRAMES.length) {
            this.watchlist.remove(entry.symbol, entry.direction);
            logger.info('WATCHLIST', `🔥 Removed ${entry.symbol} ${entry.direction} — triggered on all timeframes (3m, 5m, 15m)`);
          }

          // Notify
          if (this.onTradeCallback) {
            this.onTradeCallback(trade, 'OPEN');
          }
        }
      }

      // Track the latest price of each symbol from this timeframe's data
      for (const [symbol, emaData] of emaResults) {
        if (emaData.currentCandle) {
          currentPrices.set(symbol, emaData.currentCandle.close);
        } else if (emaData.candles.length > 0) {
          currentPrices.set(symbol, emaData.candles[emaData.candles.length - 1].close);
        }
      }

      // Pause briefly to respect rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    // 3. Manage open positions using latest prices
    if (currentPrices.size > 0) {
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
  }

  /**
   * Print a periodic status report to the console.
   */
  private printStatus(): void {
    const watchlistEntries = this.watchlist.getAll();
    const openPositions = this.paperTrader.getOpenPositions();
    const closedTrades = this.paperTrader.getClosedTrades();
    const stats = this.paperTrader.getStats();

    if (watchlistEntries.length === 0 && openPositions.length === 0 && stats.totalTrades === 0) {
      return; // Nothing to report
    }

    console.log('\n\x1b[90m' + '─'.repeat(60) + '\x1b[0m');
    logger.info('TRADER', '🤖 PAPER TRADING STATUS REPORT');
    console.log('\x1b[90m' + '─'.repeat(60) + '\x1b[0m');

    // Watchlist
    if (watchlistEntries.length > 0) {
      logger.info('TRADER', `📋 Watchlist (${watchlistEntries.length} coins):`);
      for (const entry of watchlistEntries) {
        const ttl = Math.round((entry.expiresAt - Date.now()) / 3600_000);
        const triggeredStr = entry.triggeredTimeframes && entry.triggeredTimeframes.length > 0
          ? ` (Triggered: ${entry.triggeredTimeframes.map(tf => tf + 'm').join(', ')})`
          : '';
        logger.info('TRADER', `   ${entry.symbol} ${entry.direction} — conviction: ${entry.convictionScore}/10, TTL: ${ttl}h${triggeredStr}`);
      }
    }

    // Open positions
    if (openPositions.length > 0) {
      logger.info('TRADER', `📊 Open Positions (${openPositions.length}):`);
      for (const pos of openPositions) {
        const duration = Math.round((Date.now() - pos.entryTime) / 60_000);
        const trailing = pos.trailingActivated ? ' [TRAILING]' : '';
        logger.info('TRADER', `   ${pos.symbol} (${pos.timeframe}m) ${pos.direction} @ $${pos.entryPrice} — SL: $${pos.stopLoss.toFixed(4)} TP: $${pos.takeProfit.toFixed(4)} (${duration}m)${trailing}`);
      }
    }

    // Performance per timeframe
    if (stats.totalTrades > 0) {
      logger.info('TRADER', `📈 Performance Breakdown:`);
      
      const timeframes: ('3' | '5' | '15')[] = ['3', '5', '15'];
      for (const tf of timeframes) {
        const tfTrades = closedTrades.filter(t => t.timeframe === tf);
        if (tfTrades.length === 0) continue;

        const wins = tfTrades.filter(t => t.status === 'WIN').length;
        const losses = tfTrades.filter(t => t.status === 'LOSS').length;
        const breakevens = tfTrades.filter(t => t.status === 'BREAKEVEN').length;
        const totalPnlUsd = tfTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winRate = (wins / tfTrades.length) * 100;
        const pnlColor = totalPnlUsd >= 0 ? '\x1b[32m' : '\x1b[31m';

        logger.info('TRADER', `   [${tf}m Chart]: ${wins}W / ${losses}L / ${breakevens}BE | WR: ${winRate.toFixed(0)}% | P&L: ${pnlColor}$${totalPnlUsd.toFixed(2)}\x1b[0m`);
      }

      const globalPnlColor = stats.totalPnlUsd >= 0 ? '\x1b[32m' : '\x1b[31m';
      logger.info('TRADER', `   [GLOBAL TOTAL]: ${stats.wins}W / ${stats.losses}L / ${stats.breakevens}BE | WR: ${stats.winRate.toFixed(0)}% | P&L: ${globalPnlColor}$${stats.totalPnlUsd.toFixed(2)}\x1b[0m`);
    }

    console.log('\x1b[90m' + '─'.repeat(60) + '\x1b[0m\n');
  }
}
