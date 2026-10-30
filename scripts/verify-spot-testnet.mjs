// Run with node --import tsx; use the current source SDK without installing dependencies.
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  LeagueClient,
  metadataHash,
  quoteSpotTrade,
  assertSpotQuote,
  stringify,
} from "../packages/sdk/src/index.ts";
import { Journal } from "../packages/executor/src/journal.ts";
const d = JSON.parse(await readFile("deployments/testnet-v5-lp.json", "utf8"));
const selected = d.protocols.find((p) => p.id === "soroswap_spot");
if (!selected) throw new Error("Use the admitted direct Spot deployment.");
const keys = {};
for (const name of ["operator", "player-a", "player-b"]) {
  const path = `.local/${name}.secret`;
  if ((await stat(path)).mode & 0o077)
    throw new Error("Use private key files.");
  keys[name] = Keypair.fromSecret((await readFile(path, "utf8")).trim());
}
const client = new LeagueClient(d, keys.operator.publicKey());
const journalPath = ".local/keeper-independent.sqlite";
const check = new Journal(
  journalPath,
  Keypair.fromSecret(
    (await readFile(".local/keeper-independent.secret", "utf8")).trim(),
  ).publicKey(),
);
if (check.pending().length)
  throw new Error("Reconcile the autonomous operator first.");
