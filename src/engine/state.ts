// ============================================================
// before-move: State Aggregator (The Brain)
//
// Processes raw ticks into actionable aggregated state:
//   - Groups trades into 1-minute volume buckets
//   - Tracks Cumulative Volume Delta (CVD)
//   - Maintains rolling OI snapshots
//   - Provides query methods for the Anomaly Detector
//
// This is a ring-buffer architecture: we keep N minutes in
// memory and discard older data to prevent memory leaks.
// ============================================================

import { logger } from '../utils/logger.js';
import type {
  VolumeBucket,
  SymbolState,
  ProcessedTrade,
  ProcessedLiquidation,
} from '../types.js';

/** Floor a timestamp to the start of its minute */
function floorToMinute(ts: number): number {
  return Math.floor(ts / 60_000) * 60_000;
}

export class StateAggregator {
  /** State keyed by symbol (e.g., 'BTCUSDT') */
  private state: Map<string, SymbolState> = new Map();

  /** How many minutes of bucket history to retain */
  private maxBuckets: number;

  /** How many OI snapshots to retain */
  private maxOiSnapshots: number;

  constructor(symbols: string[], rollingWindowMinutes: number) {
    this.maxBuckets = rollingWindowMinutes;
    // Bybit streams ticker every 100ms, so ~600/min. Keep generous buffer.
    this.maxOiSnapshots = rollingWindowMinutes * 15;

    for (const symbol of symbols) {
      this.state.set(symbol.toUpperCase(), {
        symbol: symbol.toUpperCase(),
        lastPrice: 0,
        markPrice: 0,
        fundingRate: 0,
        cumulativeDelta: 0,
        buckets: [],
        oiSnapshots: [],
        lastUpdate: 0,
      });
    }

    logger.info('STATE', `Initialized state aggregator`, {
      symbols: symbols.join(', '),
      rollingWindow: `${rollingWindowMinutes}m`,
      maxBuckets: this.maxBuckets,
    });
  }

  /**
   * Process a single trade (exchange-agnostic).
   * Called from the adapter layer which normalizes exchange-specific formats.
   */
  processTrade(
    symbol: string,
    price: number,
    quantity: number,
    isBuyerAggressor: boolean,
    timestamp: number
  ): ProcessedTrade {
    const quoteQty = price * quantity;

    const trade: ProcessedTrade = {
      symbol,
      price,
      quantity,
      quoteQuantity: quoteQty,
      isBuyerAggressor,
      timestamp,
    };

    const state = this.state.get(symbol);
    if (!state) return trade;

    // Update last price
    state.lastPrice = price;
    state.lastUpdate = timestamp;

    // Update CVD (cumulative delta for the entire session)
    if (isBuyerAggressor) {
      state.cumulativeDelta += quoteQty;
    } else {
      state.cumulativeDelta -= quoteQty;
    }

    // Get or create the current 1-minute bucket
    const bucketTime = floorToMinute(timestamp);
    let bucket = state.buckets[state.buckets.length - 1];

    if (!bucket || bucket.openTime !== bucketTime) {
      // New minute — create a new bucket
      bucket = {
        symbol,
        openTime: bucketTime,
        closeTime: bucketTime + 60_000,
        open: price,
        high: price,
        low: price,
        close: price,
        totalVolume: 0,
        totalQuoteVolume: 0,
        buyVolume: 0,
        sellVolume: 0,
        delta: 0,
        tradeCount: 0,
        longLiquidations: 0,
        shortLiquidations: 0,
      };
      state.buckets.push(bucket);

      // Trim old buckets (ring buffer)
      if (state.buckets.length > this.maxBuckets) {
        state.buckets.shift();
      }
    }

    // Update bucket OHLCV
    bucket.high = Math.max(bucket.high, price);
    bucket.low = Math.min(bucket.low, price);
    bucket.close = price;
    bucket.totalVolume += quantity;
    bucket.totalQuoteVolume += quoteQty;
    bucket.tradeCount++;

    if (isBuyerAggressor) {
      bucket.buyVolume += quoteQty;
    } else {
      bucket.sellVolume += quoteQty;
    }
    bucket.delta = bucket.buyVolume - bucket.sellVolume;

    return trade;
  }

  /**
   * Process a liquidation event (exchange-agnostic).
   */
  processLiquidation(
    symbol: string,
    side: 'LONG' | 'SHORT',
    quantity: number,
    price: number,
    timestamp: number
  ): ProcessedLiquidation {
    const usdValue = price * quantity;

    const liq: ProcessedLiquidation = {
      symbol,
      side,
      quantity,
      price,
      usdValue,
      timestamp,
    };

    const state = this.state.get(symbol);
    if (!state) return liq;

    // Add to current bucket
    const bucketTime = floorToMinute(timestamp);
    const bucket = state.buckets[state.buckets.length - 1];
    if (bucket && bucket.openTime === bucketTime) {
      if (side === 'LONG') {
        bucket.longLiquidations += usdValue;
      } else {
        bucket.shortLiquidations += usdValue;
      }
    }

    if (usdValue > 100_000) {
      logger.warn('STATE', `🔥 Large ${side} liquidation`, {
        symbol,
        usdValue: `$${(usdValue / 1000).toFixed(0)}K`,
        price: price.toFixed(2),
      });
    }

    return liq;
  }

  /** Update mark price and funding rate from ticker */
  updateTickerInfo(symbol: string, markPrice: number, fundingRate: number): void {
    const state = this.state.get(symbol);
    if (!state) return;
    state.markPrice = markPrice;
    state.fundingRate = fundingRate;
  }

