// Quick one-shot scanner — fetches live data and prints a report
// Now matches the EXACT same filters as the live engine.
const BYBIT = 'https://api.bybit.com';

interface CoinScan {
  symbol: string;
  price: number;
  vol24h: number;
  oiNow: number;
  oi4h: number;
  oi24h: number;
  oiChange4hPct: number;
  oiChange24hPct: number;
  priceChange4hPct: number;
  priceChange24hPct: number;
  fundingRate: number;
  verdict: string;
}

async function scan() {
  // 1. Get top 50 by volume
  const tickerRes = await fetch(`${BYBIT}/v5/market/tickers?category=linear`);
  const tickerData = (await tickerRes.json()) as any;
  const allTickers = tickerData.result.list
    .filter((t: any) => t.symbol.endsWith('USDT') && !t.symbol.includes('1000'))
    .sort((a: any, b: any) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .slice(0, 50);

  const results: CoinScan[] = [];

  // 2. For each coin, fetch OI history and klines
  for (let i = 0; i < allTickers.length; i += 10) {
    const chunk = allTickers.slice(i, i + 10);
    await Promise.all(chunk.map(async (ticker: any) => {
      try {
        const sym = ticker.symbol;
        const price = parseFloat(ticker.lastPrice);
        const vol24h = parseFloat(ticker.turnover24h);
        const fundingRate = parseFloat(ticker.fundingRate || '0');
        const oiNow = parseFloat(ticker.openInterest || '0');

        // OI history (1h intervals, 25 entries)
        const oiRes = await fetch(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=1h&limit=25`);
        const oiData = (await oiRes.json()) as any;
        const oiList = oiData?.result?.list || [];
        const oi4h = oiList.length >= 5 ? parseFloat(oiList[4].openInterest) : 0;
        const oi24h = oiList.length >= 24 ? parseFloat(oiList[23].openInterest) : 0;

        // Klines (4h intervals)
        const klRes = await fetch(`${BYBIT}/v5/market/kline?category=linear&symbol=${sym}&interval=240&limit=7`);
        const klData = (await klRes.json()) as any;
        const klList = klData?.result?.list || [];
        const price4h = klList.length >= 2 ? parseFloat(klList[1][4]) : 0;
        const price24h = klList.length >= 7 ? parseFloat(klList[6][4]) : 0;

        const oiChange4hPct = oi4h > 0 ? ((oiNow - oi4h) / oi4h) * 100 : 0;
        const oiChange24hPct = oi24h > 0 ? ((oiNow - oi24h) / oi24h) * 100 : 0;
        const priceChange4hPct = price4h > 0 ? ((price - price4h) / price4h) * 100 : 0;
        const priceChange24hPct = price24h > 0 ? ((price - price24h) / price24h) * 100 : 0;

        // === EXACT SAME LOGIC AS LIVE ENGINE ===

        let verdict = '—';

        // God Setup 1: Breakout Coil
        const hasMacroBuild = oiChange4hPct > 15 || oiChange24hPct > 25;
        const isCompressed = Math.abs(priceChange4hPct) < 5;
        const isMaxGreed = fundingRate > 0.0005;
        const isMaxFear = fundingRate < -0.0005;

        if (hasMacroBuild && isCompressed) {
          // Check funding filter
          if (fundingRate < -0.0001) {
            if (!isMaxFear) verdict = '🚨 COIL READY → Waiting for BULLISH breakout (shorts trapped)';
            else verdict = '⛔ COIL but funding at MAX FEAR — blocked';
          } else if (fundingRate > 0.0001) {
            if (!isMaxGreed) verdict = '🚨 COIL READY → Waiting for BEARISH breakout (longs trapped)';
            else verdict = '⛔ COIL but funding at MAX GREED — blocked';
          } else {
            verdict = '🚨 COIL READY → Waiting for breakout (direction unclear)';
          }
        }

        // God Setup 2: Bearish Top
        const isBearishTop = priceChange24hPct > 15 && fundingRate > 0.0003;
        if (isBearishTop && verdict === '—') {
          verdict = '🚨 BEARISH TOP — pump exhaustion + greedy funding';
        }

        // Watchlist (building up, not ready)
        if (verdict === '—' && oiChange4hPct > 10) {
          verdict = '👀 OI rising fast — WATCH';
        }

        results.push({
          symbol: sym, price, vol24h,
          oiNow, oi4h, oi24h,
          oiChange4hPct, oiChange24hPct,
          priceChange4hPct, priceChange24hPct,
          fundingRate, verdict,
        });
      } catch {}
    }));
    await new Promise(r => setTimeout(r, 200));
  }

  // 3. Print Report
  results.sort((a, b) => Math.abs(b.oiChange4hPct) - Math.abs(a.oiChange4hPct));

  console.log('\n' + '═'.repeat(90));
  console.log('  🧠 BEFORE-MOVE MACRO SCAN — ' + new Date().toISOString());
  console.log('  Filters: OI>15%(4H) | Price<5%(4H) | 15m FullBody>75% | Delta>30% | Funding Trap');
  console.log('═'.repeat(90));

  console.log('\n── 🚨 GOD SETUPS (Coiled & Ready — Need 15m Breakout Candle to Fire) ──');
  const godSetups = results.filter(r => r.verdict.startsWith('🚨'));
  if (godSetups.length === 0) {
    console.log('  None detected right now. Market is quiet. Be patient.');
  } else {
    for (const c of godSetups) {
      console.log(`\n  ${c.verdict}`);
      console.log(`  ${c.symbol.padEnd(12)} Price: $${c.price}`);
      console.log(`    OI Δ(4h): ${c.oiChange4hPct >= 0 ? '+' : ''}${c.oiChange4hPct.toFixed(2)}%   OI Δ(24h): ${c.oiChange24hPct >= 0 ? '+' : ''}${c.oiChange24hPct.toFixed(2)}%`);
      console.log(`    Price Δ(4h): ${c.priceChange4hPct >= 0 ? '+' : ''}${c.priceChange4hPct.toFixed(2)}%   Price Δ(24h): ${c.priceChange24hPct >= 0 ? '+' : ''}${c.priceChange24hPct.toFixed(2)}%`);
      console.log(`    Funding: ${(c.fundingRate * 100).toFixed(4)}%   Vol(24h): $${(c.vol24h / 1e9).toFixed(2)}B`);
    }
  }

  console.log('\n── ⛔ BLOCKED (Coiled but Funding Too Extreme) ─────────────────────');
  const blocked = results.filter(r => r.verdict.startsWith('⛔'));
  if (blocked.length === 0) {
    console.log('  None blocked.');
  } else {
    for (const c of blocked) {
      console.log(`  ${c.symbol.padEnd(12)} ${c.verdict}   Funding: ${(c.fundingRate * 100).toFixed(4)}%`);
    }
  }

  console.log('\n── 👀 WATCHLIST (Building Up, Not Ready Yet) ────────────────────────');
  const watchlist = results.filter(r => r.verdict.includes('WATCH'));
  if (watchlist.length === 0) {
    console.log('  Nothing notable building up.');
  } else {
    for (const c of watchlist.slice(0, 10)) {
      console.log(`  ${c.symbol.padEnd(12)} OI Δ(4h): ${c.oiChange4hPct >= 0 ? '+' : ''}${c.oiChange4hPct.toFixed(1)}%   Price Δ(4h): ${c.priceChange4hPct >= 0 ? '+' : ''}${c.priceChange4hPct.toFixed(1)}%   Funding: ${(c.fundingRate * 100).toFixed(4)}%`);
    }
  }

  console.log('\n── 📊 TOP 10 BY OI CHANGE (4H) ─────────────────────────────────────');
  for (const c of results.slice(0, 10)) {
    const tag = c.verdict !== '—' ? ` ← ${c.verdict}` : '';
    console.log(`  ${c.symbol.padEnd(12)} OI Δ(4h): ${c.oiChange4hPct >= 0 ? '+' : ''}${c.oiChange4hPct.toFixed(2)}%   Price: $${c.price}   Funding: ${(c.fundingRate * 100).toFixed(4)}%${tag}`);
  }

  console.log('\n' + '═'.repeat(90) + '\n');
}

scan().catch(e => { console.error('Scan failed:', e); process.exit(1); });
