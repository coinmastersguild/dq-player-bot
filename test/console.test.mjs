import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {collectConsoleState,tailRecords} from '../src/console-state.mjs';
import {createConsoleServer} from '../src/console-server.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dq-console-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=path.join(root,'state'),run=path.join(state,'runs/2026-11-04T20-00-00.000Z-1');fs.mkdirSync(run,{recursive:true});
  const now=Date.now(),write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
  write(path.join(state,'status.json'),{at:new Date(now).toISOString(),phase:'playing',characterId:100,runId:'run-one',world:'silverrun',model:'glm-5.3-flash-local',goal:{kind:'visit',targetId:7},inference:{calls:1,token:'private-token'},cookie:'private-cookie'});
  write(path.join(run,'manifest.json'),{runId:'run-one'});
  const records=[{at:now-800,kind:'glm-plan',data:{model:'glm-5.3-flash-local',plan:{goal:{kind:'visit',targetId:7},rationale:'Find a quest.'}}},
    {at:now-200,kind:'snapshot',data:{tick:42,self:{id:1,k:'player',nm:'FrostbyteAgent',x:0,y:2,z:3,f:0,hp:54,mhp:54,known:[{signature:'private-signature'}]},entities:[{id:7,k:'npc',nm:'Mira',x:5,y:2,z:6,cookie:'private-entity-cookie'},{id:8,k:'npc',x:NaN,y:0,z:0}]}},
    {at:now-100,kind:'event',data:{type:'game',data:{type:'dialog',npcId:7,text:'Hello, traveler.',choices:[{text:'Ask for work',enabled:true}],ticket:'private-ticket'}}}];
  const events=path.join(run,'events.jsonl');fs.writeFileSync(events,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  return {root,state,run,now,events,write};
}
test('console projects real recorded state and excludes account, inventory and transport secrets',t=>{
  const f=fixture(t),s=collectConsoleState(f.root,{activeState:'active',subState:'running',enabled:true},f.now);
  assert.equal(s.live,true);assert.equal(s.observation.entities.length,1);assert.equal(s.observation.entities[0].nm,'Mira');
  assert.equal(s.plan.rationale,'Find a quest.');assert.equal(s.dialog.text,'Hello, traveler.');
  assert.equal(s.activity[0].label,'dialog');assert.equal(JSON.stringify(s).includes('private-'),false);
});
test('stale, stopped and different-run observations cannot become a live preview',t=>{
  const f=fixture(t),active={activeState:'active'};
  assert.equal(collectConsoleState(f.root,active,f.now+10000).live,false);
  f.write(path.join(f.state,'status.json'),{at:new Date(f.now).toISOString(),phase:'playing',runId:'new-run'});
  assert.equal(collectConsoleState(f.root,active,f.now).observation,null);
  f.write(path.join(f.state,'status.json'),{at:new Date(f.now).toISOString(),phase:'stopped'});
  const stopped=collectConsoleState(f.root,{activeState:'inactive'},f.now);
  assert.equal(stopped.live,false);assert.equal(stopped.observation.self.nm,'FrostbyteAgent');
});
test('record reader tolerates a partial append and a bounded tail starting inside a record',t=>{
  const f=fixture(t);fs.appendFileSync(f.events,'{"at":123,"kind":"snap');
  assert.equal(tailRecords(f.events).length,3);
  const partial=tailRecords(f.events,400);
  assert.ok(partial.every(e=>typeof e.kind==='string'));assert.ok(partial.length<3);
});

// Exercise the actual HTTP handler over in-memory streams. No socket permission
// is needed; the separate ordinary-client transport test still uses real TCP.
function harness(t,run){
  const app=createConsoleServer({run,pollMs:1e9});app.server.address=()=>({port:4783});
  t.after(()=>app.server.close());
  return {app,request:(url,{method='GET',headers={},body=''}={})=>new Promise((resolve,reject)=>{
    const req=Readable.from(body?[Buffer.from(body)]:[]);Object.assign(req,{method,url,headers:{host:'127.0.0.1:4783',...headers}});
    const chunks=[],res=new Writable({write(chunk,encoding,callback){chunks.push(Buffer.from(chunk));callback();}});
    let code,responseHeaders;
    res.writeHead=(status,h)=>{code=status;responseHeaders=h;return res;};
    res.once('error',reject);res.once('finish',()=>{const raw=Buffer.concat(chunks).toString();resolve({code,headers:responseHeaders,raw,json:()=>JSON.parse(raw)});});
    app.server.emit('request',req,res);
  })};
}
const sample=()=>({schema:'dq-bot-console-v1',at:Date.now(),live:true,observationAgeMs:100,service:{activeState:'active'}});
test('console refuses cross-site controls, forged hosts and invalid tokens',async t=>{
  const calls=[],h=harness(t,async action=>{calls.push(action);return sample();});
  const s=(await h.request('/api/state')).json();
  const headers={'content-type':'application/json',origin:'http://127.0.0.1:4783','x-console-token':s.csrfToken};
  assert.equal((await h.request('/api/control',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{"action":"stop"}'})).code,403);
  assert.equal((await h.request('/api/control',{method:'POST',headers:{...headers,'x-console-token':'wrong'},body:'{"action":"stop"}'})).code,403);
  assert.equal((await h.request('/api/state',{headers:{host:'evil.example'}})).code,403);
  assert.equal((await h.request('/api/state',{headers:{'sec-fetch-site':'cross-site'}})).code,403);
  assert.deepEqual(calls,['snapshot']);
});
test('only start/stop reach the controller, malformed and oversized requests do not',async t=>{
  const calls=[],h=harness(t,async action=>{calls.push(action);return sample();});
  const s=(await h.request('/api/state')).json(),headers={'content-type':'application/json',origin:'http://127.0.0.1:4783','x-console-token':s.csrfToken};
  const post=body=>h.request('/api/control',{method:'POST',headers,body});
  assert.equal((await post('{')).code,400);assert.equal((await post('null')).code,400);
  assert.equal((await post('{"action":"stop; rm -rf /"}')).code,400);
  assert.equal((await post('{"action":"stop","host":"other"}')).code,400);
  assert.equal((await post('x'.repeat(200))).code,413);
  assert.equal((await post('{"action":"stop"}')).code,200);
  assert.equal((await post('{"action":"start"}')).code,200);
  assert.deepEqual(calls,['snapshot','stop','start']);
});
test('concurrent control is serialized and an uncertain control is never replayed',async t=>{
  let release,calls=0;
  const h=harness(t,action=>action==='snapshot'?Promise.resolve(sample()):new Promise((resolve,reject)=>{calls++;release=()=>reject(Error('Connection lost'));}));
  const s=(await h.request('/api/state')).json(),headers={'content-type':'application/json',origin:'http://127.0.0.1:4783','x-console-token':s.csrfToken};
  const pending=h.request('/api/control',{method:'POST',headers,body:'{"action":"stop"}'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await h.request('/api/control',{method:'POST',headers,body:'{"action":"start"}'})).code,409);
  release();assert.equal((await pending).code,502);assert.equal(calls,1);
});
test('static app uses strict local assets and cannot expose private files',async t=>{
  const h=harness(t,async()=>sample()),index=await h.request('/');
  assert.equal(index.code,200);assert.match(index.raw,/First-person game/);
  assert.match(index.headers['Content-Security-Policy'],/frame-ancestors 'none'/);
  assert.equal((await h.request('/private/player.host.json')).code,404);
  assert.equal((await h.request('/../.secrets/bot-signer.json')).code,404);
  assert.equal((await h.request('/app.js')).code,200);
});
