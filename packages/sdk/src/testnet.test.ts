import { describe, it, expect, vi } from 'vitest';
import {
  Account,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  Operation,
} from '@stellar/stellar-sdk';
import { TestnetClient, samePayload } from './testnet.js';
const source = Keypair.random().publicKey(),
  contract = StrKey.encodeContract(new Uint8Array(32).fill(1));
describe('Testnet transport', () => {
  it('rejects another network before preparing or requesting a signature', async () => {
    const c = new TestnetClient({ contractId: contract, source });
    vi.spyOn(c.server, 'getNetwork').mockResolvedValue({
      passphrase: Networks.PUBLIC,
      protocolVersion: '23',
    });
    const getAccount = vi.spyOn(c.server, 'getAccount');
    await expect(c.prepare('advance')).rejects.toThrow('TESTNET');
    expect(getAccount).not.toHaveBeenCalled();
  });
  it('detects payload changes and preserves signatures without changing its hash', () => {
    const signer = Keypair.random();
    const build = (n: string) =>
      new TransactionBuilder(new Account(source, '1'), {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.manageData({ name: 'test', value: n }))
        .setTimeout(60)
        .build();
    const a = build('a'),
      b = build('b');
    expect(samePayload(a, a)).toBe(true);
    expect(samePayload(a, b)).toBe(false);
    const signed = TransactionBuilder.fromXDR(a.toXDR(), Networks.TESTNET);
    signed.sign(signer);
    expect(samePayload(a, signed)).toBe(true);
  });
});
