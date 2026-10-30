import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  LeagueClient,
  profileContract,
  PROFILE_BUILD_ARTIFACT,
} from "../dist/sdk/src/index.js";
const input =
  process.env.DL_TESTNET_MANIFEST ?? "deployments/testnet-v5-blend.json";
const output =
  process.env.DL_PROFILE_MANIFEST ?? "deployments/testnet-v5-profile.json";
const manifest = JSON.parse(await readFile(input, "utf8"));
const client = new LeagueClient(manifest);
await client.ledger();
try {
  await readFile(output);
  throw new Error("Preserve the existing profile deployment manifest.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const wasm =
  "contracts/target/wasm32v1-none/release/dogstar_player_profile.wasm";
if (
  createHash("sha256")
    .update(await readFile(wasm))
    .digest("hex") !== PROFILE_BUILD_ARTIFACT.wasmHash
)
  throw new Error("Current profile WASM differs from the SDK.");
const key = Keypair.fromSecret(
  (await readFile(".local/operator.secret", "utf8")).trim(),
);
const address = await new Promise((resolve, reject) => {
  const child = spawn(
    "stellar",
    [
      "contract",
      "deploy",
      "--wasm",
      wasm,
      "--optimize=false",
      "--rpc-url",
      manifest.rpcUrl,
      "--network-passphrase",
      Networks.TESTNET,
      "--config-dir",
      ".local/stellar",
    ],
    {
      env: { ...process.env, STELLAR_ACCOUNT: key.secret() },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "",
    error = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (error += d));
  child.on("error", reject);
  child.on("close", (code) => {
    const id = out.match(/\bC[A-Z2-7]{55}\b/)?.[0];
    code === 0 && id
      ? resolve(id)
      : reject(new Error(error.replaceAll(key.secret(), "[redacted]")));
  });
});
const profile = { address, ...PROFILE_BUILD_ARTIFACT, version: 1 };
if (
  (await profileContract(profile, manifest.readSource, manifest.rpcUrl).read(
    "version",
  )) !== 1
)
  throw new Error("Unexpected deployed profile ABI.");
await writeFile(
  output,
  JSON.stringify({ ...manifest, profile }, null, 2) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify({ manifest: output, profile }));
