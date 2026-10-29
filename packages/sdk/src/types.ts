export type ContractId = string;
export interface Calendar {
  funding_open: bigint;
  funding_close: bigint;
  registration_open: bigint;
  registration_close: bigint;
  prepare_by: bigint;
  start: bigint;
  risk_cutoff: bigint;
  end: bigint;
  settle_by: bigint;
}
export interface RoundConfig {
  creator: string;
  cash: ContractId;
  assets: ContractId[];
  adapters: ContractId[];
  quote_policy: ContractId;
  calendar: Calendar;
  capital: bigint;
  min_players: number;
  max_players: number;
  share_bps: number;
  prizes: bigint;
  execution: bigint;
  reward: bigint;
  exit?: ExitPolicy;
}
export interface ExitArtifacts {
  facility_wasm: Uint8Array;
  spot_receipt_wasm: Uint8Array;
}
export interface ExitTerms {
  provider: string;
  fallback_bps: number;
  premium_bps: number;
  minimum_coverage: bigint;
  artifacts: ExitArtifacts;
}
export type ExitPolicy =
  | { tag: "CashOnly"; values?: undefined }
  | { tag: "Covered"; values: [ExitTerms] };
export interface ReceiptInfo {
  controller: string;
  round: string;
  facility: string;
  player: string;
  cash: string;
  asset: string;
  units: bigint;
  basis: bigint;
  active: boolean;
}
export interface Residual {
  owner: string;
  asset: string;
  units: bigint;
  claimed: boolean;
}
export interface ProtocolSelection {
  id: string;
  version: number;
}
export interface ProtocolVersion extends ProtocolSelection {
  adapter: ContractId;
  wasm_hash: Uint8Array;
  capabilities: number;
  metadata_hash: Uint8Array;
}
export interface RoundRecord {
  id: number;
  address: ContractId;
  creator: string;
  metadata_hash: Uint8Array;
  config_hash: Uint8Array;
  protocols: ProtocolVersion[];
  created_at: bigint;
}
export interface Totals {
  capital: bigint;
  prizes: bigint;
  execution: bigint;
  fee_reserved: bigint;
  open_orders: number;
  allocated: bigint;
  sponsor: bigint;
  players: number;
  settled: number;
  next_order: number;
  next_deposit: number;
  prize_winner?: string;
  best_recovery: bigint;
}
export interface Player {
  settled: boolean;
  claimed: boolean;
  recovery: bigint;
  payout: bigint;
}
export interface Registration {
  valid_until: bigint;
  confirmed: boolean;
  withdrawn: boolean;
}
export interface LimitOrder {
  player: string;
  sell: ContractId;
  buy: ContractId;
  amount: bigint;
  minimum: bigint;
  expires: bigint;
  open: boolean;
  premium?: bigint;
}
export interface RoundSnapshot {
  address: ContractId;
  record: RoundRecord;
  config: RoundConfig;
  totals: Totals;
  phase: number;
  terms: Uint8Array;
  registrations: string[];
}
export interface Deployment {
  protocolVersion?: "0.2.0" | "0.3.0" | "0.4.0";
  schemaVersion: 1;
  network: "TESTNET";
  rpcUrl: string;
  readSource: string;
  factory: { address: ContractId; wasmHash: string; interfaceHash: string };
  registry: { address: ContractId; wasmHash: string; interfaceHash: string };
  tournament: { wasmHash: string; interfaceHash: string };
  cash: { address: ContractId; symbol: string; decimals: number };
  protocols: {
    id: string;
    version: number;
    name: string;
    capabilities: number;
    adapter: ContractId;
    wasmHash: string;
    assets: { address: ContractId; symbol: string; decimals: number }[];
  }[];
  environment: "testnet";
}
export interface RoundMetadata {
  schemaVersion: 1;
  name: string;
  description: string;
  organizer: { name: string; website?: string; bio?: string };
}
export const PHASES = [
  "Funding",
  "Registration",
  "Ready",
  "Live",
  "Settling",
  "Completed",
  "Cancelled",
] as const;

export interface ManagedPosition {
  id: number;
  player: string;
  adapter: string;
  vault: string;
  vault_hash: Uint8Array;
  basis: bigint;
  open: boolean;
}
export interface VaultContext {
  round: string;
  player: string;
  facility: string;
  adapter: string;
  cash: string;
  basis: bigint;
  quote_policy: string;
  quote_hash: Uint8Array;
}
