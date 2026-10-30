// Read-only venue inspection. A passing market check never admits an adapter.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Networks } from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";
import {
  LeagueClient,
  TestnetClient,
  stringify,
} from "../dist/sdk/src/index.js";

const output = process.argv[2];
if (!output)
  throw new Error(
    "Usage: node scripts/inspect-lp-testnet.mjs <new-evidence.json>",
  );
try {
  await readFile(output);
  throw new Error(
    "Preserve the existing inspection and select a new evidence path.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const deployment = JSON.parse(
  await readFile(
    process.env.DL_TESTNET_MANIFEST ?? "deployments/testnet-v5-profile.json",
    "utf8",
  ),
);
const league = new LeagueClient(deployment);
await league.ledger();
const vendorSource =
  "https://raw.githubusercontent.com/soroswap/core/main/public/testnet.contracts.json";
const vendorResponse = await fetch(vendorSource);
if (!vendorResponse.ok)
  throw new Error("Official Soroswap deployment lookup failed.");
const vendor = await vendorResponse.json();
const directory = `.local/inspections/${crypto.randomUUID()}`;
await mkdir(directory, { recursive: true, mode: 0o700 });
async function contract(name, address, expectedHash) {
  const path = `${directory}/${name}.wasm`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      "stellar",
      [
        "contract",
        "fetch",
        "--id",
        address,
        "--out-file",
        path,
        "--rpc-url",
        deployment.rpcUrl,
        "--network-passphrase",
        Networks.TESTNET,
        "--config-dir",
        ".local/stellar",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errors = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(errors)),
    );
  });
  const wasm = await readFile(path),
    codeHash = createHash("sha256").update(wasm).digest("hex");
  if (codeHash !== expectedHash)
    throw new Error(`Unexpected deployed ${name} code.`);
  const spec = Spec.fromWasm(wasm);
  const transport = new TestnetClient({
    contractId: address,
    source: deployment.readSource,
    rpcUrl: deployment.rpcUrl,
    expectedCodeHash: codeHash,
  });
  return {
    address,
    codeHash,
    read: async (method, args = {}) => {
      const result = await transport.prepare(
        method,
        spec.funcArgsToScVals(method, args),
      );
      const value = spec.funcResToNative(
        method,
        result.simulation.result.retval,
      );
      if (value && typeof value.isOk === "function") {
        if (!value.isOk())
          throw new Error(`External ${name}.${method} failed.`);
        return value.unwrap();
      }
      return value;
    },
  };
}
const factory = await contract(
  "factory",
  vendor.ids.factory,
  vendor.hashes.factory,
);
const router = await contract(
  "router",
  vendor.ids.router,
  vendor.hashes.router,
);
const cash = deployment.cash.address;
const testUsdc = "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
const pairAddress = await factory.read("get_pair", {
  token_a: cash,
  token_b: testUsdc,
});
const pair = await contract("pair", pairAddress, vendor.hashes.pair);
const oracle = await contract(
  "oracle",
  "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
  "25fc306065cbb9b05461db78ec259802cb916053ba5b3ab911b0a72dd1a81439",
);
const tokenDecimals = (contractId) =>
  new TestnetClient({
    contractId,
    source: deployment.readSource,
    rpcUrl: deployment.rpcUrl,
  }).read("decimals");
const amount = 5000000n;
const [
  token0,
  token1,
  reserves,
  supply,
  base,
  oracleDecimals,
  a,
  b,
  cashDecimals,
  buyDecimals,
  quoted,
] = await Promise.all([
  pair.read("token_0"),
  pair.read("token_1"),
  pair.read("get_reserves"),
  pair.read("total_supply"),
  oracle.read("base"),
  oracle.read("decimals"),
  oracle.read("lastprice", { asset: { tag: "Other", values: ["XLM"] } }),
  oracle.read("lastprice", { asset: { tag: "Other", values: ["USDC"] } }),
  tokenDecimals(cash),
  tokenDecimals(testUsdc),
  router.read("router_get_amounts_out", {
    amount_in: amount,
    path: [cash, testUsdc],
  }),
]);
if (
  base.tag !== "Other" ||
  base.values[0] !== "USD" ||
  !a ||
  !b ||
  a.price <= 0n ||
  b.price <= 0n ||
  ![token0, token1].includes(cash) ||
  ![token0, token1].includes(testUsdc) ||
  cashDecimals !== 7 ||
  buyDecimals !== 7 ||
  quoted.length !== 2 ||
  quoted[0] !== amount
)
  throw new Error("Unexpected pair, oracle units or venue quote.");
const ledger = await league.ledger();
const maxAge = 600n,
  maxSkew = 60n,
  slippageBps = 100n,
  now = BigInt(ledger.timestamp);
const fresh =
  [a, b].every((p) => p.timestamp <= now && now - p.timestamp <= maxAge) &&
  (a.timestamp > b.timestamp
    ? a.timestamp - b.timestamp
    : b.timestamp - a.timestamp) <= maxSkew;
const fair =
  (amount * a.price * 10n ** BigInt(buyDecimals)) /
  b.price /
  10n ** BigInt(cashDecimals);
const minimum = (fair * (10000n - slippageBps)) / 10000n;
const evidence = {
  checkedAt: new Date().toISOString(),
  network: "TESTNET",
  ledger,
  sources: {
    soroswap: vendorSource,
    oracle: "https://developers.stellar.org/docs/data/oracles/oracle-providers",
  },
  external: Object.fromEntries(
    Object.entries({ factory, router, pair, oracle }).map(([name, c]) => [
      name,
      { address: c.address, wasmHash: c.codeHash },
    ]),
  ),
  pair: { token0, token1, reserves, supply },
  oracle: { base, decimals: oracleDecimals, xlm: a, usdc: b },
  conversion: {
    sell: cash,
    buy: testUsdc,
    amount,
    expectedOut: quoted[1],
    referenceOut: fair,
    independentMinimum: minimum,
    maxAgeSeconds: maxAge,
    maxSkewSeconds: maxSkew,
    slippageBps,
    fresh,
    meetsPriceFloor: fresh && quoted[1] >= minimum,
  },
  admitted: false,
  liveLpLifecycle: false,
  fundsMoved: false,
  scope:
    "Read-only official Soroswap Testnet AMM and external Reflector reference inspection. The USDC contract is a Testnet asset; an external USDC reference does not prove its issuer, backing or production suitability. Market inspection does not admit a route or establish native/funded exits, Mainnet liquidity, keeper profitability or economic manipulation resistance.",
};
await writeFile(output, stringify(evidence) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    evidence: output,
    pair: pairAddress,
    fresh,
    meetsPriceFloor: evidence.conversion.meetsPriceFloor,
    admitted: false,
    fundsMoved: false,
  }),
);
