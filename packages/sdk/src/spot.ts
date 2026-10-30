import { StrKey } from "@stellar/stellar-sdk";
import {
  BoundContract,
  LeagueClient,
  V5_BUILD_ARTIFACTS,
  hex,
} from "./client.js";
import type {
  Deployment,
  DirectSettings,
  RoundConfig,
  RoundRecord,
} from "./types.js";

const MAX_I128 = (1n << 127n) - 1n;
function positive(value: bigint, label: string) {
  if (value <= 0n || value > MAX_I128)
    throw new Error(`Enter a positive ${label} within the token range.`);
  return value;
}
export interface SpotTradeInput {
  adapter: string;
  sell: string;
  buy: string;
  amount: bigint;
  slippageBps?: number;
}
export function spotTradeRequirements(
  config: RoundConfig,
  sell: string,
  buy: string,
  amount: bigint,
) {
  positive(amount, "amount");
  if (
    sell === buy ||
    !config.assets.includes(sell) ||
    !config.assets.includes(buy)
  )
    throw new Error("Choose two different assets allowed by this round.");
  const bps =
    config.exit?.tag === "Covered" &&
    sell === config.cash &&
    buy !== config.cash
      ? config.exit.values[0].premium_bps
      : 0;
  if (!Number.isInteger(bps) || bps < 0 || bps > 1000)
    throw new Error("Invalid immutable coverage premium.");
  const premium = (amount * BigInt(bps) + 9999n) / 10000n;
  const cashRequired = (sell === config.cash ? amount : 0n) + premium;
  if (cashRequired > MAX_I128)
    throw new Error(
      "The amount plus coverage premium exceeds the token range.",
    );
  return {
    premium,
    cashRequired,
    maximumExpiry:
      buy === config.cash ? config.calendar.end : config.calendar.risk_cutoff,
  };
}
export function prepareSpotLimit(
  config: RoundConfig,
  input: {
    sell: string;
    buy: string;
    amount: bigint;
    minimum: bigint;
    expires: bigint;
  },
  now = BigInt(Math.floor(Date.now() / 1000)),
) {
  const requirements = spotTradeRequirements(
    config,
    input.sell,
    input.buy,
    input.amount,
  );
  positive(input.minimum, "minimum received");
  if (input.expires <= now || input.expires > requirements.maximumExpiry)
    throw new Error(
      "The limit must expire after now and no later than this trade’s round cutoff.",
    );
  return {
    ...requirements,
    args: {
      sell: input.sell,
      buy: input.buy,
      n: input.amount,
      minimum: input.minimum,
      expires: input.expires,
    },
  };
}
export interface DirectSpotQuote {
  round: string;
  terms: string;
  adapter: string;
  sell: string;
  buy: string;
  amount: bigint;
  checkedAt: number;
  validUntil: number;
  ledgerTime: number;
  slippageBps: number;
  expectedOut: bigint;
  independentMinimum: bigint;
  minimumOut: bigint;
  premium: bigint;
  cashRequired: bigint;
  maximumExpiry: bigint;
  tradingOpen: boolean;
  eligible: boolean;
  reasons: string[];
}
export function assertSpotQuote(
  quote: DirectSpotQuote,
  round: string,
  terms: Uint8Array,
  input: SpotTradeInput,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    quote.round !== round ||
    quote.terms !== hex(terms) ||
    quote.adapter !== input.adapter ||
    quote.sell !== input.sell ||
    quote.buy !== input.buy ||
    quote.amount !== input.amount ||
    quote.slippageBps !== (input.slippageBps ?? 50)
  )
    throw new Error("The round, amount or trade changed. Refresh the quote.");
  if (now < quote.checkedAt || now >= quote.validUntil)
    throw new Error("The swap quote expired. Refresh it before signing.");
  if (!quote.eligible) throw new Error(quote.reasons.join(" "));
  if (!quote.tradingOpen)
    throw new Error("This round is outside the trading window.");
}
/** Read-only quote for the pinned direct-pair implementation. A new venue needs its
 * own reviewed quote provider; a capability or symbol cannot select an arbitrary ABI.
 * The round's immutable factory record, rather than a publisher's metadata, is authority.
 */
