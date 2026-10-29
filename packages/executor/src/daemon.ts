#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

export class Executor {
  constructor(
    readonly client: LeagueClient,
    readonly signer: WalletSigner,
    readonly journal: Journal,
    readonly policy: FeePolicy = DEFAULT_FEE_POLICY,
  ) {}
  async reconcile() {
    const server = this.client.factory().transport.server;
    const ledger = await this.client.ledger();
    for (const { envelope } of this.journal.pending()) {
      const tx = await server.getTransaction(envelope.hash);
      if (tx.status === "SUCCESS" || tx.status === "FAILED")
        this.journal.finish(envelope.hash, tx.status);
      else if (ledger.timestamp > envelope.expiresAt)
        this.journal.finish(envelope.hash, "EXPIRED");
      else
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
    const c = this.client.round(task.round);
    try {
      let reward = snapshot.config.reward;
      if (task.method === "advance")
        reward = (["0.3.0", "0.4.0"] as (string | undefined)[]).includes(
          this.client.deployment.protocolVersion,
        )
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
        this.journal.finish(result.hash, "SUCCESS");
      console.log(
        stringify({ task: task.key, status: result.status, hash: result.hash }),
      );
    } catch (error) {
      this.journal.fail(task, error);
      if (error instanceof RestorationRequired) await this.restoreRead(error);
      else
        console.error(
          stringify({
            task: task.key,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  }
  async next(s: RoundSnapshot, now: bigint): Promise<Task | undefined> {
    const operator = this.client.source;
    const transition = transitionTask(s, now, operator);
    if (transition) return transition;
    const c = this.client.round(s.address);
    if (s.phase !== 3 && s.phase !== 4) return;
    const v3 = (["0.3.0", "0.4.0"] as (string | undefined)[]).includes(
      this.client.deployment.protocolVersion,
    );
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
    if (expired.length)
      return {
        round: s.address,
        method: "expire_limits",
        args: { ids: expired, operator },
        key: `${s.address}:expire:${expired.join(",")}`,
      };
    if (s.phase !== 4 || s.totals.open_orders > 0) return;
    for (const p of s.registrations) {
      const reg = await c.read<Registration>("registration", { p });
      if (!reg.confirmed) continue;
      const player = await c.read<Player>("player", { p });
      if (player.settled) continue;
      let blocked = false;
      if (this.client.deployment.protocolVersion === "0.4.0") {
        for (const position of await c.read<ManagedPosition[]>("positions", {
          p,
        })) {
          if (!position.open) continue;
          if (now >= s.config.calendar.settle_by)
            return {
              round: s.address,
              method: "buyout_position",
              args: { id: position.id, operator },
              key: `${s.address}:position-buyout:${position.id}`,
            };
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
          try {
            await c.transport.prepare(
              task.method,
              c.spec.funcArgsToScVals(task.method, task.args),
            );
            return task;
          } catch (error) {
            if (error instanceof RestorationRequired) throw error;
            blocked = true;
          }
        }
      }
      for (const asset of s.config.assets) {
        if (asset === s.config.cash) continue;
        const n = await c.read<bigint>("balance", { p, asset });
        if (n === 0n) continue;
        if (v3 && now >= s.config.calendar.settle_by)
          return {
            round: s.address,
            method: "close_buyout",
            args: { p, asset, operator },
            key: `${s.address}:buyout:${p}:${asset}`,
          };
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
      if (!blocked)
        return {
          round: s.address,
          method: "settle_player",
          args: { p, operator },
          key: `${s.address}:settle:${p}`,
        };
    }
  }
  async tick() {
    if (!(await this.reconcile())) return;
    const count = await this.client.factory().read<number>("count");
    if (count === 0) return;
    const offset = this.journal.cursor() % count;
    const records = await this.client.rounds(
      offset,
      Math.min(20, count - offset),
    );
    const { timestamp } = await this.client.ledger();
    for (const record of records) {
      try {
        const snapshot = await this.client.snapshot(record);
        const task = await this.next(snapshot, BigInt(timestamp));
        if (task) {
          this.journal.setCursor((record.id + 1) % count);
          await this.submit(task, snapshot);
          return;
        }
      } catch (error) {
        if (error instanceof RestorationRequired) await this.restoreRead(error);
        else
          console.error(
            stringify({
              round: record.address,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    }
    this.journal.setCursor((offset + records.length) % count);
  }
}

export async function main(args = process.argv.slice(2)) {
  const option = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const manifest = option("manifest"),
    keyFile = option("key-file");
  if (!manifest || !keyFile) {
    console.log(
      "Usage: dogstar-executor --manifest=deployments/testnet.json --key-file=/private/operator.secret --journal=.local/executor.sqlite [--once] [--interval-ms=10000] --fee-budget-stroops=100000000 [--max-fee-stroops=10000000] [--min-surplus-stroops=1000] [--allow-unprofitable]\nTESTNET only. Each operator uses their own account and journal.",
    );
    return;
  }
  const permissions = await stat(keyFile);
  if ((permissions.mode & 0o077) !== 0)
    throw new Error("Operator key file must have mode 0600.");
  const signerKey = Keypair.fromSecret(
    (await readFile(keyFile, "utf8")).trim(),
  );
  const deployment = parse<Deployment>(await readFile(manifest, "utf8"));
  const client = new LeagueClient(deployment, signerKey.publicKey());
  const signer: WalletSigner = {
    signTransaction: async (xdr, { address, networkPassphrase }) => {
      if (
        address !== signerKey.publicKey() ||
        networkPassphrase !== Networks.TESTNET
      )
        throw new Error("Signer context changed.");
      const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      transaction.sign(signerKey);
      return { signedTxXdr: transaction.toXDR(), signerAddress: address };
    },
  };
  const journal = new Journal(
    option("journal") ?? ".local/executor.sqlite",
    client.source,
  );
  const policy: FeePolicy = {
    maxFee: BigInt(option("max-fee-stroops") ?? "10000000"),
    totalFeeBudget: BigInt(option("fee-budget-stroops") ?? "0"),
    minSurplus: BigInt(option("min-surplus-stroops") ?? "1000"),
    allowUnprofitable: args.includes("--allow-unprofitable"),
  };
  const executor = new Executor(client, signer, journal, policy);
  const interval = Number(option("interval-ms") ?? 10000);
  if (!Number.isFinite(interval) || interval < 1000 || interval > 60000)
    throw new Error("Interval must be between 1000 and 60000 milliseconds.");
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
  });
  try {
    do {
      try {
        await executor.tick();
      } catch (error) {
        try {
          await executor.restoreRead(error);
        } catch (failure) {
          console.error(
            stringify({
              error:
                failure instanceof Error ? failure.message : String(failure),
            }),
          );
          if (args.includes("--once")) throw failure;
        }
      }
      if (args.includes("--once")) break;
      await new Promise((r) => setTimeout(r, interval));
    } while (!stopped);
  } finally {
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