  /** Process an OI update from the REST poller */
  processOiUpdate(symbol: string, openInterest: number, timestamp: number): void {
    const state = this.state.get(symbol);
    if (!state) return;

    state.oiSnapshots.push({ symbol, openInterest, timestamp });

    // Trim old snapshots (ring buffer)
    if (state.oiSnapshots.length > this.maxOiSnapshots) {
      state.oiSnapshots.shift();
    }
  }

  // ===== MACRO TRACKING (Injected on Boot) =====

  /** Inject historical baselines fetched from REST API */
  setHistoricalBaselines(symbol: string, oi4h: number, oi24h: number, price4h: number, price24h: number): void {
    const state = this.state.get(symbol);
    if (!state) return;
    state.historicalBaselines = {
      oi4hAgo: oi4h,
      oi24hAgo: oi24h,
      price4hAgo: price4h,
      price24hAgo: price24h,
    };
  }

  /** Get macro OI change (4h or 24h) */
  getMacroOiChangePct(symbol: string, period: '4h' | '24h'): number {
    const state = this.state.get(symbol);
    if (!state || !state.historicalBaselines) return 0;
    
    // Use the latest OI snapshot as current
    if (state.oiSnapshots.length === 0) return 0;
    const currentOi = state.oiSnapshots[state.oiSnapshots.length - 1].openInterest;
    
    const baseline = period === '4h' ? state.historicalBaselines.oi4hAgo : state.historicalBaselines.oi24hAgo;
    if (baseline === 0) return 0;

    return ((currentOi - baseline) / baseline) * 100;
  }

  /** Get macro Price change (4h or 24h) */
  getMacroPriceChangePct(symbol: string, period: '4h' | '24h'): number {
    const state = this.state.get(symbol);
    if (!state || !state.historicalBaselines || state.lastPrice === 0) return 0;

    const baseline = period === '4h' ? state.historicalBaselines.price4hAgo : state.historicalBaselines.price24hAgo;
    if (baseline === 0) return 0;

    return ((state.lastPrice - baseline) / baseline) * 100;
  }

  // ===== QUERY METHODS (used by Anomaly Detector) =====

  /** Get the full state for a symbol */
  getState(symbol: string): SymbolState | undefined {
    return this.state.get(symbol);
  }

  /** Get all symbols being tracked */
  getSymbols(): string[] {
    return Array.from(this.state.keys());
  }

  /** Get the last N minutes of buckets for a symbol */
  getRecentBuckets(symbol: string, minutes: number): VolumeBucket[] {
    const state = this.state.get(symbol);
    if (!state) return [];
    return state.buckets.slice(-minutes);
  }

  /** Get the price range (high-low as %) over the last N minutes */
  getPriceRangePct(symbol: string, minutes: number): number {
    const candle = this.getRecentCandle(symbol, minutes);
    if (!candle || candle.low === 0) return 0;
    return ((candle.high - candle.low) / candle.low) * 100;
  }

  /** Get a synthesized OHLC candle for the last N minutes */
  getRecentCandle(symbol: string, minutes: number): { open: number; high: number; low: number; close: number } | null {
    const buckets = this.getRecentBuckets(symbol, minutes);
    if (buckets.length === 0) return null;

    let high = -Infinity;
    let low = Infinity;
    for (const b of buckets) {
      high = Math.max(high, b.high);
      low = Math.min(low, b.low);
    }

    return {
      open: buckets[0].open,
      high,
      low,
      close: buckets[buckets.length - 1].close
    };
  }

  /** Get the net delta (buy - sell volume in USD) over the last N minutes */
  getNetDelta(symbol: string, minutes: number): number {
    const buckets = this.getRecentBuckets(symbol, minutes);
    let netDelta = 0;
    for (const b of buckets) {
      netDelta += b.delta;
    }
    return netDelta;
  }

  /** Get total volume (USD) over the last N minutes */
  getTotalVolume(symbol: string, minutes: number): number {
    const buckets = this.getRecentBuckets(symbol, minutes);
    let total = 0;
    for (const b of buckets) {
      total += b.totalQuoteVolume;
    }
    return total;
  }

  /** Get the OI change % over the last N minutes */
  getOiChangePct(symbol: string, minutes: number): number {
    const state = this.state.get(symbol);
    if (!state || state.oiSnapshots.length < 2) return 0;

    const now = Date.now();
    const cutoff = now - minutes * 60_000;

    // Find the oldest snapshot within the window
    const oldSnapshot = state.oiSnapshots.find(s => s.timestamp >= cutoff);
    const currentSnapshot = state.oiSnapshots[state.oiSnapshots.length - 1];

    if (!oldSnapshot || !currentSnapshot || oldSnapshot.openInterest === 0) return 0;

    return ((currentSnapshot.openInterest - oldSnapshot.openInterest) / oldSnapshot.openInterest) * 100;
  }

  /** Get total liquidation value (USD) over the last N minutes */
  getLiquidations(symbol: string, minutes: number): { longLiqs: number; shortLiqs: number } {
    const buckets = this.getRecentBuckets(symbol, minutes);
    let longLiqs = 0;
    let shortLiqs = 0;
    for (const b of buckets) {
      longLiqs += b.longLiquidations;
      shortLiqs += b.shortLiquidations;
    }
    return { longLiqs, shortLiqs };
  }

  /** Get the price direction over last N minutes (positive = up, negative = down) */
  getPriceChangePct(symbol: string, minutes: number): number {
    const buckets = this.getRecentBuckets(symbol, minutes);
    if (buckets.length < 2) return 0;

    const firstClose = buckets[0].open;
    const lastClose = buckets[buckets.length - 1].close;

    if (firstClose === 0) return 0;
    return ((lastClose - firstClose) / firstClose) * 100;
  }
}
