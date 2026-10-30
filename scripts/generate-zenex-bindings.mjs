import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Spec } from "@stellar/stellar-sdk/contract";
const specs = {},
  artifacts = {};
for (const name of ["zenex_adapter", "zenex_vault"]) {
  const wasm = await readFile(
    `contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`,
  );
  const entries = Spec.fromWasm(wasm).entries.map((e) => e.toXDR("base64"));
  specs[name] = entries;
  artifacts[name] = {
    wasmHash: createHash("sha256").update(wasm).digest("hex"),
    interfaceHash: createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex"),
  };
}
await writeFile(
  "packages/sdk/src/generated/zenex-v1.ts",
  `// Generated from own experimental Zenex adapter/vault WASMs. Requires an unavailable venue accounting extension; not a live admission.\nexport const ZENEX_SPEC_ENTRIES = ${JSON.stringify(specs, null, 2)} as const;\nexport const ZENEX_BUILD_ARTIFACTS = ${JSON.stringify(artifacts, null, 2)} as const;\n`,
);
