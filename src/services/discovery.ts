// ============================================================
// before-move: Coin Discovery Service
//
// Automatically fetches the top N coins by 24h trading volume
// from Bybit and Binance. Merges and deduplicates them.
//
// This runs once at startup, and optionally refreshes daily
// so the watchlist stays relevant as market conditions change.
// ============================================================

import { logger } from '../utils/logger.js';
import type { SymbolConfig } from '../types.js';

const BYBIT_REST = 'https://api.bybit.com';
const BINANCE_REST = 'https://fapi.binance.com';

interface TickerInfo {
  symbol: string;
  volume24hUsd: number;
  lastPrice: number;
}

/**
 * Fetch top coins by 24h volume from Bybit Linear Futures
 */
async function fetchBybitTopCoins(limit: number): Promise<TickerInfo[]> {
  try {
    const url = `${BYBIT_REST}/v5/market/tickers?category=linear`;
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn('DISCOVERY', `Bybit API returned ${response.status}`);
      return [];
    }

    const data = await response.json() as {
      result: {
        list: Array<{
          symbol: string;
          turnover24h: string;
          lastPrice: string;
        }>;
      };
    };

    const tickers = data.result.list
      // Only USDT perpetuals (skip inverse, USDC pairs, etc.)
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('1000'))
      .map(t => ({
        symbol: t.symbol,
        volume24hUsd: parseFloat(t.turnover24h),
        lastPrice: parseFloat(t.lastPrice),
      }))
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
      .slice(0, limit);

    logger.info('DISCOVERY', `Fetched ${tickers.length} coins from Bybit`);
    return tickers;
  } catch (err) {
    logger.error('DISCOVERY', `Failed to fetch Bybit tickers`, { error: String(err) });
    return [];
  }
}

/**
 * Fetch top coins by 24h volume from Binance Futures
 * (Will fail from India — that's fine, Bybit covers us)
 */
async function fetchBinanceTopCoins(limit: number): Promise<TickerInfo[]> {
  try {
    const url = `${BINANCE_REST}/fapi/v1/ticker/24hr`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn('DISCOVERY', `Binance API returned ${response.status}`);
      return [];
    }

    const data = await response.json() as Array<{
      symbol: string;
      quoteVolume: string;
      lastPrice: string;
    }>;

    const tickers = data
      .filter(t => t.symbol.endsWith('USDT'))
      .map(t => ({
        symbol: t.symbol,
        volume24hUsd: parseFloat(t.quoteVolume),
        lastPrice: parseFloat(t.lastPrice),
      }))
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
      .slice(0, limit);

    logger.info('DISCOVERY', `Fetched ${tickers.length} coins from Binance`);
    return tickers;
  } catch (err) {
    logger.warn('DISCOVERY', `Binance unreachable (expected in India)`, { error: String(err) });
    return [];
  }
}

/**
 * Generate dynamic thresholds based on a coin's volume.
 * High-volume coins (BTC, ETH) need tighter thresholds.
 * Low-volume coins need wider thresholds to avoid noise.
 */
function generateThresholds(ticker: TickerInfo): SymbolConfig {
  const vol = ticker.volume24hUsd;

  // Tier 1: BTC, ETH (>$5B daily volume)
  if (vol > 5_000_000_000) {
    return {
      symbol: ticker.symbol,
      oiThresholdPct: 8,
      tightRangePct: 0.3,
      deltaDivergenceThreshold: 5_000_000,
      liquidationCascadeThreshold: 2_000_000,
    };
  }

  // Tier 2: SOL, XRP, DOGE etc ($500M - $5B)
  if (vol > 500_000_000) {
    return {
      symbol: ticker.symbol,
      oiThresholdPct: 10,
      tightRangePct: 0.5,
      deltaDivergenceThreshold: 2_000_000,
      liquidationCascadeThreshold: 1_000_000,
    };
  }

  // Tier 3: Mid-caps ($100M - $500M)
  if (vol > 100_000_000) {
    return {
      symbol: ticker.symbol,
      oiThresholdPct: 12,
      tightRangePct: 0.7,
      deltaDivergenceThreshold: 500_000,
      liquidationCascadeThreshold: 300_000,
    };
  }

  // Tier 4: Small-caps (<$100M)
  return {
    symbol: ticker.symbol,
    oiThresholdPct: 15,
    tightRangePct: 1.0,
    deltaDivergenceThreshold: 200_000,
    liquidationCascadeThreshold: 100_000,
  };
}

/**
 * Discover the top N coins across both exchanges.
 * Merges, deduplicates, and sorts by combined volume.
 */
export async function discoverTopCoins(count: number = 50): Promise<{
  symbols: string[];
  configs: SymbolConfig[];
  bybitSymbols: string[];
  binanceSymbols: string[];
}> {
  logger.info('DISCOVERY', `Discovering top ${count} coins across Bybit + Binance...`);

  // Fetch from both exchanges in parallel
  const [bybitCoins, binanceCoins] = await Promise.all([
    fetchBybitTopCoins(count),
    fetchBinanceTopCoins(count),
  ]);

  // Merge by symbol, taking the higher volume
  const merged = new Map<string, TickerInfo>();
  for (const coin of bybitCoins) {
    merged.set(coin.symbol, coin);
  }
  for (const coin of binanceCoins) {
    const existing = merged.get(coin.symbol);
    if (!existing || coin.volume24hUsd > existing.volume24hUsd) {
      merged.set(coin.symbol, coin);
    }
  }

  // Sort by volume and take top N
  const topCoins = Array.from(merged.values())
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
    .slice(0, count);

  // Determine which symbols are available on each exchange
  const bybitSymbolSet = new Set(bybitCoins.map(c => c.symbol));
  const binanceSymbolSet = new Set(binanceCoins.map(c => c.symbol));

  const symbols = topCoins.map(c => c.symbol);
  const configs = topCoins.map(c => generateThresholds(c));
  const bybitSymbols = symbols.filter(s => bybitSymbolSet.has(s));
  const binanceSymbols = symbols.filter(s => binanceSymbolSet.has(s));

  // Log the discovered coins
  logger.info('DISCOVERY', `Top ${symbols.length} coins discovered:`);
  for (let i = 0; i < Math.min(10, topCoins.length); i++) {
    const c = topCoins[i];
    logger.info('DISCOVERY', `  #${i + 1} ${c.symbol}`, {
      vol24h: `$${(c.volume24hUsd / 1_000_000_000).toFixed(2)}B`,
      price: `$${c.lastPrice}`,
    });
  }
  if (topCoins.length > 10) {
    logger.info('DISCOVERY', `  ... and ${topCoins.length - 10} more`);
  }

  logger.info('DISCOVERY', `Exchange coverage`, {
    bybit: `${bybitSymbols.length} symbols`,
    binance: `${binanceSymbols.length} symbols`,
    overlap: `${symbols.filter(s => bybitSymbolSet.has(s) && binanceSymbolSet.has(s)).length} shared`,
  });

  return { symbols, configs, bybitSymbols, binanceSymbols };
}
