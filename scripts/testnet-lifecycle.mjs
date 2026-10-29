import { readFile,writeFile } from 'node:fs/promises';
import { Keypair,Networks,TransactionBuilder } from '@stellar/stellar-sdk';
import { LeagueClient,metadataHash,stringify } from '../dist/sdk/src/index.js';
import { Executor } from '../dist/executor/src/daemon.js';
import { Journal } from '../dist/executor/src/journal.js';
const d=JSON.parse(await readFile('deployments/testnet.json','utf8'));
const keys={};for(const name of ['operator','player-a','player-b'])keys[name]=Keypair.fromSecret((await readFile(`.local/${name}.secret`,'utf8')).trim());
const signer=(key)=>({signTransaction:async(xdr,options)=>{if(options.address!==key.publicKey()||options.networkPassphrase!==Networks.TESTNET)throw new Error('Signer context mismatch.');const t=TransactionBuilder.fromXDR(xdr,Networks.TESTNET);t.sign(key);return {signedTxXdr:t.toXDR(),signerAddress:key.publicKey()};}});
const client=new LeagueClient(d,keys.operator.publicKey()),proof={network:'TESTNET',transactions:[],startedAt:new Date().toISOString()};
async function invoke(c,method,args,key=keys.operator){const r=await c.invoke(method,args,signer(key));if(r.status!=='SUCCESS')throw new Error(`Pending ${method}: ${r.hash}; reconcile before continuing.`);proof.transactions.push({method,hash:r.hash});console.log(JSON.stringify({method,status:r.status,hash:r.hash}));return r.value;}
const now=(await client.ledger()).timestamp;
const metadata={schemaVersion:1,name:'Protocol lifecycle verification',description:'On-chain Testnet funding, consent, public execution and claims verification.',organizer:{name:'Dogstar protocol verification'}};
const calendar={funding_open:BigInt(now-30),funding_close:BigInt(now+90),registration_open:BigInt(now-30),registration_close:BigInt(now+120),prepare_by:BigInt(now+140),start:BigInt(now+150),risk_cutoff:BigInt(now+170),end:BigInt(now+190),settle_by:BigInt(now+310)};
const config={creator:keys.operator.publicKey(),cash:d.cash.address,assets:[d.cash.address],adapters:[],quote_policy:d.quotePolicy.address,capital:10000000n,min_players:2,max_players:2,share_bps:10000,prizes:10000000n,execution:10000000n,reward:10000n,calendar};
const address=await invoke(client.factory(),'create',{c:config,selections:[],salt:crypto.getRandomValues(new Uint8Array(32)),metadata_hash:await metadataHash(metadata)});
proof.round=address;proof.metadata=metadata;await writeFile('.local/lifecycle-progress.json',stringify(proof)+'\n');
const round=client.round(address);
const deposits=[];for(const [bucket,n] of [[0,20000000n],[1,10000000n],[2,10000000n]])deposits.push(await invoke(round,'contribute',{owner:keys.operator.publicKey(),bucket,n}));
const terms=await round.read('terms');
for(const name of ['player-a','player-b']){const key=keys[name];await invoke(new LeagueClient(d,key.publicKey()).round(address),'pre_register',{p:key.publicKey(),terms,valid_until:calendar.prepare_by},key);}
const journal=new Journal('.local/lifecycle-executor.sqlite',keys.operator.publicKey()),executor=new Executor(client,signer(keys.operator),journal);
try{
  for(let tick=0;tick<120;tick++){
    await executor.tick();const phase=await round.read('phase');
    console.log(JSON.stringify({round:address,phase,ledger:(await client.ledger()).sequence}));
    if(phase===5)break;if(phase===6)throw new Error('Verification round cancelled.');
    await new Promise(r=>setTimeout(r,3000));
  }
  if(await round.read('phase')!==5)throw new Error('Settlement did not complete within the verification window.');
  for(const name of ['player-a','player-b'])await invoke(round,'claim',{beneficiary:keys[name].publicKey()});
  for(const id of deposits)await invoke(round,'sponsor_claim',{id});
  proof.phase=await round.read('phase');proof.totals=await round.read('totals');proof.finishedAt=new Date().toISOString();
  await writeFile('.local/testnet-lifecycle-proof.json',stringify(proof)+'\n');console.log(JSON.stringify({verified:true,round:address,proof:'.local/testnet-lifecycle-proof.json'}));
}finally{journal.close();}
