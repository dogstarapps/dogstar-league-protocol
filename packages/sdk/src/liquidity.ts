import { Address } from "@stellar/stellar-sdk";
import { BoundContract, LeagueClient, hex } from "./client.js";
import { TestnetClient } from "./testnet.js";
import type {
  Deployment,
  DirectSettings,
  LpSettings,
  ProtocolVersion,
} from "./types.js";

const MAX_I128 = (1n << 127n) - 1n;
function positive(value: bigint, label: string) {
  if (value <= 0n || value > MAX_I128) throw new Error(`Invalid ${label}.`);
  return value;
}
function ratio(amount: bigint, units: bigint, supply: bigint) {
  return (amount * units) / positive(supply, "LP supply");
}
export interface LiquidityProjection {
  used: [bigint, bigint];
  idle: [bigint, bigint];
  units: bigint;
  components: [bigint, bigint];
}
/** Project an existing pair after conversion/synchronization. The final transaction simulation
 * also checks actual minting, possible protocol-fee dilution and independent value on chain. */
export function projectLiquidity(
  desired: [bigint, bigint],
  reserves: [bigint, bigint],
  supply: bigint,
): LiquidityProjection {
  [...desired, ...reserves, supply].forEach((n) =>
    positive(n, "liquidity amount"),
  );
  const optimal1 = (desired[0] * reserves[1]) / reserves[0];
  const used: [bigint, bigint] =
    optimal1 <= desired[1]
      ? [desired[0], optimal1]
      : [(desired[1] * reserves[0]) / reserves[1], desired[1]];
  const units = positive(
    [
      ratio(used[0], supply, reserves[0]),
      ratio(used[1], supply, reserves[1]),
    ].reduce((a, b) => (a < b ? a : b)),
    "minted LP quantity",
  );
  const idle: [bigint, bigint] = [desired[0] - used[0], desired[1] - used[1]];
  const afterSupply = positive(supply + units, "post-mint LP supply");
  return {
    used,
    idle,
    units,
    components: [
      ratio(
        positive(reserves[0] + used[0], "post-mint reserve"),
        units,
        afterSupply,
      ) + idle[0],
      ratio(
        positive(reserves[1] + used[1], "post-mint reserve"),
        units,
        afterSupply,
      ) + idle[1],
    ],
  };
}
export interface LiquidityEntryQuote {
  adapter: string;
  amount: bigint;
  checkedAt: number;
  validUntil: number;
  assets: [string, string];
  lpDecimals: number;
  legs: { cash: bigint; expected: bigint; independentMinimum: bigint }[];
  minimums: [bigint, bigint, bigint];
  projection: LiquidityProjection;
  independentValue: bigint;
  requiredValue: bigint;
  eligible: boolean;
  reasons: string[];
}
export function assertLiquidityQuote(
  quote: LiquidityEntryQuote,
  adapter: string,
  amount: bigint,
  now = Math.floor(Date.now() / 1000),
) {
  if (quote.adapter !== adapter || quote.amount !== amount)
    throw new Error(
      "The liquidity amount or protocol changed. Refresh the quote.",
    );
  if (now < quote.checkedAt || now >= quote.validUntil)
    throw new Error("The liquidity quote expired. Refresh it before signing.");
  if (!quote.eligible) throw new Error(quote.reasons.join(" "));
}
/** Read-only, code-checked quote for the direct-router LP implementation. This helper never
 * approves a protocol or moves funds. It requires an already selected deployment admission. */
