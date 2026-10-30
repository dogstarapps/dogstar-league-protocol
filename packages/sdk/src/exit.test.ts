import { describe, it, expect } from "vitest";
import { Spec } from "@stellar/stellar-sdk/contract";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { V3_SPEC_ENTRIES, V3_BUILD_ARTIFACTS } from "./generated/specs-v3.js";
import { LeagueClient, validateDeployment } from "./client.js";
import type { Deployment, RoundConfig } from "./types.js";
const address = StrKey.encodeContract(new Uint8Array(32).fill(2));
describe("versioned exit ABI", () => {
  it("encodes explicit covered terms and receipt buyouts from the actual WASM schema", () => {
    const spec = new Spec(Array.from(V3_SPEC_ENTRIES.tournament));
    const creator = Keypair.random().publicKey();
    const config: RoundConfig = {
      creator,
      cash: address,
      assets: [address],
      adapters: [],
      quote_policy: address,
      capital: 100n,
      min_players: 1,
      max_players: 2,
      share_bps: 10000,
      prizes: 10n,
      execution: 100n,
      reward: 1n,
      calendar: {
        funding_open: 1n,
        funding_close: 20n,
        registration_open: 1n,
        registration_close: 30n,
        prepare_by: 40n,
        start: 50n,
        risk_cutoff: 90n,
        end: 100n,
        settle_by: 120n,
      },
      exit: {
        tag: "Covered",
        values: [
          {
            provider: creator,
            fallback_bps: 8000,
            premium_bps: 50,
            minimum_coverage: 160n,
            artifacts: {
              facility_wasm: new Uint8Array(32),
              spot_receipt_wasm: new Uint8Array(32),
            },
          },
        ],
      },
    };
    const factory = new Spec(Array.from(V3_SPEC_ENTRIES.factory));
    const args = factory.funcArgsToScVals("create", {
      c: config,
      selections: [],
      salt: new Uint8Array(32),
      metadata_hash: new Uint8Array(32),
    });
    expect(spec.funcResToNative("config", args[0])).toEqual(config);
    expect(
      spec.funcArgsToScVals("close_buyout", {
        p: creator,
        asset: address,
        operator: creator,
      }),
    ).toHaveLength(3);
    const facility = new Spec(Array.from(V3_SPEC_ENTRIES.exit_facility));
    expect(() => facility.funcArgsToScVals("fund", { n: 100n })).toThrow();
    expect(
      facility.funcArgsToScVals("fund", { n: 100n, terms: new Uint8Array(32) }),
    ).toHaveLength(2);
  });
  it("keeps old deployments readable and rejects applying the new ABI to an old manifest", () => {
    const legacy = JSON.parse(
      readFileSync("deployments/testnet.json", "utf8"),
    ) as Deployment;
    expect(validateDeployment(legacy)).toBe(legacy);
    expect(() =>
      validateDeployment({ ...legacy, protocolVersion: "0.3.0" }),
    ).toThrow("Incompatible");
    const current = {
      ...legacy,
      protocolVersion: "0.3.0" as const,
      factory: { ...legacy.factory, ...V3_BUILD_ARTIFACTS.factory },
      registry: { ...legacy.registry, ...V3_BUILD_ARTIFACTS.registry },
      tournament: V3_BUILD_ARTIFACTS.tournament,
    };
    const client = new LeagueClient(current);
    expect(
      client
        .round(address)
        .spec.funcArgsToScVals("player_orders", { p: legacy.readSource }),
    ).toHaveLength(1);
    expect(() =>
      new LeagueClient(legacy)
        .round(address)
        .spec.funcArgsToScVals("close_buyout", {}),
    ).toThrow();
  });
});
