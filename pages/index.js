// pages/index.js
import { useEffect, useState } from 'react';
import { ethers } from 'ethers';

const HISTORY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_RETRY_DELAY_MS = 2500;
const COINBASE_MAX_CANDLES_PER_REQUEST = 300;

const HISTORY_RANGES = [
  { key: '1', label: '24H' },
  { key: '7', label: '7D' },
  { key: '30', label: '30D' },
  { key: '60', label: '60D' },
  { key: '365', label: '1Y' },
  { key: '730', label: '2Y' },
];

const FIXED_YIELD_TOKEN_AMOUNTS = {
  AERO: 61809,
  VELO: 1800000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, retries = 1) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 429 && attempt < retries) {
        await sleep(HISTORY_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(HISTORY_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError;
}

function formatHistoryError(error) {
  const message = String(error?.message || error || '');

  if (message.includes('429')) {
    return 'Coinbase historical data rate limit reached. Please wait a moment and try again.';
  }

  if (message.toLowerCase().includes('failed to fetch')) {
    return 'Historical data request failed. This is usually a temporary network or Coinbase availability issue.';
  }

  return message || 'Unable to load historical market data.';
}

function getCoinbaseGranularity(days) {
  if (days <= 1) {
    return 3600;
  }
  if (days <= 7) {
    return 21600;
  }
  return 86400;
}

function buildCoinbaseCandlesUrls(productId, days) {
  const granularity = getCoinbaseGranularity(Number(days));
  const end = Math.floor(Date.now() / 1000);
  const start = end - Number(days) * 24 * 60 * 60;
  const chunkDuration = granularity * (COINBASE_MAX_CANDLES_PER_REQUEST - 1);
  const urls = [];

  for (let chunkStart = start; chunkStart < end; chunkStart += chunkDuration) {
    const chunkEnd = Math.min(chunkStart + chunkDuration, end);
    const params = new URLSearchParams({
      granularity: String(granularity),
      start: String(chunkStart),
      end: String(chunkEnd),
    });
    urls.push(`https://api.exchange.coinbase.com/products/${productId}/candles?${params.toString()}`);
  }

  return urls;
}

async function fetchCoinbaseCandles(productId, days) {
  const urls = buildCoinbaseCandlesUrls(productId, days);
  const candles = [];

  // Fetch sequentially to avoid a burst of requests when loading multi-year ranges.
  for (const url of urls) {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw new Error(`Unable to load ${productId} historical market data (${response.status}).`);
    }
    const chunk = await response.json();
    if (Array.isArray(chunk)) {
      candles.push(...chunk);
    }
  }

  return candles;
}

function candlesToPrices(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => [Number(candle[0]) * 1000, Number(candle[4])])
    .filter(([timestamp, price]) => Number.isFinite(timestamp) && Number.isFinite(price) && price > 0)
    .sort((a, b) => a[0] - b[0]);
}

function parseYieldCsv(csvText) {
  const [headerLine, ...lines] = csvText.trim().split(/\r?\n/);
  const headers = headerLine.split(',').map((value) => value.trim());

  return lines
    .map((line) => {
      const values = line.split(',').map((value) => value.trim());
      return headers.reduce((row, header, index) => ({
        ...row,
        [header]: header === 'date' ? values[index] : Number(values[index]),
      }), {});
    })
    .filter((row) => row.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function toDateKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

async function readYieldCsvText(fs, path) {
  const candidates = [
    path.join(process.cwd(), 'pages', 'data.csv'),
    path.join(process.cwd(), 'data.csv'),
    path.join(process.cwd(), 'public', 'data.csv'),
  ];

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const response = await fetch('https://raw.githubusercontent.com/8280998/neweaero/main/pages/data.csv');
  if (!response.ok) {
    throw new Error(`Unable to load data.csv: ${response.status}`);
  }
  return response.text();
}

async function fetchTokenDailyPrices(productId, tokenLabel, startDate, endDate) {
  const prices = new Map();
  const chunkMs = 250 * 24 * 60 * 60 * 1000;
  let cursor = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T23:59:59.000Z`).getTime();

  while (cursor <= end) {
    const chunkEnd = Math.min(cursor + chunkMs, end);
    const params = new URLSearchParams({
      granularity: '86400',
      start: new Date(cursor).toISOString(),
      end: new Date(chunkEnd).toISOString(),
    });
    const response = await fetch(`https://api.exchange.coinbase.com/products/${productId}/candles?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Unable to load ${tokenLabel} historical prices: ${response.status}`);
    }
    const candles = await response.json();
    candlesToPrices(candles).forEach(([timestamp, price]) => {
      prices.set(toDateKey(timestamp), price);
    });
    cursor = chunkEnd + 24 * 60 * 60 * 1000;
  }

  return prices;
}

async function fetchAeroDailyPrices(startDate, endDate) {
  return fetchTokenDailyPrices('AERO-USD', 'AERO', startDate, endDate);
}

async function fetchVeloDailyPrices(startDate, endDate) {
  return fetchTokenDailyPrices('VELO-USD', 'VELO', startDate, endDate);
}

function getNearestPrice(priceMap, date, fallbackPrice = 0) {
  const target = new Date(`${date}T00:00:00.000Z`).getTime();
  for (let offset = 0; offset <= 3; offset += 1) {
    const forward = toDateKey(target + offset * 24 * 60 * 60 * 1000);
    const backward = toDateKey(target - offset * 24 * 60 * 60 * 1000);
    if (priceMap.has(forward)) {
      return priceMap.get(forward);
    }
    if (priceMap.has(backward)) {
      return priceMap.get(backward);
    }
  }
  return fallbackPrice;
}

