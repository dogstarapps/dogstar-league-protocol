import { mkdir,readFile,writeFile,chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Asset,Keypair,Networks,rpc } from '@stellar/stellar-sdk';
import { BUILD_ARTIFACTS } from '../dist/sdk/src/generated/specs.js';

const rpcUrl=process.env.DL_TESTNET_RPC??'https://soroban-testnet.stellar.org';
const server=new rpc.Server(rpcUrl);
if((await server.getNetwork()).passphrase!==Networks.TESTNET)throw new Error('Deployment supports TESTNET only.');
await mkdir('.local',{recursive:true,mode:0o700});await mkdir('.local/stellar',{recursive:true,mode:0o700});await mkdir('deployments',{recursive:true});
const actors={};
for(const role of ['operator','player-a','player-b']){
  const path=`.local/${role}.secret`;let secret;
  try{secret=(await readFile(path,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;secret=Keypair.random().secret();await writeFile(path,secret+'\n',{flag:'wx',mode:0o600});}
  await chmod(path,0o600);const key=Keypair.fromSecret(secret);actors[role]=key;
  try{await server.getAccount(key.publicKey());}catch{const response=await fetch(`https://friendbot.stellar.org/?addr=${key.publicKey()}`);if(!response.ok)throw new Error(`Friendbot failed for ${role}: ${response.status}`);}
}
const cash=Asset.native().contractId(Networks.TESTNET),secret=actors.operator.secret();
let receipts={};try{receipts=JSON.parse(await readFile('.local/deployment-receipts.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
async function cli(args){
  return new Promise((resolve,reject)=>{
    const child=spawn('stellar',[...args,'--rpc-url',rpcUrl,'--network-passphrase',Networks.TESTNET,'--config-dir','.local/stellar'],{env:{...process.env,STELLAR_ACCOUNT:secret},stdio:['ignore','pipe','pipe']});let out='',err='';
    child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err.replaceAll(secret,'[redacted]'))));
  });
}
async function deploy(name,args=[]){
  const wasm=`contracts/target/wasm32v1-none/release/dogstar_${name}.wasm`,hash=createHash('sha256').update(await readFile(wasm)).digest('hex'),key=createHash('sha256').update(JSON.stringify({name,hash,args,owner:actors.operator.publicKey()})).digest('hex');
  if(receipts[key])return {address:receipts[key],wasmHash:hash,interfaceHash:BUILD_ARTIFACTS[name]?.interfaceHash};
  // Constructor arguments must follow global options, so assemble this call directly.
  const address=await new Promise((resolve,reject)=>{
    const command=['contract','deploy','--wasm',wasm,'--optimize=false','--rpc-url',rpcUrl,'--network-passphrase',Networks.TESTNET,'--config-dir','.local/stellar',...(args.length?['--',...args]:[])];
    const child=spawn('stellar',command,{env:{...process.env,STELLAR_ACCOUNT:secret},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});child.on('error',reject);child.on('close',code=>{const id=out.match(/\bC[A-Z2-7]{55}\b/)?.[0];if(code===0&&id)resolve(id);else reject(new Error(err.replaceAll(secret,'[redacted]')));});
  });
  receipts[key]=address;await writeFile('.local/deployment-receipts.json',JSON.stringify(receipts,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({deployed:name,address,wasmHash:hash}));return {address,wasmHash:hash,interfaceHash:BUILD_ARTIFACTS[name]?.interfaceHash};
}
const registry=await deploy('registry',['--admin',actors.operator.publicKey()]);
const quotePolicy=await deploy('cash_policy');
const roundWasm='contracts/target/wasm32v1-none/release/dogstar_tournament.wasm';
const uploaded=await cli(['contract','upload','--wasm',roundWasm,'--optimize=false']);
const roundHash=uploaded.match(/\b[a-f0-9]{64}\b/)?.[0];if(!roundHash)throw new Error('Missing uploaded tournament hash.');
const factory=await deploy('factory',['--registry',registry.address,'--round_wasm',roundHash,'--quote_policy',quotePolicy.address,'--cash',cash]);
const manifest={schemaVersion:1,network:'TESTNET',environment:'testnet',rpcUrl,readSource:actors.operator.publicKey(),registry,factory,tournament:{wasmHash:roundHash,interfaceHash:BUILD_ARTIFACTS.tournament.interfaceHash},quotePolicy,cash:{address:cash,symbol:'XLM',decimals:7},protocols:[],deployedAt:new Date().toISOString()};
await writeFile('deployments/testnet.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({manifest:'deployments/testnet.json',network:'TESTNET',operator:actors.operator.publicKey(),protocolsAdmitted:0}));
