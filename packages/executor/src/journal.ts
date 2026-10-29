import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse,stringify,type PendingEnvelope } from '../../sdk/src/index.js';
import type { Task } from './planner.js';
export class Journal {
  readonly db:DatabaseSync;
  constructor(path:string,source:string){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS transactions(hash TEXT PRIMARY KEY,envelope TEXT NOT NULL,task TEXT NOT NULL,status TEXT NOT NULL,updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS failures(task TEXT PRIMARY KEY,message TEXT NOT NULL,updated INTEGER NOT NULL);');
    const owner=this.db.prepare("SELECT value FROM settings WHERE key='source'").get() as {value:string}|undefined;
    if(owner && owner.value!==source)throw new Error('Executor journal belongs to a different signing account.');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('source',source);
  }
  pending(){return (this.db.prepare("SELECT envelope,task FROM transactions WHERE status='PENDING' ORDER BY updated").all() as {envelope:string;task:string}[]).map(r=>({envelope:parse<PendingEnvelope>(r.envelope),task:parse<Task>(r.task)}));}
  save(task:Task,pending:PendingEnvelope){this.db.prepare('INSERT INTO transactions VALUES(?,?,?,?,?)').run(pending.hash,stringify(pending),stringify(task),'PENDING',Date.now());}
  finish(hash:string,status:string){this.db.prepare('UPDATE transactions SET status=?,updated=? WHERE hash=?').run(status,Date.now(),hash);}
  fail(task:Task,error:unknown){this.db.prepare('INSERT OR REPLACE INTO failures VALUES(?,?,?)').run(task.key,error instanceof Error?error.message:String(error),Date.now());}
  cursor(){const row=this.db.prepare("SELECT value FROM settings WHERE key='cursor'").get() as {value:string}|undefined;return Number(row?.value??0);}
  setCursor(cursor:number){this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('cursor',String(cursor));}
  orderCursor(round:string){const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(`orders:${round}`) as {value:string}|undefined;return Number(row?.value??1);}
  setOrderCursor(round:string,cursor:number){this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(`orders:${round}`,String(cursor));}
  close(){this.db.close();}
}
