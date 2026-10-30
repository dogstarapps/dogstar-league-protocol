import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Account,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { Journal } from "./journal.js";
import { Executor } from "./daemon.js";
import type {
  LeagueClient,
  RoundRecord,
  RoundSnapshot,
} from "../../sdk/src/index.js";
const deployment = JSON.parse(
  readFileSync("deployments/testnet-v5-profile.json", "utf8"),
);
const source = deployment.readSource;
const task = {
  round: "round",
  method: "close_position",
  args: { id: 1 },
  key: "round:close:1",
};
const journals: Journal[] = [];
function journal() {
  const j = new Journal(":memory:", source);
  journals.push(j);
  return j;
}
afterEach(() => {
  journals.splice(0).forEach((j) => j.close());
  vi.restoreAllMocks();
});
describe("operator durability and work scheduling", () => {
  it("keeps ambiguous envelopes exclusive and accounts charged fees once without replenishing the cap", () => {
    const j = journal(),
      envelope = { hash: "one", signedXdr: "envelope", expiresAt: 1 };
    j.save(task, envelope, 90n, 1000n);
    expect(() =>
      j.save(
        { ...task, key: "other" },
        { ...envelope, hash: "two" },
        20n,
        1000n,
      ),
    ).toThrow("pending envelope");
    j.finish("one", "UNKNOWN");
    expect(j.pending()).toHaveLength(1);
    expect(j.feeAllocated()).toBe(90n);
    j.receipt("one", 20, 40n, "SUCCESS");
    j.receipt("one", 20, 40n, "SUCCESS");
    expect(j.summary().feesCharged).toBe(40n);
    expect(j.feeAllocated()).toBe(90n);
    expect(j.pending()).toEqual([]);
  });
  it("backs off one failed operation without blocking a distinct deadline purchase and retains failure history", () => {
    const j = journal();
    j.fail(task, new Error("Venue unavailable"));
    expect(j.canAttempt(task)).toBe(false);
    expect(j.canAttempt({ ...task, key: "round:buyout:1" })).toBe(true);
    expect(j.canAttempt(task, Date.now() + 130000)).toBe(true);
    j.fail(task, new Error("Still unavailable"));
    expect(
      j.db.prepare("SELECT COUNT(*) n FROM failure_history").get()?.n,
    ).toBe(2);
  });
  it("isolates factory scopes and stops polling terminal rounds while discovering new work first", () => {
    const j = journal();
    const make = (id: number, address: string) =>
      ({ id, address }) as RoundRecord;
    j.remember("first", [make(99, "latest"), make(1, "old")]);
    j.remember("second", [make(99, "other")]);
    expect(j.work("first", 100).map((r) => r.address)).toEqual([
      "latest",
      "old",
    ]);
    j.checked("first", "latest", 5, 0);
    expect(j.work("first", 100).map((r) => r.address)).toEqual(["old"]);
    expect(j.work("second", 100).map((r) => r.address)).toEqual(["other"]);
  });
  it("quarantines a consumed sequence whose receipt disappeared from RPC history", async () => {
    const j = journal();
    const envelope = new TransactionBuilder(new Account(source, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: "test", value: "value" }))
      .setTimeout(60)
      .build();
    j.save(
      task,
      { hash: "pending", signedXdr: envelope.toXDR(), expiresAt: 10 },
      100n,
      1000n,
    );
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
      getAccount: vi.fn().mockResolvedValue(new Account(source, "2")),
      sendTransaction: vi.fn(),
    };
    const client = {
      deployment,
      source,
      factory: () => ({ transport: { server } }),
      ledger: async () => ({ timestamp: 100 }),
    } as unknown as LeagueClient;
    const runner = new Executor(client, { signTransaction: vi.fn() }, j);
    expect(await runner.reconcile()).toBe(false);
    expect(j.db.prepare("SELECT status FROM transactions").get()?.status).toBe(
      "UNKNOWN",
    );
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(j.feeAllocated()).toBe(100n);
    server.getAccount.mockResolvedValue(new Account(source, "1"));
    expect(await runner.reconcile()).toBe(false);
    expect(j.db.prepare("SELECT status FROM transactions").get()?.status).toBe(
      "UNKNOWN",
    );
    expect(j.feeAllocated()).toBe(100n);
    server.getTransaction.mockResolvedValue({
      status: "SUCCESS",
      ledger: 101,
      resultXdr: { feeCharged: 60n },
    } as never);
    expect(await runner.reconcile()).toBe(true);
    expect(j.summary().feesCharged).toBe(60n);
    expect(j.pending()).toHaveLength(0);
  });
  it("offers a plan without invoking or signing a transaction", async () => {
    const j = journal(),
      signTransaction = vi.fn(),
      invoke = vi.fn();
    const record = {
      id: 0,
      address: deployment.factory.address,
    } as RoundRecord;
    const snapshot = {
      address: record.address,
      record,
      phase: 5,
      totals: { settled: 1, players: 1, open_orders: 0 },
      config: { calendar: {} },
    } as unknown as RoundSnapshot;
    const client = {
      deployment,
      source,
      factory: () => ({ read: async () => 1 }),
      rounds: async () => [record],
      snapshot: async () => snapshot,
      ledger: async () => ({ timestamp: 100 }),
      round: () => ({ invoke }),
    } as unknown as LeagueClient;
    const runner = new Executor(client, { signTransaction }, j);
    expect((await runner.plan()).mode).toBe("READ_ONLY_PLAN");
    expect(signTransaction).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(j.feeAllocated()).toBe(0n);
  });
  it("continues known work through failed discovery, backs off reads and schedules with ledger time", async () => {
    const j = journal(),
      scope = deployment.factory.address;
    const record = { id: 1, address: scope } as RoundRecord;
    j.remember(scope, [record]);
    const snapshot = {
      address: scope,
      record,
      phase: 0,
      config: { calendar: { funding_close: 150n } },
      totals: {},
    } as unknown as RoundSnapshot;
    const rounds = vi
      .fn()
      .mockRejectedValue(new Error("Archived factory page"));
    const client = {
      deployment,
      source,
      factory: () => ({ read: async () => 40 }),
      rounds,
      snapshot: async () => snapshot,
      ledger: async () => ({ timestamp: 100 }),
    } as unknown as LeagueClient;
    const runner = new Executor(client, { signTransaction: vi.fn() }, j);
    vi.spyOn(runner, "reconcile").mockResolvedValue(true);
    const next = vi.spyOn(runner, "next").mockResolvedValue(undefined);
    await runner.tick();
    expect(next).toHaveBeenCalledWith(snapshot, 100n);
    expect(j.work(scope, 149)).toEqual([]);
    expect(j.work(scope, 150)).toHaveLength(1);
    expect(j.value(`seen:${scope}`)).toBe(0);
    expect(rounds).toHaveBeenCalledTimes(2);
    await runner.tick();
    expect(rounds).toHaveBeenCalledTimes(2);
  });
});
