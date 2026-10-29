import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";
import {
  LeagueClient,
  TestnetClient,
  V5_BUILD_ARTIFACTS,
  stringify,
} from "../dist/sdk/src/index.js";
import { Journal } from "../dist/executor/src/journal.js";

const manifest = JSON.parse(
  await readFile(
    process.env.DL_TESTNET_MANIFEST ?? "deployments/testnet-v5.json",
    "utf8",
  ),
);
if (manifest.protocolVersion !== "0.5.0" || manifest.network !== "TESTNET")
  throw new Error(
    "Blend admission requires the managed-position Testnet deployment.",
  );
const output =
  process.env.DL_ADMISSION_OUTPUT ?? "deployments/testnet-v5-blend.json";
try {
  await readFile(output);
  throw new Error(
    "Preserve the existing admission manifest; reconcile it before repeating admission.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const key = Keypair.fromSecret(
  (await readFile(".local/operator.secret", "utf8")).trim(),
);
const client = new LeagueClient(manifest, key.publicKey());
await client.ledger(); // Verify the network before any signing.
const run = `.local/admissions/${crypto.randomUUID()}`;
await mkdir(run, { recursive: true, mode: 0o700 });
const source =
  "https://raw.githubusercontent.com/blend-capital/blend-utils/main/testnet.contracts.json";
const response = await fetch(source);
if (!response.ok)
  throw new Error(`Official deployment lookup failed: ${response.status}`);
const official = await response.json();
if (official.ids.XLM !== manifest.cash.address)
  throw new Error("Unexpected Blend settlement asset.");
async function cli(args, signing = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "stellar",
      [
        ...args,
        "--rpc-url",
        manifest.rpcUrl,
        "--network-passphrase",
        Networks.TESTNET,
        "--config-dir",
        ".local/stellar",
      ],
      {
        env: {
          ...process.env,
          ...(signing ? { STELLAR_ACCOUNT: key.secret() } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      error = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (error += data));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(error.replaceAll(key.secret(), "[redacted]"))),
    );
  });
}
const poolWasm = `${run}/official-pool.wasm`;
await cli([
  "contract",
  "fetch",
  "--id",
  official.ids.TestnetV2,
  "--out-file",
  poolWasm,
]);
const wasm = await readFile(poolWasm);
const poolHash = createHash("sha256").update(wasm).digest("hex");
if (poolHash !== official.hashes.lendingPoolV2)
  throw new Error("Official pool code does not match the published hash.");
const poolSpec = Spec.fromWasm(wasm);
const pool = new TestnetClient({
  contractId: official.ids.TestnetV2,
  source: key.publicKey(),
  rpcUrl: manifest.rpcUrl,
  expectedCodeHash: poolHash,
});
async function readPool(method, args = {}) {
  const result = await pool.prepare(
    method,
    poolSpec.funcArgsToScVals(method, args),
  );
  return poolSpec.funcResToNative(method, result.simulation.result.retval);
}
const reserve = await readPool("get_reserve", { asset: manifest.cash.address });
const poolConfig = await readPool("get_config");
if (!reserve.config.enabled || poolConfig.status !== 0)
  throw new Error("Official XLM reserve is not active.");
const vaultPath =
  "contracts/target/wasm32v1-none/release/dogstar_blend_vault.wasm";
const adapterPath =
  "contracts/target/wasm32v1-none/release/dogstar_blend_adapter.wasm";
for (const [name, path] of [
  ["blend_vault", vaultPath],
  ["blend_adapter", adapterPath],
])
  if (
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") !== V5_BUILD_ARTIFACTS[name].wasmHash
  )
    throw new Error(`Current source artifacts differ from SDK: ${name}`);
// Reuse an already admitted immutable adapter only after checking its deployed code,
// exact settings and registry record against the current local artifacts.
const records = [];
const count = await client.registry().read("count");
for (let offset = 0; offset < count; offset += 50)
  records.push(
    ...(await client.registry().read("page", { offset, limit: 50 })),
  );
for (const existing of records
  .filter((r) => r.id === "blend_supply")
  .reverse()) {
  if (
    Buffer.from(existing.wasm_hash).toString("hex") !==
      V5_BUILD_ARTIFACTS.blend_adapter.wasmHash ||
    existing.capabilities !== 20
  )
    continue;
  const { BoundContract } = await import("../dist/sdk/src/index.js");
  const adapter = new BoundContract(
    "blend_adapter",
    existing.adapter,
    key.publicKey(),
    manifest.rpcUrl,
    V5_BUILD_ARTIFACTS.blend_adapter.wasmHash,
  );
  const settings = await adapter.read("config");
  if (
    settings.cash !== manifest.cash.address ||
    settings.underlying !== manifest.cash.address ||
    settings.pool !== official.ids.TestnetV2 ||
    settings.reserve_index !== reserve.config.index ||
    Buffer.from(settings.pool_hash).toString("hex") !== poolHash ||
    Buffer.from(settings.vault_wasm).toString("hex") !==
      V5_BUILD_ARTIFACTS.blend_vault.wasmHash
  )
    continue;
  if (
    !(await client
      .registry()
      .read("available", { id: existing.id, version: existing.version }))
  )
    continue;
  await writeFile(
    output,
    JSON.stringify(
      {
        ...manifest,
        protocols: [
          ...manifest.protocols,
          {
            id: existing.id,
            version: existing.version,
            name: "Blend supply",
            capabilities: existing.capabilities,
            adapter: existing.adapter,
            wasmHash: V5_BUILD_ARTIFACTS.blend_adapter.wasmHash,
            assets: [{ ...manifest.cash }],
          },
        ],
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      manifest: output,
      adapter: existing.adapter,
      reusedVerifiedAdmission: true,
      ledger: (await client.ledger()).sequence,
    }),
  );
  process.exit(0);
}
const uploaded = await cli(
  ["contract", "upload", "--wasm", vaultPath, "--optimize=false"],
  true,
);
const vaultHash = uploaded.match(/\b[a-f0-9]{64}\b/)?.[0];
if (vaultHash !== V5_BUILD_ARTIFACTS.blend_vault.wasmHash)
  throw new Error("Unexpected vault upload hash.");
