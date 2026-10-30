import { afterEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import {
  BoundContract,
  LeagueClient,
  V5_BUILD_ARTIFACTS,
  hex,
} from "./client.js";
import {
  assertSpotQuote,
  prepareSpotLimit,
  quoteSpotTrade,
  spotTradeRequirements,
} from "./spot.js";
import type { Deployment, RoundConfig } from "./types.js";
const deployment = JSON.parse(
  readFileSync("deployments/testnet-v5-lp.json", "utf8"),
) as Deployment;
const protocol = deployment.protocols.find((p) => p.id === "soroswap_spot")!;
const cash = deployment.cash.address,
  other = protocol.assets.find((a) => a.address !== cash)!.address;
const roundAddress = StrKey.encodeContract(new Uint8Array(32).fill(9));
const terms = new Uint8Array(32).fill(4);
const calendar = {
  funding_open: 0n,
  funding_close: 5n,
  registration_open: 0n,
  registration_close: 10n,
  prepare_by: 15n,
  start: 20n,
  risk_cutoff: 100n,
  end: 120n,
  settle_by: 150n,
};
const config = {
  cash,
  assets: [cash, other],
  adapters: [protocol.adapter],
  quote_policy: deployment.quotePolicy!.address,
  calendar,
  reward: 10n,
  exit: { tag: "Covered", values: [{ premium_bps: 50 }] },
} as unknown as RoundConfig;
const input = {
  adapter: protocol.adapter,
  sell: cash,
  buy: other,
  amount: 1000n,
};
function reads(
  output = 990n,
  floor = 980n,
  code: string = V5_BUILD_ARTIFACTS.direct_swap.wasmHash,
) {
  vi.spyOn(LeagueClient.prototype, "ledger").mockResolvedValue({
    sequence: 100,
    timestamp: 50,
  });
  return vi
    .spyOn(BoundContract.prototype, "read")
    .mockImplementation(async function (this: BoundContract, method, args) {
      const id = this.transport.options.contractId;
      if (id === deployment.factory.address && method === "find")
        return {
          address: roundAddress,
          protocols: [
            {
              id: protocol.id,
              version: 1,
              adapter: protocol.adapter,
              capabilities: 1,
              wasm_hash: Uint8Array.from(Buffer.from(code, "hex")),
            },
          ],
        };
      if (id === roundAddress)
        return method === "config" ? config : method === "terms" ? terms : 3;
      if (id === protocol.adapter)
        return method === "config" ? { asset0: cash, asset1: other } : output;
      if (id === deployment.quotePolicy!.address && method === "minimum")
        return floor;
      throw new Error(
        "Unexpected quote read " + method + " " + JSON.stringify(args),
      );
    });
}
afterEach(() => vi.restoreAllMocks());
describe("immutable round Spot reviews", () => {
  it("quotes the committed route, includes an additional cash premium and rejects stale or changed reviews", async () => {
    const read = reads();
    const quote = await quoteSpotTrade(deployment, roundAddress, input);
    expect(quote.minimumOut).toBe(985n);
    expect(quote.premium).toBe(5n);
    expect(quote.cashRequired).toBe(1005n);
    expect(quote.terms).toBe(hex(terms));
    expect(quote.tradingOpen).toBe(true);
    expect(() =>
      assertSpotQuote(quote, roundAddress, terms, input, quote.checkedAt),
    ).not.toThrow();
    expect(() =>
      assertSpotQuote(quote, roundAddress, terms, input, quote.validUntil),
    ).toThrow("expired");
    expect(() =>
      assertSpotQuote(
        quote,
        roundAddress,
        terms,
        { ...input, amount: 999n },
        quote.checkedAt,
      ),
    ).toThrow("changed");
    expect(() =>
      assertSpotQuote(
        quote,
        roundAddress,
        new Uint8Array(32),
        input,
        quote.checkedAt,
      ),
    ).toThrow("changed");
    expect(read.mock.calls.some(([method]) => method === "available")).toBe(
      false,
    );
  });
  it("blocks an attractive-looking venue price below the independent floor and an unsupported code version", async () => {
    reads(970n, 980n);
    const quote = await quoteSpotTrade(deployment, roundAddress, input);
    expect(quote.eligible).toBe(false);
    expect(quote.minimumOut).toBe(980n);
    expect(() =>
      assertSpotQuote(quote, roundAddress, terms, input, quote.checkedAt),
    ).toThrow("independent");
    vi.restoreAllMocks();
    reads(990n, 980n, "01".repeat(32));
    await expect(
      quoteSpotTrade(deployment, roundAddress, input),
    ).rejects.toThrow("quote provider");
  });
  it("does not accept a publisher-selected policy, uncommitted adapter or unsupported pair", async () => {
    reads();
    await expect(
      quoteSpotTrade(
        {
          ...deployment,
          quotePolicy: {
            address: deployment.registry.address,
            wasmHash: "ab".repeat(32),
          },
        },
        roundAddress,
        input,
      ),
    ).rejects.toThrow("policy");
    await expect(
      quoteSpotTrade(deployment, roundAddress, {
        ...input,
        adapter: deployment.registry.address,
      }),
    ).rejects.toThrow("committed");
    await expect(
      quoteSpotTrade(deployment, roundAddress, { ...input, buy: cash }),
    ).rejects.toThrow("different assets");
    await expect(
      quoteSpotTrade(deployment, roundAddress, { ...input, slippageBps: 1001 }),
    ).rejects.toThrow("slippage");
  });
  it("preserves integer rounding and different risk-increase versus cash-return limit deadlines", () => {
    expect(spotTradeRequirements(config, cash, other, 1n)).toMatchObject({
      premium: 1n,
      cashRequired: 2n,
      maximumExpiry: 100n,
    });
    const entry = prepareSpotLimit(
      config,
      { sell: cash, buy: other, amount: 1000n, minimum: 1500n, expires: 100n },
      50n,
    );
    expect(entry.args.minimum).toBe(1500n);
    expect(entry.cashRequired).toBe(1005n);
    expect(() =>
      prepareSpotLimit(
        config,
        { sell: cash, buy: other, amount: 1000n, minimum: 1n, expires: 101n },
        50n,
      ),
    ).toThrow("cutoff");
    expect(
      prepareSpotLimit(
        config,
        { sell: other, buy: cash, amount: 1000n, minimum: 1n, expires: 120n },
        50n,
      ),
    ).toMatchObject({ premium: 0n, cashRequired: 0n });
    expect(() =>
      prepareSpotLimit(
        config,
        { sell: other, buy: cash, amount: 1000n, minimum: 0n, expires: 120n },
        50n,
      ),
    ).toThrow("positive");
    expect(() =>
      spotTradeRequirements(config, cash, other, (1n << 127n) - 1n),
    ).toThrow("token range");
  });
});
