import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: node scripts/inspect-zenex-readiness.mjs <fetched-market.wasm> <new-evidence.json>",
  );
const market = "CAOZCITWHWAXH5FRU4EULQ5EN2HMTCHICRNC4R5ZAOVD7XHCCQSJ42IB";
const source = "GBDCXZDDDJWW2OOZ7LDS7AECDFJXUAXXW6U3YM2QJPRIAXONV5SOQNDX";
const server = new rpc.Server("https://mainnet.sorobanrpc.com");
if ((await server.getNetwork()).passphrase !== Networks.PUBLIC)
  throw new Error("Unexpected public network identity.");
const wasm = await readFile(input),
  spec = Spec.fromWasm(wasm),
  hash = createHash("sha256").update(wasm).digest("hex");
async function identity(address) {
  const result = await server.getLedgerEntries(
    new Contract(address).getFootprint(),
  );
  const value = result.entries[0]?.val;
  const executable =
    value?.type === "contractData" &&
    value.contractData.val.type === "scvContractInstance"
      ? value.contractData.val.instance.executable
      : undefined;
  if (executable?.type !== "contractExecutableWasm")
    throw new Error("Contract code unavailable.");
  return {
    address,
    codeHash: executable.wasmHash.toString(),
    observedLedger: result.latestLedger,
  };
}
const deployed = await identity(market);
if (deployed.codeHash !== hash)
  throw new Error(
    "The fetched ABI does not match the current market. Fetch and review its new code.",
  );
const account = await server.getAccount(source);
async function read(method) {
  const tx = new TransactionBuilder(
    new Account(source, account.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC },
  )
    .addOperation(
      new Contract(market).call(method, ...spec.funcArgsToScVals(method, {})),
    )
    .setTimeout(60)
    .build();
  const result = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(result) || !result.result)
    throw new Error("Read-only market simulation unavailable: " + method);
  const value = spec.funcResToNative(method, result.result.retval);
  return value && typeof value.isOk === "function" ? value.unwrap() : value;
}
const [token, oracle, feed, status, config] = await Promise.all(
  ["get_token", "get_oracle", "get_feed", "get_status", "get_config"].map(read),
);
const evidence = {
  checkedAt: new Date().toISOString(),
  network: "PUBLIC",
  market: deployed,
  settlementToken: token,
  oracle: await identity(oracle),
  feedId: Buffer.from(feed).toString("hex"),
  status,
  marketConfig: config,
  hasTraderState: spec
    .funcs()
    .some((f) => f.name.toString() === "get_trader_state"),
  hasClaimableCredit: spec
    .funcs()
    .some((f) => f.name.toString() === "get_claimable_credit"),
  signedTransactions: 0,
  liveAdmitted: false,
  scope:
    "Read-only identity and configuration observations from the actual market. Successful historical trader-payment accounting is absent from this inspected ABI. No oracle report credentials, venue upgrade, Testnet deployment or admission is claimed.",
};
await writeFile(
  output,
  JSON.stringify(
    evidence,
    (_, v) => (typeof v === "bigint" ? { $bigint: String(v) } : v),
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    evidence: output,
    market: deployed.address,
    codeHash: deployed.codeHash,
    hasTraderState: evidence.hasTraderState,
    feedId: evidence.feedId,
    signedTransactions: 0,
    liveAdmitted: false,
  }),
);