const settings = {
  cash: manifest.cash.address,
  underlying: manifest.cash.address,
  pool: official.ids.TestnetV2,
  pool_hash: poolHash,
  reserve_index: reserve.config.index,
  // No swap can occur when the immutable underlying and settlement asset are identical.
  swap_adapter: manifest.quotePolicy.address,
  swap_hash: manifest.quotePolicy.wasmHash,
  vault_wasm: vaultHash,
};
// Constructor arguments must follow global options.
const address = await new Promise((resolve, reject) => {
  const child = spawn(
    "stellar",
    [
      "contract",
      "deploy",
      "--wasm",
      adapterPath,
      "--optimize=false",
      "--rpc-url",
      manifest.rpcUrl,
      "--network-passphrase",
      Networks.TESTNET,
      "--config-dir",
      ".local/stellar",
      "--",
      "--c",
      JSON.stringify(settings),
    ],
    {
      env: { ...process.env, STELLAR_ACCOUNT: key.secret() },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "",
    error = "";
  child.stdout.on("data", (data) => (out += data));
  child.stderr.on("data", (data) => (error += data));
  child.on("error", reject);
  child.on("close", (code) => {
    const id = out.match(/\bC[A-Z2-7]{55}\b/)?.[0];
    code === 0 && id
      ? resolve(id)
      : reject(new Error(error.replaceAll(key.secret(), "[redacted]")));
  });
});
const descriptor = {
  network: "TESTNET",
  kind: "blend_supply",
  pool: settings.pool,
  poolHash,
  underlying: manifest.cash.address,
  reserveIndex: settings.reserve_index,
  adapter: address,
  adapterHash: V5_BUILD_ARTIFACTS.blend_adapter.wasmHash,
  vaultHash,
  source,
  officialPoolUsesTestOracle: poolConfig.oracle === official.ids.oraclemock,
};
await writeFile(`${run}/descriptor.json`, stringify(descriptor) + "\n", {
  mode: 0o600,
});
const record = {
  id: "blend_supply",
  version:
    Math.max(
      0,
      ...records.filter((r) => r.id === "blend_supply").map((r) => r.version),
    ) + 1,
  adapter: address,
  capabilities: 20,
  wasm_hash: Buffer.from(descriptor.adapterHash, "hex"),
  metadata_hash: createHash("sha256")
    .update(JSON.stringify(descriptor))
    .digest(),
};
const journal = new Journal(`${run}/admission.sqlite`, key.publicKey());
let fee = 0n;
const signer = {
  signTransaction: async (xdr, options) => {
    if (
      options.address !== key.publicKey() ||
      options.networkPassphrase !== Networks.TESTNET
    )
      throw new Error("Signer context mismatch.");
    const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    fee = BigInt(transaction.fee);
    if (fee > 10000000n)
      throw new Error("Admission exceeds its explicit one-XLM fee cap.");
    transaction.sign(key);
    return { signedTxXdr: transaction.toXDR(), signerAddress: key.publicKey() };
  },
};
try {
  const result = await client.registry().invoke("admit", { record }, signer, {
    beforeSubmit: async (envelope) =>
      journal.save(
        {
          round: manifest.registry.address,
          method: "admit",
          args: { record },
          key: "blend_supply:1",
        },
        envelope,
        fee,
        10000000n,
      ),
  });
  if (result.status !== "SUCCESS")
    throw new Error(
      `Pending admission ${result.hash}; reconcile ${run}/admission.sqlite before repeating.`,
    );
  journal.finish(result.hash, "SUCCESS");
  const updated = {
    ...manifest,
    protocols: [
      ...manifest.protocols,
      {
        id: record.id,
        version: record.version,
        name: "Blend supply",
        capabilities: record.capabilities,
        adapter: address,
        wasmHash: descriptor.adapterHash,
        assets: [{ ...manifest.cash }],
      },
    ],
  };
  await writeFile(output, JSON.stringify(updated, null, 2) + "\n", {
    flag: "wx",
  });
  await writeFile(
    `${run}/admission-proof.json`,
    stringify({
      checkedAt: new Date().toISOString(),
      ...descriptor,
      registry: manifest.registry.address,
      admissionTransaction: result.hash,
      poolConfig,
      reserve,
      ledger: (await client.ledger()).sequence,
    }) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      manifest: output,
      adapter: address,
      admission: result.hash,
      records: run,
    }),
  );
} finally {
  journal.close();
}
