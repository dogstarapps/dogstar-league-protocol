import { describe,it,expect } from 'vitest';
import { Keypair,StrKey } from '@stellar/stellar-sdk';
import { Spec } from '@stellar/stellar-sdk/contract';
import { SPEC_ENTRIES } from './generated/specs.js';
import { canonicalMetadata,metadataHash,stringify,parse } from './metadata.js';
import { hex } from './client.js';
const address=StrKey.encodeContract(new Uint8Array(32).fill(1));
describe('contract ABI and metadata',()=>{
  it('encodes exact factory terms and rejects missing transaction arguments',()=>{
    const spec=new Spec(Array.from(SPEC_ENTRIES.factory));
    const creator=Keypair.random().publicKey();
    const config={creator,cash:address,assets:[address],adapters:[],quote_policy:address,capital:10000000n,min_players:1,max_players:2,share_bps:10000,prizes:1n,execution:100n,reward:1n,calendar:{funding_open:1n,funding_close:20n,registration_open:1n,registration_close:30n,prepare_by:40n,start:50n,risk_cutoff:90n,end:100n,settle_by:120n}};
    expect(spec.funcArgsToScVals('create',{c:config,selections:[],salt:new Uint8Array(32),metadata_hash:new Uint8Array(32)})).toHaveLength(4);
    const round=new Spec(Array.from(SPEC_ENTRIES.tournament));
    expect(()=>round.funcArgsToScVals('close_swap',{p:creator,asset:address,minimum:1n,adapter:address,operator:creator})).toThrow();
    expect(round.funcArgsToScVals('close_swap',{p:creator,sell:address,min_out:1n,adapter:address,operator:creator})).toHaveLength(5);
  });
  it('binds canonical round metadata to a stable hash',async()=>{
    const metadata={schemaVersion:1 as const,name:'  Stellar Open ',description:'Round',organizer:{name:'Dogstar',website:'https://dogstar.example'}};
    const a=await metadataHash(metadata),b=await metadataHash({...metadata,name:'Stellar Open'});
    expect(hex(a)).toBe(hex(b));expect(canonicalMetadata(metadata)).not.toContain('  Stellar');
    await expect(metadataHash({...metadata,organizer:{name:'x',website:'https://user:password@example.com'}})).rejects.toThrow();
  });
  it('preserves integer amounts and byte hashes across JSON transport',()=>{
    const value={amount:1234567890123456789012345678n,hash:new Uint8Array([0,255,17])};
    expect(parse(stringify(value))).toEqual(value);
  });
});
