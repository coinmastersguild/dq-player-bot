import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {LocalPlayer} from '../src/local-player.mjs';
const waitFor=async condition=>{const until=Date.now()+4000;while(!condition()){if(Date.now()>until)throw Error('Local child did not reach expected state');await new Promise(r=>setTimeout(r,10));}};
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dq-local-player-'));
  for(const dir of ['bin','.secrets','.local/state'])fs.mkdirSync(path.join(root,dir),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(root,'.secrets/player.local.json'),'{}',{mode:0o600});
  fs.writeFileSync(path.join(root,'.local/state/service.halt'),'stopped',{mode:0o600});
  // This child stands in for an external player process; tests exercise the
  // real OS spawn, IPC ownership, signals and durable local controls.
  fs.writeFileSync(path.join(root,'bin/service.mjs'),`import fs from 'node:fs';
fs.writeFileSync('child-started',String(process.pid));
const timer=setInterval(()=>{},1000);
process.on('SIGTERM',()=>clearInterval(timer));
process.on('disconnect',()=>clearInterval(timer));`);
  let starts=0;
  const player=new LocalPlayer({root,keepAwake:false,restartMs:30,spawnImpl:(...args)=>{starts++;return spawn(...args);}});
  t.after(async()=>{await player.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,player,starts:()=>starts};
}
test('local Start creates one owned player; Stop persists and disconnects it',async t=>{
  const {root,player,starts}=fixture(t);
  assert.equal(player.snapshot().runtime.mode,'local');assert.equal(player.snapshot().service.activeState,'inactive');
  await player.action('start');await waitFor(()=>fs.existsSync(path.join(root,'child-started')));
  const pid=player.child.pid;await player.action('start');assert.equal(starts(),1);assert.equal(player.child.pid,pid);
  await player.action('stop');assert.equal(fs.statSync(path.join(root,'.local/state/service.halt')).mode&0o077,0);
  await waitFor(()=>!player.child);assert.equal(player.snapshot().service.activeState,'inactive');
  await new Promise(r=>setTimeout(r,70));assert.equal(starts(),1);
});
test('an unexpected player exit restarts locally and the console lock prevents another controller',async t=>{
  const {root,player,starts}=fixture(t);
  assert.throws(()=>new LocalPlayer({root,keepAwake:false}),/already running/);
  await player.action('start');await waitFor(()=>fs.existsSync(path.join(root,'child-started')));
  const first=player.child.pid;player.child.kill('SIGKILL');
  await waitFor(()=>starts()===2&&player.child?.pid!==first);
  assert.equal(player.snapshot().service.activeState,'active');
});
test('closing the local console stops its player and releases its lock',async t=>{
  const {root,player}=fixture(t);
  await player.action('start');await waitFor(()=>fs.existsSync(path.join(root,'child-started')));
  await player.close();assert.equal(player.child,null);assert.equal(fs.existsSync(path.join(root,'.local/state/console.lock')),false);
});
test('invalid actions or a missing local profile cannot clear a stopped state',async t=>{
  const {root,player,starts}=fixture(t);
  await assert.rejects(player.action('ssh-start'),/Unknown local/);
  fs.rmSync(path.join(root,'.secrets/player.local.json'));
  await assert.rejects(player.action('start'),/profile is missing/);
  assert.equal(player.halted(),true);assert.equal(starts(),0);
});
