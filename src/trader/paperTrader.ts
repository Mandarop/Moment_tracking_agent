// ============================================================
// before-move: Paper Trader
//
// Manages simulated positions with entry, stop-loss, take-profit,
// and P&L tracking. No real money is involved.
//
// Position sizing: $10,000 paper balance, 2% risk per trade.
// Risk-Reward: 1:2 (TP = 2× the SL distance).
// Trailing stop: Once 1.5% in profit, move SL to breakeven.
// ============================================================

import { logger } from '../utils/logger.js';
import type { SignalDirection } from '../types.js';
import type { PullbackSignal } from './pullbackDetector.js';
import type { Timeframe } from './emaCalculator.js';
import type { Storage } from '../db/storage.js';

/** Paper trading configuration */
const RISK_PER_TRADE_PCT = 2;   // Risk 2% of balance per trade
const RISK_REWARD_RATIO = 1.5;  // 1:1.5 risk-reward
const TRAILING_STOP_TRIGGER = 1.5; // Move SL to breakeven when 1.5% in profit
const MAX_OPEN_POSITIONS = 5;   // Don't overexpose

export interface PaperTrade {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: SignalDirection;
  entryPrice: number;
  stopLoss: number;
  originalStopLoss: number;
  takeProfit: number;
  positionSizeUsd: number;
  entryTime: number;
  exitPrice: number | null;
  exitTime: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  status: 'OPEN' | 'WIN' | 'LOSS' | 'BREAKEVEN';
  triggerSignalId: string;
  convictionScore: number;
  pattern: string;
  trailingActivated: boolean;
}

/**
 * Generate a unique trade ID.
 */
function generateTradeId(symbol: string, timeframe: Timeframe): string {
  return `PAPER:${symbol}:${timeframe}:${Date.now()}`;
}

export class PaperTrader {
  private timeframe: Timeframe;
  private storage: Storage;
  private balance: number = 10_000;
  private openPositions: Map<string, PaperTrade> = new Map();
  private closedTrades: PaperTrade[] = [];
  private consecutiveLosses: Map<string, number> = new Map();

  constructor(timeframe: Timeframe, storage: Storage) {
    this.timeframe = timeframe;
    this.storage = storage;
    this.initFromDatabase();
  }

  /**
   * Load previous closed trades and open trades from SQLite
   * to restore account state and balance.
   */
  private initFromDatabase(): void {
    try {
      const closed = this.storage.getPaperTradesForTimeframe(this.timeframe, false);
      const closedPnl = closed.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
      this.balance = 10_000 + closedPnl;
      this.closedTrades = closed;

      // Reconstruct consecutive losses per symbol
      // Sort trades from oldest to newest to replay the sequence
      const sortedClosed = [...closed].sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0));
      for (const t of sortedClosed) {
        if (t.status === 'LOSS') {
          const current = this.consecutiveLosses.get(t.symbol) || 0;
          this.consecutiveLosses.set(t.symbol, current + 1);
        } else if (t.status === 'WIN') {
          this.consecutiveLosses.set(t.symbol, 0);
        }
      }

      const open = this.storage.getPaperTradesForTimeframe(this.timeframe, true);
      for (const trade of open) {
        this.openPositions.set(trade.symbol, trade);
      }

