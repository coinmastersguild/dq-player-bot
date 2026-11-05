import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {GlmClient, GLM_MODEL, validatePlan} from '../src/glm.mjs';
import {FeedbackQueue} from '../src/feedback.mjs';
import {PlayerBridge} from '../src/bridge.mjs';
import {PlayerExecutor} from '../src/executor.mjs';
import {renewLogin} from '../src/login.mjs';
import {Wallet} from 'ethers';
import {config, hello, snap, self, npc} from './fixtures.mjs';

function folder(t) { const p=fs.mkdtempSync(path.join(os.tmpdir(),'dq-continuous-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p; }
const modelConfig={model:GLM_MODEL,baseUrl:'http://127.0.0.1:12399/v1',requestsPerHour:2};
const validPlan={goal:{kind:'visit',targetId:3},abilityPriority:['strike'],rationale:'Visit the observed NPC.',findings:[]};
const response=value=>({ok:true,status:200,text:async()=>JSON.stringify(value)});

test('GLM model is pinned and rejected model responses never become plans',async t=>{
  const directory=folder(t),requests=[];
  const glm=new GlmClient(modelConfig,directory,{fetchImpl:async(url,options)=>{
    requests.push({url,options});return response(url.endsWith('/models')?{data:[{id:GLM_MODEL}]}:{model:'another-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(validPlan)}}]});
  }});
  await assert.rejects(glm.complete('system',{}),/wrong-model/);
  assert.equal(glm.ledger.failed,1);assert.equal(glm.ledger.calls,1);
  assert.equal(requests[1].options.redirect,'error');assert.equal(JSON.parse(requests[1].options.body).model,GLM_MODEL);
  assert.throws(()=>new GlmClient({...modelConfig,model:'kimi-k3-fast'},directory),/pinned GLM/);
});
test('inference reservation survives restart and an unknown paid request is not replayed',async t=>{
  const directory=folder(t);let calls=0;
  const client=new GlmClient({...modelConfig,requestsPerHour:1},directory,{fetchImpl:async url=>{
    if(url.endsWith('/models'))return response({data:[{id:GLM_MODEL}]});calls++;throw Error('lost response');
  }});
  await assert.rejects(client.complete('system',{}));assert.equal(calls,1);
  const restarted=new GlmClient({...modelConfig,requestsPerHour:1},directory,{fetchImpl:async()=>response({data:[{id:GLM_MODEL}]})});
  await assert.rejects(restarted.complete('system',{}),/Hourly/);assert.equal(restarted.ledger.calls,1);
});
test('GLM plans require observed targets, learned abilities and actual evidence IDs',()=>{
  const observation={self:self(),entities:[npc()],events:[{sequence:1}]};
  assert.equal(validatePlan(validPlan,observation).goal.targetId,3);
  assert.throws(()=>validatePlan({...validPlan,goal:{kind:'visit',targetId:999}},observation));
  assert.throws(()=>validatePlan({...validPlan,abilityPriority:['invented']},observation));
  assert.throws(()=>validatePlan({...validPlan,findings:[{category:'content',title:'Missing dialogue',detail:'Evidence',eventSequences:[999]}]},observation));
});
test('findings deduplicate across restart; successful agent jobs cannot close them',t=>{
  const directory=folder(t),queue=new FeedbackQueue(directory,config);
  const report={category:'navigation',title:'No route',detail:'Observed stall',evidence:{tick:12,ticket:'secret'}};
  const first=queue.report(report),same=new FeedbackQueue(directory,config).report(report);
  assert.equal(first.id,same.id);assert.equal(same.occurrences,2);assert.equal(queue.list().length,1);
  assert(!fs.readFileSync(path.join(directory,first.id+'.json'),'utf8').includes('secret'));
  assert.throws(()=>queue.update(first.id,{status:'closed',remediation:{jobState:'succeeded'}}),/playtest/);
  queue.update(first.id,{status:'closed',retest:{passed:true,runId:'real-run',release:'real-release'}});
  assert.equal(queue.report(report).status,'reopened');
});
test('deterministic executor consumes a GLM goal without inventing actors or abilities',()=>{
  let now=1000;const sent=[];
  const bridge=new PlayerBridge(config,{send:m=>sent.push(m),now:()=>now,setIntervalImpl:()=>1,clearIntervalImpl:()=>{}});
  bridge.receive(hello());bridge.receive(snap({ents:[{...npc(),x:1,z:1}]}));
  const executor=new PlayerExecutor(bridge,{now:()=>now});executor.install(validPlan);executor.step();
  // Interaction is time-gated; after the interval, it uses the actual observed NPC.
  now=10000;bridge.receive(snap({tick:11,time:0.55,ents:[{...npc(),x:1,z:1}]}));executor.step();
  assert(sent.some(message=>message.cmd==='talk'&&message.npcId===3));
  executor.goal.expiresAt=0;now+=1000;executor.step();bridge.stop();
});
test('dead actor can only release through the ordinary observed death action',()=>{
  const bridge=new PlayerBridge(config,{send:()=>{},setIntervalImpl:()=>1,clearIntervalImpl:()=>{}});
  bridge.receive(hello());bridge.receive(snap({self:self({dead:1})}));
  const envelope={commandId:'release',generation:bridge.generation,observedTick:bridge.world.tick};
  assert.equal(bridge.act({...envelope,action:{kind:'release'}}).status,'submitted');
  assert.throws(()=>bridge.act({...envelope,commandId:'attack',action:{kind:'attack'}}),/actor_dead/);bridge.stop();
});
test('login renewal signs only a fresh game challenge and stores an owner-only secure cookie',async t=>{
  const directory=folder(t),wallet=new Wallet('0x'+'1'.padStart(64,'0'));
  const signerFile=path.join(directory,'signer.json');fs.writeFileSync(signerFile,JSON.stringify({privateKey:wallet.privateKey}),{mode:0o600});
  const cookieFile=path.join(directory,'cookies.txt'),routes=[];
  const result=await renewLogin({origin:'https://play.degenquest.ai',walletAddress:wallet.address,signerFile,cookieFile},{fetchImpl:async(url,options)=>{
    routes.push({url,body:JSON.parse(options.body)});
    if(url.endsWith('/nonce'))return{ok:true,json:async()=>({nonce:'test-nonce',message:'DegenQuest login test-nonce'})};
    return{ok:true,headers:{getSetCookie:()=>['__Host-dq-session='+'a'.repeat(64)+'; Path=/; HttpOnly; Secure; Max-Age=600']}};
  }});
  assert(result.expiresAt>Date.now());assert.equal(fs.statSync(cookieFile).mode&0o777,0o600);
  assert.equal(routes.length,2);assert(routes[1].body.signature.startsWith('0x'));
  assert(routes.every(r=>/\/api\/auth\/(nonce|verify)$/.test(r.url)));
});
