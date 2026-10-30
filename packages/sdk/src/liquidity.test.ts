import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { BoundContract, V5_BUILD_ARTIFACTS as artifacts } from "./client.js";
import { TestnetClient } from "./testnet.js";
import {
  assertLiquidityQuote,
  projectLiquidity,
  quoteLiquidityEntry,
} from "./liquidity.js";
import type { Deployment, LpSettings } from "./types.js";
const address = (n: number) =>
  StrKey.encodeContract(new Uint8Array(32).fill(n));
const cash = address(1),
  other = address(2),
  adapter = address(3),
  pair = address(4),
  swap = address(5);
const hash = new Uint8Array(32).fill(7),
  hashText = "07".repeat(32);
const settings: LpSettings = {
  cash,
  asset0: other,
  asset1: cash,
  pair,
  pair_hash: hash,
  router: address(6),
  router_hash: hash,
  factory: address(7),
  factory_hash: hash,
  swap_adapter: swap,
  swap_hash: hash,
  vault_wasm: hash,
  minimum_entry_bps: 9900,
};
const deployment: Deployment = {
  schemaVersion: 1,
  protocolVersion: "0.5.0",
  network: "TESTNET",
  environment: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  readSource: Keypair.random().publicKey(),
  factory: { address: address(8), ...artifacts.factory },
  registry: { address: address(9), ...artifacts.registry },
  tournament: artifacts.tournament,
  cash: { address: cash, symbol: "XLM", decimals: 7 },
  quotePolicy: { address: address(10), wasmHash: hashText },
  protocols: [
    {
      id: "lp",
      version: 1,
      name: "LP fixture",
      adapter,
      capabilities: 18,
      wasmHash: hashText,
      assets: [
        { address: cash, symbol: "XLM", decimals: 7 },
        { address: other, symbol: "USD", decimals: 7 },
      ],
    },
  ],
};
function reads(output = 4990n, paused = false) {
  vi.spyOn(BoundContract.prototype, "read").mockImplementation(async function (
    this: BoundContract,
    method,
    args,
  ) {
    const id = this.transport.options.contractId;
    if (id === deployment.registry.address)
      return method === "available"
        ? !paused
        : { adapter, capabilities: 18, wasm_hash: hash };
    if (id === adapter) return settings;
    if (id === swap) return method === "config" ? settings : output;
    if (id === deployment.quotePolicy!.address && method === "minimum")
      return ((args as { amount: bigint }).amount * 99n) / 100n;
    throw new Error("Unexpected fixture read.");
  });
  vi.spyOn(TestnetClient.prototype, "read").mockImplementation(
    async function (method) {
      if (method === "get_reserves") return [1000000000n, 1000000000n];
      if (method === "total_supply") return 1000000000n;
      if (method === "balance") return 1000000000n;
      if (method === "decimals") return 7;
      throw new Error("Unexpected fixture pair read.");
    },
  );
}
afterEach(() => vi.restoreAllMocks());
describe("bounded LP quote and mint projection", () => {
  it("keeps integer precision and includes unused components in the owner's position", () => {
    const large = 10n ** 25n;
    expect(projectLiquidity([large, large], [large, large], large).units).toBe(
      large,
    );
    const projected = projectLiquidity([10n, 1000n], [100n, 100n], 100n);
    expect(projected).toEqual({
      used: [10n, 10n],
      idle: [0n, 990n],
      units: 10n,
      components: [10n, 1000n],
    });
    expect(() => projectLiquidity([0n, 1n], [1n, 1n], 1n)).toThrow();
    expect(() => projectLiquidity([1n << 128n, 1n], [1n, 1n], 1n)).toThrow();
  });
  it("projects the conversion before LP minting and enforces time/selection review", async () => {
    reads();
    const quote = await quoteLiquidityEntry(deployment, adapter, 10000n);
    expect(quote.eligible).toBe(true);
    expect(quote.minimums[0]).toBeGreaterThanOrEqual(4950n);
    expect(quote.projection.units).toBeLessThan(5000n);
    expect(() =>
      assertLiquidityQuote(quote, adapter, 10000n, quote.checkedAt),
    ).not.toThrow();
    expect(() =>
      assertLiquidityQuote(quote, adapter, 10000n, quote.validUntil),
    ).toThrow("expired");
    expect(() =>
      assertLiquidityQuote(quote, adapter, 10001n, quote.checkedAt),
    ).toThrow("changed");
  });
  it("blocks an attractive mint when the conversion fails independent valuation", async () => {
    reads(4500n);
    const quote = await quoteLiquidityEntry(deployment, adapter, 10000n);
    expect(quote.eligible).toBe(false);
    expect(quote.reasons.join(" ")).toContain("independent price floor");
    expect(quote.reasons.join(" ")).toContain("independent entry floor");
    expect(() =>
      assertLiquidityQuote(quote, adapter, 10000n, quote.checkedAt),
    ).toThrow("price floor");
  });
  it("checks actual registry availability before requesting a market quote", async () => {
    reads(4990n, true);
    await expect(
      quoteLiquidityEntry(deployment, adapter, 10000n),
    ).rejects.toThrow("admission");
    await expect(
      quoteLiquidityEntry(deployment, adapter, 10000n, 1001),
    ).rejects.toThrow("slippage");
  });
});
