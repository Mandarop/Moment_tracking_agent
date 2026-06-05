// ============================================================
// before-move: Main Entry Point (Multi-Exchange, Top 50)
//
// Pipeline:
//   Discovery → Bybit WS  ─┐
//                           ├→ State Aggregator → Detector → Notifier
//   Discovery → Binance WS ─┘                             → Storage
//
// Automatically discovers top 50 coins by volume,
// connects to BOTH Bybit and Binance for merged data,
// and runs anomaly detection across all symbols.
// ============================================================

import config from './config.js';
import { discoverTopCoins } from './services/discovery.js';
import { BybitWsManager } from './services/bybitWs.js';
import { BinanceWsManager } from './services/binanceWs.js';
import { StateAggregator } from './engine/state.js';
import { AnomalyDetector } from './engine/strategies.js';
import { Notifier } from './services/notifier.js';
import { Storage } from './db/storage.js';
import { logger } from './utils/logger.js';

// ===== STARTUP BANNER =====

function printBanner(): void {
  console.log(`
\x1b[35m\x1b[1m
  ██████╗ ███████╗███████╗ ██████╗ ██████╗ ███████╗
  ██╔══██╗██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝
  ██████╔╝█████╗  █████╗  ██║   ██║██████╔╝█████╗
  ██╔══██╗██╔══╝  ██╔══╝  ██║   ██║██╔══██╗██╔══╝
  ██████╔╝███████╗██║     ╚██████╔╝██║  ██║███████╗
  ╚═════╝ ╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝╚══════╝
  ███╗   ███╗ ██████╗ ██╗   ██╗███████╗
  ████╗ ████║██╔═══██╗██║   ██║██╔════╝
  ██╔████╔██║██║   ██║██║   ██║█████╗
  ██║╚██╔╝██║██║   ██║╚██╗ ██╔╝██╔══╝
  ██║ ╚═╝ ██║╚██████╔╝ ╚████╔╝ ███████╗
  ╚═╝     ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝
\x1b[0m
\x1b[36m  Order Flow & Anomaly Detection Engine\x1b[0m
\x1b[90m  Multi-Exchange (Bybit + Binance) | Top 50 Coins\x1b[0m
  `);
}

// ===== PERIODIC STATUS REPORT =====

function printStatus(aggregator: StateAggregator): void {
  const symbols = aggregator.getSymbols();

  // Only consider symbols that have actual data and some OI history
  const activeSymbols = symbols.filter(s => {
    const state = aggregator.getState(s);
    return state && state.lastPrice > 0 && state.oiSnapshots.length > 0;
  });

  if (activeSymbols.length === 0) return;

  // Calculate stats and "suspicion score" (magnitude of OI change)
  const stats = activeSymbols.map(symbol => {
    const state = aggregator.getState(symbol)!;
    const delta5m = aggregator.getNetDelta(symbol, 5);
    const oiChange = aggregator.getOiChangePct(symbol, 15);
    const priceRange = aggregator.getPriceRangePct(symbol, 15);
    const volume5m = aggregator.getTotalVolume(symbol, 5);
    
    return {
      symbol,
      price: state.lastPrice,
      delta5m,
      oiChange,
      priceRange,
      volume5m,
      score: Math.abs(oiChange) // Rank by how fast positions are building/closing
    };
  });

  // Sort by suspicion score
  stats.sort((a, b) => b.score - a.score);

  console.log('\n\x1b[90m' + '─'.repeat(72) + '\x1b[0m');
  logger.info('STATUS', `🚨 TOP 5 SUSPICIOUS COINS (Position Build-Up)`);
  console.log('\x1b[90m' + '─'.repeat(72) + '\x1b[0m');

  const displayCount = Math.min(5, stats.length);
  for (let i = 0; i < displayCount; i++) {
    const s = stats[i];
    const deltaDir = s.delta5m > 0 ? '\x1b[32m↑\x1b[0m' : '\x1b[31m↓\x1b[0m';
    
    // Highlight large OI changes in yellow/red
    let oiColor = '\x1b[0m';
    if (Math.abs(s.oiChange) > 10) oiColor = '\x1b[31m'; // Red
    else if (Math.abs(s.oiChange) > 5) oiColor = '\x1b[33m'; // Yellow

    logger.info('STATUS', `${(i+1).toString().padStart(2)}. ${s.symbol.padEnd(10)}`, {
      price: `$${s.price.toLocaleString()}`,
      'OI∆(15m)': `${oiColor}${s.oiChange >= 0 ? '+' : ''}${s.oiChange.toFixed(2)}%\x1b[0m`,
      'Δ(5m)': `${deltaDir} $${(Math.abs(s.delta5m) / 1_000_000).toFixed(2)}M`,
      'rng': `${s.priceRange.toFixed(2)}%`,
      'vol': `$${(s.volume5m / 1_000_000).toFixed(1)}M`,
    });
  }

  console.log('\x1b[90m' + '─'.repeat(72) + '\x1b[0m\n');
}

// ===== MAIN =====

