import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  LeagueClient,
  BoundContract,
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
const scenario = process.env.DL_TESTNET_SCENARIO ?? "cash";
if (!["cash", "blend"].includes(scenario))
  throw new Error("Unknown Testnet scenario.");
const blend =
  scenario === "blend"
    ? d.protocols.find((p) => p.id === "blend_supply")
    : undefined;
if (
  scenario === "blend" &&
  (!blend || !["0.4.0", "0.5.0"].includes(d.protocolVersion))
)
  throw new Error("Use an admitted managed-position Blend Testnet manifest.");
const creatorFunded = process.env.DL_TESTNET_FUNDING === "creator";
if (creatorFunded && d.protocolVersion !== "0.5.0")
  throw new Error("Creator funding requires ABI 0.5.0.");
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
  name: blend
    ? creatorFunded
      ? "Creator-funded Blend Open"
      : "Blend supply lifecycle verification"
    : "Protocol lifecycle verification",
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
  adapters: blend ? [blend.adapter] : [],
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
if (["0.3.0", "0.4.0", "0.5.0"].includes(d.protocolVersion))
  config.exit = { tag: "CashOnly" };
if (blend)
  config.exit = {
    tag: "Covered",
    values: [
      {
        provider: keys.operator.publicKey(),
        fallback_bps: 10000,
        premium_bps: 50,
        minimum_coverage: 20000000n,
        artifacts: Object.fromEntries(
          Object.entries(d.exitArtifacts).map(([k, v]) => [
            k,
            Buffer.from(v, "hex"),
          ]),
        ),
      },
    ],
  };
const salt = crypto.getRandomValues(new Uint8Array(32));
proof.deployment = d;
proof.config = config;
proof.metadata = metadata;
proof.salt = salt;
await writeFile(`${runDir}/progress.json`, stringify(proof) + "\n", {
  mode: 0o600,
});
const address = await invoke(
  client.factory(),
  creatorFunded ? "create_funded" : "create",
  {
    c: config,
    selections: blend ? [{ id: blend.id, version: blend.version }] : [],
    salt,
    metadata_hash: await metadataHash(metadata),
  },
);
proof.round = address;
proof.metadata = metadata;
await writeFile(`${runDir}/progress.json`, stringify(proof) + "\n", {
  mode: 0o600,
});
const round = client.round(address);
const deposits = creatorFunded
  ? (
      await round.read("owner_deposits", {
        owner: keys.operator.publicKey(),
        offset: 0,
        limit: 20,
      })
    ).map(([id]) => id)
  : [];
proof.creatorFunded = creatorFunded;
if (creatorFunded) {
  const record = await client.factory().read("find", { address });
  if (!record.creator_funded || deposits.length !== 3)
    throw new Error("Creator funding was not recorded atomically.");
}
if (!creatorFunded)
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
const facilityAddress = blend ? await round.read("exit_facility") : undefined;
const facility = facilityAddress
  ? client.facility(facilityAddress, d.exitArtifacts.facility_wasm)
  : undefined;
if (facility) {
  await invoke(facility, "fund", { n: 20000000n, terms });
  proof.coverage = { address: facilityAddress, funded: 20000000n };
}
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
  let opened = false;
  for (let tick = 0; tick < 120; tick++) {
    const ledger = await client.ledger();
    // Keep one actual Blend position open until the emergency-purchase deadline.
    // This verifies the public fallback even when the external pool remains healthy.
    if (!opened || BigInt(ledger.timestamp) >= calendar.settle_by)
      await executor.tick();
    const phase = await round.read("phase");
    if (blend && phase === 3 && !opened) {
      proof.positions = [];
      for (const name of ["player-a", "player-b"]) {
        const key = keys[name];
        const playerRound = new LeagueClient(d, key.publicKey()).round(address);
        const id = await invoke(
          playerRound,
          "open_position",
          {
            p: key.publicKey(),
            adapter: blend.adapter,
            n: 5000000n,
            minimums: [5000000n],
            request: new Uint8Array(),
          },
          key,
        );
        proof.positions.push(await round.read("position", { id }));
      }
      const key = keys["player-a"];
      const recovered = await invoke(
        new LeagueClient(d, key.publicKey()).round(address),
        "exit_position",
        {
          p: key.publicKey(),
          id: proof.positions[0].id,
          min_cash: 0n,
          request: new Uint8Array(),
        },
        key,
      );
      proof.nativeRecovery = recovered;
      opened = true;
    }
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
  if (blend) {
    const position = proof.positions[1];
    const vault = new BoundContract(
      "blend_vault",
      position.vault,
      keys.operator.publicKey(),
      d.rpcUrl,
      Buffer.from(position.vault_hash).toString("hex"),
    );
    const info = await vault.read("info");
    if (info.controller !== keys.operator.publicKey())
      throw new Error("Provider did not acquire the actual Blend vault.");
    proof.providerRecovery = await invoke(vault, "native_exit", {
      min_cash: 0n,
      request: new Uint8Array(),
    });
    if (d.protocolVersion === "0.5.0") {
      proof.ownedPositions = {};
      for (const name of ["operator", "player-a", "player-b"]) {
        const owner = keys[name].publicKey();
        const count = await round.read("owner_position_count", { owner });
        const positions = await round.read("owner_positions_page", {
          owner,
          offset: 0,
          limit: 20,
        });
        if (count !== (name === "player-b" ? 0 : 1))
          throw new Error("Incorrect final vault ownership index.");
        proof.ownedPositions[owner] = positions;
      }
    }
    const available = await facility.read("available");
    if (available > 0n)
      await invoke(facility, "withdraw_free", { n: available });
    proof.coverage.reserved = await facility.read("reserved");
    proof.coverage.committed = await facility.read("committed");
  }
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
