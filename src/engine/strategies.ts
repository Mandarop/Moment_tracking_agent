// ============================================================
// before-move: Anomaly Detection Engine (The Sniper)
//
// "God Mode" Macro Setups.
// The engine now only fires on strict confluence of Macro OI,
// Volatility compression, Funding rates, and a Micro Trigger.
// Noise is ignored. Conviction is absolute.
// ============================================================

import { logger } from '../utils/logger.js';
import { StateAggregator } from './state.js';
import type { Signal, SignalType, SymbolConfig, SignalDirection } from '../types.js';

function signalId(type: SignalType, symbol: string): string {
  return `${type}:${symbol}:${Date.now()}`;
}

// ===== HELPER: Detect Micro Triggers (5m scale) =====

/** Returns true if there is a massive volume absorption on the 5m chart */
function hasAbsorptionTrigger(agg: StateAggregator, symbol: string): boolean {
  const vol5m = agg.getTotalVolume(symbol, 5);
  const vol15m = agg.getTotalVolume(symbol, 15);
  const priceRange = agg.getPriceRangePct(symbol, 5);
  
  if (vol15m === 0) return false;
  const avgVol5m = vol5m / 5;
  const avgVol15m = vol15m / 15;
  
  const volRatio = avgVol5m / avgVol15m;
  return volRatio > 2.0 && priceRange < 0.2; // 2x volume but tight range
}




// ===== GOD SETUP 1: THE BREAKOUT TRIGGER =====
// Tracks a consolidated market with heavy position build-up,
// and fires the EXACT moment price violently breaks out.

function detectBreakout(
  agg: StateAggregator,
  cfg: SymbolConfig
): Signal | null {
  const symbol = cfg.symbol;
  const state = agg.getState(symbol);
  if (!state || !state.historicalBaselines) return null;

  // 0. The Funding Filter (No Trap Rule)
  // Max greed = > 0.05%. Max fear = < -0.05%.
  const isMaxGreed = state.fundingRate > 0.0005; 
  const isMaxFear = state.fundingRate < -0.0005;

  // 1. Context: Macro Position Build-Up
  const oiChange4h = agg.getMacroOiChangePct(symbol, '4h');
  const oiChange24h = agg.getMacroOiChangePct(symbol, '24h');
  
  // Need at least 15% jump in 4h, or 25% jump in 24h
  const hasMacroBuildUp = oiChange4h > 15 || oiChange24h > 25;
  if (!hasMacroBuildUp) return null;

  // 2. Context: Volatility Compression (The Consolidation)
  const priceChange4h = agg.getMacroPriceChangePct(symbol, '4h');
  // If price moved > 5% over 4h, it's not a tight consolidation, it's already trending
  if (Math.abs(priceChange4h) > 5.0) return null; 

  // 3. Trigger: The Live Breakout (15m scale)
  const candle15m = agg.getRecentCandle(symbol, 15);
  if (!candle15m) return null;

  const priceChange15m = ((candle15m.close - candle15m.open) / candle15m.open) * 100;
  
  // Need a sudden spike in price (> 1.2% in 15 minutes)
  const isBreakingOut = Math.abs(priceChange15m) > 1.2;
  if (!isBreakingOut) return null;

  const direction: SignalDirection = priceChange15m > 0 ? 'BULLISH' : 'BEARISH';

  // Apply Funding Filter Block
  if (direction === 'BULLISH' && isMaxGreed) return null; // Block long if longs are overleveraged
  if (direction === 'BEARISH' && isMaxFear) return null;  // Block short if shorts are overleveraged

  // 4. Filter: The 75% Full Body Rule
  const totalRange = candle15m.high - candle15m.low;
  if (totalRange === 0) return null;
  
  const bodySize = Math.abs(candle15m.close - candle15m.open);
  const bodyRatio = bodySize / totalRange;
  if (bodyRatio < 0.75) return null; // Too much wick, liquidity sweep fakeout

  // 5. Filter: Delta Dominance
  const vol15m = agg.getTotalVolume(symbol, 15);
  const delta15m = agg.getNetDelta(symbol, 15);
  if (vol15m === 0) return null;
  
  const deltaRatio = Math.abs(delta15m) / vol15m;
  if (deltaRatio < 0.3) return null; // Delta must account for >30% of total volume

  // Ensure Delta matches price direction
  if (direction === 'BULLISH' && delta15m < 0) return null;
  if (direction === 'BEARISH' && delta15m > 0) return null;
  
  return {
    id: signalId('COILED_SPRING', symbol), // Keeping internal type name
    type: 'COILED_SPRING',
    direction,
    urgency: 'CRITICAL',
    symbol,
    price: state.lastPrice,
    message: `🚨 BREAKOUT ALERT: ${symbol} is breaking out of a 4H consolidation! 🚨\n\nPositions built up massively (+${Math.max(oiChange4h, oiChange24h).toFixed(1)}% OI). Price just broke out ${direction} by ${Math.abs(priceChange15m).toFixed(2)}% in a clean 15m full-body candle (Body Ratio: ${(bodyRatio * 100).toFixed(0)}%). Strong aggressive delta confirms the trend.`,
    metadata: {
      oiChange4hPct: oiChange4h,
      priceChange15mPct: priceChange15m,
      bodyRatio: bodyRatio,
      deltaRatio: deltaRatio,
      fundingRate: state.fundingRate,
    },
    timestamp: Date.now(),
  };
}

