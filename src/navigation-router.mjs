import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
export class NavigationRouter {
  constructor(config,stateRoot,{diagnostic=()=>{}}={}){
    this.diagnostic=diagnostic;this.pending=new Map();this.sequence=0;this.ready=false;this.closed=false;
    const directory=path.join(stateRoot,'navigation',config.world);
    if(!fs.existsSync(path.join(directory,'index.json'))||!fs.existsSync(path.join(directory,'collision.bin'))){diagnostic({type:'navigation-map-unavailable',reason:'No verified public collision cache'});return;}
    this.worker=new Worker(new URL('./navigation-worker.mjs',import.meta.url),{workerData:{directory,config:{world:config.world,nativeSession:config.nativeSession}}});
    this.worker.on('message',message=>{
      if('ready' in message){this.ready=message.ready;this.huntingSites=message.huntingSites??[];diagnostic({type:'navigation-map',...message});return;}
      const pending=this.pending.get(message.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(message.id);pending.resolve(message);
    });
    const failed=()=>{this.ready=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.resolve({status:'unavailable'});}this.pending.clear();};
    this.worker.on('error',error=>{diagnostic({type:'navigation-map-error',reason:error.message});failed();});
    this.worker.on('exit',failed);
  }
  route(from,to,{reach=.4,exactY=true,avoid=[]}={}){
    if(!this.ready||this.closed)return Promise.resolve({status:'unavailable'});
    const id=++this.sequence;
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending.delete(id);resolve({status:'timeout'});},20000);timer.unref();
      this.pending.set(id,{resolve,timer});this.worker.postMessage({id,from:{x:from.x,y:from.y,z:from.z},to:{x:to.x,y:to.y,z:to.z},reach,exactY,avoid});
    });
  }
  async close(){this.closed=true;await this.worker?.terminate();}
}
