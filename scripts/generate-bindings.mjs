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
  "packages/sdk/src/generated/specs-v4.ts",
  `// Generated from current compiled contract WASM. ABI 0.4.0. Prior 0.2.0 and 0.3.0 schemas remain in specs.ts and specs-v3.ts for existing immutable deployments. Run npm run bindings after contract changes.\nexport const V4_SPEC_ENTRIES = ${JSON.stringify(schemas, null, 2)} as const;\nexport const V4_BUILD_ARTIFACTS = ${JSON.stringify(artifacts, null, 2)} as const;\n`,
);
console.log(
  "Generated ABI schemas and hashes from current contract WASMs; retained legacy deployment schemas.",
);
