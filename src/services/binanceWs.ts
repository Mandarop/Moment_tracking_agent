// ============================================================
// before-move: Binance WebSocket Connection Manager
//
// Connects to Binance Futures for additional data coverage.
// NOTE: Blocked from India. Will work when deployed on
// Oracle Cloud Singapore. Gracefully fails locally.
//
// Uses the same callback interface as BybitWsManager so the
// main orchestrator can wire both identically.
// ============================================================

import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

const BINANCE_FUTURES_WS = 'wss://fstream.binance.com/stream';
const BINANCE_FUTURES_REST = 'https://fapi.binance.com';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// Max 200 streams per single WS connection on Binance
const MAX_STREAMS_PER_CONNECTION = 200;

// ----- Normalized callback types (exchange-agnostic) -----
export interface NormalizedTrade {
  symbol: string;
  price: number;
  quantity: number;
  isBuyerAggressor: boolean;
  timestamp: number;
}

export interface NormalizedLiquidation {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  price: number;
  timestamp: number;
}

export interface NormalizedOiUpdate {
  symbol: string;
  openInterest: number;
  timestamp: number;
}

type TradeCallback = (trade: NormalizedTrade) => void;
type LiquidationCallback = (liq: NormalizedLiquidation) => void;
type OiCallback = (update: NormalizedOiUpdate) => void;

export class BinanceWsManager {
  private connections: WebSocket[] = [];
  private symbols: string[];
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private heartbeatTimers: ReturnType<typeof setInterval>[] = [];
  private pongTimers: Map<WebSocket, ReturnType<typeof setTimeout>> = new Map();
  private isShuttingDown = false;
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];

  // OI polling
  private oiPollTimer: ReturnType<typeof setInterval> | null = null;

  // Event callbacks
  private onTrade: TradeCallback | null = null;
  private onLiquidation: LiquidationCallback | null = null;
  private onOiUpdate: OiCallback | null = null;

  constructor(symbols: string[]) {
    this.symbols = symbols.map(s => s.toLowerCase());
  }

  onTradeEvent(cb: TradeCallback): void { this.onTrade = cb; }
  onLiquidationEvent(cb: LiquidationCallback): void { this.onLiquidation = cb; }
  onOiUpdateEvent(cb: OiCallback): void { this.onOiUpdate = cb; }

  /**
   * Connect to Binance. For 50 symbols we need ~100 streams.
   * Binance allows 200 per connection, so 1 connection is enough.
   * If we ever exceed 200, we'll split into multiple connections.
   */
  connect(): void {
    if (this.isShuttingDown) return;

    // Build streams: aggTrade + forceOrder per symbol
    const allStreams: string[] = [];
    for (const sym of this.symbols) {
      allStreams.push(`${sym}@aggTrade`);
      allStreams.push(`${sym}@forceOrder`);
    }

    // Chunk into groups of MAX_STREAMS_PER_CONNECTION
    const chunks: string[][] = [];
    for (let i = 0; i < allStreams.length; i += MAX_STREAMS_PER_CONNECTION) {
      chunks.push(allStreams.slice(i, i + MAX_STREAMS_PER_CONNECTION));
    }

    logger.info('BINANCE-WS', `Connecting with ${chunks.length} connection(s)`, {
      symbols: this.symbols.length,
      totalStreams: allStreams.length,
    });

    for (const chunk of chunks) {
      this.connectChunk(chunk);
    }
  }

  private connectChunk(streams: string[]): void {
    const url = `${BINANCE_FUTURES_WS}?streams=${streams.join('/')}`;

    const ws = new WebSocket(url);

    ws.on('open', () => {
      logger.info('BINANCE-WS', `✅ Connected (${streams.length} streams)`);
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.startHeartbeat(ws);
    });

    ws.on('message', (raw: WebSocket.Data) => {
      try {
        const wrapper = JSON.parse(raw.toString());
        const data = (wrapper.data ?? wrapper) as Record<string, unknown>;
        this.handleMessage(data);
      } catch (err) {
        logger.error('BINANCE-WS', 'Parse error', { error: String(err) });
      }
    });

    ws.on('pong', () => {
      const timer = this.pongTimers.get(ws);
      if (timer) {
        clearTimeout(timer);
        this.pongTimers.delete(ws);
      }
    });

    ws.on('close', (code, reason) => {
      logger.warn('BINANCE-WS', `Connection closed`, { code, reason: reason.toString() });
      this.scheduleReconnectChunk(streams);
    });

    ws.on('error', (err) => {
      logger.warn('BINANCE-WS', `WebSocket error (expected in India)`, { error: err.message });
    });

    this.connections.push(ws);
  }

  private handleMessage(data: Record<string, unknown>): void {
    const eventType = data.e as string;

    if (eventType === 'aggTrade' && this.onTrade) {
      this.onTrade({
        symbol: data.s as string,
        price: parseFloat(data.p as string),
        quantity: parseFloat(data.q as string),
        // Binance `m`: true = buyer is market maker = SELL aggressor
        isBuyerAggressor: !(data.m as boolean),
        timestamp: data.T as number,
      });
    } else if (eventType === 'forceOrder' && this.onLiquidation) {
      const order = data.o as Record<string, unknown>;
      this.onLiquidation({
        symbol: order.s as string,
        side: (order.S as string) === 'SELL' ? 'LONG' : 'SHORT',
        quantity: parseFloat(order.q as string),
        price: parseFloat((order.ap as string) || (order.p as string)),
        timestamp: order.T as number,
      });
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        this.pongTimers.set(ws, setTimeout(() => {
          logger.warn('BINANCE-WS', 'Pong timeout, terminating');
          ws.terminate();
        }, PONG_TIMEOUT_MS));
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimers.push(timer);
  }

  private scheduleReconnectChunk(streams: string[]): void {
    if (this.isShuttingDown) return;
    logger.info('BINANCE-WS', `Reconnecting in ${this.reconnectDelay}ms...`);
    const timer = setTimeout(() => this.connectChunk(streams), this.reconnectDelay);
    this.reconnectTimers.push(timer);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  /** Start polling OI for all symbols (Binance doesn't stream OI) */
  startOiPolling(intervalMs: number): void {
    this.pollAllOi();
    this.oiPollTimer = setInterval(() => this.pollAllOi(), intervalMs);
  }

  private async pollAllOi(): Promise<void> {
    for (const symbol of this.symbols) {
      try {
        const url = `${BINANCE_FUTURES_REST}/fapi/v1/openInterest?symbol=${symbol.toUpperCase()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) continue;
        const data = await response.json() as { openInterest: string; time: number };
        if (this.onOiUpdate) {
          this.onOiUpdate({
            symbol: symbol.toUpperCase(),
            openInterest: parseFloat(data.openInterest),
            timestamp: data.time || Date.now(),
          });
        }
      } catch {
        // Expected to fail from India — silently skip
      }
    }
  }

  shutdown(): void {
    this.isShuttingDown = true;
    for (const timer of this.heartbeatTimers) clearInterval(timer);
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    if (this.oiPollTimer) clearInterval(this.oiPollTimer);
    for (const [, timer] of this.pongTimers) clearTimeout(timer);
    for (const ws of this.connections) {
      ws.close(1000, 'Shutdown');
    }
    this.connections = [];
    logger.info('BINANCE-WS', 'Shut down');
  }
}