// ===== GOD SETUP 2: BEARISH TOP (Reversal) =====
// Price pumped hard over 24H, retail greed is high (funding),
// but volume is dying or smart money is absorbing the buys at the top.

function detectBearishTop(
  agg: StateAggregator,
  cfg: SymbolConfig
): Signal | null {
  const symbol = cfg.symbol;
  const state = agg.getState(symbol);
  if (!state || !state.historicalBaselines) return null;

  // 1. Context: Macro Pump
  const priceChange24h = agg.getMacroPriceChangePct(symbol, '24h');
  if (priceChange24h < 15.0) return null; // Must be a massive 24h pump (>15%)

  // 2. Context: Excessive Greed
  // Funding rate > 0.03% per 8h is very high (standard is 0.01%)
  if (state.fundingRate < 0.0003) return null;

  // 3. Trigger: Top Exhaustion or Absorption
  const isAbsorbing = hasAbsorptionTrigger(agg, symbol); // Whale is capping the price
  const vol5m = agg.getTotalVolume(symbol, 5);
  const vol15m = agg.getTotalVolume(symbol, 15);
  const isExhausted = (vol15m > 0) && ((vol5m / 5) < (vol15m / 15) * 0.4); // Volume dropped by 60%

  if (!isAbsorbing && !isExhausted) return null;

  return {
    id: signalId('EXHAUSTION', symbol),
    type: 'EXHAUSTION',
    direction: 'BEARISH',
    urgency: 'HIGH',
    symbol,
    price: state.lastPrice,
    message: `🚨 GOD SETUP: MACRO BEARISH TOP on ${symbol} 🚨\n\nPrice pumped ${priceChange24h.toFixed(1)}% but momentum has completely died. Retail greed is extreme (Funding: ${(state.fundingRate * 100).toFixed(4)}%). Whales are capping the top. Short reversal setup valid.`,
    metadata: {
      priceChange24hPct: priceChange24h,
      fundingRate: state.fundingRate,
      microTrigger: isAbsorbing ? 'ABSORPTION' : 'EXHAUSTION',
    },
    timestamp: Date.now(),
  };
}


// ===== MAIN EVALUATOR =====

export class AnomalyDetector {
  private aggregator: StateAggregator;
  private symbolConfigs: SymbolConfig[];
  private signalCooldowns: Map<string, number> = new Map();
  private cooldownMs: number;

  private onSignalCallback: ((signal: Signal) => void) | null = null;

  constructor(aggregator: StateAggregator, symbolConfigs: SymbolConfig[], cooldownMs: number) {
    this.aggregator = aggregator;
    this.symbolConfigs = symbolConfigs;
    this.cooldownMs = cooldownMs;
  }

  onSignal(cb: (signal: Signal) => void): void {
    this.onSignalCallback = cb;
  }

  evaluate(): Signal[] {
    const signals: Signal[] = [];

    for (const cfg of this.symbolConfigs) {
      // Only run the two God Setups. Micro-noise strategies are disabled.
      const strategies = [
        detectBreakout,
        detectBearishTop
      ];

      for (const strategy of strategies) {
        const signal = strategy(this.aggregator, cfg);
        if (signal && !this.isOnCooldown(signal)) {
          this.setCooldown(signal);
          
          logger.signal('ANOMALY', signal.message, signal.metadata);

          signals.push(signal);
          if (this.onSignalCallback) {
            this.onSignalCallback(signal);
          }
        }
      }
    }

    return signals;
  }

  private isOnCooldown(signal: Signal): boolean {
    const key = `${signal.type}:${signal.symbol}`;
    const lastFired = this.signalCooldowns.get(key);
    if (!lastFired) return false;
    return Date.now() - lastFired < this.cooldownMs;
  }

  private setCooldown(signal: Signal): void {
    const key = `${signal.type}:${signal.symbol}`;
    this.signalCooldowns.set(key, Date.now());
  }
}
