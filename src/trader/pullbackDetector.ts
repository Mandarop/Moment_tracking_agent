// ============================================================
// before-move: Pullback Detector
//
// Detects when price pulls back to the 9/15 EMA zone and
// forms a confirmation candlestick pattern. This is the core
// of the "EMA Pullback" strategy.
//
// Supported patterns:
//   - Hammer / Pin Bar (long wick rejection off EMA)
//   - Bullish/Bearish Engulfing (momentum candle at EMA)
//   - Strong Rejection (clean close above/below EMA)
//
// All patterns are mirrored for bearish trends.
// ============================================================

import { logger } from '../utils/logger.js';
import type { Kline, EMAResult, Timeframe } from './emaCalculator.js';
import type { SignalDirection } from '../types.js';

export interface PullbackSignal {
  symbol: string;
  timeframe: Timeframe;
  direction: SignalDirection;
  pattern: 'HAMMER' | 'ENGULFING' | 'REJECTION';
  /** The confirmation candle that triggered the entry */
  confirmationCandle: Kline;
  /** The previous candle (used for engulfing comparison) */
  previousCandle: Kline;
  ema9: number;
  ema15: number;
  /** Suggested entry price (close of confirmation candle) */
  entryPrice: number;
  /** Suggested stop loss (below wick of confirmation candle) */
  stopLoss: number;
}

/**
 * Check if a candle is a Hammer/Pin Bar pattern.
 *
 * BULLISH Hammer:
 *   - Body is in the upper 40% of the candle
 *   - Lower wick is >= 2x the body size
 *   - Candle closes green (close > open) or near the top
 *
 * BEARISH Shooting Star (inverted hammer):
 *   - Body is in the lower 40% of the candle
 *   - Upper wick is >= 2x the body size
 */
function isHammer(candle: Kline, direction: SignalDirection): boolean {
  const body = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;

  if (totalRange === 0 || body === 0) return false;

  if (direction === 'BULLISH') {
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);

    // Lower wick must be >= 2x body, upper wick must be small
    return lowerWick >= body * 2 && upperWick < body * 0.5 && candle.close > candle.open;
  } else {
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;

    // Upper wick must be >= 2x body, lower wick must be small
    return upperWick >= body * 2 && lowerWick < body * 0.5 && candle.close < candle.open;
  }
}

/**
 * Check if current candle engulfs the previous candle.
 *
 * BULLISH Engulfing:
 *   - Previous candle is red (close < open)
 *   - Current candle is green (close > open)
 *   - Current body completely covers previous body
 *
 * BEARISH Engulfing: mirrored.
 */
function isEngulfing(current: Kline, previous: Kline, direction: SignalDirection): boolean {
  const currBody = Math.abs(current.close - current.open);
  const prevBody = Math.abs(previous.close - previous.open);

  if (currBody === 0 || prevBody === 0) return false;

  // Current body must be significantly larger than previous
  if (currBody < prevBody * 1.2) return false;

  if (direction === 'BULLISH') {
    // Previous must be red, current must be green
    if (previous.close >= previous.open) return false;
    if (current.close <= current.open) return false;

    // Current body engulfs previous body
    return current.open <= previous.close && current.close >= previous.open;
  } else {
    // Previous must be green, current must be red
    if (previous.close <= previous.open) return false;
    if (current.close >= current.open) return false;

    // Current body engulfs previous body
    return current.open >= previous.close && current.close <= previous.open;
  }
}

/**
 * Check for a strong rejection candle off the EMA.
 *
 * BULLISH Rejection:
 *   - Candle low touches or dips below the 15 EMA
 *   - Candle closes above the 9 EMA
 *   - Body ratio > 60% (clean, decisive candle)
 *   - Green candle
 *
 * BEARISH Rejection: mirrored.
 */
