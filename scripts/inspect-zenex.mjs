import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Spec } from "@stellar/stellar-sdk/contract";
import { inspectZenexInterface } from "../dist/sdk/src/index.js";
const input = process.argv[2],
  output = process.argv[3];
if (!input || !output)
  throw new Error(
    "Usage: node scripts/inspect-zenex.mjs <fetched-market.wasm> <new-evidence.json>",
  );
const wasm = await readFile(input),
  hash = createHash("sha256").update(wasm).digest("hex");
const spec = Spec.fromWasm(wasm),
  entries = spec.entries.map((e) => e.toXDR("base64"));
const result = {
  checkedAt: new Date().toISOString(),
  network: "PUBLIC",
  market: "CAOZCITWHWAXH5FRU4EULQ5EN2HMTCHICRNC4R5ZAOVD7XHCCQSJ42IB",
  observedWasmHash: hash,
  source:
    "https://github.com/zenith-protocols/zenex-docs/blob/main/docs/deployments.md",
  ...inspectZenexInterface(entries),
  methods: spec.funcs().map((f) => f.name.toString()),
  signedTransactions: 0,
  scope:
    "Read-only inspection of the current fetched market binary. Interface compatibility alone cannot admit a venue: actual payment attribution, oracle reports, isolation and both exit paths require verification. The own experimental adapter/vault implements the proposed extension, not an upgrade of this deployed Zenex market.",
};
await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    evidence: output,
    hash,
    interfaceCompatible: result.interfaceCompatible,
    liveAdmitted: false,
    reasons: result.reasons,
  }),
);