function buildYieldAnalytics(rows, priceMap, fallbackPrice = 0, warning = '', options = {}) {
  const {
    incomeKey = 'sum',
    tokenLabel = 'AERO',
    fixedTokenAmount = FIXED_YIELD_TOKEN_AMOUNTS[tokenLabel],
  } = options;
  const validRows = rows.filter((row) => (
    row.date
    && Number.isFinite(fixedTokenAmount)
    && fixedTokenAmount > 0
    && Number.isFinite(row[incomeKey])
  ));

  if (!validRows.length) {
    return {
      rows: [],
      totalProfit: 0,
      compoundProfit: 0,
      simpleAnnualYield: 0,
      compoundAnnualYield: 0,
      weeks: 0,
      initialCapital: 0,
      finalToken: 0,
      finalTokenPerInitialToken: 0,
      simpleIncomePerToken: 0,
      compoundIncomePerToken: 0,
      latestIncomePerToken: 0,
      startDate: '',
      endDate: '',
      tokenLabel,
      warning,
    };
  }

  const enriched = validRows.map((row) => {
    const price = getNearestPrice(priceMap, row.date, fallbackPrice);
    const tokenAmount = fixedTokenAmount;
    const income = row[incomeKey];
    const capital = tokenAmount * price;
    const weeklyYield = capital > 0 ? income / capital : 0;
    return {
      ...row,
      tokenAmount,
      income,
      price,
      capital,
      weeklyYield,
    };
  });

  let compoundToken = enriched[0].tokenAmount;
  let compoundProfit = 0;
  const series = enriched.map((row) => {
    const profitPerToken = row.tokenAmount > 0 ? row.income / row.tokenAmount : 0;
    const compoundedWeekProfit = compoundToken * profitPerToken;
    const reinvestedToken = row.price > 0 ? compoundedWeekProfit / row.price : 0;
    compoundToken += reinvestedToken;
    compoundProfit += compoundedWeekProfit;

    return {
      ...row,
      profitPerToken,
      compoundedWeekProfit,
      reinvestedToken,
      compoundToken,
      cumulativeProfit: 0,
      cumulativeCompoundProfit: compoundProfit,
    };
  });

  let runningProfit = 0;
  let runningYieldRate = 0;
  let runningCompoundMultiplier = 1;
  const rowsWithCumulative = series.map((row) => {
    runningProfit += row.income;
    runningYieldRate += row.weeklyYield;
    runningCompoundMultiplier *= 1 + row.weeklyYield;
    return {
      ...row,
      cumulativeProfit: runningProfit,
      cumulativeYieldRate: runningYieldRate,
      cumulativeCompoundYieldRate: runningCompoundMultiplier - 1,
    };
  });

  const initialCapital = rowsWithCumulative[0].capital;
  const totalProfit = runningProfit;
  const initialToken = rowsWithCumulative[0].tokenAmount || 0;
  const rowsWithRates = rowsWithCumulative.map((row) => {
    const cumulativeReturnRate = row.cumulativeYieldRate * 100;
    const cumulativeCompoundReturnRate = row.cumulativeCompoundYieldRate * 100;
    const annualizedReturnRate = row.weeklyYield * 52 * 100;
    const annualizedCompoundReturnRate = ((1 + row.weeklyYield) ** 52 - 1) * 100;

    return {
      ...row,
      cumulativeReturnRate,
      cumulativeCompoundReturnRate,
      annualizedReturnRate,
      annualizedCompoundReturnRate,
      weeklyYieldRate: row.weeklyYield * 100,
    };
  });
  const latestRates = rowsWithRates[rowsWithRates.length - 1];

  return {
    rows: rowsWithRates,
    totalProfit,
    compoundProfit,
    simpleAnnualYield: latestRates?.annualizedReturnRate || 0,
    compoundAnnualYield: latestRates?.annualizedCompoundReturnRate || 0,
    weeks: rowsWithCumulative.length,
    initialCapital,
    finalToken: compoundToken,
    finalTokenPerInitialToken: initialToken > 0 ? compoundToken / initialToken : 0,
    simpleIncomePerToken: initialToken > 0 ? totalProfit / initialToken : 0,
    compoundIncomePerToken: initialToken > 0 ? compoundProfit / initialToken : 0,
    latestIncomePerToken: initialToken > 0 ? rowsWithCumulative[rowsWithCumulative.length - 1].profitPerToken : 0,
    startDate: rowsWithCumulative[0].date,
    endDate: rowsWithCumulative[rowsWithCumulative.length - 1].date,
    tokenLabel,
    warning,
  };
}

