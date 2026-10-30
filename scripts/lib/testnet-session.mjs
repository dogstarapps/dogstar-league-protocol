import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";
import {
  LeagueClient,
  TestnetClient,
  V5_BUILD_ARTIFACTS,
  stringify,
} from "../../dist/sdk/src/index.js";
import { Journal } from "../../dist/executor/src/journal.js";

export async function testnetSession(
  deployment,
  name,
  artifacts = V5_BUILD_ARTIFACTS,
) {
  const keyPath = ".local/operator.secret";
  if ((await stat(keyPath)).mode & 0o077)
    throw new Error("Use a private operator key file.");
  const key = Keypair.fromSecret((await readFile(keyPath, "utf8")).trim());
  const client = new LeagueClient(deployment, key.publicKey());
  await client.ledger();
  const directory = `.local/${name}/${crypto.randomUUID()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const journal = new Journal(
    `${directory}/transactions.sqlite`,
    key.publicKey(),
  );
  const transactions = [];
  const transport = new TestnetClient({
    contractId: deployment.factory.address,
    source: key.publicKey(),
    rpcUrl: deployment.rpcUrl,
  });
  let fee = 0n;
  const signer = {
    signTransaction: async (xdr, options) => {
      if (
        options.address !== key.publicKey() ||
        options.networkPassphrase !== Networks.TESTNET
      )
        throw new Error("Signer context mismatch.");
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      fee = BigInt(tx.fee);
      if (fee > 50000000n)
        throw new Error("Testnet operation exceeds its five-XLM fee cap.");
      tx.sign(key);
      return { signedTxXdr: tx.toXDR(), signerAddress: key.publicKey() };
    },
  };
  async function send(method, args, submit) {
    if (journal.pending().length)
      throw new Error(
        `Reconcile the saved envelope under ${directory} before signing anything else.`,
      );
    const result = await submit(signer, {
      beforeSubmit: async (pending) =>
        journal.save(
          {
            round: name,
            method,
            args,
            key: `${transactions.length}:${method}`,
          },
          pending,
          fee,
          500000000n,
        ),
    });
    if (result.status !== "SUCCESS")
      throw new Error(
        `Pending transaction ${result.hash}; reconcile ${directory} before repeating.`,
      );
    journal.finish(result.hash, "SUCCESS");
    transactions.push({ method, hash: result.hash });
    await writeFile(
      `${directory}/progress.json`,
      stringify({ transactions }) + "\n",
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({ method, hash: result.hash, status: result.status }),
    );
    return result;
  }
  async function operation(method, args, op) {
    const account = await transport.server.getAccount(key.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();
    const prepared = await transport.server.prepareTransaction(tx);
    const result = await send(method, args, (wallet, hooks) =>
      transport.submitPrepared(prepared, wallet, hooks),
    );
    return result.returnValue ? scValToNative(result.returnValue) : undefined;
  }
  const uploaded = new Set();
  async function artifact(name) {
    const wasm = await readFile(
      `contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`,
    );
    const expected = artifacts[name];
    if (
      !expected ||
      createHash("sha256").update(wasm).digest("hex") !== expected.wasmHash
    )
      throw new Error(`Current artifact differs from SDK: ${name}`);
    return { wasm, ...expected };
  }
  async function upload(name) {
    const info = await artifact(name);
    if (!uploaded.has(name)) {
      await operation(
        `upload:${name}`,
        { wasmHash: info.wasmHash },
        Operation.uploadContractWasm({ wasm: info.wasm }),
      );
      uploaded.add(name);
    }
    return info.wasmHash;
  }
  async function deploy(name, args) {
    const hash = await upload(name),
      info = await artifact(name),
      salt = randomBytes(32);
    const spec = Spec.fromWasm(info.wasm);
    const address = await operation(
      `deploy:${name}`,
      { args, salt, wasmHash: hash },
      Operation.createCustomContract({
        address: new Address(key.publicKey()),
        wasmHash: Buffer.from(hash, "hex"),
        salt,
        constructorArgs: spec.funcArgsToScVals("__constructor", args),
      }),
    );
    if (typeof address !== "string" || !address.startsWith("C"))
      throw new Error(
        "Missing deployed contract address; inspect the saved successful transaction.",
      );
    return { address, wasmHash: hash, interfaceHash: info.interfaceHash };
  }
  async function invoke(contract, method, args) {
    const result = await send(method, args, (wallet, hooks) =>
      contract.invoke(method, args, wallet, hooks),
    );
    return result.value;
  }
  async function external(address, file, expectedHash) {
    let wasm;
    try {
      wasm = await readFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const fetched = `${directory}/external-${crypto.randomUUID()}.wasm`;
      await new Promise((resolve, reject) => {
        const child = spawn(
          "stellar",
          [
            "contract",
            "fetch",
            "--id",
            address,
            "--out-file",
            fetched,
            "--rpc-url",
            deployment.rpcUrl,
            "--network-passphrase",
            Networks.TESTNET,
            "--config-dir",
            ".local/stellar",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout.resume();
        let diagnostic = "";
        child.stderr.on("data", (data) => {
          diagnostic += data;
        });
        child.on("error", reject);
        child.on("close", async (code) => {
          if (code === 0) resolve();
          else {
            await writeFile(`${fetched}.log`, diagnostic, { mode: 0o600 });
            reject(
              new Error(
                "External ABI fetch failed; inspect the preserved private diagnostic.",
              ),
            );
          }
        });
      });
      wasm = await readFile(fetched);
    }
    if (createHash("sha256").update(wasm).digest("hex") !== expectedHash)
      throw new Error("External ABI code mismatch.");
    const spec = Spec.fromWasm(wasm),
      c = new TestnetClient({
        contractId: address,
        source: key.publicKey(),
        rpcUrl: deployment.rpcUrl,
        expectedCodeHash: expectedHash,
      });
    return {
      read: async (method, args = {}) => {
        const p = await c.prepare(method, spec.funcArgsToScVals(method, args));
        const r = spec.funcResToNative(method, p.simulation.result.retval);
        return r && typeof r.isOk === "function" ? r.unwrap() : r;
      },
      invoke: async (method, args) => {
        const result = await send(method, args, (wallet, hooks) =>
          c.invoke(method, spec.funcArgsToScVals(method, args), wallet, hooks),
        );
        return result.returnValue
          ? scValToNative(result.returnValue)
          : undefined;
      },
    };
  }
  return {
    client,
    key,
    directory,
    transactions,
    invoke,
    external,
    deploy,
    upload,
    close: () => journal.close(),
  };
}
