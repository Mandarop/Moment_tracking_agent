// ============================================================
// before-move: SQLite Storage Layer (sql.js — pure JS/WASM)
//
// Persists signals and state snapshots to disk so you can:
//   1. Review past signals and see what triggered them
//   2. Backtest your strategies against historical data
//   3. Tune thresholds based on hit/miss analysis
//
// sql.js compiles SQLite to WebAssembly — zero native dependencies.
// Works on every machine without Visual Studio build tools.
// ============================================================

import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import type { Signal, VolumeBucket } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/before_move.db');

export class Storage {
  private db: Database;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /** Factory: create and initialize the storage */
  static async create(): Promise<Storage> {
    // Ensure the data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const SQL = await initSqlJs();

    // Load existing database file if it exists
    let db: Database;
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
      logger.info('DB', `Loaded existing database from ${DB_PATH}`);
    } else {
      db = new SQL.Database();
      logger.info('DB', `Created new database at ${DB_PATH}`);
    }

    const storage = new Storage(db, DB_PATH);
    storage.createTables();

    // Auto-save to disk every 30 seconds
    storage.saveTimer = setInterval(() => {
      storage.saveToDisk();
    }, 30_000);

    return storage;
  }

  /** Write the in-memory database to disk */
  private saveToDisk(): void {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (err) {
      logger.error('DB', `Failed to save database to disk`, { error: String(err) });
    }
  }

  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        direction TEXT NOT NULL,
        urgency TEXT NOT NULL,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT NOT NULL,
        conviction_score INTEGER NOT NULL,
        btc_confirmed INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS volume_buckets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        open_time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        total_volume REAL NOT NULL,
        total_quote_volume REAL NOT NULL,
        buy_volume REAL NOT NULL,
        sell_volume REAL NOT NULL,
        delta REAL NOT NULL,
        trade_count INTEGER NOT NULL,
        long_liquidations REAL DEFAULT 0,
        short_liquidations REAL DEFAULT 0,
        UNIQUE(symbol, open_time)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS oi_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        open_interest REAL NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_buckets_symbol_time ON volume_buckets(symbol, open_time)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_oi_symbol_time ON oi_snapshots(symbol, timestamp)`);
  }

  /** Persist a signal */
  saveSignal(signal: Signal): void {
    this.db.run(
      `INSERT OR IGNORE INTO signals (id, type, direction, urgency, symbol, price, message, metadata, conviction_score, btc_confirmed, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        signal.id,
        signal.type,
        signal.direction,
        signal.urgency,
        signal.symbol,
        signal.price,
        signal.message,
        JSON.stringify(signal.metadata),
        signal.convictionScore,
        signal.btcConfirmed ? 1 : 0,
        signal.timestamp,
      ]
    );
  }

  /** Persist a completed volume bucket */
  saveBucket(bucket: VolumeBucket): void {
    this.db.run(
      `INSERT OR REPLACE INTO volume_buckets
        (symbol, open_time, open, high, low, close, total_volume, total_quote_volume, buy_volume, sell_volume, delta, trade_count, long_liquidations, short_liquidations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bucket.symbol,
        bucket.openTime,
        bucket.open,
        bucket.high,
        bucket.low,
        bucket.close,
        bucket.totalVolume,
        bucket.totalQuoteVolume,
        bucket.buyVolume,
        bucket.sellVolume,
        bucket.delta,
        bucket.tradeCount,
        bucket.longLiquidations,
        bucket.shortLiquidations,
      ]
    );
  }

  /** Persist an OI snapshot */
  saveOiSnapshot(symbol: string, oi: number, timestamp: number): void {
    this.db.run(
      `INSERT INTO oi_snapshots (symbol, open_interest, timestamp) VALUES (?, ?, ?)`,
      [symbol, oi, timestamp]
    );
  }

  /** Get recent signals for display */
  getRecentSignals(limit: number = 50): Signal[] {
    const results = this.db.exec(
      `SELECT id, type, direction, urgency, symbol, price, message, metadata, conviction_score, btc_confirmed, timestamp
       FROM signals ORDER BY timestamp DESC LIMIT ${limit}`
    );

    if (results.length === 0) return [];

    const rows = results[0];
    return rows.values.map((row: unknown[]) => ({
      id: row[0] as string,
      type: row[1] as Signal['type'],
      direction: row[2] as Signal['direction'],
      urgency: row[3] as Signal['urgency'],
      symbol: row[4] as string,
      price: row[5] as number,
      message: row[6] as string,
      metadata: JSON.parse(row[7] as string),
      convictionScore: row[8] as number,
      btcConfirmed: (row[9] as number) === 1,
      timestamp: row[10] as number,
    }));
  }

  /** Clean up old data (older than N days) */
  cleanup(daysToKeep: number = 30): void {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    this.db.run('DELETE FROM volume_buckets WHERE open_time < ?', [cutoff]);
    this.db.run('DELETE FROM oi_snapshots WHERE timestamp < ?', [cutoff]);
    logger.info('DB', `Cleanup complete for data older than ${daysToKeep} days`);
  }

  /** Close the database and save to disk */
  close(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
    this.db.close();
    logger.info('DB', 'Database saved and closed');
  }
}
