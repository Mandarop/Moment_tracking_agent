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

/** Returns the direction of CVD divergence on 5m chart, or null */
function getCvdDivergenceTrigger(agg: StateAggregator, symbol: string, threshold: number): 'BULLISH' | 'BEARISH' | null {
  const priceChange = agg.getPriceChangePct(symbol, 5);
  const netDelta = agg.getNetDelta(symbol, 5);

  if (Math.abs(priceChange) < 0.1 || Math.abs(netDelta) < threshold * 0.3) return null;

  if (priceChange > 0 && netDelta < -threshold * 0.3) return 'BEARISH'; // Price up, smart money selling
  if (priceChange < 0 && netDelta > threshold * 0.3) return 'BULLISH';  // Price down, smart money buying
  
  return null;
}


// ===== GOD SETUP 1: THE MACRO COIL (Breakout) =====
// High timeframe position build-up + tight range + trapped funding.
// A directional explosion is inevitable.

function detectMacroCoil(
  agg: StateAggregator,
  cfg: SymbolConfig
): Signal | null {
  const symbol = cfg.symbol;
  const state = agg.getState(symbol);
  if (!state || !state.historicalBaselines) return null;

  // 1. Context: Macro Position Build-Up
  const oiChange4h = agg.getMacroOiChangePct(symbol, '4h');
  const oiChange24h = agg.getMacroOiChangePct(symbol, '24h');
  
  // Need at least 15% jump in 4h, or 25% jump in 24h
  const hasMacroBuildUp = oiChange4h > 15 || oiChange24h > 25;
  if (!hasMacroBuildUp) return null;

  // 2. Context: Volatility Compression
  const priceChange4h = agg.getMacroPriceChangePct(symbol, '4h');
  // Price hasn't moved much despite huge money entering
  if (Math.abs(priceChange4h) > 4.0) return null; 

  // 3. Trigger: Micro Catalyst
  // We need a micro event to time the entry
  const isAbsorbing = hasAbsorptionTrigger(agg, symbol);
  const divergence = getCvdDivergenceTrigger(agg, symbol, cfg.deltaDivergenceThreshold);
  
  if (!isAbsorbing && !divergence) return null;

  // Determine Direction
  let direction: SignalDirection = 'NEUTRAL';
  // Use funding rate to see who is trapped. Negative funding = shorts are paying longs.
  if (state.fundingRate < -0.0001) direction = 'BULLISH'; // Shorts are trapped, short squeeze incoming
  else if (state.fundingRate > 0.0001) direction = 'BEARISH'; // Longs trapped
  else if (divergence) direction = divergence; // Follow the smart money CVD
  
  // We have a God Setup.
  return {
    id: signalId('COILED_SPRING', symbol),
    type: 'COILED_SPRING',
    direction,
    urgency: 'CRITICAL',
    symbol,
    price: state.lastPrice,
    message: `🚨 GOD SETUP: MACRO COIL BREAKOUT on ${symbol} 🚨\n\nMassive structural trap detected. OI is up ${Math.max(oiChange4h, oiChange24h).toFixed(1)}% while price is compressed. A violent 4H/24H breakout is imminent. Funding rate (${(state.fundingRate * 100).toFixed(4)}%) and order flow suggest a ${direction} release.`,
    metadata: {
      oiChange4hPct: oiChange4h,
      oiChange24hPct: oiChange24h,
      priceChange4hPct: priceChange4h,
      fundingRate: state.fundingRate,
      microTrigger: isAbsorbing ? 'ABSORPTION' : 'DIVERGENCE',
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
        detectMacroCoil,
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
