import { describe,it,expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from './journal.js';
describe('durable executor reconciliation',()=>{
  it('preserves the exact pending envelope across process restarts',()=>{
    const path=join(mkdtempSync(join(tmpdir(),'dogstar-executor-test-')),'journal.sqlite');
    const a=new Journal(path,'operator');
    const task={round:'round',method:'advance',args:{operator:'operator'},key:'round:advance:0'};
    const envelope={hash:'123',signedXdr:'same-signed-envelope',expiresAt:1000};
    a.save(task,envelope);a.close();
    const b=new Journal(path,'operator');expect(b.pending()).toEqual([{task,envelope}]);
    b.finish('123','SUCCESS');expect(b.pending()).toEqual([]);b.close();
    expect(()=>new Journal(path,'another-operator')).toThrow('different signing account');
  });
});
