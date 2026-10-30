// Reuse admitted venue identities; deploy the new immutable access-aware factory/round/registry.
import { readFile, writeFile } from "node:fs/promises";
import {
  LeagueClient,
  BoundContract,
  V6_BUILD_ARTIFACTS,
  hex,
} from "../dist/sdk/src/index.js";
import { testnetSession } from "./lib/testnet-session.mjs";
const output = "deployments/testnet-v6-access.json";
try {
  await readFile(output);
  throw new Error(
    "Preserve the existing access deployment; choose a new reviewed deployment for changed code.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const previous = JSON.parse(
  await readFile("deployments/testnet-v5-lp.json", "utf8"),
);
const session = await testnetSession(
  previous,
  "access-deployment",
  V6_BUILD_ARTIFACTS,
);
try {
  const records = [];
  for (const p of previous.protocols) {
    const record = await session.client
      .registry()
      .read("get", { id: p.id, version: p.version });
    if (
      record.adapter !== p.adapter ||
      hex(record.wasm_hash) !== p.wasmHash ||
      record.capabilities !== p.capabilities ||
      !(await session.client
        .registry()
        .read("available", { id: p.id, version: p.version }))
    )
      throw new Error("Existing venue admission changed.");
    records.push(record);
  }
  const registry = await session.deploy("registry", {
    admin: session.key.publicKey(),
  });
  const registryClient = new BoundContract(
    "registry_v6",
    registry.address,
    session.key.publicKey(),
    previous.rpcUrl,
    registry.wasmHash,
  );
  for (const record of records)
    await session.invoke(registryClient, "admit", { record });
  const roundHash = await session.upload("tournament");
  const factory = await session.deploy("factory", {
    registry: registry.address,
    round_wasm: Buffer.from(roundHash, "hex"),
    quote_policy: previous.quotePolicy.address,
    cash: previous.cash.address,
    exit_artifacts: Object.fromEntries(
      Object.entries(previous.exitArtifacts).map(([key, value]) => [
        key,
        Buffer.from(value, "hex"),
      ]),
    ),
  });
  const deployment = {
    ...previous,
    protocolVersion: "0.6.0",
    factory,
    registry,
    tournament: {
      wasmHash: roundHash,
      interfaceHash: V6_BUILD_ARTIFACTS.tournament.interfaceHash,
    },
    deployedAt: new Date().toISOString(),
  };
  const client = new LeagueClient(deployment);
  if ((await client.factory().read("count")) !== 0)
    throw new Error("New factory should have no rounds.");
  for (const p of deployment.protocols)
    if (
      !(await client
        .registry()
        .read("available", { id: p.id, version: p.version }))
    )
      throw new Error("Copied admission is unavailable.");
  await writeFile(output, JSON.stringify(deployment, null, 2) + "\n", {
    flag: "wx",
  });
  await writeFile(
    "docs/evidence/testnet-access-deployment-2026-10-30.json",
    JSON.stringify(
      {
        network: "TESTNET",
        deployment,
        sourceRevision: "57ae93614c59a2faec5a4fac6b696c05dc4d4cc6",
        transactions: session.transactions,
        reusedVenueIdentities: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      manifest: output,
      factory: factory.address,
      transactions: session.transactions.length,
    }),
  );
} finally {
  session.journal.close();
}
