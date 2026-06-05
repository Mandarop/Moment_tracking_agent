// ============================================================
// before-move: Core Type Definitions
// All data structures flowing through the system are defined here.
// A systems engineer never uses `any`. Every byte is typed.
// ============================================================

// ----- Raw Binance Websocket Payloads -----

/** Binance @aggTrade stream payload */
export interface BinanceAggTrade {
  /** Event type */
  e: 'aggTrade';
  /** Event time (ms) */
  E: number;
  /** Symbol */
  s: string;
  /** Aggregate trade ID */
  a: number;
  /** Price */
  p: string;
  /** Quantity */
  q: string;
  /** First trade ID */
  f: number;
  /** Last trade ID */
  l: number;
  /** Timestamp (ms) */
  T: number;
  /** Is the buyer the market maker? (true = SELL aggressor, false = BUY aggressor) */
  m: boolean;
}

/** Binance @markPrice stream payload (includes funding rate) */
export interface BinanceMarkPrice {
  e: 'markPriceUpdate';
  E: number;
  s: string;
  /** Mark price */
  p: string;
  /** Index price */
  i: string;
  /** Estimated settle price */
  P: string;
  /** Funding rate */
  r: string;
  /** Next funding time */
  T: number;
}

/** Binance @forceOrder stream payload (liquidation events) */
export interface BinanceLiquidation {
  e: 'forceOrder';
  E: number;
  o: {
    s: string;
    /** SELL or BUY */
    S: 'SELL' | 'BUY';
    /** Order type (LIMIT) */
    o: string;
    /** Time in force */
    f: string;
    /** Original quantity */
    q: string;
    /** Price */
    p: string;
    /** Average price */
    ap: string;
    /** Order status */
    X: string;
    /** Last filled quantity */
    l: string;
    /** Accumulated filled quantity */
    z: string;
    /** Trade time */
    T: number;
  };
}

// ----- Internal Processed Data -----

/** A single processed trade with parsed numeric values */
export interface ProcessedTrade {
  symbol: string;
  price: number;
  quantity: number;
  /** USD notional value (price * quantity) */
  quoteQuantity: number;
  /** true = buyer was the aggressor (market buy), false = seller was aggressor (market sell) */
  isBuyerAggressor: boolean;
  timestamp: number;
}

/** A single liquidation event, parsed */
export interface ProcessedLiquidation {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  price: number;
  usdValue: number;
  timestamp: number;
}

// ----- Aggregated State (per symbol, per time bucket) -----

/** A 1-minute volume profile bucket */
export interface VolumeBucket {
  symbol: string;
  /** Bucket start time (ms, floored to minute) */
  openTime: number;
  /** Bucket end time (ms) */
  closeTime: number;
  /** OHLC for the bucket */
  open: number;
  high: number;
  low: number;
  close: number;
  /** Total volume in base asset */
  totalVolume: number;
  /** Total volume in USD */
  totalQuoteVolume: number;
  /** Aggressive buy volume (USD) */
  buyVolume: number;
  /** Aggressive sell volume (USD) */
  sellVolume: number;
  /** Delta = buyVolume - sellVolume */
  delta: number;
  /** Number of trades in this bucket */
  tradeCount: number;
  /** Total long liquidation USD value in this bucket */
  longLiquidations: number;
  /** Total short liquidation USD value in this bucket */
  shortLiquidations: number;
}

/** Open Interest snapshot */
export interface OISnapshot {
  symbol: string;
  /** Open interest in contracts */
  openInterest: number;
  /** Timestamp of the snapshot */
  timestamp: number;
}

/** The full rolling state for a single symbol */
export interface SymbolState {
  symbol: string;
  /** Current price */
  lastPrice: number;
  /** Current mark price */
  markPrice: number;
  /** Current funding rate */
  fundingRate: number;
  /** Cumulative Volume Delta for the session */
  cumulativeDelta: number;
  /** Rolling 1-minute volume buckets (ring buffer, last N minutes) */
  buckets: VolumeBucket[];
  /** Rolling OI snapshots */
  oiSnapshots: OISnapshot[];
  /** Last update timestamp */
  lastUpdate: number;
  /** Historical baselines fetched on boot (for 4H and 24H macro tracking) */
  historicalBaselines?: {
    oi4hAgo: number;
    oi24hAgo: number;
    price4hAgo: number;
    price24hAgo: number;
  };
}

// ----- Anomaly / Signal Output -----

export type SignalType =
  | 'ABSORPTION'
  | 'COILED_SPRING'
  | 'EXHAUSTION'
  | 'LIQUIDATION_CASCADE'
  | 'DELTA_DIVERGENCE'
  | 'WHALE_WALL';

export type SignalDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type SignalUrgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** A detected anomaly / signal */
export interface Signal {
  id: string;
  type: SignalType;
  direction: SignalDirection;
  urgency: SignalUrgency;
  symbol: string;
  price: number;
  /** Human-readable description of what triggered this signal */
  message: string;
  /** The raw metrics that triggered this signal (for debugging and backtesting) */
  metadata: Record<string, number | string>;
  timestamp: number;
}

// ----- Configuration -----

export interface SymbolConfig {
  symbol: string;
  /** Minimum OI change % to trigger coiled spring */
  oiThresholdPct: number;
  /** Maximum price range % to qualify as "tight range" */
  tightRangePct: number;
  /** Minimum absolute delta divergence (USD) */
  deltaDivergenceThreshold: number;
  /** Minimum liquidation cascade USD value */
  liquidationCascadeThreshold: number;
}

export interface AppConfig {
  /** Symbols to track */
  symbols: SymbolConfig[];
  /** How many 1-minute buckets to keep in memory */
  rollingWindowMinutes: number;
  /** How often to poll OI from REST API (ms) */
  oiPollIntervalMs: number;
  /** Telegram bot token (optional) */
  telegramBotToken?: string;
  /** Telegram chat ID (optional) */
  telegramChatId?: string;
  /** Discord webhook URL (optional) */
  discordWebhookUrl?: string;
  /** Cooldown between duplicate signals (ms) */
  signalCooldownMs: number;
}
