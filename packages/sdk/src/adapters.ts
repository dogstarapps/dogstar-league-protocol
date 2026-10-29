import type { Amount } from '../../core/src/types.js';
export type ProtocolId = string;
/** Production admission record. Symbols alone never identify tokens or approve a venue. */
export interface AssetIdentity {
  network: 'TESTNET' | 'PUBLIC';
  contractId: string;
  decimals: number;
  code?: string;
  issuer?: string;
}
export interface Admission {
  protocol: ProtocolId;
  contractId: string;
  codeHash: string;
  assets: AssetIdentity[];
  quotePolicy: string;
  maxExposure: Amount;
  nativeExitTested: boolean;
  buyoutTested: boolean;
  approved: boolean;
}
export interface SpotQuote {
  protocol: ProtocolId;
  sell: string;
  buy: string;
  amountIn: Amount;
  minimumNetOut: Amount;
  validUntil: number;
  routeHash: string;
}
export interface PositionReceipt {
  controller: string;
  isolatedVault: string;
  protocol: ProtocolId;
  externalId: string;
  ownerRound: string;
  ownerPlayer: string;
}
export interface ExitQuote {
  receipt: PositionReceipt;
  eligibleRecovery: Amount;
  cashReserved: Amount;
  deadline: number;
  finalBuyout: boolean;
  residualOwner: string;
}
/** Metadata alone cannot authorize a venue: the registry and selected code must also be checked. */
export const admissionStatus = (record: Admission, onChainAvailable: boolean) => ({
  enabled: onChainAvailable && record.approved && record.nativeExitTested && record.buyoutTested,
  record,
});
