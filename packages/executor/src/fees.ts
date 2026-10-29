export interface FeePolicy {
  maxFee: bigint;
  totalFeeBudget: bigint;
  minSurplus: bigint;
  allowUnprofitable: boolean;
}
export const DEFAULT_FEE_POLICY: FeePolicy = {
  maxFee: 10000000n,
  totalFeeBudget: 0n,
  minSurplus: 1000n,
  allowUnprofitable: false,
};
export function checkFee(fee: bigint, reward: bigint, policy: FeePolicy) {
  if (
    fee < 0n ||
    reward < 0n ||
    policy.maxFee <= 0n ||
    policy.totalFeeBudget < 0n ||
    policy.minSurplus < 0n
  )
    throw new Error("Invalid operator fee policy.");
  if (fee > policy.maxFee)
    throw new Error("Assembled transaction exceeds the operator fee cap.");
  if (!policy.allowUnprofitable && reward - fee < policy.minSurplus)
    throw new Error(
      "Eligible reward does not cover the assembled fee and required surplus.",
    );
}
