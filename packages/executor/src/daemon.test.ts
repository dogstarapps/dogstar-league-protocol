import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spec } from "@stellar/stellar-sdk/contract";
import {
  LeagueClient,
  RestorationRequired,
  type Deployment,
  type ManagedPosition,
  type RoundSnapshot,
} from "../../sdk/src/index.js";
import { V4_SPEC_ENTRIES } from "../../sdk/src/generated/specs-v4.js";
import { Executor } from "./daemon.js";
import { Journal } from "./journal.js";

const deployment = JSON.parse(
  readFileSync("deployments/testnet-v3-lease.json", "utf8"),
) as Deployment;
const player = deployment.readSource;
const position: ManagedPosition = {
  id: 7,
  player,
  adapter: deployment.registry.address,
  vault: deployment.factory.address,
  vault_hash: new Uint8Array(32),
  basis: 100n,
  open: true,
};
const snapshot: RoundSnapshot = {
  address: deployment.factory.address,
  record: {} as RoundSnapshot["record"],
  phase: 4,
  terms: new Uint8Array(32),
  registrations: [player],
  config: {
    creator: player,
    cash: deployment.cash.address,
    assets: [deployment.cash.address],
    adapters: [position.adapter],
    quote_policy: deployment.registry.address,
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
  },
  totals: {
    capital: 0n,
    prizes: 10n,
    execution: 100n,
    fee_reserved: 1n,
    open_orders: 0,
    allocated: 100n,
    sponsor: 0n,
    players: 1,
    settled: 0,
    next_order: 0,
    next_deposit: 0,
    best_recovery: -1n,
  },
};
const journals: Journal[] = [];
afterEach(() => {
  journals.splice(0).forEach((journal) => journal.close());
});
function executor(positions = [position]) {
  const prepare = vi.fn().mockResolvedValue({});
  const read = vi.fn(async (method: string, args?: { p?: string }) => {
    if (method === "open_orders") return [];
    if (method === "registration") return { confirmed: true };
    if (method === "player") return { settled: false };
    if (method === "positions") return args?.p === player ? positions : [];
    throw new Error(`Unexpected read: ${method}`);
  });
  const client = {
    source: player,
    deployment: { ...deployment, protocolVersion: "0.4.0" },
    round: () => ({
      read,
      spec: new Spec(Array.from(V4_SPEC_ENTRIES.tournament)),
      transport: { prepare },
    }),
  } as unknown as LeagueClient;
  const journal = new Journal(
    join(
      mkdtempSync(join(tmpdir(), "dogstar-position-planner-")),
      "journal.sqlite",
    ),
    player,
  );
  journals.push(journal);
  return {
    runner: new Executor(client, { signTransaction: vi.fn() }, journal),
    prepare,
    read,
  };
}
describe("public managed-position closure", () => {
  it("simulates the native exit before the deadline", async () => {
    const { runner, prepare } = executor();
    expect((await runner.next(snapshot, 110n))?.method).toBe("close_position");
    expect(prepare).toHaveBeenCalledOnce();
  });
  it("does not settle a player whose position still cannot close", async () => {
    const { runner, prepare } = executor();
    prepare.mockRejectedValue(new Error("Pool has no withdrawal liquidity"));
    expect(await runner.next(snapshot, 110n)).toBeUndefined();
  });
  it("selects the local prefunded purchase at the deadline without an oracle or venue read", async () => {
    const { runner, prepare, read } = executor();
    const task = await runner.next(snapshot, 120n);
    expect(task?.method).toBe("buyout_position");
    expect(task?.args).toEqual({ id: position.id, operator: player });
    expect(prepare).not.toHaveBeenCalled();
    expect(read.mock.calls.map(([method]) => method)).toEqual([
      "open_orders",
      "registration",
      "player",
      "positions",
    ]);
  });
  it("continues to another player while a native exit is blocked", async () => {
    const { runner, prepare } = executor();
    prepare.mockRejectedValue(new Error("Pool unavailable"));
    const other = deployment.registry.address;
    const task = await runner.next(
      { ...snapshot, registrations: [player, other] },
      110n,
    );
    expect(task?.method).toBe("settle_player");
    expect(task?.args.p).toBe(other);
  });
  it("propagates restoration so archived position state is not mistaken for a closed position", async () => {
    const { runner, prepare } = executor();
    const error = new RestorationRequired(
      {
        minResourceFee: "1",
        transactionData: {} as never,
      },
      position.vault,
    );
    prepare.mockRejectedValue(error);
    await expect(runner.next(snapshot, 110n)).rejects.toBe(error);
  });
});
