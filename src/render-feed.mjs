import {EventEmitter} from 'node:events';
import {redact} from './recording.mjs';
const identity=['k','tid','nm','lv','bt','cat','sk','app','nvi','ri','ric','pi','pic','pci','pcic','eqs','companion','fac','ht','hb','gd','kg','dgn','obj','cpo','rk','sc','c'];
const dynamic=['dead','ic','act','mnt','brb','cast','castEnd','castTot','chan','auras','h','tgt','aggro','loot','lootList','tap','own','thr'];
export class RenderFeed extends EventEmitter {
  constructor(){super();this.reset();}
  reset(){this.bootstrap=null;this.hello=null;this.snap=null;this.entities=new Map();this.self=null;this.at=0;this.emit('end');}
  receive(packet){
    if(packet?.kind==='render-entry'){
      this.reset();this.bootstrap=redact(packet.data);return;
    }
    if(packet?.kind!=='render-frame'||!this.bootstrap)return;
    const frame=redact(packet.data);
    if(frame.t==='hello'){this.hello=frame;this.emit('frame',frame);return;}
    if(frame.t==='snap'){
      if(!this.hello||!Array.isArray(frame.ents)||frame.self?.id!==this.hello.pid)return;
      const next=new Map();
      for(const id of frame.keep??[])if(this.entities.has(id))next.set(id,this.entities.get(id));
      for(const row of [...frame.ents,frame.self]){
        if(!Number.isSafeInteger(row?.id)||!['x','y','z','f'].every(k=>Number.isFinite(row[k])))continue;
        const old=this.entities.get(row.id);
        if(!old&&typeof row.k!=='string')continue;
        const base=row.id===frame.self.id?{...this.self}:Object.fromEntries(identity.filter(k=>old?.[k]!==undefined).map(k=>[k,old[k]]));
        for(const key of dynamic)delete base[key];
        for(const key of ['hp','mhp'])if(row[key]===undefined&&old?.[key]!==undefined)base[key]=old[key];
        next.set(row.id,{...base,...row});
      }
      this.entities=next;this.self=next.get(frame.self.id);
      this.snap={...frame,self:this.self,ents:[...next.values()].filter(e=>e.id!==frame.self.id),keep:[]};this.at=Date.now();
    }
    this.emit('frame',frame);
  }
  ready(){return !!(this.bootstrap&&this.hello&&this.snap&&Date.now()-this.at<6000);}
}
