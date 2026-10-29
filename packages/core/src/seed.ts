import { amount } from './money.js';
import { newWorld, newRound, execute } from './engine.js';
import type { Config, Protocol, World } from './types.js';
export const DEMO_PLAYER = 'DEMO_YOUR_WALLET';
export const DEMO_SPONSOR = 'DEMO_SPONSOR';
export function template(now: number, override: Partial<Config> = {}): Config {
  return {
    id: 'dl-open',
    title: 'Stellar Open',
    description:
      'Sponsored capital. Your decisions. Explore DeFi and compete with transparent rules.',
    organizer: 'Dogstar League',
    creator: DEMO_SPONSOR,
    protocols: ['Aquarius', 'Sushi', 'Soroswap', 'Blend', 'Zenex'],
    assets: ['USDC', 'XLM', 'AQUA', 'BLND', 'XTAR', 'EURC', 'PYUSD', 'USDT0', 'BTC', 'ETH'],
    calendar: {
      fundingOpen: now - 86400,
      fundingClose: now + 3600,
      registrationOpen: now - 86400,
      registrationClose: now + 7200,
      preparationDeadline: now + 10800,
      start: now + 14400,
      riskCutoff: now + 604800,
      end: now + 608400,
      settlementDeadline: now + 694800,
    },
    capitalPerPlayer: amount(100),
    minPlayers: 2,
    maxPlayers: 12,
    playerShareBps: 10000,
    prizeTarget: amount(300),
    executionTarget: amount(10),
    executorReward: amount('0.02'),
    fundingMode: 'public',
    sponsorAllowlist: [],
    playerAllowlist: [],
    exitPolicy: 'prefunded-buyout',
    payoffCap: amount(200),
    extraPrizes: true,
    mylab: false,
    ...override,
  };
}
export function seed(now = Math.floor(Date.now() / 1000)): World {
  let w = newWorld(now);
  const active = template(now - 18000);
  w.rounds.push(newRound(active));
  const req = {
    capital: amount(1200),
    prizes: amount(300),
    execution: amount(10),
    exit: amount(2400),
  };
  w.now = active.calendar.fundingOpen + 1;
  for (const bucket of ['capital', 'prizes', 'execution', 'exit'] as const)
    w = execute(w, 'dl-open', DEMO_SPONSOR, { type: 'contribute', bucket, amount: req[bucket] });
  for (const wallet of ['DEMO_NOVA', 'DEMO_SIRIUS', 'DEMO_LUNA', 'DEMO_ORION', DEMO_PLAYER])
    w = execute(w, 'dl-open', wallet, {
      type: 'register',
      terms: w.rounds[0].terms,
      validUntil: active.calendar.registrationClose,
    });
  w.now = active.calendar.fundingClose;
  w = execute(w, 'dl-open', 'DEMO_EXECUTOR', { type: 'advance' });
  w.now = active.calendar.registrationClose;
  w = execute(w, 'dl-open', 'DEMO_EXECUTOR', { type: 'advance' });
  w.now = now;
  w = execute(w, 'dl-open', 'DEMO_EXECUTOR', { type: 'advance' });
  w = execute(w, 'dl-open', 'DEMO_NOVA', {
    type: 'swap',
    sell: 'USDC',
    buy: 'XLM',
    amount: amount(65),
    minOut: amount(380),
    protocol: 'Aquarius',
  });
  w = execute(w, 'dl-open', 'DEMO_SIRIUS', {
    type: 'position',
    kind: 'blend',
    asset: 'USDC',
    amount: amount(60),
  });
  w = execute(w, 'dl-open', 'DEMO_LUNA', {
    type: 'position',
    kind: 'perp',
    asset: 'XLM',
    amount: amount(30),
    side: 'long',
    leverage: 3,
  });
  const blend = template(now, {
    id: 'blend-builders',
    title: 'Blend Builders Cup',
    organizer: 'Blend Community',
    description: 'Explore lending, develop a strategy and compete for prizes. Funding is open.',
    protocols: ['Blend', 'Soroswap'] as Protocol[],
    maxPlayers: 20,
    minPlayers: 2,
    prizeTarget: amount(500),
    capitalPerPlayer: amount(250),
    payoffCap: amount(500),
    playerShareBps: 7500,
  });
  w.rounds.push(newRound(blend));
  w = execute(w, blend.id, DEMO_SPONSOR, {
    type: 'contribute',
    bucket: 'capital',
    amount: amount(3250),
  });
  const zenex = template(now, {
    id: 'zenex-arena',
    title: 'Zenex Trading Arena',
    organizer: 'Zenex Community',
    description:
      'Go long or short with isolated margin and funded final buyout coverage. Illustrative XLM/USD market.',
    protocols: ['Zenex', 'Sushi'] as Protocol[],
    maxPlayers: 8,
    minPlayers: 2,
    prizeTarget: amount(200),
    fundingMode: 'closed',
  });
  w.rounds.push(newRound(zenex));
  for (const b of ['capital', 'prizes', 'execution', 'exit'] as const) {
    const n =
      b === 'capital'
        ? amount(800)
        : b === 'exit'
          ? amount(1600)
          : b === 'prizes'
            ? amount(200)
            : amount(10);
    w = execute(w, zenex.id, DEMO_SPONSOR, { type: 'contribute', bucket: b, amount: n });
  }
  // No real wallets, transactions, balances, APR or market quotes are represented by these fixtures.
  return w;
}