export async function getServerSideProps() {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    // Fetch supplies on-chain
    const baseProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');
    const optimismProvider = new ethers.JsonRpcProvider('https://mainnet.optimism.io');
    const erc20Abi = ['function totalSupply() external view returns (uint256)'];

    const aeroContract = new ethers.Contract('0x940181a94a35a4569e4529a3cdfb74e38fd98631', erc20Abi, baseProvider);
    const veloContract = new ethers.Contract('0x9560e827af36c94d2ac33a39bce1fe78631088db', erc20Abi, optimismProvider);

    const aeroSupplyRaw = await aeroContract.totalSupply();
    const veloSupplyRaw = await veloContract.totalSupply();

    const aeroSupply = Number(ethers.formatUnits(aeroSupplyRaw, 18));
    const veloSupply = Number(ethers.formatUnits(veloSupplyRaw, 18));

    // Fetch AERO price from Coinbase
    const aeroPriceRes = await fetch('https://api.coinbase.com/v2/prices/AERO-USD/spot');
    const aeroPriceData = await aeroPriceRes.json();
    const aeroPrice = parseFloat(aeroPriceData.data?.amount || 0);

    // Fetch VELO price from Coinbase
    const veloPriceRes = await fetch('https://api.coinbase.com/v2/prices/VELO-USD/spot');
    const veloPriceData = await veloPriceRes.json();
    const veloPrice = parseFloat(veloPriceData.data?.amount || 0);
    let yieldAnalytics = buildYieldAnalytics([], new Map(), aeroPrice, '', { tokenLabel: 'AERO' });
    let veloYieldAnalytics = buildYieldAnalytics([], new Map(), veloPrice, '', {
      incomeKey: 'velo_sum',
      tokenLabel: 'VELO',
    });
    try {
      const csvText = await readYieldCsvText(fs, path);
      const yieldRows = parseYieldCsv(csvText);
      let aeroPriceMap = new Map();
      let veloPriceMap = new Map();
      let aeroYieldWarning = '';
      let veloYieldWarning = '';
      try {
        aeroPriceMap = yieldRows.length
          ? await fetchAeroDailyPrices(yieldRows[0].date, yieldRows[yieldRows.length - 1].date)
          : new Map();
      } catch (priceError) {
        console.error('Error loading AERO historical prices:', priceError);
        aeroYieldWarning = 'AERO historical prices were unavailable, so current AERO price was used as a temporary estimate.';
      }
      try {
        veloPriceMap = yieldRows.length
          ? await fetchVeloDailyPrices(yieldRows[0].date, yieldRows[yieldRows.length - 1].date)
          : new Map();
      } catch (priceError) {
        console.error('Error loading VELO historical prices:', priceError);
        veloYieldWarning = 'VELO historical prices were unavailable, so current VELO price was used as a temporary estimate.';
      }
      yieldAnalytics = buildYieldAnalytics(yieldRows, aeroPriceMap, aeroPrice, aeroYieldWarning, { tokenLabel: 'AERO' });
      veloYieldAnalytics = buildYieldAnalytics(yieldRows, veloPriceMap, veloPrice, veloYieldWarning, {
        incomeKey: 'velo_sum',
        tokenLabel: 'VELO',
      });
    } catch (yieldError) {
      console.error('Error loading yield data:', yieldError);
      const warning = yieldError.message || 'Unable to load data.csv';
      yieldAnalytics = buildYieldAnalytics([], new Map(), aeroPrice, warning, { tokenLabel: 'AERO' });
      veloYieldAnalytics = buildYieldAnalytics([], new Map(), veloPrice, warning, {
        incomeKey: 'velo_sum',
        tokenLabel: 'VELO',
      });
    }

    return {
      props: {
        initialAeroPrice: aeroPrice,
        initialVeloPrice: veloPrice,
        aeroSupply,
        veloSupply,
        yieldAnalytics,
        veloYieldAnalytics,
      },
    };
  } catch (error) {
    console.error('Error fetching data:', error);
    return {
      props: {
        initialAeroPrice: 0,
        initialVeloPrice: 0,
        aeroSupply: 0,
        veloSupply: 0,
        yieldAnalytics: buildYieldAnalytics([], new Map(), 0, '', { tokenLabel: 'AERO' }),
        veloYieldAnalytics: buildYieldAnalytics([], new Map(), 0, '', {
          incomeKey: 'velo_sum',
          tokenLabel: 'VELO',
        }),
      },
    };
  }
}

