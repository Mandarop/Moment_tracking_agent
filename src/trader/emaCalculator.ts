// ============================================================
// before-move: EMA Calculator
//
// Fetches klines from Bybit REST API for multiple timeframes
// (3m, 5m, 15m) and calculates the 9 EMA and 15 EMA.
// Returns the current EMA values and the last few closed
// candles for pattern detection.
//
// EMA Formula: EMA = price × k + previousEMA × (1 - k)
// where k = 2 / (period + 1)
// ============================================================

import { logger } from '../utils/logger.js';

const BYBIT_REST = 'https://api.bybit.com';

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Supported timeframes for the EMA pullback strategy */
export type Timeframe = '3' | '5' | '15';

export const ALL_TIMEFRAMES: Timeframe[] = ['3', '5', '15'];

/** Human-readable labels for timeframes */
export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  '3': '3m',
  '5': '5m',
  '15': '15m',
};

export interface EMAResult {
  symbol: string;
  timeframe: Timeframe;
  ema9: number;
  ema15: number;
  ema50: number;
  /** Last 5 closed candles (newest last) for pattern detection */
  candles: Kline[];
  /** Current (possibly unclosed) candle */
  currentCandle: Kline | null;
  timestamp: number;
}

/**
 * Calculate EMA from an array of closing prices.
 * Prices should be ordered oldest → newest.
 */
function calculateEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) {
    // Not enough data — fall back to SMA
    const sum = closes.reduce((a, b) => a + b, 0);
    return sum / closes.length;
  }

  const k = 2 / (period + 1);

  // Seed with SMA of the first `period` values
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += closes[i];
  }
  ema /= period;

  // Apply EMA formula for the remaining values
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Fetch klines from Bybit for a given timeframe and calculate 9/15 EMA.
 * Returns null if the API call fails.
 */
export async function getEMAData(symbol: string, interval: Timeframe = '15'): Promise<EMAResult | null> {
  try {
    // Fetch 200 candles — enough for accurate 50 EMA calculation
    const url = `${BYBIT_REST}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=200`;
    const res = await fetch(url);
    const data = await res.json() as any;

    if (!data?.result?.list || data.result.list.length === 0) {
      logger.warn('EMA', `No kline data for ${symbol} (${interval}m)`);
      return null;
    }

    // Bybit returns newest first — reverse to oldest first
    const rawList: string[][] = data.result.list.reverse();

    const klines: Kline[] = rawList.map((k: string[]) => ({
      openTime: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    if (klines.length < 50) {
      logger.warn('EMA', `Not enough klines for ${symbol} ${interval}m (${klines.length} < 50)`);
      return null;
    }

    // The last candle may be unclosed — separate it
    const currentCandle = klines[klines.length - 1];
    const closedCandles = klines.slice(0, -1);

    // Calculate EMAs using closed candle closes
    const closes = closedCandles.map(k => k.close);
    const ema9 = calculateEMA(closes, 9);
    const ema15 = calculateEMA(closes, 15);
    const ema50 = calculateEMA(closes, 50);

    // Return last 5 closed candles for pattern detection
    const recentCandles = closedCandles.slice(-5);

    return {
      symbol,
      timeframe: interval,
      ema9,
      ema15,
      ema50,
      candles: recentCandles,
      currentCandle,
      timestamp: Date.now(),
    };
  } catch (err) {
    logger.error('EMA', `Failed to fetch klines for ${symbol} (${interval}m)`, { error: String(err) });
    return null;
  }
}

/**
 * Calculate the EMA values for multiple symbols in parallel for a specific timeframe.
 * Processes in chunks to respect rate limits.
 */
export async function getEMADataBatch(symbols: string[], interval: Timeframe = '15'): Promise<Map<string, EMAResult>> {
  const results = new Map<string, EMAResult>();
  const chunkSize = 5;

  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const promises = chunk.map(async (symbol) => {
      const result = await getEMAData(symbol, interval);
      if (result) {
        results.set(symbol, result);
      }
    });
    await Promise.all(promises);

    // Slight pause between chunks to respect rate limits
    if (i + chunkSize < symbols.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return results;
}
