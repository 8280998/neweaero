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
    <div style={{ fontFamily: 'Arial, sans-serif', margin: '20px' }}>
      <h1>AERO/VELO Merger Calculator</h1>
      <div id="input-section" style={{ marginBottom: '20px' }}>
        <label htmlFor="aero-amount">Enter AERO Amount:</label>
        <input type="number" id="aero-amount" value={aeroAmount} onChange={handleAeroAmountChange} min="0" />
        <br /><br />
        <label htmlFor="velo-amount">Enter VELO Amount:</label>
        <input type="number" id="velo-amount" value={veloAmount} onChange={handleVeloAmountChange} min="0" />
        <br /><br />
        <label htmlFor="total-new-tokens">Enter Total New Tokens:</label>
        <input type="number" id="total-new-tokens" value={totalNewTokens} onChange={handleTotalNewTokensChange} min="0" />
      </div>
      <div id="results">
        <h2>Real-Time Data</h2>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
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
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>${aeroPrice.toFixed(4)}</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>{aeroPerNew.toFixed(6)}</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>${aeroImpliedPrice.toFixed(4)}</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>{aeroNewForInput.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>VELO</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>{veloSupply.toLocaleString()}</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>${veloPrice.toFixed(4)}</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>{veloPerNew.toFixed(6)}</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>${veloImpliedPrice.toFixed(4)}</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>{veloNewForInput.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            </tr>
          </tbody>
        </table>
        <h2>Merger Allocations (Based on Custom Total New Tokens)</h2>
        <p>AERO Allocation: {aeroAllocation.toLocaleString()} tokens (94.5%)</p>
        <p>VELO Allocation: {veloAllocation.toLocaleString()} tokens (5.5%)</p>
        <h2>Total New Tokens You Can Get</h2>
        <p>{totalNewForInput.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
      </div>
    </div>
  );
}