export async function quoteSpotTrade(
  deployment: Deployment,
  roundAddress: string,
  input: SpotTradeInput,
): Promise<DirectSpotQuote> {
  const checkedAt = Math.floor(Date.now() / 1000),
    slippageBps = input.slippageBps ?? 50;
  positive(input.amount, "amount");
  if (
    !StrKey.isValidContract(roundAddress) ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 1000
  )
    throw new Error("Invalid round or slippage.");
  const client = new LeagueClient(deployment),
    round = client.round(roundAddress);
  const [record, config, terms, phase, ledger] = await Promise.all([
    client.factory().read<RoundRecord>("find", { address: roundAddress }),
    round.read<RoundConfig>("config"),
    round.read<Uint8Array>("terms"),
    round.read<number>("phase"),
    client.ledger(),
  ]);
  const selected = record.protocols.find(
    (p) => p.adapter === input.adapter && (p.capabilities & 1) !== 0,
  );
  if (
    record.address !== roundAddress ||
    !selected ||
    !config.adapters.includes(input.adapter)
  )
    throw new Error("Select a Spot protocol committed in this round.");
  if (hex(selected.wasm_hash) !== V5_BUILD_ARTIFACTS.direct_swap.wasmHash)
    throw new Error(
      "This protocol needs a supported quote provider. No substitute venue price is used.",
    );
  if (
    !deployment.quotePolicy ||
    config.quote_policy !== deployment.quotePolicy.address ||
    config.cash !== deployment.cash.address
  )
    throw new Error("The quote policy differs from the selected round.");
  const requirements = spotTradeRequirements(
    config,
    input.sell,
    input.buy,
    input.amount,
  );
  const adapter = new BoundContract(
    "direct_swap",
    input.adapter,
    deployment.readSource,
    deployment.rpcUrl,
    hex(selected.wasm_hash),
  );
  const route = await adapter.read<DirectSettings>("config");
  if (
    route.asset0 === route.asset1 ||
    ![route.asset0, route.asset1].includes(input.sell) ||
    ![route.asset0, route.asset1].includes(input.buy)
  )
    throw new Error("This direct route does not support the selected pair.");
  const policy = new BoundContract(
    "price_policy",
    config.quote_policy,
    deployment.readSource,
    deployment.rpcUrl,
    deployment.quotePolicy.wasmHash,
  );
  const [expectedOut, independentMinimum] = await Promise.all([
    adapter.read<bigint>("quote", {
      sell: input.sell,
      buy: input.buy,
      amount: input.amount,
    }),
    policy.read<bigint>("minimum", {
      sell: input.sell,
      buy: input.buy,
      amount: input.amount,
    }),
  ]);
  positive(expectedOut, "quoted output");
  positive(independentMinimum, "independent minimum");
  const userMinimum = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;
  const minimumOut =
    userMinimum > independentMinimum ? userMinimum : independentMinimum;
  const reasons =
    expectedOut < minimumOut
      ? ["The current venue quote is below the independent price floor."]
      : [];
  const tradingOpen =
    phase === 3 &&
    BigInt(ledger.timestamp) >= config.calendar.start &&
    BigInt(ledger.timestamp) < requirements.maximumExpiry;
  return {
    round: roundAddress,
    terms: hex(terms),
    adapter: input.adapter,
    sell: input.sell,
    buy: input.buy,
    amount: input.amount,
    checkedAt,
    validUntil: checkedAt + 30,
    ledgerTime: ledger.timestamp,
    slippageBps,
    expectedOut,
    independentMinimum,
    minimumOut,
    ...requirements,
    tradingOpen,
    eligible: reasons.length === 0,
    reasons,
  };
}
