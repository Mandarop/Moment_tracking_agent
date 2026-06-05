import { logger } from '../utils/logger.js';
import type { StateAggregator } from '../engine/state.js';

const BYBIT_REST = 'https://api.bybit.com';

/**
 * Fetch historical data for all symbols and inject it into the StateAggregator.
 * This allows the bot to fire 4H and 24H macro signals immediately on boot,
 * without waiting 24 hours to collect data.
 */
export async function populateHistoricalData(
  symbols: string[],
  aggregator: StateAggregator
): Promise<void> {
  logger.info('HISTORY', `Fetching 4H and 24H historical data for ${symbols.length} symbols...`);

  // Process in chunks to avoid overwhelming the REST API
  const chunkSize = 10;
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    
    await Promise.all(
      chunk.map(async (symbol) => {
        try {
          // 1. Fetch historical OI (1h intervals, limit 25 to cover 24h)
          const oiUrl = `${BYBIT_REST}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=25`;
          const oiRes = await fetch(oiUrl);
          const oiData = await oiRes.json() as any;

          let oi4h = 0;
          let oi24h = 0;

          if (oiData?.result?.list?.length > 0) {
            const list = oiData.result.list;
            // List is newest first. 
            // index 4 = 4 hours ago, index 24 = 24 hours ago
            if (list.length >= 5) oi4h = parseFloat(list[4].openInterest);
            if (list.length >= 24) oi24h = parseFloat(list[23].openInterest);
          }

          // 2. Fetch historical Klines (4h intervals, limit 7 to cover 24h)
          const klineUrl = `${BYBIT_REST}/v5/market/kline?category=linear&symbol=${symbol}&interval=240&limit=7`;
          const klineRes = await fetch(klineUrl);
          const klineData = await klineRes.json() as any;

          let price4h = 0;
          let price24h = 0;

          if (klineData?.result?.list?.length > 0) {
            const list = klineData.result.list;
            // [startTime, openPrice, highPrice, lowPrice, closePrice, volume, turnover]
            // index 1 = 4 hours ago, index 6 = 24 hours ago
            if (list.length >= 2) price4h = parseFloat(list[1][4]); // close price of 4h ago candle
            if (list.length >= 7) price24h = parseFloat(list[6][4]); // close price of 24h ago candle
          }

          // Inject into aggregator
          aggregator.setHistoricalBaselines(symbol, oi4h, oi24h, price4h, price24h);

        } catch (err) {
          logger.error('HISTORY', `Failed to fetch history for ${symbol}`, { error: String(err) });
        }
      })
    );
    
    // Slight pause between chunks
    await new Promise(r => setTimeout(r, 200));
  }

  logger.info('HISTORY', `Historical data injected successfully.`);
}
