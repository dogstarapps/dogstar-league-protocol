import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  parse,
  stringify,
  type PendingEnvelope,
  type RoundRecord,
} from "../../sdk/src/index.js";
import type { Task } from "./planner.js";
export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string, source: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS transactions(hash TEXT PRIMARY KEY,envelope TEXT NOT NULL,task TEXT NOT NULL,status TEXT NOT NULL,updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS failures(task TEXT PRIMARY KEY,message TEXT NOT NULL,updated INTEGER NOT NULL);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS transaction_receipts(hash TEXT PRIMARY KEY,ledger INTEGER NOT NULL,fee TEXT NOT NULL,status TEXT NOT NULL);",
    );
    const owner = this.db
      .prepare("SELECT value FROM settings WHERE key='source'")
      .get() as { value: string } | undefined;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS task_retries(task TEXT PRIMARY KEY,attempts INTEGER NOT NULL,retry_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS failure_history(id INTEGER PRIMARY KEY,task TEXT NOT NULL,message TEXT NOT NULL,at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS round_work(scope TEXT NOT NULL,address TEXT NOT NULL,record TEXT NOT NULL,phase INTEGER NOT NULL DEFAULT -1,next_at INTEGER NOT NULL DEFAULT 0,checked_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,address));",
    );
    if (path !== ":memory:") chmodSync(path, 0o600);
    if (owner && owner.value !== source) {
      this.db.close();
      throw new Error(
        "Executor journal belongs to a different signing account.",
      );
    }
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES(?,?)")
      .run("source", source);
  }
  pending() {
    return (
      this.db
        .prepare(
          "SELECT envelope,task,status FROM transactions WHERE status IN('PENDING','UNKNOWN') ORDER BY updated",
        )
        .all() as { envelope: string; task: string; status: string }[]
    ).map((r) => ({
      envelope: parse<PendingEnvelope>(r.envelope),
      task: parse<Task>(r.task),
      status: r.status,
    }));
  }
  feeAllocated() {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='fees_allocated'")
      .get() as { value: string } | undefined;
    return BigInt(row?.value ?? 0);
  }
  save(task: Task, pending: PendingEnvelope, fee = 0n, budget = 0n) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (fee < 0n || this.feeAllocated() + fee > budget)
        throw new Error("Operator fee budget is exhausted.");
      if (this.pending().length)
        throw new Error(
          "Reconcile the pending envelope before allocating another source sequence.",
        );
      this.db
        .prepare("INSERT INTO transactions VALUES(?,?,?,?,?)")
        .run(
          pending.hash,
          stringify(pending),
          stringify(task),
          "PENDING",
          Date.now(),
        );
      this.db
        .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
        .run("fees_allocated", String(this.feeAllocated() + fee));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  receipt(
    hash: string,
    ledger: number,
    fee: bigint,
    status: "SUCCESS" | "FAILED",
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (fee < 0n) throw new Error("Invalid charged fee.");
      const result = this.db
        .prepare("INSERT OR IGNORE INTO transaction_receipts VALUES(?,?,?,?)")
        .run(hash, ledger, String(fee), status);
      if (result.changes) {
        const row = this.db
          .prepare("SELECT value FROM settings WHERE key='fees_charged'")
          .get() as { value: string } | undefined;
        this.db
          .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
          .run("fees_charged", String(BigInt(row?.value ?? 0) + fee));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.finish(hash, status);
  }
  finish(hash: string, status: string) {
    this.db
      .prepare("UPDATE transactions SET status=?,updated=? WHERE hash=?")
      .run(status, Date.now(), hash);
    if (status === "SUCCESS") {
      const row = this.db
        .prepare("SELECT task FROM transactions WHERE hash=?")
        .get(hash) as { task: string } | undefined;
      if (row)
        this.db
          .prepare("UPDATE task_retries SET attempts=0,retry_at=0 WHERE task=?")
          .run(parse<Task>(row.task).key);
    }
  }
  fail(task: Task, error: unknown) {
    const message = error instanceof Error ? error.message : String(error),
      now = Date.now();
    this.db
      .prepare("INSERT OR REPLACE INTO failures VALUES(?,?,?)")
      .run(task.key, message, now);
    const previous = this.db
      .prepare("SELECT attempts FROM task_retries WHERE task=?")
      .get(task.key) as { attempts: number } | undefined;
    const attempts = Math.min(20, (previous?.attempts ?? 0) + 1);
    this.db
      .prepare("INSERT OR REPLACE INTO task_retries VALUES(?,?,?)")
      .run(
        task.key,
        attempts,
        now + Math.min(120000, 5000 * 2 ** (attempts - 1)),
      );
    this.db
      .prepare("INSERT INTO failure_history(task,message,at) VALUES(?,?,?)")
      .run(task.key, message, now);
  }
  canAttempt(task: Task, now = Date.now()) {
    const row = this.db
      .prepare("SELECT retry_at FROM task_retries WHERE task=?")
      .get(task.key) as { retry_at: number } | undefined;
    return !row || row.retry_at <= now;
  }
  value(key: string, fallback = 0) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    return Number(row?.value ?? fallback);
  }
  setValue(key: string, value: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run(key, String(value));
  }
  remember(scope: string, records: RoundRecord[]) {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO round_work(scope,address,record) VALUES(?,?,?)",
    );
    for (const record of records)
      insert.run(scope, record.address, stringify(record));
  }
  work(scope: string, now: number) {
    const known = this.db
      .prepare(
        "SELECT record FROM round_work WHERE scope=? AND phase NOT IN(-1,5,6) AND next_at<=? ORDER BY next_at,checked_at LIMIT 15",
      )
      .all(scope, now);
    const unknown = this.db
      .prepare(
        "SELECT record FROM round_work WHERE scope=? AND phase=-1 AND next_at<=? ORDER BY json_extract(record,'$.id') DESC LIMIT 5",
      )
      .all(scope, now);
    return [...known, ...unknown].map((row) =>
      parse<RoundRecord>((row as { record: string }).record),
    );
  }
  checked(scope: string, address: string, phase: number, nextAt: number) {
    this.db
      .prepare(
        "UPDATE round_work SET phase=?,next_at=?,checked_at=? WHERE scope=? AND address=?",
      )
      .run(phase, nextAt, Date.now(), scope, address);
  }
  summary() {
    const counts = this.db
      .prepare("SELECT status,COUNT(*) count FROM transactions GROUP BY status")
      .all();
    const backlog = this.db
      .prepare("SELECT phase,COUNT(*) count FROM round_work GROUP BY phase")
      .all();
    const charged = this.db
      .prepare("SELECT value FROM settings WHERE key='fees_charged'")
      .get() as { value: string } | undefined;
    return {
      feesCharged: BigInt(charged?.value ?? 0),
      feesAllocated: this.feeAllocated(),
      transactions: counts,
      rounds: backlog,
    };
  }
  cursor() {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='cursor'")
      .get() as { value: string } | undefined;
    return Number(row?.value ?? 0);
  }
  setCursor(cursor: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run("cursor", String(cursor));
  }
  orderCursor(round: string) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`orders:${round}`) as { value: string } | undefined;
    return Number(row?.value ?? 1);
  }
  setOrderCursor(round: string, cursor: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run(`orders:${round}`, String(cursor));
  }
  close() {
    this.db.close();
  }
}
