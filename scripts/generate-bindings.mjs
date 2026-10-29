import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Spec } from '@stellar/stellar-sdk/contract';

const contracts = ['tournament', 'registry', 'factory', 'spot_adapter', 'price_policy'];
const schemas = {};
const artifacts = {};
for (const name of contracts) {
  const path = `contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`;
  const wasm = await readFile(path);
  const entries = Spec.fromWasm(wasm).entries.map((entry) => entry.toXDR('base64'));
  schemas[name] = entries;
  artifacts[name] = {
    wasmHash: createHash('sha256').update(wasm).digest('hex'),
    interfaceHash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}
await mkdir('packages/sdk/src/generated', { recursive: true });
await writeFile('packages/sdk/src/generated/specs.ts', `// Generated from current compiled contract WASM. Run npm run bindings after contract changes.\nexport const SPEC_ENTRIES = ${JSON.stringify(schemas, null, 2)} as const;\nexport const BUILD_ARTIFACTS = ${JSON.stringify(artifacts, null, 2)} as const;\n`);
console.log('Generated ABI schemas and hashes from five current contract WASMs.');
