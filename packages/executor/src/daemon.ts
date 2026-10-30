#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import {
  Asset,
  Keypair,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  BoundContract,
  LeagueClient,
  TestnetClient,
  RestorationRequired,
  parse,
  stringify,
  type Deployment,
  type LimitOrder,
  type Player,
  type ManagedPosition,
  type Registration,
  type RoundSnapshot,
  type WalletSigner,
} from "../../sdk/src/index.js";
import { checkFee, DEFAULT_FEE_POLICY, type FeePolicy } from "./fees.js";
import { Journal } from "./journal.js";
import { transitionTask, type Task } from "./planner.js";
import {
  exitReportProvider,
  type ExitRequestProvider,
} from "./exit-reports.js";

export class Executor {
  lastTick?: number;
  lastError?: string;
  lastTask?: { key: string; method: string; status: string; hash?: string };
  constructor(
    readonly client: LeagueClient,
    readonly signer: WalletSigner,
    readonly journal: Journal,
    readonly policy: FeePolicy = DEFAULT_FEE_POLICY,
    readonly requests?: ExitRequestProvider,
  ) {}
  async reconcile() {
    const server = this.client.factory().transport.server;
    const ledger = await this.client.ledger();
    for (const { envelope, status } of this.journal.pending()) {
      const tx = await server.getTransaction(envelope.hash);
      if (tx.status === "SUCCESS" || tx.status === "FAILED")
        this.journal.receipt(
          envelope.hash,
          tx.ledger,
          BigInt(tx.resultXdr.feeCharged),
          tx.status,
        );
      else if (status === "UNKNOWN") continue;
      else if (ledger.timestamp > envelope.expiresAt) {
        const signed = TransactionBuilder.fromXDR(
          envelope.signedXdr,
          Networks.TESTNET,
        );
        if (!("sequence" in signed))
          throw new Error("Unsupported pending envelope.");
        const account = await server.getAccount(this.client.source);
        // Consumed sequence plus missing history is ambiguous, not proof of expiry.
        this.journal.finish(
          envelope.hash,
          BigInt(account.sequenceNumber()) >= BigInt(signed.sequence)
            ? "UNKNOWN"
            : "EXPIRED",
        );
      } else
        await server.sendTransaction(
          TransactionBuilder.fromXDR(envelope.signedXdr, Networks.TESTNET),
        );
    }
    return this.journal.pending().length === 0;
  }
  private signing(task: Task, reward: bigint) {
    let fee = 0n;
    const signer: WalletSigner = {
      signTransaction: async (xdr, options) => {
        const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
        fee = BigInt(tx.fee);
        checkFee(fee, reward, this.policy);
        if (this.journal.feeAllocated() + fee > this.policy.totalFeeBudget)
          throw new Error("Operator fee budget is exhausted.");
        return this.signer.signTransaction(xdr, options);
      },
    };
    return {
      signer,
      hooks: {
        beforeSubmit: async (p: Parameters<Journal["save"]>[1]) => {
          this.journal.save(task, p, fee, this.policy.totalFeeBudget);
        },
      },
    };
  }
  async restoreRead(error: unknown) {
    if (!(error instanceof RestorationRequired)) throw error;
    if (!this.policy.allowUnprofitable)
      throw new Error("Restoration needs an explicit maintenance allowance.");
    const address = error.contractId ?? this.client.deployment.factory.address;
    const task = {
      round: address,
      method: "restoreFootprint",
      args: {},
      key: `${address}:restore`,
    };
    const { signer, hooks } = this.signing(task, 0n);
    const transport = new TestnetClient({
      contractId: address,
      source: this.client.source,
      rpcUrl: this.client.deployment.rpcUrl,
    });
    const result = await transport.restore(error.preamble, signer, hooks);
    if (result.status === "SUCCESS")
      this.journal.finish(result.hash, "SUCCESS");
  }
  async submit(task: Task, snapshot: RoundSnapshot) {
    const c =
      task.target === "factory"
        ? this.client.factory()
        : this.client.round(task.round);
    try {
      let reward = snapshot.config.reward;
      if (task.maintenance) reward = 0n;
      if (task.method === "advance")
        reward = (
          ["0.3.0", "0.4.0", "0.5.0", "0.6.0"] as (string | undefined)[]
        ).includes(this.client.deployment.protocolVersion)
          ? await c.read<bigint>("advance_reward")
          : snapshot.phase === 2 || snapshot.phase === 3
            ? snapshot.config.reward
            : 0n;
      if (task.method === "cancel_limit") reward = 0n;
      if (task.method === "expire_limits")
        reward *= BigInt((task.args.ids as number[]).length);
      if (
        this.client.deployment.cash.address !==
        Asset.native().contractId(Networks.TESTNET)
      )
        reward = 0n;
      const { signer, hooks } = this.signing(task, reward);
      const result = await c.invoke(task.method, task.args, signer, hooks);
      if (result.status === "SUCCESS")
        this.journal.receipt(
          result.hash,
          result.ledger,
          BigInt(result.resultXdr.feeCharged),
          "SUCCESS",
        );
      if (result.status === "SUCCESS" && task.maintenance)
        this.journal.setValue(`maintained:${task.key}`, Date.now());
      this.lastTask = {
        key: task.key,
        method: task.method,
        status: result.status,
        hash: result.hash,
      };
      console.log(
        stringify({ task: task.key, status: result.status, hash: result.hash }),
      );
      return result.status === "SUCCESS" ? "SUCCESS" : "PENDING";
    } catch (error) {
      this.journal.fail(task, error);
      this.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof RestorationRequired) await this.restoreRead(error);
      else
        console.error(
          stringify({
            task: task.key,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      this.lastTask = { key: task.key, method: task.method, status: "FAILED" };
      return "FAILED";
    }
  }
  async next(s: RoundSnapshot, now: bigint): Promise<Task | undefined> {
    const operator = this.client.source;
    const transition = transitionTask(s, now, operator);
    if (transition && this.journal.canAttempt(transition)) return transition;
    const c = this.client.round(s.address);
    if (s.phase !== 3 && s.phase !== 4) return this.maintenance(s);
    let archived: RestorationRequired | undefined;
    const v3 = (
      ["0.3.0", "0.4.0", "0.5.0", "0.6.0"] as (string | undefined)[]
    ).includes(this.client.deployment.protocolVersion);
    const active = v3 ? await c.read<number[]>("open_orders") : undefined;
    const total =
      active?.length ?? (s.totals.open_orders > 0 ? s.totals.next_order : 0);
    const start = total
      ? ((this.journal.orderCursor(s.address) - 1) % total) + 1
      : 1;
    const expired: number[] = [];
    for (let scan = 0; scan < Math.min(total, 100); scan++) {
      const position = (start + scan - 1) % total;
      const id = active ? active[position] : position + 1;
      this.journal.setOrderCursor(s.address, ((position + 1) % total) + 1);
      const o = await c.read<LimitOrder>("order", { id });
      if (!o.open) continue;
      if (now >= o.expires || now >= s.config.calendar.end) {
        if (!v3)
          return {
            round: s.address,
            method: "cancel_limit",
            args: { id },
            key: `${s.address}:cancel:${id}`,
          };
        expired.push(id);
        if (expired.length === 20) break;
        continue;
      }
      const cutoff =
        o.buy === s.config.cash && v3
          ? s.config.calendar.end
          : s.config.calendar.risk_cutoff;
      if (s.phase === 3 && now < cutoff) {
        for (const adapter of s.config.adapters) {
          const task = {
            round: s.address,
            method: "fill_limit",
            args: { id, adapter, operator },
            key: `${s.address}:fill:${id}:${adapter}`,
          };
          if (!this.journal.canAttempt(task)) continue;
          try {
            await c.transport.prepare(
              task.method,
              c.spec.funcArgsToScVals(task.method, task.args),
            );
            return task;
          } catch {
            /* Another price or venue may become executable later. */
          }
        }
      }
    }
    if (expired.length) {
      const task = {
        round: s.address,
        method: "expire_limits",
        args: { ids: expired, operator },
        key: `${s.address}:expire:${expired.join(",")}`,
      };
      if (this.journal.canAttempt(task)) return task;
    }
    if (s.phase !== 4 || s.totals.open_orders > 0)
      return this.maintenance(s, active ?? []);
    for (const p of s.registrations) {
      const reg = await c.read<Registration>("registration", { p });
      if (!reg.confirmed) continue;
      const player = await c.read<Player>("player", { p });
      if (player.settled) continue;
      let blocked = false;
      if (
        ["0.4.0", "0.5.0", "0.6.0"].includes(
          this.client.deployment.protocolVersion ?? "",
        )
      ) {
        for (const position of await c.read<ManagedPosition[]>("positions", {
          p,
        })) {
          if (!position.open) continue;
          if (now >= s.config.calendar.settle_by) {
            const task = {
              round: s.address,
              method: "buyout_position",
              args: { id: position.id, operator },
              key: `${s.address}:position-buyout:${position.id}`,
            };
            if (this.journal.canAttempt(task)) return task;
            blocked = true;
            continue;
          }
          const task = {
            round: s.address,
            method: "close_position",
            args: {
              id: position.id,
              min_cash: 0n,
              request: new Uint8Array(),
              operator,
            },
            key: `${s.address}:position-close:${position.id}`,
          };
          if (!this.journal.canAttempt(task)) {
            blocked = true;
            continue;
          }
          try {
            if (
              this.requests &&
              s.record.protocols?.some(
                (p) => p.adapter === position.adapter && p.capabilities === 24,
              )
            ) {
              try {
                await c.transport.prepare(
                  task.method,
                  c.spec.funcArgsToScVals(task.method, task.args),
                );
                return task;
              } catch (error) {
                if (error instanceof RestorationRequired) throw error;
              }
              task.args.request = new Uint8Array(
                await this.requests(position, s),
              );
            }
            await c.transport.prepare(
              task.method,
              c.spec.funcArgsToScVals(task.method, task.args),
            );
            return task;
          } catch (error) {
            if (error instanceof RestorationRequired) archived = error;
            else this.journal.fail(task, error);
            blocked = true;
          }
        }
      }
      for (const asset of s.config.assets) {
        if (asset === s.config.cash) continue;
        const n = await c.read<bigint>("balance", { p, asset });
        if (n === 0n) continue;
        if (v3 && now >= s.config.calendar.settle_by) {
          const task = {
            round: s.address,
            method: "close_buyout",
            args: { p, asset, operator },
            key: `${s.address}:buyout:${p}:${asset}`,
          };
          if (this.journal.canAttempt(task)) return task;
          blocked = true;
          continue;
        }
        try {
          const policy = new BoundContract(
            "price_policy",
            s.config.quote_policy,
            operator,
            this.client.deployment.rpcUrl,
          );
          const minimum = await policy.read<bigint>("minimum", {
            sell: asset,
            buy: s.config.cash,
            amount: n,
          });
          for (const adapter of s.config.adapters) {
            const task = {
              round: s.address,
              method: "close_swap",
              args: { p, sell: asset, min_out: minimum, adapter, operator },
              key: `${s.address}:close:${p}:${asset}`,
            };
            if (!this.journal.canAttempt(task)) continue;
            try {
              await c.transport.prepare(
                task.method,
                c.spec.funcArgsToScVals(task.method, task.args),
              );
              return task;
            } catch {
              /* Do not replace the independent floor with an unsafe quote. */
            }
          }
        } catch (error) {
          if (error instanceof RestorationRequired) throw error;
        }
        blocked = true;
        console.error(
          stringify({
            round: s.address,
            player: p,
            asset,
            status: "cash_exit_unavailable",
          }),
        );
      }
      if (!blocked) {
        const task = {
          round: s.address,
          method: "settle_player",
          args: { p, operator },
          key: `${s.address}:settle:${p}`,
        };
        if (this.journal.canAttempt(task)) return task;
      }
    }
    if (archived) throw archived;
    return this.maintenance(s);
  }
  maintenance(s: RoundSnapshot, orders: number[] = []): Task | undefined {
    if (!this.policy.allowUnprofitable || s.phase === 5 || s.phase === 6)
      return;
    const factory: Task = {
      round: this.client.deployment.factory.address,
      target: "factory",
      maintenance: true,
      method: "find",
      args: { address: s.address },
      key: `${s.address}:maintain:factory`,
    };
    const tasks = [
      factory,
      {
        round: s.address,
        maintenance: true,
        method: "keepalive",
        args: {},
        key: `${s.address}:maintain:round`,
      },
      ...s.registrations.map((p) => ({
        round: s.address,
        maintenance: true,
        method: "keep_player",
        args: { p },
        key: `${s.address}:maintain:${p}`,
      })),
      ...orders.map((id) => ({
        round: s.address,
        maintenance: true,
        method: "keep_order",
        args: { id },
        key: `${s.address}:maintain:order:${id}`,
      })),
    ];
    return tasks.find(
      (task) =>
        this.journal.canAttempt(task) &&
        Date.now() - this.journal.value(`maintained:${task.key}`) >= 86400000,
    );
  }
  health() {
    return {
      network: "TESTNET",
      operator: this.client.source,
      factory: this.client.deployment.factory.address,
      lastTick: this.lastTick,
      lastError: this.lastError,
      lastTask: this.lastTask,
      feeBudget: this.policy.totalFeeBudget,
      ...this.journal.summary(),
    };
  }
  async plan() {
    const count = await this.client.factory().read<number>("count");
    const records = await this.client.rounds(
      Math.max(0, count - 20),
      Math.min(count, 20),
    );
    const { timestamp } = await this.client.ledger();
    const rows = [];
    for (const record of records) {
      const snapshot = await this.client.snapshot(record);
      const task = await this.next(snapshot, BigInt(timestamp));
      rows.push({ round: record.address, phase: snapshot.phase, task });
    }
    return {
      mode: "READ_ONLY_PLAN",
      network: "TESTNET",
      operator: this.client.source,
      ledgerTime: timestamp,
      rows,
    };
  }
  async tick() {
    if (!(await this.reconcile())) return;
    this.lastTick = Date.now();
    this.lastError = undefined;
    const count = await this.client.factory().read<number>("count");
    if (count === 0) return;
    const scope = this.client.deployment.factory.address;
    const seen = this.journal.value(`seen:${scope}`);
    if (count < seen)
      throw new Error(
        "Factory count moved backwards. Preserve the journal and review the network reset.",
      );
    // Discovery failures must not starve known active rounds. Retry the same
    // page later without advancing its cursor or re-signing failed work.
    const discover = async (
      key: string,
      offset: number,
      limit: number,
      done: (length: number) => void,
    ) => {
      if (this.journal.value(`discover:${scope}:${key}`) > Date.now()) return;
      try {
        const page = await this.client.rounds(offset, limit);
        this.journal.remember(scope, page);
        done(page.length);
        this.journal.setValue(`discover:${scope}:${key}`, 0);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.journal.setValue(`discover:${scope}:${key}`, Date.now() + 30000);
        if (
          error instanceof RestorationRequired &&
          this.policy.allowUnprofitable
        ) {
          try {
            await this.restoreRead(error);
          } catch (failure) {
            this.lastError =
              failure instanceof Error ? failure.message : String(failure);
          }
        }
      }
    };
    if (count > seen) {
      const newest = Math.max(seen, count - 20);
      await discover("latest", newest, count - newest, () =>
        this.journal.setValue(`seen:${scope}`, count),
      );
      if (this.journal.pending().length) return;
    }
    const offset = this.journal.value(`backfill:${scope}`);
    if (offset < count) {
      await discover(
        "backfill",
        offset,
        Math.min(20, count - offset),
        (length) => this.journal.setValue(`backfill:${scope}`, offset + length),
      );
      if (this.journal.pending().length) return;
    }
    const { timestamp } = await this.client.ledger();
    const records = this.journal.work(scope, timestamp);
    for (const record of records) {
      try {
        const snapshot = await this.client.snapshot(record);
        const nextCalendar = [
          snapshot.config.calendar.funding_close,
          snapshot.config.calendar.registration_close,
          snapshot.config.calendar.start,
          snapshot.config.calendar.end,
        ][snapshot.phase];
        const nextAt =
          nextCalendar !== undefined &&
          nextCalendar > BigInt(timestamp) &&
          snapshot.phase < 3
            ? Math.min(Number(nextCalendar), timestamp + 86400)
            : timestamp + 5;
        this.journal.checked(scope, record.address, snapshot.phase, nextAt);
        const task = await this.next(snapshot, BigInt(timestamp));
        if (task) {
          this.journal.checked(
            scope,
            record.address,
            snapshot.phase,
            timestamp + 5,
          );
          const result = await this.submit(task, snapshot);
          if (result === "FAILED" && !this.journal.pending().length) continue;
          this.lastTick = Date.now();
          this.lastError = undefined;
          return;
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.journal.checked(scope, record.address, -1, timestamp + 15);
        if (error instanceof RestorationRequired) {
          try {
            await this.restoreRead(error);
            if (this.journal.pending().length) return;
          } catch (failure) {
            this.lastError =
              failure instanceof Error ? failure.message : String(failure);
          }
        } else
          console.error(
            stringify({
              round: record.address,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    }
    this.lastTick = Date.now();
  }
}

export async function main(args = process.argv.slice(2)) {
  const option = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const manifests = args
    .filter((a) => a.startsWith("--manifest="))
    .flatMap((a) => a.slice(11).split(","))
    .filter(Boolean);
  const planning = args.includes("--plan"),
    keyFile = option("key-file");
  if (!manifests.length || (!planning && !keyFile)) {
    console.log(
      "Usage: dogstar-executor --manifest=deployments/testnet-v5-profile.json [--manifest=another.json] [--plan | --key-file=/private/operator.secret --fee-budget-stroops=100000000] [--journal=.local/executor.sqlite] [--once] [--interval-ms=10000] [--health-port=5190] [--allow-unprofitable]\nTESTNET only. Plan mode reads without signing. Operators use their own account; all manifests share one durable pending-envelope and fee budget.",
    );
    return;
  }
  if (manifests.length > 5)
    throw new Error(
      "At most five deployment manifests are supported per process.",
    );
  const deployments = await Promise.all(
    manifests.map(async (path) =>
      parse<Deployment>(await readFile(path, "utf8")),
    ),
  );
  if (
    new Set(deployments.map((d) => d.factory.address)).size !==
    deployments.length
  )
    throw new Error("Duplicate factory manifests.");
  let signerKey: Keypair | undefined;
  if (!planning && keyFile) {
    if ((await stat(keyFile)).mode & 0o077)
      throw new Error("Operator key file must have mode 0600.");
    signerKey = Keypair.fromSecret((await readFile(keyFile, "utf8")).trim());
  }
  const source =
    signerKey?.publicKey() ?? option("operator") ?? deployments[0].readSource;
  const signer: WalletSigner = {
    signTransaction: async (xdr, options) => {
      if (!signerKey || planning)
        throw new Error("Read-only planning never signs.");
      if (
        options.address !== signerKey.publicKey() ||
        options.networkPassphrase !== Networks.TESTNET
      )
        throw new Error("Signer context changed.");
      const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      transaction.sign(signerKey);
      return { signedTxXdr: transaction.toXDR(), signerAddress: source };
    },
  };
  const journal = new Journal(
    planning ? ":memory:" : (option("journal") ?? ".local/executor.sqlite"),
    source,
  );
  const policy: FeePolicy = {
    maxFee: BigInt(option("max-fee-stroops") ?? "10000000"),
    totalFeeBudget: BigInt(option("fee-budget-stroops") ?? "0"),
    minSurplus: BigInt(option("min-surplus-stroops") ?? "1000"),
    allowUnprofitable: args.includes("--allow-unprofitable"),
  };
  if (
    policy.maxFee <= 0n ||
    policy.totalFeeBudget < 0n ||
    policy.minSurplus < 0n
  )
    throw new Error("Invalid operator fee policy.");
  const runners = await Promise.all(
    deployments.map(
      async (d) =>
        new Executor(
          new LeagueClient(d, source),
          signer,
          journal,
          policy,
          option("exit-reports")
            ? await exitReportProvider(option("exit-reports")!, d)
            : undefined,
        ),
    ),
  );
  const interval = Number(option("interval-ms") ?? 10000);
  if (!Number.isInteger(interval) || interval < 1000 || interval > 60000)
    throw new Error("Interval must be between 1000 and 60000 milliseconds.");
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const port = option("health-port");
  const health = port
    ? createServer((req, res) => {
        if (
          req.method !== "GET" ||
          !["/healthz", "/readyz"].includes(req.url ?? "")
        ) {
          res.writeHead(404);
          res.end();
          return;
        }
        const ready =
          runners.every(
            (r) =>
              !r.lastError &&
              r.lastTick &&
              Date.now() - r.lastTick < Math.max(60000, interval * 3),
          ) && journal.pending().length === 0;
        res.writeHead(req.url === "/readyz" && !ready ? 503 : 200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          stringify({ ready, operators: runners.map((r) => r.health()) }),
        );
      })
    : undefined;
  try {
    if (planning) {
      for (const runner of runners) console.log(stringify(await runner.plan()));
      return;
    }
    if (health) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1024 || n > 65535)
        throw new Error("Use a health port between 1024 and 65535.");
      await new Promise<void>((resolve, reject) => {
        health.once("error", reject);
        health.listen(n, "127.0.0.1", resolve);
      });
    }
    do {
      for (const runner of runners) {
        try {
          await runner.tick();
        } catch (error) {
          try {
            await runner.restoreRead(error);
          } catch (failure) {
            runner.lastError =
              failure instanceof Error ? failure.message : String(failure);
            console.error(
              stringify({
                factory: runner.client.deployment.factory.address,
                error: runner.lastError,
              }),
            );
            if (args.includes("--once")) throw failure;
          }
        }
      }
      if (args.includes("--once")) break;
      await new Promise((r) => setTimeout(r, interval));
    } while (!stopped);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (health?.listening)
      await new Promise<void>((resolve, reject) =>
        health.close((error) => (error ? reject(error) : resolve())),
      );
    journal.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
