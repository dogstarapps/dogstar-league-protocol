export type Amount = bigint;
export type Protocol = 'Aquarius' | 'Sushi' | 'Soroswap' | 'Blend' | 'Zenex';
export type Bucket = 'capital' | 'prizes' | 'execution' | 'exit';
export type Phase =
  'funding' | 'registration' | 'ready' | 'active' | 'settling' | 'settled' | 'cancelled';
export type Symbol =
  'USDC' | 'XLM' | 'AQUA' | 'BLND' | 'XTAR' | 'EURC' | 'PYUSD' | 'USDT0' | 'BTC' | 'ETH';
export interface Calendar {
  fundingOpen: number;
  fundingClose: number;
  registrationOpen: number;
  registrationClose: number;
  preparationDeadline: number;
  start: number;
  riskCutoff: number;
  end: number;
  settlementDeadline: number;
}
export interface Config {
  id: string;
  title: string;
  description: string;
  organizer: string;
  organizerWebsite?: string;
  organizerBio?: string;
  creator: string;
  protocols: Protocol[];
  assets: Symbol[];
  calendar: Calendar;
  capitalPerPlayer: Amount;
  minPlayers: number;
  maxPlayers: number;
  playerShareBps: number;
  prizeTarget: Amount;
  executionTarget: Amount;
  executorReward: Amount;
  fundingMode: 'public' | 'private' | 'closed';
  sponsorAllowlist: string[];
  playerAllowlist: string[];
  exitPolicy: 'prefunded-buyout';
  payoffCap: Amount; // Explicit per-player final recovery cap, distinct from profit share.
  extraPrizes: boolean;
  mylab: false; // No emission capability in this version.
}
export interface Contribution {
  id: string;
  owner: string;
  bucket: Bucket;
  amount: Amount;
  claimed: boolean;
}
export interface Registration {
  wallet: string;
  terms: string;
  validUntil: number;
  confirmed: boolean;
  withdrawn: boolean;
}
export interface Position {
  id: string;
  kind: 'lp' | 'blend' | 'perp';
  protocol: Protocol;
  asset: Symbol;
  principal: Amount;
  units: Amount;
  openedAt: number;
  side?: 'long' | 'short';
  leverage?: number;
  entryPrice?: Amount;
  nativeBlocked: boolean;
}
export interface Player {
  wallet: string;
  nickname: string;
  balances: Partial<Record<Symbol, Amount>>;
  positions: Position[];
  prepared: boolean;
  recovery?: Amount;
  playerPayout: Amount;
  sponsorReturn: Amount;
  prize: Amount;
  claimed: boolean;
  settled: boolean;
}
export interface LimitOrder {
  id: string;
  wallet: string;
  sell: Symbol;
  buy: Symbol;
  amount: Amount;
  minimum: Amount;
  expires: number;
  reward: Amount;
  state: 'open' | 'filled' | 'cancelled' | 'expired';
  nonce: number;
}
export interface Residual {
  position: Position;
  formerPlayer: string;
  owner: 'exit-facility';
  cashPaid: Amount;
}
export interface Event {
  id: number;
  at: number;
  roundId: string;
  kind: string;
  actor: string;
  detail: string;
}
export interface Round {
  config: Config;
  terms: string;
  phase: Phase;
  budgets: Record<Bucket, Amount>;
  contributions: Contribution[];
  registrations: Registration[];
  players: Player[];
  orders: LimitOrder[];
  residuals: Residual[];
  executorEarnings: Record<string, Amount>;
  feeReserved: Amount;
  snapshot?: { prices: World['prices']; at: number };
  sponsorPool: Amount;
  settledCapital: Amount;
  nonce: number;
  fundingSealed: boolean;
}
export interface World {
  schema: 1;
  now: number;
  rounds: Round[];
  events: Event[];
  prices: Record<Symbol, Amount>;
}
export type Command =
  | { type: 'contribute'; bucket: Bucket; amount: Amount }
  | { type: 'register'; terms: string; validUntil: number; nickname?: string }
  | { type: 'leave' }
  | { type: 'advance' }
  | { type: 'swap'; sell: Symbol; buy: Symbol; amount: Amount; minOut: Amount; protocol: Protocol }
  | { type: 'limit'; sell: Symbol; buy: Symbol; amount: Amount; minimum: Amount; expires: number }
  | { type: 'cancel'; orderId: string }
  | { type: 'fill'; orderId: string; protocol: Protocol }
  | {
      type: 'position';
      kind: Position['kind'];
      asset: Symbol;
      amount: Amount;
      side?: 'long' | 'short';
      leverage?: number;
    }
  | { type: 'close-position'; positionId: string }
  | { type: 'settle-player'; wallet: string }
  | { type: 'finalize' }
  | { type: 'claim'; beneficiary: string }
  | { type: 'refund'; contributionId: string }
  | { type: 'sponsor-claim'; contributionId: string };
