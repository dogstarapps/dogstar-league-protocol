import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Spec } from "@stellar/stellar-sdk/contract";
import { V5_BUILD_ARTIFACTS } from "../packages/sdk/src/generated/specs-v5.ts";
for (const [name, artifact] of Object.entries(V5_BUILD_ARTIFACTS)) {
  const wasm = await readFile(
    `contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`,
  );
  const entries = Spec.fromWasm(wasm).entries.map((entry) =>
    entry.toXDR("base64"),
  );
  if (
    createHash("sha256").update(JSON.stringify(entries)).digest("hex") !==
    artifact.interfaceHash
  )
    throw new Error(`Generated ABI drift: ${name}`);
}
console.log(
  "Current compiled interfaces match the versioned SDK. Compiler-specific code hashes are checked separately during deployment.",
);
