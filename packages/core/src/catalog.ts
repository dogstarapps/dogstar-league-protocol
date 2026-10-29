import { amount } from './money.js';
import type { Protocol, Symbol } from './types.js';
export const PROTOCOLS: {
  id: Protocol;
  label: string;
  kind: string;
  color: string;
  capability: string;
}[] = [
  {
    id: 'Aquarius',
    label: 'Aquarius',
    kind: 'AMM · LP',
    color: '#9369ee',
    capability: 'Swaps and fungible LP',
  },
  {
    id: 'Sushi',
    label: 'Sushi',
    kind: 'AMM',
    color: '#ea6c9a',
    capability: 'Spot swaps; V3 LP is outside this release',
  },
  {
    id: 'Soroswap',
    label: 'Soroswap',
    kind: 'AMM · LP',
    color: '#f9ad58',
    capability: 'Swaps and fungible LP',
  },
  {
    id: 'Blend',
    label: 'Blend',
    kind: 'Lending',
    color: '#b5e25b',
    capability: 'Supply-only deposits and withdrawals',
  },
  {
    id: 'Zenex',
    label: 'Zenex',
    kind: 'Perpetuals',
    color: '#64bef0',
    capability: 'Long / short positions isolated per player',
  },
];
export const ASSETS: {
  symbol: Symbol;
  name: string;
  color: string;
  demoPrice: bigint;
  status: 'candidate' | 'observed';
}[] = [
  ['USDC', 'USD Coin', '#2775ca', '1', 'observed'],
  ['XLM', 'Stellar', '#222222', '0.167', 'observed'],
  ['AQUA', 'Aquarius', '#745ee0', '0.00062', 'candidate'],
  ['BLND', 'Blend', '#6b943c', '0.065', 'candidate'],
  ['XTAR', 'Dogstar', '#d69051', '0.0018', 'candidate'],
  ['EURC', 'Euro Coin', '#2567be', '1.08', 'candidate'],
  ['PYUSD', 'PayPal USD', '#336cda', '1', 'candidate'],
  ['USDT0', 'USDT0', '#239c7d', '1', 'candidate'],
  ['BTC', 'BTC on Stellar', '#e99a24', '68000', 'candidate'],
  ['ETH', 'ETH on Stellar', '#6679c4', '2400', 'candidate'],
].map(([symbol, name, color, price, status]) => ({
  symbol: symbol as Symbol,
  name,
  color,
  demoPrice: amount(price),
  status: status as 'candidate' | 'observed',
}));
export const asset = (symbol: Symbol) => ASSETS.find((a) => a.symbol === symbol)!;
export const LIVE_MANIFEST = {
  network: 'PUBLIC',
  enabled: false,
  reason: 'No live execution adapters or exit policy are certified for real funds.',
  observed: {
    XLM: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
    USDC: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  },
} as const;