export async function quoteLiquidityEntry(
  deployment: Deployment,
  adapter: string,
  amount: bigint,
  slippageBps = 50,
): Promise<LiquidityEntryQuote> {
  const checkedAt = Math.floor(Date.now() / 1000);
  positive(amount, "cash input");
  if (
    amount < 2n ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 1000
  )
    throw new Error("Invalid liquidity amount or slippage.");
  const protocol = deployment.protocols.find(
    (p) => p.adapter === adapter && (p.capabilities & 18) === 18,
  );
  if (!protocol || !deployment.quotePolicy)
    throw new Error("Select an admitted LP protocol and quote policy.");
  const registry = new LeagueClient(deployment).registry();
  const selection = { id: protocol.id, version: protocol.version };
  const [record, available] = await Promise.all([
    registry.read<ProtocolVersion>("get", selection),
    registry.read<boolean>("available", selection),
  ]);
  if (
    !available ||
    record.adapter !== adapter ||
    record.capabilities !== protocol.capabilities ||
    hex(record.wasm_hash) !== protocol.wasmHash
  )
    throw new Error(
      "The LP protocol admission is unavailable or differs from the registry.",
    );
  const source = deployment.readSource,
    rpcUrl = deployment.rpcUrl;
  const settings = await new BoundContract(
    "lp_adapter",
    adapter,
    source,
    rpcUrl,
    protocol.wasmHash,
  ).read<LpSettings>("config");
  const assets: [string, string] = [settings.asset0, settings.asset1];
  if (
    settings.cash !== deployment.cash.address ||
    !assets.includes(settings.cash) ||
    assets[0] === assets[1] ||
    !assets.every((a) =>
      protocol.assets.some((known) => known.address === a),
    ) ||
    settings.minimum_entry_bps < 9000 ||
    settings.minimum_entry_bps > 10000
  )
    throw new Error(
      "This quote requires the admitted direct pair with one cash leg.",
    );
  const swap = new BoundContract(
    "direct_swap",
    settings.swap_adapter,
    source,
    rpcUrl,
    hex(settings.swap_hash),
  );
  const route = await swap.read<DirectSettings>("config");
  for (const field of [
    "router",
    "factory",
    "pair",
    "asset0",
    "asset1",
  ] as const)
    if (route[field] !== settings[field])
      throw new Error("LP conversion route mismatch.");
  for (const field of ["router_hash", "factory_hash", "pair_hash"] as const)
    if (hex(route[field]) !== hex(settings[field]))
      throw new Error("LP conversion code mismatch.");
  const pair = new TestnetClient({
    contractId: settings.pair,
    source,
    rpcUrl,
    expectedCodeHash: hex(settings.pair_hash),
  });
  const [reserves, supply, balances, lpDecimals] = await Promise.all([
    pair.read("get_reserves") as Promise<[bigint, bigint]>,
    pair.read("total_supply") as Promise<bigint>,
    Promise.all(
      assets.map((contractId) =>
        new TestnetClient({ contractId, source, rpcUrl }).read("balance", [
          new Address(settings.pair).toScVal(),
        ]),
      ),
    ) as Promise<[bigint, bigint]>,
    pair.read("decimals") as Promise<number>,
  ]);
  if (!Number.isInteger(lpDecimals) || lpDecimals < 0 || lpDecimals > 18)
    throw new Error("Invalid LP token decimals.");
  if (
    reserves.length !== 2 ||
    balances.length !== 2 ||
    balances.some((n, i) => n < reserves[i])
  )
    throw new Error(
      "Pair reserves and actual balances disagree. Refresh the quote.",
    );
  const policy = new BoundContract(
    "price_policy",
    deployment.quotePolicy.address,
    source,
    rpcUrl,
    deployment.quotePolicy.wasmHash,
  );
  const splits: [bigint, bigint] = [amount / 2n, amount - amount / 2n];
  const legs: LiquidityEntryQuote["legs"] = [];
  const desired: [bigint, bigint] = [0n, 0n];
  const projectedReserves: [bigint, bigint] = [...balances];
  const minimums: [bigint, bigint, bigint] = [0n, 0n, 0n];
  const reasons: string[] = [];
  for (const [i, asset] of assets.entries()) {
    const cash = splits[i];
    const unchanged = asset === settings.cash;
    const expected = positive(
      unchanged
        ? cash
        : await swap.read<bigint>("quote", {
            sell: settings.cash,
            buy: asset,
            amount: cash,
          }),
      "conversion output",
    );
    const independentMinimum = unchanged
      ? cash
      : await policy.read<bigint>("minimum", {
          sell: settings.cash,
          buy: asset,
          amount: cash,
        });
    positive(independentMinimum, "independent conversion minimum");
    legs.push({ cash, expected, independentMinimum });
    desired[i] = expected;
    const userMinimum = positive(
      (expected * BigInt(10000 - slippageBps)) / 10000n,
      "conversion minimum",
    );
    minimums[i] =
      userMinimum > independentMinimum ? userMinimum : independentMinimum;
    if (expected < independentMinimum)
      reasons.push(
        "The conversion quote is below the independent price floor.",
      );
    if (!unchanged) {
      projectedReserves[i] -= expected;
      projectedReserves[1 - i] += cash;
    }
  }
  const projection = projectLiquidity(desired, projectedReserves, supply);
  minimums[2] = positive(
    (projection.units * BigInt(10000 - slippageBps)) / 10000n,
    "minimum LP quantity",
  );
  let independentValue = 0n;
  for (const [i, asset] of assets.entries()) {
    const component = projection.components[i];
    independentValue +=
      asset === settings.cash
        ? component
        : await policy.read<bigint>("minimum", {
            sell: asset,
            buy: settings.cash,
            amount: component,
          });
  }
  const requiredValue = (amount * BigInt(settings.minimum_entry_bps)) / 10000n;
  if (independentValue < requiredValue)
    reasons.push(
      "The expected LP value is below the configured independent entry floor.",
    );
  return {
    adapter,
    amount,
    checkedAt,
    validUntil: checkedAt + 30,
    assets,
    lpDecimals,
    legs,
    minimums,
    projection,
    independentValue,
    requiredValue,
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}
