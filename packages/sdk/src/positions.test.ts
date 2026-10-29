import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  LeagueClient,
  V4_BUILD_ARTIFACTS,
  V5_BUILD_ARTIFACTS,
} from "./client.js";
import type { Deployment } from "./types.js";

describe("immutable managed-position ABI versions", () => {
  const previous = JSON.parse(
    readFileSync("deployments/testnet-v3-lease.json", "utf8"),
  ) as Deployment;
  const deployment: Deployment = {
    ...previous,
    protocolVersion: "0.4.0",
    factory: { ...previous.factory, ...V4_BUILD_ARTIFACTS.factory },
    registry: { ...previous.registry, ...V4_BUILD_ARTIFACTS.registry },
    tournament: V4_BUILD_ARTIFACTS.tournament,
  };
  it("encodes standard position requests and permissionless maintenance from compiled WASM", () => {
    const spec = new LeagueClient(deployment).round(
      deployment.factory.address,
    ).spec;
    expect(
      spec.funcArgsToScVals("open_position", {
        p: deployment.readSource,
        adapter: deployment.registry.address,
        n: 100n,
        minimums: [99n],
        request: new Uint8Array(),
      }),
    ).toHaveLength(5);
    expect(
      spec.funcArgsToScVals("close_position", {
        id: 1,
        min_cash: 0n,
        request: new Uint8Array(),
        operator: deployment.readSource,
      }),
    ).toHaveLength(4);
    expect(spec.funcArgsToScVals("keep_position", { id: 1 })).toHaveLength(1);
  });
  it("does not silently apply managed-position methods to earlier factories", () => {
    const old = new LeagueClient(previous).round(previous.factory.address);
    expect(() =>
      old.spec.funcArgsToScVals("positions", { p: previous.readSource }),
    ).toThrow();
    const client = new LeagueClient(deployment);
    expect(
      client.factory().spec.funcArgsToScVals("page", { offset: 0, limit: 20 }),
    ).toHaveLength(2);
    expect(
      client.registry().spec.funcArgsToScVals("page", { offset: 0, limit: 20 }),
    ).toHaveLength(2);
  });
});

describe("creator funding and owned-vault ABI", () => {
  const previous = JSON.parse(
    readFileSync("deployments/testnet-v4-blend.json", "utf8"),
  ) as Deployment;
  const current: Deployment = {
    ...previous,
    protocolVersion: "0.5.0",
    factory: { ...previous.factory, ...V5_BUILD_ARTIFACTS.factory },
    registry: { ...previous.registry, ...V5_BUILD_ARTIFACTS.registry },
    tournament: V5_BUILD_ARTIFACTS.tournament,
  };
  it("keeps old managed-position result shapes frozen and ownership methods versioned", () => {
    const old = new LeagueClient(previous).round(previous.factory.address);
    const round = new LeagueClient(current).round(current.factory.address);
    expect(() =>
      old.spec.funcArgsToScVals("owner_positions_page", {
        owner: previous.readSource,
        offset: 0,
        limit: 20,
      }),
    ).toThrow();
    expect(
      round.spec.funcArgsToScVals("owner_positions_page", {
        owner: current.readSource,
        offset: 0,
        limit: 20,
      }),
    ).toHaveLength(3);
    expect(
      new LeagueClient(current)
        .vault(current.registry.address, current.registry.wasmHash)
        .spec.funcArgsToScVals("recover", { asset: current.cash.address }),
    ).toHaveLength(1);
    const names = (c: typeof round) => {
      const entry = c.spec.entries.find(
        (e) =>
          e.type === "scSpecEntryUdtStructV0" &&
          e.udtStructV0.name.toString() === "ManagedPosition",
      );
      if (!entry || entry.type !== "scSpecEntryUdtStructV0")
        throw new Error("Missing position schema.");
      return entry.udtStructV0.fields.map((f) => f.name.toString());
    };
    expect(names(old)).not.toContain("owner");
    expect(names(round)).toContain("owner");
  });
  it("exposes atomic creation only on new factories", () => {
    const client = new LeagueClient(current);
    const factory = client.factory();
    const c = {
      creator: current.readSource,
      cash: current.cash.address,
      assets: [current.cash.address],
      adapters: [],
      quote_policy: current.registry.address,
      capital: 1n,
      min_players: 1,
      max_players: 2,
      share_bps: 10000,
      prizes: 0n,
      execution: 100n,
      reward: 1n,
      exit: { tag: "CashOnly" },
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
    };
    const args = {
      c,
      selections: [],
      salt: new Uint8Array(32),
      metadata_hash: new Uint8Array(32),
    };
    expect(factory.spec.funcArgsToScVals("create_funded", args)).toHaveLength(
      4,
    );
    expect(() =>
      new LeagueClient(previous)
        .factory()
        .spec.funcArgsToScVals("create_funded", args),
    ).toThrow();
  });
});
