import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FeedbackDispatcher,remediationTask} from '../src/dispatch.mjs';
import {FeedbackQueue} from '../src/feedback.mjs';
import {GLM_MODEL} from '../src/glm.mjs';
import {config} from './fixtures.mjs';

test('durable feedback dispatch retries the exact packet and ID, then waits for independent validation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dq-feedback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const credentialFile=path.join(root,'api.env');fs.writeFileSync(credentialFile,'AGENTS_API_KEY=fixture-secret\n',{mode:0o600});
  const q=new FeedbackQueue(path.join(root,'findings'),config);
  const input={category:'content',title:'Observed missing interaction',detail:'Repeated interaction produced a stable rejection',evidence:{runId:'r1',tick:10,event:{type:'error',text:'Unavailable'}}};
  const f=q.report(input);q.report(input);
  const packets=[];let fail=true;
  const dispatcher=new FeedbackDispatcher({baseUrl:'http://127.0.0.1:9215',credentialFile,workerModel:GLM_MODEL,ownerId:'fixture-owner',agents:{default:'a1cee373e5f52e4978306'}},{fetchImpl:async(url,options)=>{
    if(options.method==='POST'){
      packets.push({body:options.body,key:options.headers['Idempotency-Key']});
      if(fail)throw Error('reply lost');
      return{ok:true,text:async()=>JSON.stringify({id:'job-1',state:'queued'})};
    }
    return{ok:true,text:async()=>JSON.stringify({id:'job-1',state:'succeeded',result:{reply:'Candidate patch prepared'}})};
  }});
  await dispatcher.tick(q,root);assert.equal(q.list()[0].status,'dispatch-uncertain');
  const uncertain=q.list()[0];q.update(f.id,{dispatch:{...uncertain.dispatch,attemptAt:0}});fail=false;
  await dispatcher.tick(q,root);assert.deepEqual(packets[0],packets[1]);assert.equal(q.list()[0].status,'assigned');
  await dispatcher.tick(q,root);assert.equal(q.list()[0].status,'awaiting-independent-validation');
  assert(!JSON.stringify(q.list()).includes('fixture-secret'));
  assert.equal(JSON.parse(packets[0].body).kind,'coding');
});
test('one-off suspected reports are not sent as confirmed defects',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dq-feedback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const q=new FeedbackQueue(path.join(root,'findings'),config);q.report({category:'navigation',title:'Cannot arrive',detail:'One attempt'});
  let called=false;const dispatcher=new FeedbackDispatcher({baseUrl:'http://127.0.0.1:9215'},{fetchImpl:async()=>{called=true;}});
  assert.deepEqual(await dispatcher.tick(q,root),[]);assert.equal(called,false);
  assert.throws(()=>new FeedbackDispatcher({baseUrl:'https://external.test'}),/loopback/);
});
