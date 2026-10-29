import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LeagueClient, V4_BUILD_ARTIFACTS } from "./client.js";
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
