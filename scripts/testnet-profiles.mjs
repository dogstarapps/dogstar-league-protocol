import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  LeagueClient,
  profileContract,
  avatarCid,
  avatarInfo,
  stringify,
} from "../dist/sdk/src/index.js";
import { Journal } from "../dist/executor/src/journal.js";
const deployment = JSON.parse(
  await readFile(
    process.env.DL_PROFILE_MANIFEST ?? "deployments/testnet-v5-profile.json",
    "utf8",
  ),
);
if (!deployment.profile)
  throw new Error("An actual profile deployment is required.");
const a = new Uint8Array(
  await readFile(
    process.env.DL_AVATAR_A ??
      "../dogstar-league-v2/.local/profile-proof/orbit.png",
  ),
);
const b = new Uint8Array(
  await readFile(
    process.env.DL_AVATAR_B ??
      "../dogstar-league-v2/.local/profile-proof/nova.png",
  ),
);
avatarInfo(a);
avatarInfo(b);
const cidA = await avatarCid(a),
  cidB = await avatarCid(b);
const keys = {};
for (const name of ["player-a", "player-b", "operator"])
  keys[name] = Keypair.fromSecret(
    (await readFile(`.local/${name}.secret`, "utf8")).trim(),
  );
const client = new LeagueClient(deployment);
await client.ledger();
const run = `.local/profiles/${crypto.randomUUID()}`;
await mkdir(run, { recursive: true, mode: 0o700 });
const transactions = [];
const journals = [];
const proof = {
  network: "TESTNET",
  deployment,
  startedAt: new Date().toISOString(),
  transactions,
};
async function invoke(key, method, args) {
  const contract = profileContract(
    deployment.profile,
    key.publicKey(),
    deployment.rpcUrl,
  );
  const journal = new Journal(
    `${run}/${key.publicKey()}.sqlite`,
    key.publicKey(),
  );
  journals.push(journal);
  let fee = 0n;
  const result = await contract.invoke(
    method,
    args,
    {
      signTransaction: async (xdr, options) => {
        if (
          options.address !== key.publicKey() ||
          options.networkPassphrase !== Networks.TESTNET
        )
          throw new Error("Signer context mismatch.");
        const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
        fee = BigInt(transaction.fee);
        if (fee > 10000000n)
          throw new Error("Profile verification exceeds its one-XLM fee cap.");
        transaction.sign(key);
        return {
          signedTxXdr: transaction.toXDR(),
          signerAddress: key.publicKey(),
        };
      },
    },
    {
      beforeSubmit: async (envelope) =>
        journal.save(
          {
            round: deployment.profile.address,
            method,
            args,
            key: `${transactions.length}:${method}`,
          },
          envelope,
          fee,
          100000000n,
        ),
    },
  );
  if (result.status !== "SUCCESS")
    throw new Error(
      `Pending profile transaction ${result.hash}; reconcile the exact saved envelope under ${run} before repeating.`,
    );
  journal.finish(result.hash, "SUCCESS");
  transactions.push({ method, signer: key.publicKey(), hash: result.hash });
  await writeFile(`${run}/progress.json`, stringify(proof) + "\n", {
    mode: 0o600,
  });
  return result.value;
}
try {
  const contract = profileContract(
    deployment.profile,
    deployment.readSource,
    deployment.rpcUrl,
  );
  const ownerA = keys["player-a"].publicKey(),
    ownerB = keys["player-b"].publicKey();
  const existing = await contract.read("get_many", {
    owners: [ownerA, ownerB],
  });
  if (existing.some((p) => p))
    throw new Error(
      "Preserve existing profiles; use a fresh verification scope instead of overwriting them.",
    );
  await invoke(keys["player-a"], "set_profile", {
    owner: ownerA,
    nickname: "OrbitRunner Draft",
    avatar_cid: cidB,
    expected_revision: 0,
  });
  await invoke(keys["player-b"], "set_profile", {
    owner: ownerB,
    nickname: "NovaTrader",
    avatar_cid: cidB,
    expected_revision: 0,
  });
  await invoke(keys["player-a"], "set_profile", {
    owner: ownerA,
    nickname: "OrbitRunner",
    avatar_cid: cidA,
    expected_revision: 1,
  });
  let stale = false;
  try {
    await contract.read("set_profile", {
      owner: ownerA,
      nickname: "Stale Edit",
      avatar_cid: cidB,
      expected_revision: 0,
    });
  } catch (error) {
    if (/Error\(Contract, #3\)/.test(error.message)) stale = true;
    else throw error;
  }
  if (!stale)
    throw new Error(
      "The stale edit was not rejected by the deployed contract.",
    );
  await invoke(keys.operator, "keepalive", { owner: ownerA });
  const profiles = await contract.read("get_many", {
    owners: [ownerA, ownerB],
  });
  if (
    profiles[0]?.owner !== ownerA ||
    profiles[0].nickname !== "OrbitRunner" ||
    profiles[0].revision !== 2 ||
    profiles[0].avatar_cid !== cidA ||
    profiles[1]?.revision !== 1 ||
    profiles[1].owner !== ownerB
  )
    throw new Error("Live profile state does not match its signed updates.");
  const checked = [];
  for (const tx of transactions) {
    const live = await client
      .factory()
      .transport.server.getTransaction(tx.hash);
    if (live.status !== "SUCCESS")
      throw new Error("A recorded transaction is not successful.");
    checked.push({ ...tx, chargedStroops: String(live.resultXdr.feeCharged) });
  }
  Object.assign(proof, {
    profiles,
    staleEditRejected: true,
    transactions: checked,
    finishedAt: new Date().toISOString(),
    scope:
      "Synthetic Testnet players authorize their own profile creation and revisioned avatar update. An independent account renews storage without edit authority. IPFS availability and browser wallet signing are verified separately.",
  });
  const output =
    process.env.DL_PROFILE_PROOF ??
    "docs/evidence/testnet-profiles-2026-10-30.json";
  await writeFile(output, stringify(proof) + "\n", { flag: "wx" });
  await writeFile(`${run}/proof.json`, stringify(proof) + "\n", {
    mode: 0o600,
  });
  console.log(
    stringify({
      verified: true,
      contract: deployment.profile.address,
      profiles,
      transactions: checked.length,
      evidence: output,
      records: run,
    }),
  );
} finally {
  for (const journal of journals) journal.close();
}
