import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { LeagueClient, parse, stringify } from "../dist/sdk/src/index.js";
const input = process.argv[2];
const output = process.argv[3];
if (!input || !output)
  throw new Error(
    "Usage: node scripts/collect-lifecycle-proof.mjs .local/lifecycles/<run-id> docs/evidence/<new-file>.json",
  );
const directory = resolve(input);
if (!directory.startsWith(resolve(".local/lifecycles") + "/"))
  throw new Error("Use a preserved local lifecycle run directory.");
const proof = parse(await readFile(`${directory}/proof.json`, "utf8"));
if (
  proof.network !== "TESTNET" ||
  proof.phase !== 5 ||
  !proof.creatorFunded ||
  proof.deployment.protocolVersion !== "0.5.0" ||
  proof.positions?.length !== 2 ||
  !proof.ownedPositions
)
  throw new Error("A completed Testnet lifecycle is required.");
const client = new LeagueClient(proof.deployment);
const contract = client.round(proof.round);
if ((await contract.read("phase")) !== 5)
  throw new Error("The live round is not finalized.");
const registrations = await contract.read("registrations");
const players = [];
for (const address of registrations) {
  const registration = await contract.read("registration", { p: address });
  if (!registration.confirmed) continue;
  const player = await contract.read("player", { p: address });
  if (!player.settled || !player.claimed)
    throw new Error("Final participant claims are incomplete.");
  players.push({ address, ...player });
}
const db = new DatabaseSync(`${directory}/executor.sqlite`, { readOnly: true });
let executorTransactions;
try {
  executorTransactions = db
    .prepare("SELECT hash,task,status FROM transactions ORDER BY updated,hash")
    .all()
    .map((row) => ({
      method: parse(row.task).method,
      hash: row.hash,
      status: row.status,
    }));
} finally {
  db.close();
}
const actorTransactions = proof.transactions.map(({ method, hash }) => ({
  method,
  hash,
}));
const observedFees = [];
for (const transaction of [...actorTransactions, ...executorTransactions]) {
  if (!/^[a-f0-9]{64}$/.test(transaction.hash))
    throw new Error("Invalid transaction hash.");
  const live = await client
    .factory()
    .transport.server.getTransaction(transaction.hash);
  if (live.status !== "SUCCESS")
    throw new Error(
      `Transaction is not confirmed successful: ${transaction.hash}`,
    );
  observedFees.push({
    ...transaction,
    chargedStroops: String(live.resultXdr.feeCharged),
  });
}
const record = await client.factory().read("find", { address: proof.round });
if (Boolean(record.creator_funded) !== Boolean(proof.creatorFunded))
  throw new Error("Factory funding mode mismatch.");
const totals = await contract.read("totals");
if (
  ["capital", "prizes", "execution", "fee_reserved", "sponsor"].some(
    (key) => totals[key] !== 0n,
  )
)
  throw new Error("Tracked round balances remain unclaimed.");
const evidence = {
  network: proof.network,
  startedAt: proof.startedAt,
  finishedAt: proof.finishedAt,
  checkedAt: new Date().toISOString(),
  deployment: proof.deployment,
  config: proof.config,
  metadata: proof.metadata,
  round: proof.round,
  creatorFunded: proof.creatorFunded,
  coverage: proof.coverage,
  positions: proof.positions,
  ownedPositions: proof.ownedPositions,
  nativeRecovery: proof.nativeRecovery,
  providerRecovery: proof.providerRecovery,
  phase: proof.phase,
  totals,
  players,
  actorTransactions,
  executorTransactions,
  observedFees,
  scope:
    "Actual official Blend v2 Testnet native-XLM supply, creator-funded publication, normal withdrawal, public prefunded purchase, owner indexing, provider residual withdrawal and final claims. The healthy external pool uses a test oracle; frozen-venue handling is fixture-tested. Execution used an explicit bounded maintenance allowance, not demonstrated keeper profitability. No Mainnet or browser-wallet signing certification.",
};
await writeFile(output, stringify(evidence) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    evidence: output,
    round: proof.round,
    creatorFunded: proof.creatorFunded,
    actorTransactions: actorTransactions.length,
    executorTransactions: executorTransactions.length,
    confirmedTransactions: observedFees.length,
    players: players.length,
  }),
);