function YieldPanel({ analytics, formatCurrency }) {
  const [hoveredYieldIndex, setHoveredYieldIndex] = useState(null);
  const yieldRows = analytics?.rows || [];
  const tokenLabel = analytics?.tokenLabel || 'AERO';
  const yieldMetricKeys = [
    'annualizedReturnRate',
    'annualizedCompoundReturnRate',
    'cumulativeReturnRate',
    'cumulativeCompoundReturnRate',
  ];
  const yieldChartMax = yieldRows.length > 0
    ? Math.max(...yieldRows.map((point) => Math.max(...yieldMetricKeys.map((key) => point[key] || 0))), 1)
    : 1;
  const yieldChartMin = 0;
  const yieldChartSpread = Math.max(yieldChartMax - yieldChartMin, 1);
  const buildYieldPath = (key) => yieldRows.map((point, index) => {
    const x = (index / Math.max(yieldRows.length - 1, 1)) * 100;
    const y = 100 - ((point[key] - yieldChartMin) / yieldChartSpread) * 100;
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');
  const annualizedYieldPath = buildYieldPath('annualizedReturnRate');
  const annualizedCompoundYieldPath = buildYieldPath('annualizedCompoundReturnRate');
  const cumulativeYieldPath = buildYieldPath('cumulativeReturnRate');
  const cumulativeCompoundYieldPath = buildYieldPath('cumulativeCompoundReturnRate');
  const latestYieldRow = yieldRows.length > 0 ? yieldRows[yieldRows.length - 1] : null;
  const yieldTickValues = [yieldChartMax, yieldChartMax / 2, 0];
  const hoveredYieldPoint = hoveredYieldIndex !== null ? yieldRows[hoveredYieldIndex] : latestYieldRow;
  const hoveredYieldX = hoveredYieldIndex !== null
    ? 84 + (hoveredYieldIndex / Math.max(yieldRows.length - 1, 1)) * 636
    : null;
  const getYieldChartY = (value) => 40 + (100 - (((value || 0) - yieldChartMin) / yieldChartSpread) * 100) * 2.08;
  const hoveredYieldY = hoveredYieldPoint ? getYieldChartY(hoveredYieldPoint.annualizedCompoundReturnRate) : null;
  const handleYieldMouseMove = (event) => {
    if (yieldRows.length <= 1) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * 760;
    const chartX = Math.min(Math.max(svgX, 84), 720);
    const nextIndex = Math.round(((chartX - 84) / 636) * (yieldRows.length - 1));
    setHoveredYieldIndex(Math.min(Math.max(nextIndex, 0), yieldRows.length - 1));
  };

  return (
    <div style={{
      background: '#fff',
      border: '1px solid #d8dfeb',
      borderRadius: '18px',
      padding: '20px',
      boxShadow: '0 18px 45px rgba(23, 32, 51, 0.08)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div>
          <h2 style={{ margin: 0 }}>{tokenLabel} Weekly Voting Yield</h2>
          <p style={{ margin: '8px 0 0', color: '#5f6f8a' }}>
            Based on weekly {tokenLabel} count and USD income, with same-day Coinbase {tokenLabel} prices for reinvestment estimates.
          </p>
        </div>
        <div style={{ color: '#5f6f8a', fontSize: '13px' }}>
          {analytics?.weeks || 0} weekly records
        </div>
      </div>
      {analytics?.warning && (
        <p style={{ margin: '0 0 14px', color: '#b45309', fontSize: '14px' }}>
          {analytics.warning}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px', marginBottom: '18px' }}>
        <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
          <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Annualized Yield</div>
          <div style={{ fontSize: '28px', fontWeight: 700 }}>{(analytics?.simpleAnnualYield || 0).toFixed(2)}%</div>
          <div style={{ marginTop: '8px', color: '#5f6f8a', fontSize: '14px' }}>Latest weekly voting income annualized against that week&apos;s {tokenLabel} value.</div>
        </div>
        <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
          <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Estimated Compound APY</div>
          <div style={{ fontSize: '28px', fontWeight: 700 }}>{(analytics?.compoundAnnualYield || 0).toFixed(2)}%</div>
          <div style={{ marginTop: '8px', color: '#5f6f8a', fontSize: '14px' }}>Latest weekly yield compounded for 52 weeks.</div>
        </div>
        <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
          <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>1 {tokenLabel} Income</div>
          <div style={{ fontSize: '28px', fontWeight: 700 }}>{formatCurrency(analytics?.simpleIncomePerToken || 0, 6)}</div>
          <div style={{ marginTop: '8px', color: '#5f6f8a', fontSize: '14px' }}>Non-compounded income per initial {tokenLabel} since {analytics?.startDate || '2025-01-02'}.</div>
        </div>
        <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
          <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>1 {tokenLabel} Compound</div>
          <div style={{ fontSize: '28px', fontWeight: 700 }}>{formatCurrency(analytics?.compoundIncomePerToken || 0, 6)}</div>
          <div style={{ marginTop: '8px', color: '#5f6f8a', fontSize: '14px' }}>Estimated compounded income per initial {tokenLabel} since {analytics?.startDate || '2025-01-02'}.</div>
        </div>
        <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
          <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Final {tokenLabel}</div>
          <div style={{ fontSize: '28px', fontWeight: 700 }}>
            {Number(analytics?.finalTokenPerInitialToken || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}
          </div>
          <div style={{ marginTop: '8px', color: '#5f6f8a', fontSize: '14px' }}>Final {tokenLabel} per 1 initial {tokenLabel} after weekly reinvestment.</div>
        </div>
      </div>

      <div style={{ border: '1px solid #d8dfeb', borderRadius: '16px', padding: '18px', background: 'linear-gradient(180deg, #fbfcff 0%, #f3f7ff 100%)' }}>
        {yieldRows.length > 1 ? (
          <>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '12px', color: '#5f6f8a', fontSize: '13px' }}>
              <span><strong style={{ color: '#f97316' }}>Orange</strong> weekly annualized yield</span>
              <span><strong style={{ color: '#7c3aed' }}>Violet</strong> weekly compound APY</span>
              <span><strong style={{ color: '#2563eb' }}>Blue</strong> cumulative yield</span>
              <span><strong style={{ color: '#16a34a' }}>Green</strong> cumulative compound yield</span>
            </div>
            <div style={{ width: '100%', overflowX: 'auto' }}>
              <svg
                viewBox="0 0 760 320"
                style={{ width: '100%', height: 'auto', display: 'block' }}
                role="img"
                aria-label={`${tokenLabel} weekly yield chart`}
                onMouseMove={handleYieldMouseMove}
                onMouseLeave={() => setHoveredYieldIndex(null)}
              >
                <rect x="0" y="0" width="760" height="320" rx="24" fill="#fbfcff" />
                {[52, 140, 228].map((y, index) => (
                  <g key={y}>
                    <line x1="84" y1={y} x2="720" y2={y} stroke="#d8dfeb" strokeDasharray="4 6" />
                    <text x="72" y={y + 4} textAnchor="end" fill="#5f6f8a" fontSize="12">
                      {yieldTickValues[index].toFixed(2)}%
                    </text>
                  </g>
                ))}
                <path d={annualizedYieldPath} transform="translate(84 40) scale(6.36 2.08)" fill="none" stroke="#f97316" strokeWidth="0.9" strokeDasharray="4 4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <path d={annualizedCompoundYieldPath} transform="translate(84 40) scale(6.36 2.08)" fill="none" stroke="#7c3aed" strokeWidth="0.9" strokeDasharray="4 4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <path d={cumulativeYieldPath} transform="translate(84 40) scale(6.36 2.08)" fill="none" stroke="#2563eb" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <path d={cumulativeCompoundYieldPath} transform="translate(84 40) scale(6.36 2.08)" fill="none" stroke="#16a34a" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                {yieldRows.map((point, index) => {
                  if (index === 0 || index === yieldRows.length - 1 || index === Math.floor(yieldRows.length / 2)) {
                    const x = 84 + (index / Math.max(yieldRows.length - 1, 1)) * 636;
                    return (
                      <g key={point.date}>
                        <line x1={x} y1="40" x2={x} y2="248" stroke="rgba(95, 111, 138, 0.16)" />
                        <text x={x} y="280" textAnchor="middle" fill="#5f6f8a" fontSize="12">
                          {point.date.slice(5)}
                        </text>
                      </g>
                    );
                  }
                  return null;
                })}
                {latestYieldRow && (
                  <text x="718" y="36" textAnchor="end" fill="#172033" fontSize="12" fontWeight="700">
                    {latestYieldRow.annualizedCompoundReturnRate.toFixed(2)}%
                  </text>
                )}
                {hoveredYieldPoint && hoveredYieldX !== null && hoveredYieldY !== null && (
                  <g pointerEvents="none">
                    <line x1={hoveredYieldX} y1="40" x2={hoveredYieldX} y2="248" stroke="rgba(23, 32, 51, 0.22)" />
                    <circle cx={hoveredYieldX} cy={getYieldChartY(hoveredYieldPoint.annualizedReturnRate)} r="3" fill="#f97316" />
                    <circle cx={hoveredYieldX} cy={getYieldChartY(hoveredYieldPoint.annualizedCompoundReturnRate)} r="3" fill="#7c3aed" />
                    <circle cx={hoveredYieldX} cy={getYieldChartY(hoveredYieldPoint.cumulativeReturnRate)} r="3" fill="#2563eb" />
                    <circle cx={hoveredYieldX} cy={getYieldChartY(hoveredYieldPoint.cumulativeCompoundReturnRate)} r="3" fill="#16a34a" />
                    <g transform={`translate(${Math.min(Math.max(hoveredYieldX - 86, 96), 496)} ${Math.max(hoveredYieldY - 112, 48)})`}>
                      <rect width="218" height="104" rx="10" fill="#172033" opacity="0.94" />
                      <text x="12" y="20" fill="#fff" fontSize="12" fontWeight="700">{hoveredYieldPoint.date}</text>
                      <text x="12" y="40" fill="#fed7aa" fontSize="12">Weekly annualized: {hoveredYieldPoint.annualizedReturnRate.toFixed(2)}%</text>
                      <text x="12" y="58" fill="#ddd6fe" fontSize="12">Weekly compound APY: {hoveredYieldPoint.annualizedCompoundReturnRate.toFixed(2)}%</text>
                      <text x="12" y="76" fill="#c7d2fe" fontSize="12">Cumulative: {hoveredYieldPoint.cumulativeReturnRate.toFixed(2)}%</text>
                      <text x="12" y="94" fill="#bbf7d0" fontSize="12">Cumulative compound: {hoveredYieldPoint.cumulativeCompoundReturnRate.toFixed(2)}%</text>
                    </g>
                  </g>
                )}
              </svg>
            </div>
          </>
        ) : (
          <p style={{ margin: 0, color: '#5f6f8a' }}>
            {analytics?.warning || `No ${tokenLabel} yield data loaded from data.csv.`}
          </p>
        )}
      </div>
    </div>
  );
}

export default function Home({ initialAeroPrice, initialVeloPrice, aeroSupply, veloSupply, yieldAnalytics, veloYieldAnalytics }) {
  const [aeroPrice, setAeroPrice] = useState(initialAeroPrice);
  const [veloPrice, setVeloPrice] = useState(initialVeloPrice);
  const [aeroAmount, setAeroAmount] = useState(10000);
  const [veloAmount, setVeloAmount] = useState(200000);
  const [totalNewTokens, setTotalNewTokens] = useState(2000000000); // Default 2 billion
  const [historyRange, setHistoryRange] = useState('7');
  const [historySeries, setHistorySeries] = useState([]);
  const [historyStatus, setHistoryStatus] = useState('idle');
  const [historyError, setHistoryError] = useState('');

  const formatCurrency = (value, digits = 4) => (
    `$${Number.isFinite(value) ? value.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }) : '0.0000'}`
  );

  // Merger calculations
  const aeroAllocation = totalNewTokens * 0.945;
  const veloAllocation = totalNewTokens * 0.055;

  const aeroPerNew = aeroSupply / aeroAllocation;
  const veloPerNew = veloSupply / veloAllocation;

  const aeroImpliedPrice = aeroPerNew * aeroPrice;
  const veloImpliedPrice = veloPerNew * veloPrice;

  const aeroNewForInput = (aeroAmount / aeroSupply) * aeroAllocation;
  const veloNewForInput = (veloAmount / veloSupply) * veloAllocation;
  const totalNewForInput = aeroNewForInput + veloNewForInput;
  const cheaperRoute = aeroImpliedPrice <= veloImpliedPrice ? 'AERO' : 'VELO';
  const richerRoute = cheaperRoute === 'AERO' ? 'VELO' : 'AERO';
  const cheaperImpliedPrice = Math.min(aeroImpliedPrice, veloImpliedPrice);
  const richerImpliedPrice = Math.max(aeroImpliedPrice, veloImpliedPrice);
  const arbitrageSpread = richerImpliedPrice - cheaperImpliedPrice;
  const arbitrageEdge = cheaperImpliedPrice > 0 ? (arbitrageSpread / cheaperImpliedPrice) * 100 : 0;
  const chartMax = Math.max(aeroImpliedPrice, veloImpliedPrice, 0.0001);
  const chartBars = [
    {
      label: 'AERO Route',
      shortLabel: 'AERO',
      value: aeroImpliedPrice,
      color: '#2563eb',
      height: `${(aeroImpliedPrice / chartMax) * 100}%`,
      isBest: cheaperRoute === 'AERO',
    },
    {
      label: 'VELO Route',
      shortLabel: 'VELO',
      value: veloImpliedPrice,
      color: '#f97316',
      height: `${(veloImpliedPrice / chartMax) * 100}%`,
      isBest: cheaperRoute === 'VELO',
    },
  ];
  const historyMax = historySeries.length > 0 ? Math.max(...historySeries.map((point) => point.edge), 0.0001) : 1;
  const historyMin = historySeries.length > 0 ? Math.min(...historySeries.map((point) => point.edge), 0) : 0;
  const historyLatest = historySeries.length > 0 ? historySeries[historySeries.length - 1].edge : 0;
  const historyPeak = historySeries.length > 0 ? Math.max(...historySeries.map((point) => point.edge)) : 0;
  const historyAverage = historySeries.length > 0
    ? historySeries.reduce((sum, point) => sum + point.edge, 0) / historySeries.length
    : 0;
  const historySpread = Math.max(historyMax - historyMin, 0.0001);
  const historyPath = historySeries.map((point, index) => {
    const x = (index / Math.max(historySeries.length - 1, 1)) * 100;
    const y = 100 - ((point.edge - historyMin) / historySpread) * 100;
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');
  const historyAreaPath = historySeries.length > 0
    ? `${historyPath} L 100 100 L 0 100 Z`
    : '';
  const historyTickValues = [historyMax, historyMin + historySpread / 2, historyMin];
  const formatHistoryLabel = (timestamp) => {
    const days = Number(historyRange);
    let options = { month: 'short', day: 'numeric' };
    if (days === 1) {
      options = { hour: '2-digit', minute: '2-digit' };
    } else if (days > 60) {
      options = { month: 'short', year: 'numeric' };
    }

    return new Date(timestamp).toLocaleString(undefined, options);
  };

  useEffect(() => {
    const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['AERO-USD', 'VELO-USD'],
        channel: 'ticker',
      }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'ticker') {
        const productId = data.product_id;
        const price = parseFloat(data.price);
        if (productId === 'AERO-USD') {
          setAeroPrice(price);
        } else if (productId === 'VELO-USD') {
          setVeloPrice(price);
        }
      }
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
    };

    return () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchHistoricalArbitrage({ silent = false } = {}) {
      if (!silent) {
        setHistoryStatus('loading');
      }
      setHistoryError('');

      try {
        const [aeroCandles, veloCandles] = await Promise.all([
          fetchCoinbaseCandles('AERO-USD', historyRange),
          fetchCoinbaseCandles('VELO-USD', historyRange),
        ]);

        const bucketSize = getCoinbaseGranularity(Number(historyRange)) * 1000;
        const normalizePrices = (prices) => prices.reduce((acc, [timestamp, price]) => {
          const bucket = Math.round(timestamp / bucketSize) * bucketSize;
          acc.set(bucket, price);
          return acc;
        }, new Map());

        const aeroMap = normalizePrices(candlesToPrices(aeroCandles));
        const veloMap = normalizePrices(candlesToPrices(veloCandles));
        const alignedTimestamps = [...aeroMap.keys()].filter((timestamp) => veloMap.has(timestamp)).sort((a, b) => a - b);

        const nextSeries = alignedTimestamps.map((timestamp) => {
          const historicalAeroPrice = aeroMap.get(timestamp);
          const historicalVeloPrice = veloMap.get(timestamp);
          const historicalAeroImplied = aeroPerNew * historicalAeroPrice;
          const historicalVeloImplied = veloPerNew * historicalVeloPrice;
          const low = Math.min(historicalAeroImplied, historicalVeloImplied);
          const high = Math.max(historicalAeroImplied, historicalVeloImplied);
          const edge = low > 0 ? ((high - low) / low) * 100 : 0;

          return {
            timestamp,
            edge,
            label: formatHistoryLabel(timestamp),
          };
        });

        if (!cancelled) {
          setHistorySeries(nextSeries);
          setHistoryStatus('ready');
        }
      } catch (error) {
        if (!cancelled) {
          if (!silent) {
            setHistorySeries([]);
          }
          setHistoryStatus('error');
          setHistoryError(formatHistoryError(error));
        }
      }
    }

    if (aeroPerNew > 0 && veloPerNew > 0) {
      fetchHistoricalArbitrage();
    }

    const refreshTimer = setInterval(() => {
      if (!cancelled && aeroPerNew > 0 && veloPerNew > 0) {
        fetchHistoricalArbitrage({ silent: true });
      }
    }, HISTORY_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
    };
  }, [historyRange, aeroPerNew, veloPerNew]);

  const handleAeroAmountChange = (e) => {
    setAeroAmount(parseFloat(e.target.value) || 0);
  };

  const handleVeloAmountChange = (e) => {
    setVeloAmount(parseFloat(e.target.value) || 0);
  };

  const handleTotalNewTokensChange = (e) => {
    setTotalNewTokens(parseFloat(e.target.value) || 10000000000);
  };

  return (
    <div style={{
      fontFamily: 'Arial, sans-serif',
      margin: '0',
      minHeight: '100vh',
      padding: '24px',
      background: 'linear-gradient(180deg, #eef4ff 0%, #f8fbff 48%, #f4f7fb 100%)',
      color: '#172033',
    }}>
      <div style={{ maxWidth: '1120px', margin: '0 auto' }}>
        <h1 style={{ marginTop: 0 }}>AERO/VELO Merger Calculator</h1>
        <div id="input-section" style={{
          marginBottom: '20px',
          background: '#fff',
          border: '1px solid #d8dfeb',
          borderRadius: '18px',
          padding: '20px',
          boxShadow: '0 18px 45px rgba(23, 32, 51, 0.08)',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
            <label htmlFor="aero-amount" style={{ display: 'grid', gap: '8px', color: '#5f6f8a' }}>
              <span>Enter AERO Amount</span>
              <input type="number" id="aero-amount" value={aeroAmount} onChange={handleAeroAmountChange} min="0" style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid #d8dfeb' }} />
            </label>
            <label htmlFor="velo-amount" style={{ display: 'grid', gap: '8px', color: '#5f6f8a' }}>
              <span>Enter VELO Amount</span>
              <input type="number" id="velo-amount" value={veloAmount} onChange={handleVeloAmountChange} min="0" style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid #d8dfeb' }} />
            </label>
            <label htmlFor="total-new-tokens" style={{ display: 'grid', gap: '8px', color: '#5f6f8a' }}>
              <span>Enter Total New Tokens</span>
              <input type="number" id="total-new-tokens" value={totalNewTokens} onChange={handleTotalNewTokensChange} min="0" style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid #d8dfeb' }} />
            </label>
          </div>
        </div>
        <div id="results" style={{ display: 'grid', gap: '20px' }}>
          <div style={{
            background: '#fff',
            border: '1px solid #d8dfeb',
            borderRadius: '18px',
            padding: '20px',
            boxShadow: '0 18px 45px rgba(23, 32, 51, 0.08)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
              <h2 style={{ margin: 0 }}>Real-Time Data</h2>
              <span
                translate="no"
                style={{
                  color: '#4f5f78',
                  fontSize: '12px',
                  lineHeight: 1.4,
                  background: '#f4f7fb',
                  border: '1px solid #d8dfeb',
                  borderRadius: '999px',
                  padding: '4px 10px',
                  whiteSpace: 'nowrap',
                }}
              >
                Source: Coinbase WebSocket prices / Base and Optimism on-chain supply
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
                <thead>
                  <tr>
                    <th style={{ border: '1px solid #ddd', padding: '8px', backgroundColor: '#f2f2f2' }}>Token</th>
                    <th style={{ border: '1px solid #ddd', padding: '8px', backgroundColor: '#f2f2f2' }}>Total Supply</th>
                    <th style={{ border: '1px solid #ddd', padding: '8px', backgroundColor: '#f2f2f2' }}>Price (USD)</th>
                    <th style={{ border: '1px solid #ddd', padding: '8px', backgroundColor: '#f2f2f2' }}>Tokens Needed for 1 New Token</th>
                    <th style={{ border: '1px solid #ddd', padding: '8px', backgroundColor: '#f2f2f2' }}>Implied New Token Price (USD)</th>
                    <th style={{ border: '1px solid #ddd', padding: '8px', backgroundColor: '#f2f2f2' }}>New Tokens for Input Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>AERO</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{aeroSupply.toLocaleString()}</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{formatCurrency(aeroPrice)}</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{aeroPerNew.toFixed(6)}</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{formatCurrency(aeroImpliedPrice)}</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{aeroNewForInput.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  </tr>
                  <tr>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>VELO</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{veloSupply.toLocaleString()}</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{formatCurrency(veloPrice)}</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{veloPerNew.toFixed(6)}</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{formatCurrency(veloImpliedPrice)}</td>
                    <td style={{ border: '1px solid #ddd', padding: '8px' }}>{veloNewForInput.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h2>Merger Allocations (Based on Custom Total New Tokens)</h2>
            <p>AERO Allocation: {aeroAllocation.toLocaleString()} tokens (94.5%)</p>
            <p>VELO Allocation: {veloAllocation.toLocaleString()} tokens (5.5%)</p>
            <h2>Total New Tokens You Can Get</h2>
            <p>{totalNewForInput.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
          </div>

          <div style={{
            background: '#fff',
            border: '1px solid #d8dfeb',
            borderRadius: '18px',
            padding: '20px',
            boxShadow: '0 18px 45px rgba(23, 32, 51, 0.08)',
          }}>
            <h2>Arbitrage View</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '14px', marginBottom: '18px' }}>
              <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
                <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Cheaper Merge Path</div>
                <div style={{ fontSize: '28px', fontWeight: 700 }}>{cheaperRoute}</div>
                <div style={{ marginTop: '8px', color: '#5f6f8a', fontSize: '14px' }}>{cheaperRoute} implies a lower synthetic merged-token cost than {richerRoute}.</div>
              </div>
              <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
                <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Price Spread</div>
                <div style={{ fontSize: '28px', fontWeight: 700 }}>{formatCurrency(arbitrageSpread)}</div>
                <div style={{ marginTop: '8px', color: '#5f6f8a', fontSize: '14px' }}>Absolute gap between the two implied new-token prices.</div>
              </div>
              <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
                <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Arbitrage Edge</div>
                <div style={{ fontSize: '28px', fontWeight: 700 }}>{arbitrageEdge.toFixed(2)}%</div>
                <div style={{ marginTop: '8px', color: '#5f6f8a', fontSize: '14px' }}>Buy through {cheaperRoute}, benchmark against {richerRoute}&apos;s richer implied valuation.</div>
              </div>
            </div>

            <div style={{ border: '1px solid #d8dfeb', borderRadius: '16px', padding: '18px', background: 'linear-gradient(180deg, #fbfcff 0%, #f3f7ff 100%)' }}>
              <h3 style={{ marginTop: 0 }}>Implied New Token Price Comparison</h3>
              <div style={{ height: '280px', display: 'flex', alignItems: 'stretch', gap: '18px', padding: '24px 10px 12px', borderBottom: '1px solid #d8dfeb' }}>
                {chartBars.map((bar) => (
                  <div key={bar.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', minWidth: 0 }}>
                    <div style={{ marginBottom: '10px', fontSize: '14px', fontWeight: 700, color: '#172033' }}>{formatCurrency(bar.value)}</div>
                    <div style={{
                      width: '100%',
                      maxWidth: '180px',
                      height: bar.height,
                      minHeight: '10px',
                      borderRadius: '18px 18px 6px 6px',
                      background: bar.color,
                      opacity: bar.isBest ? 1 : 0.8,
                      boxShadow: bar.isBest ? '0 14px 24px rgba(22, 163, 74, 0.18)' : 'none',
                    }} />
                    <div style={{ marginTop: '12px', fontSize: '14px', color: '#172033' }}>{bar.label}</div>
                    <div style={{ marginTop: '6px', fontSize: '12px', color: '#5f6f8a' }}>{bar.isBest ? 'Lower implied price' : 'Higher implied price'}</div>
                  </div>
                ))}
              </div>
              <p style={{ marginBottom: 0, color: '#5f6f8a' }}>
                {cheaperRoute} currently offers the cheaper synthetic entry into the merged token. The implied-price gap is {formatCurrency(arbitrageSpread)} or {arbitrageEdge.toFixed(2)}%.
              </p>
            </div>
          </div>

          <div style={{
            background: '#fff',
            border: '1px solid #d8dfeb',
            borderRadius: '18px',
            padding: '20px',
            boxShadow: '0 18px 45px rgba(23, 32, 51, 0.08)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
              <div>
                <h2 style={{ margin: 0 }}>Historical Arbitrage %</h2>
                <p style={{ margin: '8px 0 0', color: '#5f6f8a' }}>
                  The line shows the historical percentage gap between the cheaper and richer implied merged-token route.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {HISTORY_RANGES.map((range) => (
                  <button
                    key={range.key}
                    type="button"
                    onClick={() => setHistoryRange(range.key)}
                    style={{
                      padding: '9px 14px',
                      borderRadius: '999px',
                      border: historyRange === range.key ? '1px solid #2563eb' : '1px solid #d8dfeb',
                      background: historyRange === range.key ? '#2563eb' : '#fff',
                      color: historyRange === range.key ? '#fff' : '#172033',
                      cursor: 'pointer',
                    }}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px', marginBottom: '18px' }}>
              <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
                <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Latest</div>
                <div style={{ fontSize: '28px', fontWeight: 700 }}>{arbitrageEdge.toFixed(2)}%</div>
              </div>
              <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
                <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Peak</div>
                <div style={{ fontSize: '28px', fontWeight: 700 }}>{historyPeak.toFixed(2)}%</div>
              </div>
              <div style={{ border: '1px solid #d8dfeb', borderRadius: '14px', padding: '16px', background: 'linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)' }}>
                <div style={{ fontSize: '13px', color: '#5f6f8a', marginBottom: '8px' }}>Average</div>
                <div style={{ fontSize: '28px', fontWeight: 700 }}>{historyAverage.toFixed(2)}%</div>
              </div>
            </div>

            <div style={{ border: '1px solid #d8dfeb', borderRadius: '16px', padding: '18px', background: 'linear-gradient(180deg, #fbfcff 0%, #f3f7ff 100%)' }}>
              {historyStatus === 'loading' && (
                <p style={{ margin: 0, color: '#5f6f8a' }}>Loading historical arbitrage data...</p>
              )}
              {historyStatus === 'error' && (
                <p style={{ margin: 0, color: '#b42318' }}>{historyError}</p>
              )}
              {historyStatus === 'ready' && historySeries.length > 1 && (
                <>
                  <div style={{ width: '100%', overflowX: 'auto' }}>
                    <svg viewBox="0 0 760 320" style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Historical arbitrage percent chart">
                      <rect x="0" y="0" width="760" height="320" rx="24" fill="#fbfcff" />
                      {[52, 140, 228].map((y, index) => (
                        <g key={y}>
                          <line x1="72" y1={y} x2="720" y2={y} stroke="#d8dfeb" strokeDasharray="4 6" />
                          <text x="60" y={y + 4} textAnchor="end" fill="#5f6f8a" fontSize="12">
                            {historyTickValues[index].toFixed(2)}%
                          </text>
                        </g>
                      ))}
                      <path d={historyAreaPath} transform="translate(72 40) scale(6.48 2.08)" fill="rgba(37, 99, 235, 0.06)" />
                      <path d={historyPath} transform="translate(72 40) scale(6.48 2.08)" fill="none" stroke="#2563eb" strokeWidth="0.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                      {historySeries.map((point, index) => {
                        if (index === 0 || index === historySeries.length - 1 || index === Math.floor(historySeries.length / 2)) {
                          const x = 72 + (index / Math.max(historySeries.length - 1, 1)) * 648;
                          return (
                            <g key={point.timestamp}>
                              <line x1={x} y1="40" x2={x} y2="248" stroke="rgba(95, 111, 138, 0.18)" />
                              <text x={x} y="280" textAnchor="middle" fill="#5f6f8a" fontSize="12">
                                {point.label}
                              </text>
                            </g>
                          );
                        }
                        return null;
                      })}
                      {historySeries.map((point, index) => {
                        if (index === historySeries.length - 1) {
                          const x = 72 + (index / Math.max(historySeries.length - 1, 1)) * 648;
                          const y = 40 + (100 - ((point.edge - historyMin) / historySpread) * 100) * 2.08;
                          return (
                            <g key={`${point.timestamp}-latest`}>
                              <circle cx={x} cy={y} r="3" fill="#2563eb" />
                              <text x={x - 8} y={y - 12} textAnchor="end" fill="#172033" fontSize="12" fontWeight="700">
                                {point.edge.toFixed(2)}%
                              </text>
                            </g>
                          );
                        }
                        return null;
                      })}
                    </svg>
                  </div>
                  <p style={{ marginBottom: 0, color: '#5f6f8a' }}>
                    Source  https://aero.xyz/articles/aero-economic-case
                  </p>
                </>
              )}
            </div>
          </div>

          <YieldPanel analytics={yieldAnalytics} formatCurrency={formatCurrency} />
          <YieldPanel analytics={veloYieldAnalytics} formatCurrency={formatCurrency} />
        </div>
      </div>
    </div>
  );
}
