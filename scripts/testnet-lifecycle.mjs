import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  LeagueClient,
  metadataHash,
  stringify,
} from "../dist/sdk/src/index.js";
import { Executor } from "../dist/executor/src/daemon.js";
import { Journal } from "../dist/executor/src/journal.js";
const d = JSON.parse(
  await readFile(
    process.env.DL_TESTNET_MANIFEST ?? "deployments/testnet.json",
    "utf8",
  ),
);
const runId = crypto.randomUUID(),
  runDir = `.local/lifecycles/${runId}`;
await mkdir(runDir, { recursive: true, mode: 0o700 });
console.log(JSON.stringify({ runId, records: runDir }));
const keys = {};
for (const name of ["operator", "player-a", "player-b"])
  keys[name] = Keypair.fromSecret(
    (await readFile(`.local/${name}.secret`, "utf8")).trim(),
  );
const signer = (key) => ({
  signTransaction: async (xdr, options) => {
    if (
      options.address !== key.publicKey() ||
      options.networkPassphrase !== Networks.TESTNET
    )
      throw new Error("Signer context mismatch.");
    const t = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    t.sign(key);
    return { signedTxXdr: t.toXDR(), signerAddress: key.publicKey() };
  },
});
const client = new LeagueClient(d, keys.operator.publicKey()),
  proof = {
    network: "TESTNET",
    transactions: [],
    startedAt: new Date().toISOString(),
  };
const actorJournals = new Map();
const journalFor = (key) => {
  let journal = actorJournals.get(key.publicKey());
  if (!journal) {
    journal = new Journal(
      `${runDir}/${key.publicKey()}.sqlite`,
      key.publicKey(),
    );
    actorJournals.set(key.publicKey(), journal);
  }
  return journal;
};
async function invoke(c, method, args, key = keys.operator) {
  const task = {
    round: c.transport.options.contractId,
    method,
    args,
    key: `${proof.transactions.length}:${method}`,
  };
  const journal = journalFor(key);
  let fee = 0n;
  const wallet = {
    signTransaction: async (xdr, options) => {
      fee = BigInt(TransactionBuilder.fromXDR(xdr, Networks.TESTNET).fee);
      if (fee > 1000000000n)
        throw new Error(
          "Verification transaction exceeds its explicit Testnet fee cap.",
        );
      return signer(key).signTransaction(xdr, options);
    },
  };
  const r = await c.invoke(method, args, wallet, {
    beforeSubmit: async (envelope) => {
      journal.save(task, envelope, fee, 1000000000n);
    },
  });
  if (r.status !== "SUCCESS")
    throw new Error(
      `Pending ${method}: ${r.hash}; the exact envelope is saved under ${runDir}. Reconcile before repeating any action.`,
    );
  journal.finish(r.hash, "SUCCESS");
  proof.transactions.push({ method, hash: r.hash });
  await writeFile(`${runDir}/progress.json`, stringify(proof) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ method, status: r.status, hash: r.hash }));
  return r.value;
}

const now = (await client.ledger()).timestamp;
const metadata = {
  schemaVersion: 1,
  name: "Protocol lifecycle verification",
  description:
    "On-chain Testnet funding, consent, public execution and claims verification.",
  organizer: { name: "Dogstar protocol verification" },
};
const calendar = {
  funding_open: BigInt(now - 30),
  funding_close: BigInt(now + 120),
  registration_open: BigInt(now - 30),
  registration_close: BigInt(now + 180),
  prepare_by: BigInt(now + 240),
  start: BigInt(now + 260),
  risk_cutoff: BigInt(now + 290),
  end: BigInt(now + 320),
  settle_by: BigInt(now + 440),
};
const config = {
  creator: keys.operator.publicKey(),
  cash: d.cash.address,
  assets: [d.cash.address],
  adapters: [],
  quote_policy: d.quotePolicy.address,
  capital: 10000000n,
  min_players: 2,
  max_players: 2,
  share_bps: 10000,
  prizes: 10000000n,
  execution: 10000000n,
  reward: 10000n,
  calendar,
};
if (d.protocolVersion === "0.3.0") config.exit = { tag: "CashOnly" };
const salt = crypto.getRandomValues(new Uint8Array(32));
proof.deployment = d;
proof.config = config;
proof.metadata = metadata;
proof.salt = salt;
await writeFile(`${runDir}/progress.json`, stringify(proof) + "\n", {
  mode: 0o600,
});
const address = await invoke(client.factory(), "create", {
  c: config,
  selections: [],
  salt,
  metadata_hash: await metadataHash(metadata),
});
proof.round = address;
proof.metadata = metadata;
await writeFile(`${runDir}/progress.json`, stringify(proof) + "\n", {
  mode: 0o600,
});
const round = client.round(address);
const deposits = [];
for (const [bucket, n] of [
  [0, 20000000n],
  [1, 10000000n],
  [2, 10000000n],
])
  deposits.push(
    await invoke(round, "contribute", {
      owner: keys.operator.publicKey(),
      bucket,
      n,
    }),
  );
const terms = await round.read("terms");
for (const name of ["player-a", "player-b"]) {
  const key = keys[name];
  await invoke(
    new LeagueClient(d, key.publicKey()).round(address),
    "pre_register",
    { p: key.publicKey(), terms, valid_until: calendar.prepare_by },
    key,
  );
}
const journal = new Journal(
    `${runDir}/executor.sqlite`,
    keys.operator.publicKey(),
  ),
  executor = new Executor(client, signer(keys.operator), journal, {
    maxFee: 10000000n,
    totalFeeBudget: 1000000000n,
    minSurplus: 0n,
    allowUnprofitable: true,
  });
try {
  for (let tick = 0; tick < 120; tick++) {
    await executor.tick();
    const phase = await round.read("phase");
    console.log(
      JSON.stringify({
        round: address,
        phase,
        ledger: (await client.ledger()).sequence,
      }),
    );
    if (phase === 5) break;
    if (phase === 6) throw new Error("Verification round cancelled.");
    await new Promise((r) => setTimeout(r, 3000));
  }
  if ((await round.read("phase")) !== 5)
    throw new Error(
      "Settlement did not complete within the verification window.",
    );
  for (const name of ["player-a", "player-b"])
    await invoke(round, "claim", { beneficiary: keys[name].publicKey() });
  for (const id of deposits) await invoke(round, "sponsor_claim", { id });
  proof.phase = await round.read("phase");
  proof.totals = await round.read("totals");
  proof.finishedAt = new Date().toISOString();
  await writeFile(`${runDir}/proof.json`, stringify(proof) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      verified: true,
      round: address,
      proof: `${runDir}/proof.json`,
    }),
  );
} finally {
  journal.close();
  for (const actorJournal of actorJournals.values()) actorJournal.close();
}