function isStrongRejection(
  candle: Kline,
  ema9: number,
  ema15: number,
  direction: SignalDirection
): boolean {
  const body = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;

  if (totalRange === 0) return false;

  const bodyRatio = body / totalRange;
  if (bodyRatio < 0.6) return false;

  if (direction === 'BULLISH') {
    // Low touched or dipped below 15 EMA, but closed above 9 EMA
    return candle.low <= ema15 * 1.002 && candle.close > ema9 && candle.close > candle.open;
  } else {
    // High touched or spiked above 15 EMA, but closed below 9 EMA
    return candle.high >= ema15 * 0.998 && candle.close < ema9 && candle.close < candle.open;
  }
}

/**
 * Calculate stop loss price based on the confirmation candle.
 * For BULLISH: below the low of the confirmation candle with a small buffer.
 * For BEARISH: above the high of the confirmation candle with a small buffer.
 */
function calculateStopLoss(candle: Kline, direction: SignalDirection): number {
  const buffer = Math.abs(candle.high - candle.low) * 0.1; // 10% of candle range as buffer

  if (direction === 'BULLISH') {
    return candle.low - buffer;
  } else {
    return candle.high + buffer;
  }
}

/**
 * Check if price is in the EMA pullback zone.
 *
 * BULLISH: Price was above both EMAs and has now dipped to touch or enter
 *          the zone between EMA9 and EMA15 (or slightly below EMA15).
 *
 * BEARISH: Mirrored — price was below and has bounced up into the zone.
 */
function isInPullbackZone(candle: Kline, ema9: number, ema15: number, direction: SignalDirection): boolean {
  if (direction === 'BULLISH') {
    // The EMA9 should be above EMA15 (uptrend structure)
    if (ema9 < ema15) return false;

    // Candle low must touch or enter the zone (within 0.3% of EMA15)
    const lowerBound = ema15 * 0.997;
    return candle.low <= ema9 && candle.low >= lowerBound;
  } else {
    // The EMA9 should be below EMA15 (downtrend structure)
    if (ema9 > ema15) return false;

    // Candle high must touch or enter the zone (within 0.3% of EMA15)
    const upperBound = ema15 * 1.003;
    return candle.high >= ema9 && candle.high <= upperBound;
  }
}

/**
 * Main detection function.
 * Checks the latest EMA data for a pullback + candlestick confirmation.
 * Returns a PullbackSignal if a trade setup is detected, or null.
 */
export function detectPullback(emaData: EMAResult, direction: SignalDirection): PullbackSignal | null {
  const { symbol, ema9, ema15, candles } = emaData;

  if (candles.length < 2) return null;

  // Use the last closed candle as the confirmation candidate
  const confirmCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  // Step 1: Is the candle in the EMA pullback zone?
  if (!isInPullbackZone(confirmCandle, ema9, ema15, direction)) {
    return null;
  }

  // Step 2: Check for confirmation patterns (try each one)
  let pattern: PullbackSignal['pattern'] | null = null;

  if (isHammer(confirmCandle, direction)) {
    pattern = 'HAMMER';
  } else if (isEngulfing(confirmCandle, prevCandle, direction)) {
    pattern = 'ENGULFING';
  } else if (isStrongRejection(confirmCandle, ema9, ema15, direction)) {
    pattern = 'REJECTION';
  }

  if (!pattern) return null;

  const entryPrice = confirmCandle.close;
  const stopLoss = calculateStopLoss(confirmCandle, direction);

  logger.signal('PULLBACK', `🎯 ${direction} pullback detected on ${symbol}!`, {
    pattern,
    entry: entryPrice.toString(),
    stopLoss: stopLoss.toString(),
    ema9: ema9.toFixed(4),
    ema15: ema15.toFixed(4),
  });

  return {
    symbol,
    timeframe: emaData.timeframe,
    direction,
    pattern,
    confirmationCandle: confirmCandle,
    previousCandle: prevCandle,
    ema9,
    ema15,
    entryPrice,
    stopLoss,
  };
}
