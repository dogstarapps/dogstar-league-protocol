#!/usr/bin/env node
import { readFile,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair,Networks,TransactionBuilder } from '@stellar/stellar-sdk';
import { BoundContract,LeagueClient,RestorationRequired,parse,stringify,type Deployment,type LimitOrder,type Player,type Registration,type RoundSnapshot,type WalletSigner } from '../../sdk/src/index.js';
import { Journal } from './journal.js';
import { transitionTask,type Task } from './planner.js';

export class Executor {
  constructor(readonly client:LeagueClient,readonly signer:WalletSigner,readonly journal:Journal){}
  async reconcile(){
    const server=this.client.factory().transport.server;
    const ledger=await this.client.ledger();
    for(const {envelope} of this.journal.pending()){
      const tx=await server.getTransaction(envelope.hash);
      if(tx.status==='SUCCESS'||tx.status==='FAILED')this.journal.finish(envelope.hash,tx.status);
      else if(ledger.timestamp>envelope.expiresAt)this.journal.finish(envelope.hash,'EXPIRED');
      else await server.sendTransaction(TransactionBuilder.fromXDR(envelope.signedXdr,Networks.TESTNET));
    }
    return this.journal.pending().length===0;
  }
  async submit(task:Task){
    const c=this.client.round(task.round);
    const hooks={beforeSubmit:async(p:Parameters<Journal['save']>[1])=>{this.journal.save(task,p);}};
    try {
      const result=await c.invoke(task.method,task.args,this.signer,hooks);
      if(result.status==='SUCCESS')this.journal.finish(result.hash,'SUCCESS');
      console.log(stringify({task:task.key,status:result.status,hash:result.hash}));
    } catch(error){
      this.journal.fail(task,error);
      if(error instanceof RestorationRequired){
        const restoreTask={...task,key:`${task.key}:restore`,method:'restoreFootprint'};
        const result=await c.transport.restore(error.preamble,this.signer,{beforeSubmit:async(p)=>{this.journal.save(restoreTask,p);}});
        if(result.status==='SUCCESS')this.journal.finish(result.hash,'SUCCESS');
      } else console.error(stringify({task:task.key,error:error instanceof Error?error.message:String(error)}));
    }
  }
  async next(s:RoundSnapshot,now:bigint):Promise<Task|undefined>{
    const operator=this.client.source;
    const transition=transitionTask(s,now,operator);if(transition)return transition;
    const c=this.client.round(s.address);
    if(s.phase!==3&&s.phase!==4)return;
    // Orders are inspected in bounded windows. The contract revalidates each fill/cancel.
    const total=s.totals.open_orders>0?s.totals.next_order:0;
    const start=total?((this.journal.orderCursor(s.address)-1)%total)+1:1;
    for(let scan=0;scan<Math.min(total,100);scan++){
      const id=((start+scan-1)%total)+1;
      this.journal.setOrderCursor(s.address,(id%total)+1);
      const o=await c.read<LimitOrder>('order',{id});if(!o.open)continue;
      if(now>=o.expires || now>=s.config.calendar.end)return {round:s.address,method:'cancel_limit',args:{id},key:`${s.address}:cancel:${id}`};
      if(s.phase===3 && now<s.config.calendar.risk_cutoff){
        for(const adapter of s.config.adapters){
          const task={round:s.address,method:'fill_limit',args:{id,adapter,operator},key:`${s.address}:fill:${id}:${adapter}`};
          try{await c.transport.prepare(task.method,c.spec.funcArgsToScVals(task.method,task.args));return task;}catch{/* Another price or venue may become executable later. */}
        }
      }
    }
    if(s.phase!==4 || s.totals.open_orders>0)return;
    for(const p of s.registrations){
      const reg=await c.read<Registration>('registration',{p});if(!reg.confirmed)continue;
      const player=await c.read<Player>('player',{p});if(player.settled)continue;
      for(const asset of s.config.assets){
        if(asset===s.config.cash)continue;
        const n=await c.read<bigint>('balance',{p,asset});if(n===0n)continue;
        const policy=new BoundContract('price_policy',s.config.quote_policy,operator,this.client.deployment.rpcUrl);
        const minimum=await policy.read<bigint>('minimum',{sell:asset,buy:s.config.cash,amount:n});
        for(const adapter of s.config.adapters){
          const task={round:s.address,method:'close_swap',args:{p,sell:asset,min_out:minimum,adapter,operator},key:`${s.address}:close:${p}:${asset}`};
          try{await c.transport.prepare(task.method,c.spec.funcArgsToScVals(task.method,task.args));return task;}catch{/* Do not replace the independent floor with an unsafe quote. */}
        }
        throw new Error(`No executable cash exit for ${s.address}/${p}/${asset}`);
      }
      return {round:s.address,method:'settle_player',args:{p,operator},key:`${s.address}:settle:${p}`};
    }
  }
  async tick(){
    if(!await this.reconcile())return;
    const count=await this.client.factory().read<number>('count');if(count===0)return;
    const offset=this.journal.cursor()%count;
    const records=await this.client.rounds(offset,Math.min(20,count-offset));
    const {timestamp}=await this.client.ledger();
    for(const record of records){
      try{const task=await this.next(await this.client.snapshot(record),BigInt(timestamp));if(task){this.journal.setCursor((record.id+1)%count);await this.submit(task);return;}}
      catch(error){console.error(stringify({round:record.address,error:error instanceof Error?error.message:String(error)}));}
    }
    this.journal.setCursor((offset+records.length)%count);
  }
}

export async function main(args=process.argv.slice(2)){
  const option=(name:string)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
  const manifest=option('manifest'),keyFile=option('key-file');
  if(!manifest || !keyFile){console.log('Usage: dogstar-executor --manifest=deployments/testnet.json --key-file=/private/operator.secret --journal=.local/executor.sqlite [--once] [--interval-ms=10000]\nTESTNET only. Each operator uses their own account and journal.');return;}
  const permissions=await stat(keyFile);if((permissions.mode&0o077)!==0)throw new Error('Operator key file must have mode 0600.');
  const signerKey=Keypair.fromSecret((await readFile(keyFile,'utf8')).trim());
  const deployment=parse<Deployment>(await readFile(manifest,'utf8'));
  const client=new LeagueClient(deployment,signerKey.publicKey());
  const signer:WalletSigner={signTransaction:async(xdr,{address,networkPassphrase})=>{
    if(address!==signerKey.publicKey()||networkPassphrase!==Networks.TESTNET)throw new Error('Signer context changed.');
    const transaction=TransactionBuilder.fromXDR(xdr,Networks.TESTNET);transaction.sign(signerKey);return {signedTxXdr:transaction.toXDR(),signerAddress:address};
  }};
  const journal=new Journal(option('journal')??'.local/executor.sqlite',client.source);const executor=new Executor(client,signer,journal);
  let stopped=false;process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
  try{do{await executor.tick();if(args.includes('--once'))break;await new Promise(r=>setTimeout(r,Math.max(1000,Number(option('interval-ms')??10000))));}while(!stopped);}finally{journal.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
