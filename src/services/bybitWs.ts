// ============================================================
// before-move: Bybit WebSocket Connection Manager (V5 API)
//
// Replaces Binance WS — Bybit works from India.
// Key differences from Binance:
//   - Subscribe via JSON message after connecting (not URL)
//   - Trade side is "Buy"/"Sell" string (not boolean)
//   - OI streams via tickers topic (no REST polling needed!)
//   - Liquidations via allLiquidation topic
//   - Requires periodic ping to keep alive (20s interval)
// ============================================================

import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

const BYBIT_WS_URL = 'wss://stream.bybit.com/v5/public/linear';

// Reconnection parameters
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;

// ----- Bybit raw message types -----

export interface BybitTrade {
  /** Timestamp (ms) */
  T: number;
  /** Symbol */
  s: string;
  /** Side: "Buy" = buyer aggressor, "Sell" = seller aggressor */
  S: 'Buy' | 'Sell';
  /** Trade size (quantity) */
  v: string;
  /** Trade price */
  p: string;
  /** Trade ID */
  i: string;
  /** Block trade */
  BT: boolean;
}

export interface BybitLiquidation {
  /** Updated timestamp (ms) */
  T: number;
  /** Symbol */
  s: string;
  /** Side: "Buy" = long liquidated (forced buy to close short?), "Sell" = short side */
  S: 'Buy' | 'Sell';
  /** Executed size */
  v: string;
  /** Bankruptcy price */
  p: string;
}

export interface BybitTickerData {
  symbol: string;
  lastPrice: string;
  markPrice: string;
  openInterest: string;
  openInterestValue: string;
  fundingRate: string;
  nextFundingTime: string;
  highPrice24h: string;
  lowPrice24h: string;
  volume24h: string;
  turnover24h: string;
}

// Callback types
type TradeCallback = (trades: BybitTrade[]) => void;
type LiquidationCallback = (liq: BybitLiquidation) => void;
type TickerCallback = (ticker: BybitTickerData) => void;

export class BybitWsManager {
  private ws: WebSocket | null = null;
  private symbols: string[];
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Event callbacks
  private onTrade: TradeCallback | null = null;
  private onLiquidation: LiquidationCallback | null = null;
  private onTicker: TickerCallback | null = null;

  constructor(symbols: string[]) {
    // Bybit uses uppercase symbols
    this.symbols = symbols.map(s => s.toUpperCase());
  }

  /** Register trade handler */
  onTradeEvent(cb: TradeCallback): void {
    this.onTrade = cb;
  }

  /** Register liquidation handler */
  onLiquidationEvent(cb: LiquidationCallback): void {
    this.onLiquidation = cb;
  }

  /** Register ticker handler (includes OI, price, funding rate) */
  onTickerEvent(cb: TickerCallback): void {
    this.onTicker = cb;
  }

  /** Connect to the websocket */
  connect(): void {
    if (this.isShuttingDown) return;

    logger.info('WS', `Connecting to Bybit Linear Futures...`, {
      symbols: this.symbols.join(', '),
    });

    this.ws = new WebSocket(BYBIT_WS_URL);

    this.ws.on('open', () => {
      logger.info('WS', '✅ Connected to Bybit WebSocket');
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.subscribe();
      this.startPing();
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        logger.error('WS', 'Failed to parse message', { error: String(err) });
      }
    });

    this.ws.on('close', (code, reason) => {
      logger.warn('WS', `Connection closed`, {
        code,
        reason: reason.toString() || 'unknown',
      });
      this.stopPing();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error('WS', `WebSocket error`, { error: err.message });
    });
  }

  /** Subscribe to all topics after connection opens */
  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const topics: string[] = [];
    for (const sym of this.symbols) {
      topics.push(`publicTrade.${sym}`);         // tick-by-tick trades
      topics.push(`tickers.${sym}`);             // OI, price, funding (streamed, no REST needed!)
      topics.push(`allLiquidation.${sym}`);      // liquidation events
    }

    const subscribeMsg = {
      op: 'subscribe',
      args: topics,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    logger.info('WS', `Subscribed to ${topics.length} topics`, {
      topics: topics.join(', '),
    });
  }

  /** Route incoming messages to the correct handler */
  private handleMessage(msg: Record<string, unknown>): void {
    // Handle subscription confirmation
    if (msg.op === 'subscribe') {
      if (msg.success) {
        logger.info('WS', '✅ Subscription confirmed');
      } else {
        logger.error('WS', '❌ Subscription failed', { msg: JSON.stringify(msg) });
      }
      return;
    }

    // Handle pong responses
    if (msg.op === 'pong' || msg.ret_msg === 'pong') {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      return;
    }

    const topic = msg.topic as string;
    if (!topic) return;

    const data = msg.data;

    // Route by topic prefix
    if (topic.startsWith('publicTrade.') && this.onTrade) {
      // data is an array of trades
      this.onTrade(data as BybitTrade[]);
    } else if (topic.startsWith('allLiquidation.') && this.onLiquidation) {
      // data is a single liquidation object
      this.onLiquidation(data as BybitLiquidation);
    } else if (topic.startsWith('tickers.') && this.onTicker) {
      // data is a ticker object
      this.onTicker(data as BybitTickerData);
    }
  }

  /** Bybit requires sending a JSON ping every 20s to keep alive */
  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));

        // Detect dead connection if no pong within timeout
        this.pongTimer = setTimeout(() => {
          logger.warn('WS', 'Pong timeout — connection presumed dead. Forcing close.');
          this.ws?.terminate();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** Exponential backoff reconnection */
  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;

    logger.info('WS', `Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  /** Graceful shutdown */
  shutdown(): void {
    logger.info('WS', 'Shutting down Bybit WebSocket manager...');
    this.isShuttingDown = true;
    this.stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Graceful shutdown');
      this.ws = null;
    }
  }
}
