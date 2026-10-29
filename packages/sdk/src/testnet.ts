import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  Operation,
  type Transaction,
  TransactionBuilder,
  rpc,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";
export function samePayload(
  a: { hash(): Uint8Array },
  b: { hash(): Uint8Array },
) {
  const left = a.hash(),
    right = b.hash();
  return (
    left.length === right.length && left.every((byte, i) => byte === right[i])
  );
}
export interface WalletSigner {
  signTransaction(
    xdr: string,
    options: { address: string; networkPassphrase: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string }>;
}
export interface TestnetOptions {
  rpcUrl?: string;
  contractId: string;
  source: string;
  expectedCodeHash?: string;
}
/** No mainnet transport. Explicit testnet calls only; nothing runs on import. */
export class TestnetClient {
  readonly server: rpc.Server;
  constructor(readonly options: TestnetOptions) {
    new Address(options.contractId);
    new Address(options.source);
    this.server = new rpc.Server(
      options.rpcUrl ?? "https://soroban-testnet.stellar.org",
    );
  }
  async prepare(method: string, args: xdr.ScVal[] = []) {
    if (!/^[a-z_]{1,32}$/.test(method))
      throw new Error("Invalid contract method.");
    const network = await this.server.getNetwork();
    if (network.passphrase !== Networks.TESTNET)
      throw new Error("Only TESTNET is allowed.");
    let instanceMissing = false;
    if (this.options.expectedCodeHash) {
      const entries = await this.server.getLedgerEntries(
        new Contract(this.options.contractId).getFootprint(),
      );
      const entry = entries.entries[0];
      instanceMissing = !entry;
      const value = entry?.val;
      const scval =
        value?.type === "contractData" ? value.contractData.val : undefined;
      const executable =
        scval?.type === "scvContractInstance"
          ? scval.instance.executable
          : undefined;
      if (
        entry &&
        (!executable ||
          executable.type !== "contractExecutableWasm" ||
          executable.wasmHash.toString() !== this.options.expectedCodeHash)
      )
        throw new Error("Contract code differs from the selected deployment.");
    }
    const account = await this.server.getAccount(this.options.source);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract(this.options.contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const simulation = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation))
      throw new Error(simulation.error);
    if (rpc.Api.isSimulationRestore(simulation))
      throw new RestorationRequired(
        simulation.restorePreamble,
        this.options.contractId,
      );
    if (instanceMissing)
      throw new Error("Contract instance code cannot be verified.");
    return {
      simulation,
      transaction: rpc.assembleTransaction(tx, simulation).build(),
    };
  }
  async read(method: string, args: xdr.ScVal[] = []) {
    const { simulation } = await this.prepare(method, args);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result)
      throw new Error("No simulation result.");
    return scValToNative(simulation.result.retval);
  }
  async invoke(
    method: string,
    args: xdr.ScVal[],
    wallet: WalletSigner,
    hooks: SubmissionHooks = {},
  ) {
    const { transaction } = await this.prepare(method, args);
    return this.submit(transaction, wallet, hooks);
  }
  async restore(
    preamble: rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"],
    wallet: WalletSigner,
    hooks: SubmissionHooks = {},
  ) {
    if ((await this.server.getNetwork()).passphrase !== Networks.TESTNET)
      throw new Error("Only TESTNET is allowed.");
    const account = await this.server.getAccount(this.options.source);
    const transaction = new TransactionBuilder(account, {
      fee: (BigInt(BASE_FEE) + BigInt(preamble.minResourceFee)).toString(),
      networkPassphrase: Networks.TESTNET,
    })
      .setSorobanData(preamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(60)
      .build();
    return this.submit(transaction, wallet, hooks);
  }
  private async submit(
    transaction: Transaction,
    wallet: WalletSigner,
    hooks: SubmissionHooks,
  ) {
    const signed = await wallet.signTransaction(transaction.toXDR(), {
      address: this.options.source,
      networkPassphrase: Networks.TESTNET,
    });
    if (signed.signerAddress && signed.signerAddress !== this.options.source)
      throw new Error("Wallet signer changed.");
    const envelope = TransactionBuilder.fromXDR(
      signed.signedTxXdr,
      Networks.TESTNET,
    );
    // A wallet must sign the reviewed transaction rather than replace its source or operations.
    if (!samePayload(envelope, transaction))
      throw new Error("Signed transaction payload differs.");
    const hash = toHex(envelope.hash());
    await hooks.beforeSubmit?.({
      hash,
      signedXdr: envelope.toXDR(),
      expiresAt: Number(transaction.timeBounds?.maxTime ?? 0),
    });
    let result;
    try {
      result = await this.server.sendTransaction(envelope);
    } catch {
      return { status: "PENDING" as const, hash };
    }
    if (result.hash !== hash)
      throw new Error(
        "RPC returned a different transaction hash. Reconcile the locally signed hash.",
      );
    if (result.status !== "PENDING" && result.status !== "DUPLICATE")
      throw new Error(`Submission ${result.status}`);
    for (let attempt = 0; attempt < 20; attempt++) {
      const tx = await this.server.getTransaction(result.hash);
      if (tx.status === "SUCCESS") return { ...tx, hash };
      if (tx.status === "FAILED") throw new Error("Transaction failed.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { status: "PENDING", hash: result.hash }; // Unknown outcome must be queried by hash; never blindly resubmit.
  }
}

export interface PendingEnvelope {
  hash: string;
  signedXdr: string;
  expiresAt: number;
}
const toHex = (value: Uint8Array) =>
  Array.from(value, (v) => v.toString(16).padStart(2, "0")).join("");
export interface SubmissionHooks {
  beforeSubmit?(pending: PendingEnvelope): Promise<void>;
}
export class RestorationRequired extends Error {
  constructor(
    readonly preamble: rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"],
    readonly contractId?: string,
  ) {
    super("Archived contract entries must be restored before this action.");
  }
}
