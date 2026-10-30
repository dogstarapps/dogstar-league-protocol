import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { StrKey, scValToNative, Asset, Networks } from "@stellar/stellar-sdk";
import { LeagueClient, parse, stringify } from "../packages/sdk/src/index.ts";
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
  proof.deployment.protocolVersion !== "0.5.0" ||
  (proof.positions &&
    (proof.positions.length !== 2 || !proof.ownedPositions)) ||
  (!proof.positions && proof.config.adapters.length !== 0 && !proof.spot)
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
const journalPath = proof.executorJournal
  ? resolve(proof.executorJournal)
  : `${directory}/executor.sqlite`;
if (!journalPath.startsWith(resolve(".local") + "/"))
  throw new Error("Use a preserved local executor journal.");
const db = new DatabaseSync(journalPath, { readOnly: true });
let executorTransactions;
let executorSource;
try {
  executorSource = db
    .prepare("SELECT value FROM settings WHERE key='source'")
    .get()?.value;
  if (!executorSource)
    throw new Error("The executor signing account is not recorded.");
  executorTransactions = db
    .prepare("SELECT hash,task,status FROM transactions ORDER BY updated,hash")
    .all()
    .filter((row) => parse(row.task).round === proof.round)
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
const operatorHashes = new Set(executorTransactions.map((t) => t.hash));
const nativeCash =
  proof.deployment.cash.address === Asset.native().contractId(Networks.TESTNET);
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
  let reward = 0n;
  if (operatorHashes.has(transaction.hash))
    for (const event of live.events?.contractEventsXdr?.flat() ?? []) {
      if (
        !event.contractId ||
        StrKey.encodeContract(event.contractId.value) !==
          proof.deployment.cash.address
      )
        continue;
      const topics = event.body.v0.topics.map(scValToNative);
      if (
        topics[0] === "transfer" &&
        topics[1] === proof.round &&
        topics[2] === executorSource
      ) {
        const amount = scValToNative(event.body.v0.data);
        if (typeof amount === "bigint") reward += amount;
      }
    }
  observedFees.push({
    ...transaction,
    chargedStroops: String(live.resultXdr.feeCharged),
    ...(operatorHashes.has(transaction.hash)
      ? { rewardCashUnits: String(reward) }
      : {}),
  });
}
const economics = observedFees.filter((tx) => operatorHashes.has(tx.hash));
const executorEconomics = {
  executor: executorSource,
  nativeCash,
  chargedStroops: economics.reduce(
    (n, tx) => n + BigInt(tx.chargedStroops),
    0n,
  ),
  rewardsCashUnits: economics.reduce(
    (n, tx) => n + BigInt(tx.rewardCashUnits),
    0n,
  ),
  everyTaskCoversChargedFee:
    nativeCash &&
    economics.every(
      (tx) => BigInt(tx.rewardCashUnits) > BigInt(tx.chargedStroops),
    ),
};
if (
  proof.spot &&
  (!proof.spot.limitFilled ||
    !executorTransactions.some((t) => t.method === "fill_limit") ||
    !executorTransactions.some((t) => t.method === "close_swap"))
)
  throw new Error(
    "A real public limit fill and native Spot closure must be verified.",
  );
const record = await client.factory().read("find", { address: proof.round });
const lp = record.protocols.some((p) => (p.capabilities & 18) === 18);
if (Boolean(record.creator_funded) !== Boolean(proof.creatorFunded))
  throw new Error("Factory funding mode mismatch.");
const totals = await contract.read("totals");
if (
  ["capital", "prizes", "execution", "fee_reserved", "sponsor"].some(
    (key) => totals[key] !== 0n,
  )
)
  throw new Error("Tracked round balances remain unclaimed.");
let coverage = proof.coverage;
if (coverage) {
  const config = await contract.read("config");
  const actualAddress = await contract.read("exit_facility");
  if (config.exit?.tag !== "Covered" || actualAddress !== coverage.address)
    throw new Error("Coverage identity mismatch.");
  const facility = client.facility(
    actualAddress,
    Buffer.from(config.exit.values[0].artifacts.facility_wasm).toString("hex"),
  );
  const [reserved, committed, available] = await Promise.all(
    ["reserved", "committed", "available"].map((method) =>
      facility.read(method),
    ),
  );
  if (reserved !== 0n || committed !== 0n || available !== 0n)
    throw new Error("Actual coverage obligations or unclaimed cash remain.");
  coverage = { ...coverage, reserved, committed, available };
}
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
  coverage,
  positions: proof.positions,
  ownedPositions: proof.ownedPositions,
  nativeRecovery: proof.nativeRecovery,
  providerRecovery: proof.providerRecovery,
  spot: proof.spot,
  phase: proof.phase,
  totals,
  players,
  actorTransactions,
  executorTransactions,
  observedFees,
  executorEconomics,
  scope: proof.spot
    ? "Actual official Soroswap Testnet direct Spot trades, reviewed independent price floors, reserved limit creation and public fill, public native cash closure by a distinct funded executor, all claims and free coverage withdrawal. No Mainnet or installed-wallet signing claim; observed fees/rewards do not guarantee future operator profitability."
    : !proof.positions
      ? "Actual cash-only Testnet funding, player consent, automatic start/end/settlement by an independently funded operator account and final participant/contributor claims. Confirmed RPC receipts and native reward transfers are compared with the operator journal. No external venue, Mainnet, browser-wallet signature or production availability certification."
      : lp
        ? "Actual official Soroswap Testnet pair, direct conversion and LP mint/burn, creator-funded publication, normal withdrawal, public prefunded purchase, owner indexing, provider native recovery and all final claims. Actual SAC transfers are compared with charged executor fees for this run. The external AMM was healthy; the purchase was deliberately exercised at its deadline. Frozen-venue handling is fixture-tested. These Testnet assets, observed rewards and public liquidity do not certify Mainnet admission, future profitability, economic manipulation resistance or browser-wallet signing."
        : "Actual official Blend v2 Testnet native-XLM supply, creator-funded publication, normal withdrawal, public prefunded purchase, owner indexing, provider residual withdrawal and final claims. The healthy external pool uses a test oracle; frozen-venue handling is fixture-tested. Execution used an explicit bounded maintenance allowance, not demonstrated keeper profitability. No Mainnet or browser-wallet signing certification.",
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
