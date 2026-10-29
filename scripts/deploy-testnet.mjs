import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Asset, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { V4_BUILD_ARTIFACTS as BUILD_ARTIFACTS } from "../dist/sdk/src/generated/specs-v4.js";

for (const [name, artifact] of Object.entries(BUILD_ARTIFACTS)) {
  const wasm = await readFile(
    `contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`,
  );
  if (createHash("sha256").update(wasm).digest("hex") !== artifact.wasmHash)
    throw new Error(
      "Regenerate bindings from the current WASM before deployment: " + name,
    );
}
const outputManifest =
  process.env.DL_DEPLOYMENT_OUTPUT ?? "deployments/testnet-v4.json";
const rpcUrl =
  process.env.DL_TESTNET_RPC ?? "https://soroban-testnet.stellar.org";
const server = new rpc.Server(rpcUrl);
if ((await server.getNetwork()).passphrase !== Networks.TESTNET)
  throw new Error("Deployment supports TESTNET only.");
await mkdir(".local", { recursive: true, mode: 0o700 });
await mkdir(".local/stellar", { recursive: true, mode: 0o700 });
await mkdir("deployments", { recursive: true });
try {
  const existing = JSON.parse(await readFile(outputManifest, "utf8"));
  if (
    existing.protocolVersion === "0.4.0" &&
    existing.factory.wasmHash === BUILD_ARTIFACTS.factory.wasmHash &&
    existing.tournament.wasmHash === BUILD_ARTIFACTS.tournament.wasmHash
  ) {
    console.log(
      JSON.stringify({
        deploymentAlreadyRecorded: outputManifest,
      }),
    );
    process.exit(0);
  }
  throw new Error(
    "Preserve the existing deployment and select a new versioned output before deploying changed code.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const actors = {};
for (const role of ["operator", "player-a", "player-b"]) {
  const path = `.local/${role}.secret`;
  let secret;
  try {
    secret = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    secret = Keypair.random().secret();
    await writeFile(path, secret + "\n", { flag: "wx", mode: 0o600 });
  }
  await chmod(path, 0o600);
  const key = Keypair.fromSecret(secret);
  actors[role] = key;
  try {
    await server.getAccount(key.publicKey());
  } catch {
    const response = await fetch(
      `https://friendbot.stellar.org/?addr=${key.publicKey()}`,
    );
    if (!response.ok)
      throw new Error(`Friendbot failed for ${role}: ${response.status}`);
  }
}
const cash = Asset.native().contractId(Networks.TESTNET),
  secret = actors.operator.secret();
let receipts = {};
try {
  receipts = JSON.parse(
    await readFile(".local/deployment-receipts.json", "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "stellar",
      [
        ...args,
        "--rpc-url",
        rpcUrl,
        "--network-passphrase",
        Networks.TESTNET,
        "--config-dir",
        ".local/stellar",
      ],
      {
        env: { ...process.env, STELLAR_ACCOUNT: secret },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(err.replaceAll(secret, "[redacted]"))),
    );
  });
}
async function deploy(name, args = []) {
  const wasm = `contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`,
    hash = createHash("sha256")
      .update(await readFile(wasm))
      .digest("hex"),
    key = createHash("sha256")
      .update(
        JSON.stringify({
          name,
          hash,
          args,
          owner: actors.operator.publicKey(),
        }),
      )
      .digest("hex");
  if (receipts[key])
    return {
      address: receipts[key],
      wasmHash: hash,
      interfaceHash: BUILD_ARTIFACTS[name]?.interfaceHash,
    };
  // Constructor arguments must follow global options, so assemble this call directly.
  const address = await new Promise((resolve, reject) => {
    const command = [
      "contract",
      "deploy",
      "--wasm",
      wasm,
      "--optimize=false",
      "--rpc-url",
      rpcUrl,
      "--network-passphrase",
      Networks.TESTNET,
      "--config-dir",
      ".local/stellar",
      ...(args.length ? ["--", ...args] : []),
    ];
    const child = spawn("stellar", command, {
      env: { ...process.env, STELLAR_ACCOUNT: secret },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const id = out.match(/\bC[A-Z2-7]{55}\b/)?.[0];
      if (code === 0 && id) resolve(id);
      else reject(new Error(err.replaceAll(secret, "[redacted]")));
    });
  });
  receipts[key] = address;
  await writeFile(
    ".local/deployment-receipts.json",
    JSON.stringify(receipts, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ deployed: name, address, wasmHash: hash }));
  return {
    address,
    wasmHash: hash,
    interfaceHash: BUILD_ARTIFACTS[name]?.interfaceHash,
  };
}
const registry = await deploy("registry", [
  "--admin",
  actors.operator.publicKey(),
]);
const quotePolicy = await deploy("cash_policy");
const roundWasm =
  "contracts/target/wasm32v1-none/release/dogstar_tournament.wasm";
const uploaded = await cli([
  "contract",
  "upload",
  "--wasm",
  roundWasm,
  "--optimize=false",
]);
const roundHash = uploaded.match(/\b[a-f0-9]{64}\b/)?.[0];
if (!roundHash) throw new Error("Missing uploaded tournament hash.");
const exitArtifacts = {};
for (const name of ["exit_facility", "spot_receipt"]) {
  const uploaded = await cli([
    "contract",
    "upload",
    "--wasm",
    `contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`,
    "--optimize=false",
  ]);
  const hash = uploaded.match(/\b[a-f0-9]{64}\b/)?.[0];
  if (hash !== BUILD_ARTIFACTS[name].wasmHash)
    throw new Error("Exit WASM differs from generated artifacts: " + name);
  exitArtifacts[
    name === "exit_facility" ? "facility_wasm" : "spot_receipt_wasm"
  ] = hash;
}
const factory = await deploy("factory", [
  "--registry",
  registry.address,
  "--round_wasm",
  roundHash,
  "--quote_policy",
  quotePolicy.address,
  "--cash",
  cash,
  "--exit_artifacts",
  JSON.stringify(exitArtifacts),
]);
const manifest = {
  schemaVersion: 1,
  protocolVersion: "0.4.0",
  exitArtifacts,
  network: "TESTNET",
  environment: "testnet",
  rpcUrl,
  readSource: actors.operator.publicKey(),
  registry,
  factory,
  tournament: {
    wasmHash: roundHash,
    interfaceHash: BUILD_ARTIFACTS.tournament.interfaceHash,
  },
  quotePolicy,
  cash: { address: cash, symbol: "XLM", decimals: 7 },
  protocols: [],
  deployedAt: new Date().toISOString(),
};
await writeFile(outputManifest, JSON.stringify(manifest, null, 2) + "\n", {
  flag: "wx",
});
console.log(
  JSON.stringify({
    manifest: outputManifest,
    network: "TESTNET",
    operator: actors.operator.publicKey(),
    protocolsAdmitted: 0,
  }),
);
