# Crypto Order Flow & Anomaly Detection System - Architecture

This document defines the architecture for a low-latency, personal-use quantitative system designed to track Binance Futures Data (Volume, CVD, and Open Interest) to detect pre-breakout anomalies.

## 1. System Overview Flowchart

```mermaid
graph TD
    subgraph "External Exchanges"
        B[Binance Futures Websocket]
    end

    subgraph "1. Data Ingestion Layer"
        WC[WS Connection Manager]
        B -->|@aggTrade, @depth, @ticker| WC
    end

    subgraph "2. Stream Processing (The Brain)"
        SA[State Aggregator]
        WC -->|Raw Tick Data| SA
        SA -->|Builds 1m/5m Profiles| CVD[Cumulative Volume Delta]
        SA -->|Tracks| OI[Open Interest Delta]
    end

    subgraph "3. Anomaly Detection Engine"
        AD[Rules Evaluator]
        CVD --> AD
        OI --> AD
        
        AD -->|Rule 1| R1[Absorption Setup\nHigh Vol + Flat Price]
        AD -->|Rule 2| R2[Coiled Spring\nOI Spikes + Tight Range]
        AD -->|Rule 3| R3[Exhaustion\nDivergence at Top/Bottom]
    end

    subgraph "4. Output & Storage"
        R1 -->|Signal| AL[Alert Manager]
        R2 -->|Signal| AL
        R3 -->|Signal| AL
        
        AL -->|Webhook| TG[Telegram / Discord]
        
        SA -->|Tick History| DB[(Local SQLite / TimescaleDB)]
    end
```

## 2. Core Components Breakdown

Since this is exclusively for Crypto, we will target **Binance USDⓈ-M Futures** as our primary data source, because it has the highest liquidity and provides the most reliable Open Interest (OI) and Order Book data.

### Component 1: Websocket Manager (`src/services/binanceWs.ts`)
*   **Purpose:** Maintain a persistent connection to Binance.
*   **Streams:**
    *   `<symbol>@aggTrade`: To calculate precise market buying vs. market selling (CVD).
    *   `<symbol>@ticker`: For real-time price and 24h rolling stats.
    *   `<symbol>@depth20`: To see the resting limit orders (Whale walls).
    *   `openInterest`: To track when new positions are opening or closing.

### Component 2: State Aggregator (`src/engine/state.ts`)
*   **Purpose:** Raw tick data is too noisy. This component groups the ticks into time-buckets (e.g., 1-minute, 5-minute).
*   **Metrics Tracked:**
    *   `Delta`: Buy Volume minus Sell Volume per minute.
    *   `Cumulative Delta (CVD)`: Running total of Delta over the session.
    *   `OI Change %`: How much Open Interest grew/shrunk in the last 5 minutes.
    *   `Price Range`: High minus Low over the last N minutes.

### Component 3: Anomaly Detector (`src/engine/strategies.ts`)
*   **Purpose:** The core intelligence. It constantly checks the `State Aggregator` against our trading rules.
*   **Example Strategy (The "Coiled Spring" you missed on June 5th):**
    ```javascript
    if (priceRange(last15Mins) < 0.3% && OISpike(last15Mins) > 10%) {
        triggerAlert("MASSIVE BUILDUP DETECTED: Spring is coiling. Breakout imminent.");
    }
    ```

### Component 4: Alerting Service (`src/services/notifier.ts`)
*   **Purpose:** Deliver the signal to you instantly.
*   **Tech:** We will use a simple Telegram Bot. It's fast, free, and delivers directly to your phone.

### Component 5: Data Storage (`src/db/sqlite.ts`)
*   **Purpose:** Store the generated signals and state data so you can look back later and see *why* an alert fired, allowing you to backtest and improve the logic.
*   **Tech:** SQLite (No heavy database installation required, it just creates a local file).

## 3. Technology Stack Choice
*   **Language:** `TypeScript / Node.js` (Perfect for heavy asynchronous WebSocket traffic).
*   **Database:** `SQLite` (For ease of use locally).
*   **Data Source:** `Binance API` (Free, no keys needed for public websocket streams).
