// ============================================================
// before-move: Conviction Scoring Algorithm
//
// Scores each signal from 1-10 based on confluence of metrics.
// Only high-conviction signals (≥ 7) are sent to Discord.
// Lower scores still log to console for debugging/backtesting.
//
// Scoring Rubric (BREAKOUT signals):
//   OI Change (4H):    >15% → +1, >50% → +2, >100% → +3
//   Body Ratio:        >75% → +1, >90% → +2
//   Delta Ratio:       >30% → +1, >45% → +2
//   Price Move (15m):  >1.5% → +1, >2.5% → +2
//   Funding Alignment: supports direction → +1
//   Max: 10
// ============================================================

import type { Signal, SignalDirection } from '../types.js';

/** Minimum conviction score to send to Discord */
export const DISCORD_THRESHOLD = 7;

export interface ConvictionBreakdown {
  score: number;
  oiPoints: number;
  bodyPoints: number;
  deltaPoints: number;
  pricePoints: number;
  fundingPoints: number;
}

/**
 * Score a BREAKOUT (COILED_SPRING) signal based on its raw metrics.
 * Returns a score from 1-10 with a breakdown of how each metric contributed.
 */
export function scoreBreakoutSignal(metadata: Record<string, number | string>, direction: SignalDirection): ConvictionBreakdown {
  let oiPoints = 0;
  let bodyPoints = 0;
  let deltaPoints = 0;
  let pricePoints = 0;
  let fundingPoints = 0;

  // --- OI Change (4H) ---
  const oiChange = Math.abs(Number(metadata.oiChange4hPct) || 0);
  if (oiChange > 100) oiPoints = 3;
  else if (oiChange > 50) oiPoints = 2;
  else if (oiChange > 15) oiPoints = 1;

  // --- Body Ratio (candle quality) ---
  const bodyRatio = Number(metadata.bodyRatio) || 0;
  if (bodyRatio > 0.90) bodyPoints = 2;
  else if (bodyRatio > 0.75) bodyPoints = 1;

  // --- Delta Ratio (aggressive volume confirmation) ---
  const deltaRatio = Number(metadata.deltaRatio) || 0;
  if (deltaRatio > 0.45) deltaPoints = 2;
  else if (deltaRatio > 0.30) deltaPoints = 1;

  // --- Price Move (15m magnitude) ---
  const priceMove = Math.abs(Number(metadata.priceChange15mPct) || 0);
  if (priceMove > 2.5) pricePoints = 2;
  else if (priceMove > 1.5) pricePoints = 1;

  // --- Funding Alignment ---
  // Negative funding + Bullish breakout = shorts are overleveraged, squeeze incoming (+1)
  // Positive funding + Bearish breakout = longs are overleveraged, dump incoming (+1)
  // Neutral funding = no edge from funding (0)
  const funding = Number(metadata.fundingRate) || 0;
  if (direction === 'BULLISH' && funding < -0.0001) fundingPoints = 1;
  else if (direction === 'BEARISH' && funding > 0.0001) fundingPoints = 1;

  const score = Math.min(10, oiPoints + bodyPoints + deltaPoints + pricePoints + fundingPoints);

  return {
    score: Math.max(1, score), // Floor at 1, never 0
    oiPoints,
    bodyPoints,
    deltaPoints,
    pricePoints,
    fundingPoints,
  };
}

/**
 * Score a BEARISH_TOP (EXHAUSTION) signal.
 * These already have very strict filters (15%+ pump, extreme funding, exhaustion trigger),
 * so they get a flat high score.
 */
export function scoreExhaustionSignal(): ConvictionBreakdown {
  return {
    score: 8,
    oiPoints: 0,
    bodyPoints: 0,
    deltaPoints: 0,
    pricePoints: 0,
    fundingPoints: 0,
  };
}

/**
 * Score any signal based on its type.
 */
export function scoreSignal(signal: Signal): ConvictionBreakdown {
  switch (signal.type) {
    case 'COILED_SPRING':
      return scoreBreakoutSignal(signal.metadata, signal.direction);
    case 'EXHAUSTION':
      return scoreExhaustionSignal();
    default:
      return scoreBreakoutSignal(signal.metadata, signal.direction);
  }
}
