import { describe, it, expect, vi } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  Operation,
} from "@stellar/stellar-sdk";
import { TestnetClient, samePayload } from "./testnet.js";
const source = Keypair.random().publicKey(),
  contract = StrKey.encodeContract(new Uint8Array(32).fill(1));
describe("Testnet transport", () => {
  it("rejects prepared mainnet or foreign-source deployments before requesting a signature", async () => {
    const c = new TestnetClient({ contractId: contract, source });
    vi.spyOn(c.server, "getNetwork").mockResolvedValue({
      passphrase: Networks.TESTNET,
      protocolVersion: "23",
    });
    const signTransaction = vi.fn();
    const build = (networkPassphrase: string, account = source) =>
      new TransactionBuilder(new Account(account, "1"), {
        fee: "100",
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: "test", value: "a" }))
        .setTimeout(60)
        .build();
    await expect(
      c.submitPrepared(build(Networks.PUBLIC), { signTransaction }),
    ).rejects.toThrow("TESTNET");
    await expect(
      c.submitPrepared(build(Networks.TESTNET, Keypair.random().publicKey()), {
        signTransaction,
      }),
    ).rejects.toThrow("source");
    expect(signTransaction).not.toHaveBeenCalled();
  });
  it("rejects another network before preparing or requesting a signature", async () => {
    const c = new TestnetClient({ contractId: contract, source });
    vi.spyOn(c.server, "getNetwork").mockResolvedValue({
      passphrase: Networks.PUBLIC,
      protocolVersion: "23",
    });
    const getAccount = vi.spyOn(c.server, "getAccount");
    for (const method of ["advance", "token_0"])
      await expect(c.prepare(method)).rejects.toThrow("TESTNET");
    expect(getAccount).not.toHaveBeenCalled();
  });
  it("rejects invalid contract symbols before contacting the network", async () => {
    const c = new TestnetClient({ contractId: contract, source });
    const network = vi.spyOn(c.server, "getNetwork");
    for (const method of ["", "token-0", "x".repeat(33), "токен"])
      await expect(c.prepare(method)).rejects.toThrow(
        "Invalid contract method",
      );
    expect(network).not.toHaveBeenCalled();
  });
  it("detects payload changes and preserves signatures without changing its hash", () => {
    const signer = Keypair.random();
    const build = (n: string) =>
      new TransactionBuilder(new Account(source, "1"), {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.manageData({ name: "test", value: n }))
        .setTimeout(60)
        .build();
    const a = build("a"),
      b = build("b");
    expect(samePayload(a, a)).toBe(true);
    expect(samePayload(a, b)).toBe(false);
    const signed = TransactionBuilder.fromXDR(a.toXDR(), Networks.TESTNET);
    signed.sign(signer);
    expect(samePayload(a, signed)).toBe(true);
  });
});
