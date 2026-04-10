// pages/index.js
import { useEffect, useState } from 'react';
import { ethers } from 'ethers';

export async function getServerSideProps() {
  try {
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

    return {
      props: {
        initialAeroPrice: aeroPrice,
        initialVeloPrice: veloPrice,
        aeroSupply,
        veloSupply,
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
      },
    };
  }
}

export default function Home({ initialAeroPrice, initialVeloPrice, aeroSupply, veloSupply }) {
  const [aeroPrice, setAeroPrice] = useState(initialAeroPrice);
  const [veloPrice, setVeloPrice] = useState(initialVeloPrice);
  const [aeroAmount, setAeroAmount] = useState(10000);
  const [veloAmount, setVeloAmount] = useState(200000);
  const [totalNewTokens, setTotalNewTokens] = useState(2000000000); // Default 2 billion

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
            <h2>Real-Time Data</h2>
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
        </div>
      </div>
    </div>
  );
}
