import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PlayerBridge} from '../src/bridge.mjs';
import {PlayerExecutor} from '../src/executor.mjs';
import {GlmClient,GLM_MODEL} from '../src/glm.mjs';
import {playerTools} from '../src/mcp.mjs';
import {config,hello,snap,self,npc} from './fixtures.mjs';

// Wire shapes copied from the actual v50 producer: qlog is QuestProgress
// ({questId,counts,state}); qview uses {id,state,turnInNpcId,turnInNpcIds}.
const quest='silverrun::q_visit',template='silverrun-guide';
const ready={questId:quest,counts:[1],state:'ready'};
const view={id:quest,state:'ready',turnInNpcId:template,turnInNpcIds:[template]};
function player(t,{progress=ready,questView=view,entities=[{...npc(),tid:template,x:1,z:0}],offer=false,dialog=false}={}){
  let clock=10000;
  const sent=[],bridge=new PlayerBridge(config,{send:m=>sent.push(m),now:()=>clock,setIntervalImpl:()=>1,clearIntervalImpl:()=>{}});
  t.after(()=>bridge.stop());bridge.receive(hello());bridge.receive(snap({ents:entities,self:self({qlog:[progress],qview:questView?[questView]:[],qoffers:offer?[{id:'other-quest',npcId:3}]:[]})}));
  if(dialog)bridge.world.dialog={npcId:3,nodeId:'welcome',choices:[{idx:0,text:'Tell me about this place',enabled:true}]};
  const executor=new PlayerExecutor(bridge,{now:()=>clock});executor.install({goal:{kind:'visit',targetId:3},abilityPriority:[],rationale:'Turn in the observed completed quest.',findings:[]});
  return {bridge,executor,sent,advance:time=>{clock=time;}};
}
test('turn-in uses the raw questId producer field and refuses a made-up id alias',t=>{
  const {bridge,sent}=player(t);
  const act=(commandId,q)=>bridge.act({commandId,generation:bridge.generation,observedTick:10,action:{kind:'turnin',quest:q}});
  assert.equal(act('ready-quest',quest).status,'submitted');assert.deepEqual(sent.at(-1),{t:'cmd',cmd:'turnin',quest});
  bridge.world.self.qlog=[{id:quest,state:'ready'}];assert.throws(()=>act('wrong-id-alias',quest),/not observed ready/);
});
test('visiting the observed receiver turns in a ready quest before unrelated offers or dialogue',t=>{
  const {executor,sent}=player(t,{offer:true,dialog:true});executor.step();
  assert.deepEqual(sent.at(-1),{t:'cmd',cmd:'turnin',quest});
});
test('turn-in receiver uses exact templates, accepts declared alternate receivers, and does not guess from names',t=>{
  const first=player(t,{questView:{...view,turnInNpcId:'elsewhere',turnInNpcIds:['elsewhere']}});first.executor.step();
  assert.equal(first.sent.at(-1).cmd,'talk');
  const alternate=player(t,{questView:{...view,turnInNpcId:'primary',turnInNpcIds:['primary',template]}});alternate.executor.step();
  assert.equal(alternate.sent.at(-1).cmd,'turnin');
});
test('stale quest view, foreign namespace and missing receiver metadata cannot authorize a turn-in',t=>{
  for(const options of [{progress:{...ready,state:'active'}},{progress:{...ready,questId:'another-world::q_visit'}},{questView:null}]){
    const {executor,sent}=player(t,options);executor.step();assert.equal(sent.at(-1).cmd,'talk');
  }
});
test('ready quests stay actionable when the planner has more than twelve observed NPCs',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dq-quest-planner-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const glm=new GlmClient({model:GLM_MODEL,baseUrl:'http://127.0.0.1:12399/v1'},root);
  const entities=Array.from({length:18},(_,i)=>({...npc(),id:100+i,tid:i===17?template:`npc-${i}`,x:i+1,z:0}));
  let input;
  glm.complete=async(_system,value)=>{input=value;return {model:GLM_MODEL,value:{goal:{kind:'visit',targetId:117},abilityPriority:['strike'],rationale:'Return a completed quest.',findings:[]}};};
  await glm.plan({self:self({qlog:[ready],qview:[view]}),entities,events:[],world:config.world,tick:10,time:.5},{});
  assert.deepEqual(input.allowedGoals[0],{kind:'visit',targetId:117});
  assert.equal(input.allowedGoals.filter(g=>g.kind==='visit').length,1);
  assert.ok(input.allowedGoals.some(g=>g.kind==='visit'&&g.targetId===117));
});
test('submitted quest actions consume the visit goal without claiming quest completion or repeating',t=>{
  const {executor,bridge,sent,advance}=player(t);executor.step();
  assert.equal(executor.goal.expiresAt,0);
  assert.equal(bridge.world.self.qlog[0].state,'ready');
  // Even a fresh transport snapshot retaining the old sparse quest state does
  // not authorize re-submission under the same goal after the interaction timer.
  advance(20000);bridge.receive(snap({tick:11,time:.55,self:bridge.world.self,ents:[...bridge.world.entities.values()].filter(e=>e.id!==1)}));executor.step();
  assert.equal(sent.filter(m=>m.cmd==='turnin').length,1);
  executor.install({goal:{kind:'visit',targetId:3},abilityPriority:[],rationale:'A fresh decision authorizes this attempt.',findings:[]});executor.step();
  assert.equal(sent.filter(m=>m.cmd==='turnin').length,2);
});
test('ordinary working/looking dialogue remains selectable while financial and crown choices stay excluded',t=>{
  const {executor,bridge,sent}=player(t,{progress:{...ready,state:'active'},dialog:true});
  bridge.world.dialog.choices=[
    ...['Pay the fee','Visit the bank','Buy a potion','Talk to the king','Offer a bribe'].map((text,idx)=>({idx,text,enabled:true})),
    {idx:5,text:"I’m looking for work. What are you working on?",enabled:true}];
  executor.step();assert.equal(sent.at(-1).cmd,'dialogChoice');assert.equal(sent.at(-1).idx,5);
});
test('an NPC on another storey requires navigation instead of quest or talk commands through a floor',t=>{
  const {executor,sent}=player(t,{entities:[{...npc(),tid:template,x:1,z:0,y:8}]});
  const diagnostics=[];executor.diagnostic=d=>diagnostics.push(d);executor.step();
  assert.equal(sent.filter(m=>['turnin','accept','talk','dialogChoice'].includes(m.cmd)).length,0);
  assert.equal(executor.goal.expiresAt,0);assert.equal(diagnostics[0].type,'navigation-blocked');
});
test('MCP advertises the implemented ordinary quest and death-recovery actions',()=>{
  const kinds=playerTools.find(t=>t.name==='act').inputSchema.properties.action.oneOf.map(s=>s.properties.kind.const);
  for(const kind of ['accept','turnin','release'])assert.ok(kinds.includes(kind),`${kind} must be advertised`);
});
