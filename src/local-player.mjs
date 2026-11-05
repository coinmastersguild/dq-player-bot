import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {collectConsoleState} from './console-state.mjs';
import {acquireLock,loadJson,saveJson} from './durable.mjs';
import {RenderFeed} from './render-feed.mjs';

export const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export class LocalPlayer {
  constructor({root=packageRoot,configFile=path.join(root,'.secrets/player.local.json'),spawnImpl=spawn,keepAwake=true,restartMs=5000}={}){
    this.root=root;this.configFile=configFile;this.spawn=spawnImpl;this.keepAwake=keepAwake;this.restartMs=restartMs;
    this.dataRoot=path.join(root,'.local');this.stateRoot=path.join(this.dataRoot,'state');
    fs.mkdirSync(this.stateRoot,{recursive:true,mode:0o700});
    this.unlock=acquireLock(path.join(this.stateRoot,'console.lock'));
    this.instanceId=createHash('sha256').update(root).digest('hex').slice(0,24);
    this.child=null;this.awake=null;this.closed=false;this.timer=null;this.error=null;this.stopping=false;
    this.renderFeed=new RenderFeed();
  }
  halted(){return fs.existsSync(path.join(this.stateRoot,'service.halt'));}
  halt(){
    const file=path.join(this.stateRoot,'service.halt');
    const fd=fs.openSync(file,'w',0o600);try{fs.writeSync(fd,'Stopped from the local bot app\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const d=fs.openSync(this.stateRoot,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  }
  priorPlayerAlive(){
    const lock=loadJson(path.join(this.stateRoot,'player-service.lock'),null);
    if(!Number.isSafeInteger(lock?.pid)||lock.pid<2)return false;
    try{process.kill(lock.pid,0);return true;}catch(error){return error.code!=='ESRCH';}
  }
  async action(action){
    if(!['snapshot','start','stop'].includes(action))throw Error('Unknown local control action');
    if(action==='start'){
      if(this.closed)throw Error('Console is closing');
      if(!fs.existsSync(this.configFile))throw Error('Local production profile is missing');
      fs.rmSync(path.join(this.stateRoot,'service.halt'),{force:true});this.error=null;this.launch();
    }
    if(action==='stop'){
      this.halt();clearTimeout(this.timer);this.timer=null;
      if(this.child){this.stopping=true;this.child.kill('SIGTERM');if(this.child.connected)this.child.disconnect();}
    }
    return this.snapshot();
  }
  launch(){
    if(this.child||this.closed||this.halted())return;
    if(this.priorPlayerAlive()){
      this.error='The previous local player is disconnecting. Waiting before starting another.';
      clearTimeout(this.timer);this.timer=setTimeout(()=>this.launch(),1000);this.timer.unref();return;
    }
    this.stopping=false;
    const log=fs.openSync(path.join(this.dataRoot,'player.log'),'a',0o600);
    let child;
    try{child=this.spawn(process.execPath,[path.join(this.root,'bin/service.mjs'),this.configFile],{cwd:this.root,stdio:['ignore',log,log,'ipc']});}
    finally{fs.closeSync(log);}
    this.child=child;
    child.on('message',packet=>{
      if(packet?.kind==='render-entry')packet.data.runId=packet.runId;
      this.renderFeed.receive(packet);
    });
    child.once('spawn',()=>{
      this.error=null;
      saveJson(path.join(this.stateRoot,'local-runtime.json'),{mode:'local',pid:child.pid,consolePid:process.pid,startedAt:new Date().toISOString()});
      if(this.keepAwake&&process.platform==='darwin'){
        this.awake=this.spawn('/usr/bin/caffeinate',['-i','-w',String(child.pid)],{stdio:'ignore'});
        this.awake.on('error',()=>{});
      }
    });
    const finish=(error)=>{
      if(this.child!==child)return;
      this.child=null;this.stopping=false;this.awake?.kill();this.awake=null;
      this.renderFeed.reset();
      if(error)this.error='Local player could not start; see the local player log.';
      if(!this.closed&&!this.halted()){
        this.timer=setTimeout(()=>this.launch(),this.restartMs);this.timer.unref();
      }
    };
    child.once('exit',()=>finish());child.once('error',error=>finish(error));
  }
  resume(){if(fs.existsSync(this.configFile)&&!this.halted())this.launch();}
  snapshot(){
    const activeState=this.child?(this.stopping?'deactivating':'active'):(!this.halted()&&this.timer?'activating':'inactive');
    return {...collectConsoleState(this.dataRoot,{activeState,subState:this.stopping?'disconnecting':this.child?'running':'stopped',enabled:false,pid:this.child?.pid??null,location:'local'}),
      runtime:{mode:'local',instanceId:this.instanceId,consolePid:process.pid,label:'This Mac'},
      controllerError:this.error};
  }
  async close(){
    if(this.closed)return;
    this.closed=true;clearTimeout(this.timer);this.timer=null;
    const child=this.child;
    if(child){
      const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
      child.kill('SIGTERM');
      if(child.connected)child.disconnect();
      const force=setTimeout(()=>child.kill('SIGKILL'),70000);force.unref();
      await exited;clearTimeout(force);
    }
    this.awake?.kill();this.awake=null;this.unlock();
  }
}