      logger.info('PAPER', `🤖 Restored [${this.timeframe}m] paper trading account:`);
      logger.info('PAPER', `   Simulated Capital: $${this.balance.toFixed(2)}`);
      logger.info('PAPER', `   Positions: ${this.openPositions.size} open | ${this.closedTrades.length} closed`);
    } catch (err) {
      logger.error('PAPER', `Failed to initialize [${this.timeframe}m] trader from DB`, { error: String(err) });
    }
  }

  /**
   * Open a new paper trade based on a pullback signal.
   * Returns the trade if opened, or null if blocked (max positions, etc.)
   */
  openTrade(
    pullback: PullbackSignal,
    signalId: string,
    convictionScore: number
  ): PaperTrade | null {
    // Block if max open positions reached
    if (this.openPositions.size >= MAX_OPEN_POSITIONS) {
      logger.warn('PAPER', `⛔ Max open positions (${MAX_OPEN_POSITIONS}) reached for ${this.timeframe}m chart. Skipping ${pullback.symbol}.`);
      return null;
    }

    // Block if already have a position on this symbol
    if (this.openPositions.has(pullback.symbol)) {
      logger.warn('PAPER', `⛔ Already have an open position on ${pullback.symbol} (${this.timeframe}m). Skipping.`);
      return null;
    }

    const { entryPrice, stopLoss, direction, symbol, pattern, timeframe } = pullback;

    // Calculate position size based on current capital balance risk
    const riskAmount = this.balance * (RISK_PER_TRADE_PCT / 100);
    const slDistance = Math.abs(entryPrice - stopLoss);
    const slDistancePct = (slDistance / entryPrice) * 100;

    if (slDistancePct === 0 || slDistancePct > 5) {
      logger.warn('PAPER', `⛔ Invalid SL distance for ${symbol}: ${slDistancePct.toFixed(2)}%. Skipping.`);
      return null;
    }

    const positionSizeUsd = riskAmount / (slDistancePct / 100);

    // Calculate Take Profit (2x risk-reward)
    let takeProfit: number;
    if (direction === 'BULLISH') {
      takeProfit = entryPrice + (slDistance * RISK_REWARD_RATIO);
    } else {
      takeProfit = entryPrice - (slDistance * RISK_REWARD_RATIO);
    }

    const trade: PaperTrade = {
      id: generateTradeId(symbol, timeframe),
      symbol,
      timeframe,
      direction,
      entryPrice,
      stopLoss,
      originalStopLoss: stopLoss,
      takeProfit,
      positionSizeUsd,
      entryTime: Date.now(),
      exitPrice: null,
      exitTime: null,
      pnlPct: null,
      pnlUsd: null,
      status: 'OPEN',
      triggerSignalId: signalId,
      convictionScore,
      pattern,
      trailingActivated: false,
    };

    this.openPositions.set(symbol, trade);

    logger.signal('PAPER', `📝 PAPER TRADE OPENED: ${direction} ${symbol} (${timeframe}m)`, {
      entry: `$${entryPrice}`,
      stopLoss: `$${stopLoss.toFixed(4)}`,
      takeProfit: `$${takeProfit.toFixed(4)}`,
      risk: `$${riskAmount.toFixed(2)}`,
      size: `$${positionSizeUsd.toFixed(0)}`,
      pattern,
      rr: `1:${RISK_REWARD_RATIO}`,
    });

    return trade;
  }

  /**
   * Check all open positions against current prices.
   * Close positions that hit SL or TP. Apply trailing stop logic.
   *
   * @param currentPrices Map of symbol → current price
   * @returns Array of trades that were closed this tick
   */
  checkPositions(currentPrices: Map<string, number>): PaperTrade[] {
    const closedThisTick: PaperTrade[] = [];

    for (const [symbol, trade] of this.openPositions) {
      const price = currentPrices.get(symbol);
      if (!price) continue;

      // Check for trailing stop activation
      if (!trade.trailingActivated) {
        const profitPct = trade.direction === 'BULLISH'
          ? ((price - trade.entryPrice) / trade.entryPrice) * 100
          : ((trade.entryPrice - price) / trade.entryPrice) * 100;

        if (profitPct >= TRAILING_STOP_TRIGGER) {
          // Move SL to breakeven
          trade.stopLoss = trade.entryPrice;
          trade.trailingActivated = true;
          logger.info('PAPER', `🔒 Trailing stop activated for ${trade.symbol} (${trade.timeframe}m) — SL moved to breakeven ($${trade.entryPrice})`);
        }
      }

      // Check Stop Loss
      let slHit = false;
      if (trade.direction === 'BULLISH' && price <= trade.stopLoss) {
        slHit = true;
      } else if (trade.direction === 'BEARISH' && price >= trade.stopLoss) {
        slHit = true;
      }

      // Check Take Profit
      let tpHit = false;
      if (trade.direction === 'BULLISH' && price >= trade.takeProfit) {
        tpHit = true;
      } else if (trade.direction === 'BEARISH' && price <= trade.takeProfit) {
        tpHit = true;
      }

      if (slHit || tpHit) {
        const exitPrice = tpHit ? trade.takeProfit : trade.stopLoss;
        this.closeTrade(trade, exitPrice, tpHit);
        closedThisTick.push(trade);
      }
    }

    return closedThisTick;
  }

  /**
   * Close a trade and calculate P&L.
   */
  private closeTrade(trade: PaperTrade, exitPrice: number, isWin: boolean): void {
    trade.exitPrice = exitPrice;
    trade.exitTime = Date.now();

    // Calculate P&L
    if (trade.direction === 'BULLISH') {
      trade.pnlPct = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
    } else {
      trade.pnlPct = ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100;
    }
    trade.pnlUsd = trade.positionSizeUsd * (trade.pnlPct / 100);

    // Update account balance
    this.balance += trade.pnlUsd;

    // Determine status
    if (trade.trailingActivated && trade.stopLoss === trade.entryPrice && !isWin) {
      trade.status = 'BREAKEVEN';
    } else {
      trade.status = isWin ? 'WIN' : 'LOSS';
    }

    // Track consecutive losses
    if (trade.status === 'LOSS') {
      const current = this.consecutiveLosses.get(trade.symbol) || 0;
      this.consecutiveLosses.set(trade.symbol, current + 1);
    } else if (trade.status === 'WIN') {
      this.consecutiveLosses.set(trade.symbol, 0);
    }

    // Remove from open, add to closed
    this.openPositions.delete(trade.symbol);
    this.closedTrades.push(trade);

    const emoji = trade.status === 'WIN' ? '✅' : trade.status === 'BREAKEVEN' ? '🔄' : '❌';
    logger.signal('PAPER', `${emoji} PAPER TRADE CLOSED: ${trade.status} on ${trade.symbol} (${trade.timeframe}m)`, {
      entry: `$${trade.entryPrice}`,
      exit: `$${exitPrice.toFixed(4)}`,
      pnl: `${trade.pnlPct!.toFixed(2)}% ($${trade.pnlUsd!.toFixed(2)})`,
      balance: `$${this.balance.toFixed(2)}`,
      duration: `${((trade.exitTime - trade.entryTime) / 60_000).toFixed(0)} min`,
    });
  }

  /**
   * Get all open positions.
   */
  getOpenPositions(): PaperTrade[] {
    return Array.from(this.openPositions.values());
  }

  /**
   * Get all closed trades.
   */
  getClosedTrades(): PaperTrade[] {
    return this.closedTrades;
  }

  /**
   * Get summary statistics for all closed trades.
   */
  getStats(): { totalTrades: number; wins: number; losses: number; breakevens: number; totalPnlUsd: number; winRate: number; balance: number } {
    const wins = this.closedTrades.filter(t => t.status === 'WIN').length;
    const losses = this.closedTrades.filter(t => t.status === 'LOSS').length;
    const breakevens = this.closedTrades.filter(t => t.status === 'BREAKEVEN').length;
    const totalPnlUsd = this.closedTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const winRate = this.closedTrades.length > 0 ? (wins / this.closedTrades.length) * 100 : 0;

    return {
      totalTrades: this.closedTrades.length,
      wins,
      losses,
      breakevens,
      totalPnlUsd,
      winRate,
      balance: this.balance,
    };
  }

  /**
   * Check if a position is open for a given symbol.
   */
  hasPosition(symbol: string): boolean {
    return this.openPositions.has(symbol);
  }

  get openCount(): number {
    return this.openPositions.size;
  }

  /**
   * Check if a symbol has hit 3 consecutive stop losses
   */
  hasHitMaxLosses(symbol: string): boolean {
    return (this.consecutiveLosses.get(symbol) || 0) >= 3;
  }
}