check.close();
const runDir = `.local/lifecycles/${crypto.randomUUID()}`;
await mkdir(runDir, { recursive: true, mode: 0o700 });
const proof = {
  network: "TESTNET",
  scenario: "spot",
  deployment: d,
  executorJournal: journalPath,
  creatorFunded: true,
  startedAt: new Date().toISOString(),
  transactions: [],
  spot: {},
};
const journals = new Map();
async function save() {
  await writeFile(`${runDir}/progress.json`, stringify(proof) + "\n", {
    mode: 0o600,
  });
}
async function invoke(contract, method, args, key = keys.operator) {
  let journal = journals.get(key.publicKey());
  if (!journal) {
    journal = new Journal(
      `${runDir}/${key.publicKey()}.sqlite`,
      key.publicKey(),
    );
    journals.set(key.publicKey(), journal);
  }
  if (journal.pending().length)
    throw new Error("Preserve and reconcile the pending actor envelope.");
  let fee = 0n;
  const wallet = {
    signTransaction: async (xdr, options) => {
      if (
        options.networkPassphrase !== Networks.TESTNET ||
        options.address !== key.publicKey()
      )
        throw new Error("Signer context changed.");
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      fee = BigInt(tx.fee);
      if (fee > 20000000n)
        throw new Error("Operation exceeds two-XLM fee cap.");
      tx.sign(key);
      return { signedTxXdr: tx.toXDR(), signerAddress: key.publicKey() };
    },
  };
  const result = await contract.invoke(method, args, wallet, {
    beforeSubmit: async (envelope) =>
      journal.save(
        {
          round: contract.transport.options.contractId,
          method,
          args,
          key: `${proof.transactions.length}:${method}`,
        },
        envelope,
        fee,
        1000000000n,
      ),
  });
  if (result.status !== "SUCCESS")
    throw new Error("Reconcile saved transaction " + result.hash);
  journal.receipt(
    result.hash,
    result.ledger,
    BigInt(result.resultXdr.feeCharged),
    "SUCCESS",
  );
  proof.transactions.push({ method, hash: result.hash });
  await save();
  console.log(
    JSON.stringify({ method, hash: result.hash, status: result.status }),
  );
  return result.value;
}
try {
  const now = (await client.ledger()).timestamp;
  const calendar = {
    funding_open: BigInt(now - 30),
    funding_close: BigInt(now + 60),
    registration_open: BigInt(now - 30),
    registration_close: BigInt(now + 110),
    prepare_by: BigInt(now + 170),
    start: BigInt(now + 190),
    risk_cutoff: BigInt(now + 460),
    end: BigInt(now + 520),
    settle_by: BigInt(now + 700),
  };
  const cash = d.cash.address,
    other = selected.assets.find((a) => a.address !== cash).address;
  const config = {
    creator: keys.operator.publicKey(),
    cash,
    assets: [cash, other],
    adapters: [selected.adapter],
    quote_policy: d.quotePolicy.address,
    capital: 100000000n,
    min_players: 2,
    max_players: 2,
    share_bps: 10000,
    prizes: 10000000n,
    execution: 100000000n,
    reward: 1000000n,
    calendar,
    exit: {
      tag: "Covered",
      values: [
        {
          provider: keys.operator.publicKey(),
          fallback_bps: 10000,
          premium_bps: 50,
          minimum_coverage: 200000000n,
          artifacts: Object.fromEntries(
            Object.entries(d.exitArtifacts).map(([k, v]) => [
              k,
              Buffer.from(v, "hex"),
            ]),
          ),
        },
      ],
    },
  };
  const metadata = {
    schemaVersion: 1,
    name: "Soroswap Spot & Limits Open",
    description:
      "Actual Testnet market swaps, public limit fills, portfolio closure and independent execution verification.",
    organizer: { name: "Dogstar protocol verification" },
  };
  Object.assign(proof, { config, metadata });
  await save();
  console.log(JSON.stringify({ records: runDir }));
  const address = await invoke(client.factory(), "create_funded", {
    c: config,
    selections: [{ id: selected.id, version: selected.version }],
    salt: crypto.getRandomValues(new Uint8Array(32)),
    metadata_hash: await metadataHash(metadata),
  });
  proof.round = address;
  await save();
  const round = client.round(address),
    terms = await round.read("terms");
  const facilityAddress = await round.read("exit_facility"),
    facility = client.facility(facilityAddress, d.exitArtifacts.facility_wasm);
  await invoke(facility, "fund", { n: 200000000n, terms });
  proof.coverage = { address: facilityAddress, funded: 200000000n };
  for (const name of ["player-a", "player-b"])
    await invoke(
      new LeagueClient(d, keys[name].publicKey()).round(address),
      "pre_register",
      { p: keys[name].publicKey(), terms, valid_until: calendar.prepare_by },
      keys[name],
    );
  let traded = false;
  for (let tick = 0; tick < 220; tick++) {
    const phase = await round.read("phase");
    if (phase === 6)
      throw new Error(
        "Verification round cancelled; preserve its funded claims.",
      );
    if (phase === 3 && !traded) {
      const entry = {
        adapter: selected.adapter,
        sell: cash,
        buy: other,
        amount: 20000000n,
      };
      const quote = await quoteSpotTrade(d, address, entry);
      assertSpotQuote(quote, address, terms, entry);
      proof.spot.playerAOutput = await invoke(
        new LeagueClient(d, keys["player-a"].publicKey()).round(address),
        "swap",
        {
          p: keys["player-a"].publicKey(),
          sell: cash,
          buy: other,
          n: entry.amount,
          min_out: quote.minimumOut,
          adapter: selected.adapter,
        },
        keys["player-a"],
      );
      const limitQuote = await quoteSpotTrade(d, address, entry);
      if (!limitQuote.eligible) throw new Error(limitQuote.reasons.join(" "));
      proof.spot.orderId = await invoke(
        new LeagueClient(d, keys["player-b"].publicKey()).round(address),
        "place_limit",
        {
          p: keys["player-b"].publicKey(),
          sell: cash,
          buy: other,
          n: entry.amount,
          minimum: limitQuote.minimumOut,
          expires: calendar.risk_cutoff,
        },
        keys["player-b"],
      );
      const exit = {
        adapter: selected.adapter,
        sell: other,
        buy: cash,
        amount: proof.spot.playerAOutput,
      };
      const exitQuote = await quoteSpotTrade(d, address, exit);
      assertSpotQuote(exitQuote, address, terms, exit);
      proof.spot.playerAReturn = await invoke(
        new LeagueClient(d, keys["player-a"].publicKey()).round(address),
        "swap",
        {
          p: keys["player-a"].publicKey(),
          sell: other,
          buy: cash,
          n: exit.amount,
          min_out: exitQuote.minimumOut,
          adapter: selected.adapter,
        },
        keys["player-a"],
      );
      traded = true;
      await save();
    }
    if (traded && !proof.spot.limitFilled) {
      const balance = await round.read("balance", {
        p: keys["player-b"].publicKey(),
        asset: other,
      });
      if (balance > 0n) {
        proof.spot.limitFilled = true;
        proof.spot.playerBOutput = balance;
        await save();
      }
    }
    console.log(
      JSON.stringify({
        round: address,
        phase,
        limitFilled: !!proof.spot.limitFilled,
      }),
    );
    if (phase === 5) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  if ((await round.read("phase")) !== 5)
    throw new Error(
      "Public settlement did not complete in the bounded window.",
    );
  if (!traded || !proof.spot.limitFilled)
    throw new Error(
      "The live Spot/limit flow was not observed; do not certify it.",
    );
  for (const name of ["player-a", "player-b"])
    await invoke(round, "claim", { beneficiary: keys[name].publicKey() });
  for (const [id] of await round.read("owner_deposits", {
    owner: keys.operator.publicKey(),
    offset: 0,
    limit: 20,
  }))
    await invoke(round, "sponsor_claim", { id });
  const available = await facility.read("available");
  if (available > 0n) await invoke(facility, "withdraw_free", { n: available });
  proof.coverage.reserved = await facility.read("reserved");
  proof.coverage.committed = await facility.read("committed");
  proof.phase = await round.read("phase");
  proof.totals = await round.read("totals");
  proof.spot.order = await round.read("order", { id: proof.spot.orderId });
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
  for (const j of journals.values()) j.close();
}
