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

/** Paper trading configuration */
const PAPER_BALANCE = 10_000;   // $10,000 simulated balance
const RISK_PER_TRADE_PCT = 2;   // Risk 2% of balance per trade
const RISK_REWARD_RATIO = 2;    // 1:2 risk-reward
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
  private openPositions: Map<string, PaperTrade> = new Map();
  private closedTrades: PaperTrade[] = [];

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
      logger.warn('PAPER', `⛔ Max open positions (${MAX_OPEN_POSITIONS}) reached. Skipping ${pullback.symbol} (${pullback.timeframe}m).`);
      return null;
    }

    const key = `${pullback.symbol}:${pullback.timeframe}`;

    // Block if already have a position on this symbol and timeframe
    if (this.openPositions.has(key)) {
      logger.warn('PAPER', `⛔ Already have an open position on ${pullback.symbol} (${pullback.timeframe}m). Skipping.`);
      return null;
    }

    const { entryPrice, stopLoss, direction, symbol, pattern, timeframe } = pullback;

    // Calculate position size based on risk
    const riskAmount = PAPER_BALANCE * (RISK_PER_TRADE_PCT / 100); // $200
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

    this.openPositions.set(key, trade);

    logger.signal('PAPER', `📝 PAPER TRADE OPENED: ${direction} ${symbol} (${timeframe}m)`, {
      entry: `$${entryPrice}`,
      stopLoss: `$${stopLoss.toFixed(4)}`,
      takeProfit: `$${takeProfit.toFixed(4)}`,
      risk: `$${riskAmount.toFixed(0)}`,
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

    for (const [, trade] of this.openPositions) {
      const price = currentPrices.get(trade.symbol);
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

    // Determine status
    if (trade.trailingActivated && trade.stopLoss === trade.entryPrice && !isWin) {
      trade.status = 'BREAKEVEN';
    } else {
      trade.status = isWin ? 'WIN' : 'LOSS';
    }

    // Remove from open, add to closed
    this.openPositions.delete(`${trade.symbol}:${trade.timeframe}`);
    this.closedTrades.push(trade);

    const emoji = trade.status === 'WIN' ? '✅' : trade.status === 'BREAKEVEN' ? '🔄' : '❌';
    logger.signal('PAPER', `${emoji} PAPER TRADE CLOSED: ${trade.status} on ${trade.symbol} (${trade.timeframe}m)`, {
      entry: `$${trade.entryPrice}`,
      exit: `$${exitPrice.toFixed(4)}`,
      pnl: `${trade.pnlPct!.toFixed(2)}% ($${trade.pnlUsd!.toFixed(2)})`,
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
  getStats(): { totalTrades: number; wins: number; losses: number; breakevens: number; totalPnlUsd: number; winRate: number } {
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
    };
  }

  /**
   * Check if a position is open for a given symbol and timeframe.
   */
  hasPosition(symbol: string, timeframe: Timeframe): boolean {
    return this.openPositions.has(`${symbol}:${timeframe}`);
  }

  get openCount(): number {
    return this.openPositions.size;
  }
}
