import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PlayerBridge} from '../src/bridge.mjs';
import {PlayerExecutor} from '../src/executor.mjs';
import {Navigator} from '../src/navigation.mjs';
import {GlmClient,GLM_MODEL} from '../src/glm.mjs';
import {config,hello,snap,self,npc,mob} from './fixtures.mjs';
const plan={goal:{kind:'visit',targetId:3},abilityPriority:['strike'],rationale:'Visit observed NPC',findings:[]};
function setup(t,router){
  let now=10000;const sent=[],diagnostics=[];
  const bridge=new PlayerBridge(config,{now:()=>now,send:message=>sent.push(message),setIntervalImpl:()=>1,clearIntervalImpl:()=>{}});
  bridge.receive(hello());bridge.receive(snap({ents:[{...npc(),x:15,z:0}]}));
  const executor=new PlayerExecutor(bridge,{now:()=>now,router,diagnostic:event=>diagnostics.push(event)});executor.install(plan);
  t.after(()=>bridge.stop());
  return {bridge,executor,sent,diagnostics,fresh:(extra={})=>{now+=500;bridge.receive(snap({tick:bridge.world.tick+10,time:bridge.world.time+.5,self:self(extra),ents:[{...npc(),x:15,z:0}]}));},advance:ms=>{now+=ms;}};
}
test('the executor follows a door waypoint rather than steering straight at the NPC',async t=>{
  const f=setup(t,{ready:true,route:async()=>({status:'route',waypoints:[{x:0,y:0,z:5},{x:15,y:0,z:0}]})});
  f.executor.step();assert.equal(f.bridge.movement,null);
  await new Promise(resolve=>setImmediate(resolve));f.fresh();f.executor.step();
  assert.equal(f.bridge.movement.facing,0,'first movement points toward the door, not east to the NPC');
  assert.ok(f.bridge.movement.until-f.bridge.now()<=600);
  f.fresh({x:0,z:4.8});f.executor.step();assert.equal(f.executor.route.index,1);
});
test('late route responses cannot move a stopped player or replace a newer goal',async t=>{
  let resolve;const f=setup(t,{ready:true,route:()=>new Promise(r=>{resolve=r;})});
  f.executor.step();f.executor.install({...plan,goal:{kind:'explore',heading:0}});
  resolve({status:'route',waypoints:[{x:15,y:0,z:0}]});await new Promise(r=>setImmediate(r));
  assert.equal(f.executor.route,null);
  f.executor.step();f.bridge.stop();const afterStop=f.sent.length;
  resolve({status:'route',waypoints:[{x:0,y:0,z:45}]});await new Promise(r=>setImmediate(r));f.executor.step();
  assert.equal(f.executor.route,null);assert.equal(f.sent.length,afterStop,'no gameplay is sent after shutdown');
});
test('arrival clears the walking route before the next GLM decision while ordinary interaction still works',async t=>{
  const f=setup(t,{ready:true,route:async()=>({status:'route',waypoints:[{x:0,y:0,z:5},{x:15,y:0,z:0}]})});
  f.executor.step();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.executor.memory().route);
  f.fresh({x:13,z:0});f.executor.step();
  assert.equal(f.executor.memory().route,null);assert.ok(f.sent.some(m=>m.cmd==='talk'&&m.npcId===3));
});
test('failed routes expire the goal and prevent another attempt until cooldown or a different approach',async t=>{
  let queries=0;const f=setup(t,{ready:true,route:async()=>{queries++;return{status:'unreachable'};}});
  f.executor.step();await new Promise(r=>setImmediate(r));
  assert.equal(f.executor.goal.expiresAt,0);assert.equal(f.executor.memory().blockedGoals.length,1);
  assert.throws(()=>f.executor.install(plan),/unreachable/);
  f.fresh();f.executor.step();assert.equal(queries,1);
  f.executor.install({...plan,goal:{kind:'explore',heading:0}});
  f.fresh({x:20});assert.doesNotThrow(()=>f.executor.install(plan),'the same target can be approached after leaving the failed area');
});
test('small sideways movement does not replenish a reactive recovery budget',()=>{
  const nav=new Navigator();nav.offset=0;nav.attempts=3;nav.moving=true;nav.anchor={x:0,z:0,tick:0};
  nav.observe({x:1,z:0},10);assert.equal(nav.attempts,3);
  nav.escape(10,0,'wall');nav.recovery=null;nav.escape(30,0,'wall');assert.equal(nav.blocked,true);
});
test('renewing the same exploration goal preserves its destination instead of moving it farther ahead',t=>{
  const f=setup(t,null),explore={...plan,goal:{kind:'explore',heading:0}};
  f.executor.install(explore);const destination={...f.executor.destination};
  f.fresh({x:2,z:12});f.executor.install(explore);assert.deepEqual(f.executor.destination,destination);
});
test('GLM cannot choose a high-level hunt or a recently failed destination outside its menu',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dq-nav-glm-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const client=new GlmClient({model:GLM_MODEL,baseUrl:'http://127.0.0.1:1'},directory,{now:()=>1000});
  let input,proposal={...plan,goal:{kind:'hunt',targetId:2}};
  client.complete=async(_system,value)=>{input=value;return{model:GLM_MODEL,value:proposal};};
  const observation={self:self({lv:1}),entities:[mob({lv:9}),{...npc(),x:5}],events:[],world:{},tick:1};
  const memory={blockedGoals:[{key:'visit:3',until:5000,origin:{x:0,z:0}}]};
  await assert.rejects(client.plan(observation,memory),/allowed choices/);
  assert.equal(input.allowedGoals.some(g=>g.kind==='hunt'||g.kind==='visit'),false);
  assert.equal(input.allowedGoals.filter(g=>g.kind==='explore').length,8);
  proposal={...plan,goal:{kind:'visit',targetId:3}};await assert.rejects(client.plan(observation,memory),/allowed choices/);
  proposal={...plan,goal:{kind:'explore',heading:0}};assert.equal((await client.plan(observation,memory)).value.goal.kind,'explore');
});
test('combat seeking keeps eligible creatures visible despite a crowd and excludes unfinished quest visits',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dq-hunt-glm-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const client=new GlmClient({model:GLM_MODEL,baseUrl:'http://127.0.0.1:1'},directory);let input;
  client.complete=async(_system,value)=>{input=value;return{model:GLM_MODEL,value:{...plan,goal:{kind:'hunt',targetId:500}}};};
  const crowd=Array.from({length:50},(_,i)=>({...npc(),id:100+i,x:1+i*.1}));
  const observation={self:self({lv:1}),entities:[...crowd,mob({id:500,lv:2,x:60})],events:[],world:{},tick:1};
  const result=await client.plan(observation,{huntingGrounds:[{heading:1.1,distance:400}]});
  assert.equal(result.value.goal.targetId,500);assert.ok(input.entities.some(e=>e.id===500));assert.equal(input.entities.length,1);
  assert.equal(input.allowedGoals.some(g=>g.kind==='visit'),false);
  assert.ok(input.allowedGoals.some(g=>g.kind==='explore'&&g.heading===1.1));
});
test('an indexed GLM choice binds to the exact allowed creature instead of invented target IDs',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dq-hunt-index-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const client=new GlmClient({model:GLM_MODEL,baseUrl:'http://127.0.0.1:1'},directory);let index=0,input;
  client.complete=async(_system,value)=>{input=value;return{model:GLM_MODEL,value:{goalIndex:index,abilityPriority:['strike'],rationale:'Hunt a suitable creature',findings:[]}};};
  const observation={self:self({lv:1}),entities:[mob({id:10,lv:12}),mob({id:500,lv:2})],events:[],world:{},tick:1};
  assert.deepEqual((await client.plan(observation,{})).value.goal,{kind:'hunt',targetId:500});
  assert.equal(input.entities.some(e=>e.id===10),false);assert.equal(input.hazards[0].level,12);
  index=100;await assert.rejects(client.plan(observation,{}),/invalid goal index/);
});
test('one bounded exploration probe can re-query from a real changed floor but cannot loop without progress',async t=>{
  let queries=0;const f=setup(t,{ready:true,route:async()=>{queries++;return{status:'no-floor'};}});
  f.executor.install({...plan,goal:{kind:'explore',heading:0}});f.executor.step();await new Promise(r=>setImmediate(r));
  assert.ok(f.executor.probe);f.fresh();f.executor.step();assert.ok(f.bridge.movement);
  f.advance(6500);f.fresh({z:8,y:-3});f.executor.step();await new Promise(r=>setImmediate(r));
  assert.equal(queries,2);assert.equal(f.executor.probe,null);assert.equal(f.executor.goal.expiresAt,0);
});
test('a much stronger aggressor causes immediate retreat instead of doomed casting',t=>{
  const f=setup(t,null);
  f.bridge.receive(snap({tick:11,time:.55,ents:[mob({x:0,z:5,lv:12,tgt:1})]}));
  f.executor.step();assert.ok(f.bridge.movement);assert.ok(Math.abs(f.bridge.movement.facing)>3);
  assert.equal(f.sent.some(m=>m.cmd==='cast'||m.cmd==='attack'),false);
});
test('a normal jump is leased input and clears automatically; malformed jump flags reject',t=>{
  const f=setup(t,null),o=f.bridge.observe();
  f.bridge.act({commandId:'normal-jump',generation:o.generation,observedTick:o.tick,action:{kind:'move',facing:0,seconds:.3,jump:true}});
  assert.equal(f.sent.at(-1).mi.j,true);f.advance(400);f.bridge.pulse();
  assert.equal(f.sent.at(-1).mi.j,false);assert.equal(f.sent.at(-1).mi.f,false);
  f.fresh();const next=f.bridge.observe();assert.throws(()=>f.bridge.act({commandId:'invalid-jump',generation:next.generation,observedTick:next.tick,action:{kind:'move',facing:0,seconds:.3,jump:'yes'}}),/boolean/);
});
test('wandering distant hazards do not cancel a clear active route',async t=>{
  let queries=0;const f=setup(t,{ready:true,route:async()=>{queries++;return{status:'route',waypoints:[{x:0,y:0,z:5},{x:15,y:0,z:0}]};}});
  f.executor.step();await new Promise(r=>setImmediate(r));
  f.bridge.receive(snap({tick:11,time:.55,ents:[{...npc(),x:15,z:0},mob({id:9,lv:12,x:60,z:20})]}));
  f.executor.step();assert.equal(queries,1);assert.ok(f.bridge.movement);
});
