import { Contract, Networks, StrKey } from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";
import { SPEC_ENTRIES, BUILD_ARTIFACTS } from "./generated/specs.js";
import { V3_SPEC_ENTRIES, V3_BUILD_ARTIFACTS } from "./generated/specs-v3.js";
import {
  TestnetClient,
  type WalletSigner,
  type SubmissionHooks,
} from "./testnet.js";
import type {
  Deployment,
  RoundRecord,
  RoundSnapshot,
  ProtocolVersion,
} from "./types.js";

const CONTRACT_SCHEMAS = {
  ...SPEC_ENTRIES,
  tournament_v3: V3_SPEC_ENTRIES.tournament,
  factory_v3: V3_SPEC_ENTRIES.factory,
  exit_facility: V3_SPEC_ENTRIES.exit_facility,
  spot_receipt: V3_SPEC_ENTRIES.spot_receipt,
};
export type ContractKind = keyof typeof CONTRACT_SCHEMAS;
export class BoundContract {
  readonly spec: Spec;
  readonly transport: TestnetClient;
  constructor(
    kind: ContractKind,
    address: string,
    source: string,
    rpcUrl?: string,
    expectedCodeHash?: string,
  ) {
    if (
      !StrKey.isValidContract(address) ||
      !StrKey.isValidEd25519PublicKey(source)
    )
      throw new Error("Invalid contract or transaction source.");
    this.spec = new Spec(Array.from(CONTRACT_SCHEMAS[kind]));
    this.transport = new TestnetClient({
      contractId: address,
      source,
      rpcUrl,
      expectedCodeHash,
    });
  }
  async read<T>(method: string, args: object = {}): Promise<T> {
    const result = await this.transport.prepare(
      method,
      this.spec.funcArgsToScVals(method, args),
    );
    if (!("result" in result.simulation) || !result.simulation.result)
      throw new Error("Missing contract result.");
    return this.spec.funcResToNative(
      method,
      result.simulation.result.retval,
    ) as T;
  }
  async invoke(
    method: string,
    args: object,
    wallet: WalletSigner,
    hooks?: SubmissionHooks,
  ) {
    const result = await this.transport.invoke(
      method,
      this.spec.funcArgsToScVals(method, args),
      wallet,
      hooks,
    );
    return {
      ...result,
      value:
        "returnValue" in result && result.returnValue
          ? this.spec.funcResToNative(method, result.returnValue)
          : undefined,
    };
  }
}
export function validateDeployment(input: Deployment): Deployment {
  if (
    input.schemaVersion !== 1 ||
    input.network !== "TESTNET" ||
    input.environment !== "testnet"
  )
    throw new Error("Unsupported deployment network.");
  if (
    input.protocolVersion &&
    input.protocolVersion !== "0.2.0" &&
    input.protocolVersion !== "0.3.0"
  )
    throw new Error("Unsupported protocol version.");
  const url = new URL(input.rpcUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("RPC must use HTTPS.");
  if (
    url.username ||
    url.password ||
    !StrKey.isValidEd25519PublicKey(input.readSource)
  )
    throw new Error("Invalid public RPC configuration.");
  for (const [kind, artifact] of Object.entries(
    input.protocolVersion === "0.3.0" ? V3_BUILD_ARTIFACTS : BUILD_ARTIFACTS,
  )) {
    if (kind !== "factory" && kind !== "registry" && kind !== "tournament")
      continue;
    const entry = input[kind];
    if (
      entry.interfaceHash !== artifact.interfaceHash ||
      !/^[a-f0-9]{64}$/.test(entry.wasmHash)
    )
      throw new Error(`Incompatible ${kind} deployment.`);
  }
  return input;
}
export class LeagueClient {
  readonly deployment: Deployment;
  constructor(
    deployment: Deployment,
    readonly source = deployment.readSource,
  ) {
    this.deployment = validateDeployment(deployment);
  }
  factory() {
    const d = this.deployment;
    return new BoundContract(
      d.protocolVersion === "0.3.0" ? "factory_v3" : "factory",
      d.factory.address,
      this.source,
      d.rpcUrl,
      d.factory.wasmHash,
    );
  }
  registry() {
    const d = this.deployment;
    return new BoundContract(
      "registry",
      d.registry.address,
      this.source,
      d.rpcUrl,
      d.registry.wasmHash,
    );
  }
  round(address: string) {
    const d = this.deployment;
    return new BoundContract(
      d.protocolVersion === "0.3.0" ? "tournament_v3" : "tournament",
      address,
      this.source,
      d.rpcUrl,
      d.tournament.wasmHash,
    );
  }
  facility(address: string, wasmHash: string) {
    return new BoundContract(
      "exit_facility",
      address,
      this.source,
      this.deployment.rpcUrl,
      wasmHash,
    );
  }
  receipt(address: string, wasmHash: string) {
    return new BoundContract(
      "spot_receipt",
      address,
      this.source,
      this.deployment.rpcUrl,
      wasmHash,
    );
  }
  async rounds(offset = 0, limit = 20): Promise<RoundRecord[]> {
    return this.factory().read("page", { offset, limit });
  }
  async protocols(offset = 0, limit = 50): Promise<ProtocolVersion[]> {
    return this.registry().read("page", { offset, limit });
  }
  async snapshot(record: RoundRecord): Promise<RoundSnapshot> {
    const c = this.round(record.address);
    const [config, totals, phase, terms, registrations] = await Promise.all([
      c.read<RoundSnapshot["config"]>("config"),
      c.read<RoundSnapshot["totals"]>("totals"),
      c.read<number>("phase"),
      c.read<Uint8Array>("terms"),
      c.read<string[]>("registrations"),
    ]);
    if (!equalBytes(terms, record.config_hash))
      throw new Error("Round terms differ from its factory record.");
    return {
      address: record.address,
      record,
      config,
      totals,
      phase,
      terms,
      registrations,
    };
  }
  async ledger() {
    const c = this.factory().transport;
    const network = await c.server.getNetwork();
    if (network.passphrase !== Networks.TESTNET)
      throw new Error("Only TESTNET is allowed.");
    const ledger = await c.server.getLatestLedger();
    return { sequence: ledger.sequence, timestamp: Number(ledger.closeTime) };
  }
}
export const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const contractKey = (address: string) =>
  new Contract(address).getFootprint();
export { BUILD_ARTIFACTS, V3_BUILD_ARTIFACTS };