async function main(): Promise<void> {
  printBanner();

  // --- Phase 1: Discover top 50 coins ---
  const discovery = await discoverTopCoins(50);

  if (discovery.symbols.length === 0) {
    logger.error('INIT', 'No symbols discovered. Check your internet connection.');
    process.exit(1);
  }

  // --- Phase 2: Initialize Components ---
  logger.info('INIT', 'Initializing components...');

  // 1. State Aggregator (all symbols in one)
  const aggregator = new StateAggregator(discovery.symbols, config.rollingWindowMinutes);

  // Fetch 4H and 24H history for all discovered coins
  const { populateHistoricalData } = await import('./services/history.js');
  await populateHistoricalData(discovery.symbols, aggregator);

  // 2. Anomaly Detector (with auto-generated thresholds)
  const detector = new AnomalyDetector(aggregator, discovery.configs, config.signalCooldownMs);

  // 3. Notifier
  const notifier = new Notifier({
    telegramBotToken: config.telegramBotToken,
    telegramChatId: config.telegramChatId,
    discordWebhookUrl: config.discordWebhookUrl,
  });

  // 4. Storage
  const storage = await Storage.create();

  // 5. Wire signals
  detector.onSignal(async (signal) => {
    storage.saveSignal(signal);
    await notifier.send(signal);
  });

  // --- Phase 3: Connect to Exchanges ---

  // === BYBIT (primary — works from India) ===
  logger.info('INIT', `🔌 Connecting to Bybit (${discovery.bybitSymbols.length} symbols)...`);
  const bybitWs = new BybitWsManager(discovery.bybitSymbols);

  bybitWs.onTradeEvent((trades) => {
    for (const trade of trades) {
      aggregator.processTrade(
        trade.s,
        parseFloat(trade.p),
        parseFloat(trade.v),
        trade.S === 'Buy',
        trade.T
      );
    }
  });

  bybitWs.onLiquidationEvent((liq) => {
    aggregator.processLiquidation(
      liq.s,
      liq.S === 'Buy' ? 'LONG' : 'SHORT',
      parseFloat(liq.v),
      parseFloat(liq.p),
      liq.T
    );
  });

  bybitWs.onTickerEvent((ticker) => {
    const symbol = ticker.symbol;
    const now = Date.now();

    if (ticker.openInterest) {
      const oi = parseFloat(ticker.openInterest);
      if (oi > 0) {
        aggregator.processOiUpdate(symbol, oi, now);
        storage.saveOiSnapshot(symbol, oi, now);
      }
    }
    if (ticker.markPrice) {
      aggregator.updateTickerInfo(
        symbol,
        parseFloat(ticker.markPrice),
        ticker.fundingRate ? parseFloat(ticker.fundingRate) : 0
      );
    }
  });

  bybitWs.connect();

  // === BINANCE (secondary — adds merged volume, fails gracefully from India) ===
  if (discovery.binanceSymbols.length > 0) {
    logger.info('INIT', `🔌 Connecting to Binance (${discovery.binanceSymbols.length} symbols)...`);
    const binanceWs = new BinanceWsManager(discovery.binanceSymbols);

    binanceWs.onTradeEvent((trade) => {
      aggregator.processTrade(
        trade.symbol,
        trade.price,
        trade.quantity,
        trade.isBuyerAggressor,
        trade.timestamp
      );
    });

    binanceWs.onLiquidationEvent((liq) => {
      aggregator.processLiquidation(
        liq.symbol,
        liq.side,
        liq.quantity,
        liq.price,
        liq.timestamp
      );
    });

    binanceWs.onOiUpdateEvent((update) => {
      aggregator.processOiUpdate(update.symbol, update.openInterest, update.timestamp);
      storage.saveOiSnapshot(update.symbol, update.openInterest, update.timestamp);
    });

    binanceWs.connect();
    binanceWs.startOiPolling(config.oiPollIntervalMs);

    // Register for shutdown
    process.on('SIGINT', () => binanceWs.shutdown());
    process.on('SIGTERM', () => binanceWs.shutdown());
  } else {
    logger.warn('INIT', 'Binance unavailable — running on Bybit data only');
  }

  // --- Phase 4: Start Evaluation & Reporting ---

  const evalInterval = setInterval(() => {
    detector.evaluate();
  }, 5_000);

  const statusInterval = setInterval(() => {
    printStatus(aggregator);
  }, 30_000);

  // --- Graceful Shutdown ---

  const shutdown = (): void => {
    logger.info('MAIN', '🛑 Shutting down gracefully...');
    clearInterval(evalInterval);
    clearInterval(statusInterval);
    bybitWs.shutdown();
    storage.close();
    logger.info('MAIN', '✅ Shutdown complete. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('INIT', '✅ All systems online.');
  logger.info('INIT', `Tracking ${discovery.symbols.length} coins across Bybit + Binance`);
  logger.info('INIT', 'Press Ctrl+C to shut down.');
}

main().catch((err) => {
  logger.error('MAIN', 'Fatal error', { error: String(err) });
  process.exit(1);
});
