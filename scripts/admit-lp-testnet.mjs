import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Address } from "@stellar/stellar-sdk";
import {
  BoundContract,
  TestnetClient,
  quoteLiquidityEntry,
  stringify,
} from "../dist/sdk/src/index.js";
import { testnetSession } from "./lib/testnet-session.mjs";
const input =
  process.env.DL_TESTNET_MANIFEST ?? "deployments/testnet-v5-profile.json";
const output =
  process.env.DL_LP_MANIFEST ?? "deployments/testnet-v5-lp-candidate.json";
try {
  await readFile(output);
  throw new Error(
    "Preserve the existing LP manifest before another admission.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const d = JSON.parse(await readFile(input, "utf8"));
const session = await testnetSession(d, "lp-admissions");
console.log(JSON.stringify({ records: session.directory }));
const source =
  "https://raw.githubusercontent.com/soroswap/core/main/public/testnet.contracts.json";
const official = await (await fetch(source)).json();
const tokenSource =
  "https://raw.githubusercontent.com/soroswap/core/main/public/tokens.json";
const tokens = (await (await fetch(tokenSource)).json()).find(
  (n) => n.network === "testnet",
).assets;
const usdc = tokens.find((a) => a.code === "USDC");
if (
  usdc.contract !==
    "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F" ||
  d.cash.decimals !== 7 ||
  usdc.decimals !== 7
)
  throw new Error("Review the changed official Testnet assets.");
try {
  const router = await session.external(
    official.ids.router,
    ".local/abi/soroswap-testnet-router-2026-10-29.wasm",
    official.hashes.router,
  );
  const factory = await session.external(
    official.ids.factory,
    ".local/abi/soroswap-testnet-factory-2026-10-29.wasm",
    official.hashes.factory,
  );
  const pairAddress = await factory.read("get_pair", {
    token_a: d.cash.address,
    token_b: usdc.contract,
  });
  const pair = await session.external(
    pairAddress,
    ".local/abi/soroswap-testnet-pair-2026-10-29.wasm",
    official.hashes.pair,
  );
  const oracleAddress =
    "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
  const oracleHash =
    "25fc306065cbb9b05461db78ec259802cb916053ba5b3ab911b0a72dd1a81439";
  const oracle = await session.external(
    oracleAddress,
    ".local/abi/reflector-testnet-external-pulse-2026-10-29.wasm",
    oracleHash,
  );
  const [asset0, asset1, reserves, xlm, usd] = await Promise.all([
    pair.read("token_0"),
    pair.read("token_1"),
    pair.read("get_reserves"),
    oracle.read("lastprice", { asset: { tag: "Other", values: ["XLM"] } }),
    oracle.read("lastprice", { asset: { tag: "Other", values: ["USDC"] } }),
  ]);
  if (asset0 !== usdc.contract || asset1 !== d.cash.address)
    throw new Error("Unexpected official pair ordering.");
  const now = BigInt((await session.client.ledger()).timestamp);
  if (
    !xlm ||
    !usd ||
    xlm.price <= 0n ||
    usd.price <= 0n ||
    [xlm, usd].some((p) => p.timestamp > now || now - p.timestamp > 600n)
  )
    throw new Error("Fresh independent reference prices are required.");
  const targetNum = xlm.price,
    targetDen = usd.price;
  const [reserveUsd, reserveCash] = reserves;
  const setup = { assisted: false, reservesBefore: reserves, xlm, usdc: usd };
  // A finite real Testnet trade aligns this existing public pair with the unchanged reference.
  // This is test preparation, not evidence of organic liquidity or Mainnet suitability.
  if (reserveUsd * targetDen * 10000n > reserveCash * targetNum * 10010n) {
    const cap = 5000n * 10000000n;
    const quote = (n) =>
      (n * 997n * reserveUsd) / (reserveCash * 1000n + n * 997n);
    let low = 0n,
      high = cap;
    if (
      (reserveUsd - quote(high)) * targetDen >
      (reserveCash + high) * targetNum
    )
      throw new Error(
        "Pair alignment exceeds the explicit 5000-XLM Testnet setup cap.",
      );
    while (high - low > 1n) {
      const middle = (low + high) / 2n;
      if (
        (reserveUsd - quote(middle)) * targetDen >
        (reserveCash + middle) * targetNum
      )
        low = middle;
      else high = middle;
    }
    const amounts = await router.read("router_get_amounts_out", {
      amount_in: high,
      path: [d.cash.address, usdc.contract],
    });
    if (amounts[1] !== quote(high))
      throw new Error(
        "The actual router does not match the expected AMM fee/rounding.",
      );
    const cash = new TestnetClient({
      contractId: d.cash.address,
      source: session.key.publicKey(),
      rpcUrl: d.rpcUrl,
    });
    const balance = await cash.read("balance", [
      new Address(session.key.publicKey()).toScVal(),
    ]);
    if (balance < high + 1000n * 10000000n)
      throw new Error("Preserve at least 1000 Testnet XLM after setup.");
    await router.invoke("swap_exact_tokens_for_tokens", {
      amount_in: high,
      amount_out_min: (amounts[1] * 9990n) / 10000n,
      path: [d.cash.address, usdc.contract],
      to: session.key.publicKey(),
      deadline: now + 120n,
    });
    Object.assign(setup, {
      assisted: true,
      cashIn: high,
      tokenOut: amounts[1],
    });
  }
  const settings = {
    router: official.ids.router,
    router_hash: Buffer.from(official.hashes.router, "hex"),
    factory: official.ids.factory,
    factory_hash: Buffer.from(official.hashes.factory, "hex"),
    pair: pairAddress,
    pair_hash: Buffer.from(official.hashes.pair, "hex"),
    asset0,
    asset1,
  };
  const direct = await session.deploy("direct_swap", { c: settings });
  const policy = await session.deploy("price_policy", {
    c: {
      oracle: oracleAddress,
      oracle_hash: Buffer.from(oracleHash, "hex"),
      max_age: 600n,
      max_skew: 60n,
      slippage_bps: 100,
      feeds: [
        {
          token: d.cash.address,
          asset: { tag: "Other", values: ["XLM"] },
          decimals: 7,
        },
        {
          token: usdc.contract,
          asset: { tag: "Other", values: ["USDC"] },
          decimals: 7,
        },
      ],
    },
  });
  const vaultHash = await session.upload("lp_vault");
  const lp = await session.deploy("lp_adapter", {
    c: {
      ...settings,
      cash: d.cash.address,
      swap_adapter: direct.address,
      swap_hash: Buffer.from(direct.wasmHash, "hex"),
      vault_wasm: Buffer.from(vaultHash, "hex"),
      minimum_entry_bps: 9900,
    },
  });
  const rootFactory = await session.deploy("factory", {
    registry: d.registry.address,
    round_wasm: Buffer.from(d.tournament.wasmHash, "hex"),
    quote_policy: policy.address,
    cash: d.cash.address,
    exit_artifacts: Object.fromEntries(
      Object.entries(d.exitArtifacts).map(([k, v]) => [
        k,
        Buffer.from(v, "hex"),
      ]),
    ),
  });
  const assets = [{ address: asset0, symbol: "USDC", decimals: 7 }, d.cash];
  const protocols = [...d.protocols];
  const registry = session.client.registry();
  const records = [];
  const count = await registry.read("count");
  for (let offset = 0; offset < count; offset += 50)
    records.push(...(await registry.read("page", { offset, limit: 50 })));
  for (const [id, name, capabilities, contract] of [
    ["soroswap_spot", "Soroswap Spot", 1, direct],
    ["soroswap_lp", "Soroswap liquidity", 18, lp],
  ]) {
    const version =
      Math.max(0, ...records.filter((r) => r.id === id).map((r) => r.version)) +
      1;
    const descriptor = {
      network: "TESTNET",
      source,
      tokenSource,
      settings,
      adapter: contract,
      setup,
      liveLifecycleVerified: false,
    };
    await session.invoke(registry, "admit", {
      record: {
        id,
        version,
        adapter: contract.address,
        capabilities,
        wasm_hash: Buffer.from(contract.wasmHash, "hex"),
        metadata_hash: createHash("sha256")
          .update(stringify(descriptor))
          .digest(),
      },
    });
    protocols.push({
      id,
      version,
      name,
      capabilities,
      adapter: contract.address,
      wasmHash: contract.wasmHash,
      assets,
    });
  }
  const manifest = {
    ...d,
    factory: rootFactory,
    quotePolicy: policy,
    protocols,
    deployedAt: new Date().toISOString(),
    testnetLp: {
      pair: pairAddress,
      source,
      tokenSource,
      assistedPriceAlignment: setup.assisted,
      liveLifecycleVerified: false,
    },
  };
  const entry = await quoteLiquidityEntry(manifest, lp.address, 50000000n);
  if (!entry.eligible)
    throw new Error(
      "Candidate LP entry fails its unchanged independent floors: " +
        entry.reasons.join(" "),
    );
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  await writeFile(
    `${session.directory}/proof.json`,
    stringify({ manifest, setup, entry, transactions: session.transactions }) +
      "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      candidate: output,
      records: session.directory,
      quoteEligible: true,
      mainnetAdmitted: false,
    }),
  );
} finally {
  session.close();
}
