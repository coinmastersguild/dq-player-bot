#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createConsoleServer} from '../src/console-server.mjs';
import {LocalPlayer,packageRoot} from '../src/local-player.mjs';
import {createRenderRoutes} from '../src/render-routes.mjs';
const port=Number(process.env.DQ_CONSOLE_PORT??4783),url=`http://127.0.0.1:${port}`;
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid DQ_CONSOLE_PORT');
const instanceId=createHash('sha256').update(packageRoot).digest('hex').slice(0,24);
let existing=null;
try{existing=await fetch(url+'/api/state',{signal:AbortSignal.timeout(1000)}).then(r=>r.json());}catch{}
if(existing){
  if(existing.runtime?.mode!=='local'||existing.runtime.instanceId!==instanceId){process.stderr.write('Port 4783 belongs to another app.\n');process.exit(1);}
  if(process.argv.includes('--open'))execFile('open',[url],()=>{});
  process.stdout.write(url+'\n');
}else{
  let player,app;
  try{
    player=new LocalPlayer();
    app=createConsoleServer({port,run:action=>player.action(action),renderRoutes:createRenderRoutes(player)});
    await app.listen();player.resume();
    process.stdout.write(`Local DegenQuest Bot Console: ${url}\n`);
    if(process.argv.includes('--open'))execFile('open',[url],()=>{});
  }catch(error){
    if(player)await player.close();
    process.stderr.write('Local console could not start: '+error.message+'\n');process.exit(1);
  }
  let closing=false;
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{
    if(closing)return;closing=true;app.server.close();await player.close();process.exit(0);
  });
}
