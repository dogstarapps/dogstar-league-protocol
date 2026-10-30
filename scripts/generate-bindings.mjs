import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Spec } from "@stellar/stellar-sdk/contract";

const contracts = [
  "tournament",
  "registry",
  "factory",
  "spot_adapter",
  "price_policy",
  "exit_facility",
  "spot_receipt",
  "blend_adapter",
  "blend_vault",
  "lp_adapter",
  "lp_vault",
  "direct_swap",
];
const schemas = {};
const artifacts = {};
for (const name of contracts) {
  const path = `contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`;
  const wasm = await readFile(path);
  const entries = Spec.fromWasm(wasm).entries.map((entry) =>
    entry.toXDR("base64"),
  );
  schemas[name] = entries;
  artifacts[name] = {
    wasmHash: createHash("sha256").update(wasm).digest("hex"),
    interfaceHash: createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex"),
  };
}
await mkdir("packages/sdk/src/generated", { recursive: true });
await writeFile(
  "packages/sdk/src/generated/specs-v5.ts",
  `// Generated from current compiled contract WASM. ABI 0.5.0. Prior schemas remain frozen for existing immutable deployments. Run npm run bindings after contract changes.\nexport const V5_SPEC_ENTRIES = ${JSON.stringify(schemas, null, 2)} as const;\nexport const V5_BUILD_ARTIFACTS = ${JSON.stringify(artifacts, null, 2)} as const;\n`,
);
console.log(
  "Generated ABI schemas and hashes from current contract WASMs; retained legacy deployment schemas.",
);
await import("./generate-zenex-bindings.mjs");

// Profile ABI is independent of immutable tournament deployment ABIs.
const profileWasm = await readFile(
  "contracts/target/wasm32v1-none/release/dogstar_player_profile.wasm",
);
const profileEntries = Spec.fromWasm(profileWasm).entries.map((entry) =>
  entry.toXDR("base64"),
);
await writeFile(
  "packages/sdk/src/generated/profile-v1.ts",
  `// Generated from the compiled player-profile contract, ABI 1.\nexport const PROFILE_SPEC_ENTRIES = ${JSON.stringify(profileEntries, null, 2)} as const;\nexport const PROFILE_BUILD_ARTIFACT = ${JSON.stringify({ wasmHash: createHash("sha256").update(profileWasm).digest("hex"), interfaceHash: createHash("sha256").update(JSON.stringify(profileEntries)).digest("hex") }, null, 2)} as const;\n`,
);
