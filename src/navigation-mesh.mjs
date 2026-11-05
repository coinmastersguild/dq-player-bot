import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const add=(a,b,t)=>a.map((v,i)=>v+t*b[i]);
const clamp=v=>Math.max(0,Math.min(1,v));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

export function verifyNavigationIndex(index,config){
  const {format,contentVersion,packHash,storeBytes,assets,...metadata}=index;
  if(format!=='DQP1'||contentVersion!==1||index.audience!=='presentation'||index.kind!=='zone'||index.packId!==config.world||
    packHash!==config.nativeSession.presentationPackHash||index.requires?.title?.packHash!==config.nativeSession.titlePackHash||
    !Number.isSafeInteger(storeBytes)||storeBytes<0||hash(JSON.stringify({...metadata,assets,storeBytes}))!==packHash)
    throw Error('Navigation presentation index differs from the player release');
  const record=index.content?.['world.json']?.physics?.staticCollision,pin=assets?.[record?.asset];
  if(record?.schema!=='dq-triangle-mesh-v1'||!pin||!/^[a-f0-9]{64}$/.test(pin.sha256)||
    !Number.isSafeInteger(pin.off)||!Number.isSafeInteger(pin.len)||pin.off<0||pin.len<32||pin.len>200*1024*1024||pin.off+pin.len>storeBytes)
    throw Error('No bounded public collision asset for navigation');
  return {record,pin};
}
export function decodeNavigationCollision(encoded,index,config){
  const {record,pin}=verifyNavigationIndex(index,config);
  if(encoded.length!==pin.len||hash(encoded)!==pin.sha256)throw Error('Navigation collision storage integrity failure');
  const storage=record.assetStorage;
  if(storage&&(!Number.isSafeInteger(storage.decodedBytes)||storage.decodedBytes>256*1024*1024||storage.decodedBytes<32))throw Error('Navigation collision exceeds the decode limit');
  const bytes=storage?.storageEncoding==='deflate'?inflateSync(encoded,{maxOutputLength:storage.decodedBytes}):encoded;
  if(storage&&(bytes.length!==storage.decodedBytes||hash(bytes)!==storage.decodedSha256))throw Error('Navigation decoded collision integrity failure');
  if(bytes.subarray(0,4).toString()!=='DQTM'||bytes.readUInt32LE(4)!==1||bytes.readUInt32LE(16)!==bytes.length)throw Error('Invalid navigation collision header');
  const vertices=bytes.readUInt32LE(8),count=bytes.readUInt32LE(12),positionsAt=bytes.readUInt32LE(24),indicesAt=bytes.readUInt32LE(28);
  if(vertices!==record.vertexCount||count!==record.indexCount||count%3||positionsAt<32||indicesAt!==positionsAt+vertices*12||bytes.length!==indicesAt+count*4)
    throw Error('Navigation collision extent differs from its declaration');
  // Copies align typed arrays independently of Buffer backing-store offsets.
  return {positions:new Float32Array(Uint8Array.from(bytes.subarray(positionsAt,indicesAt)).buffer),indices:new Uint32Array(Uint8Array.from(bytes.subarray(indicesAt)).buffer),pin,record};
}

function pointTriangle(p,a,b,c){
  const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);
  if(d1<=0&&d2<=0)return dot(ap,ap);
  const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);if(d3>=0&&d4<=d3)return dot(bp,bp);
  const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0){const q=sub(p,add(a,ab,d1/(d1-d3)));return dot(q,q);}
  const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);if(d6>=0&&d5<=d6)return dot(cp,cp);
  const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0){const q=sub(p,add(a,ac,d2/(d2-d6)));return dot(q,q);}
  const va=d3*d6-d5*d4;if(va<=0&&d4-d3>=0&&d5-d6>=0){const q=sub(p,add(b,sub(c,b),(d4-d3)/(d4-d3+d5-d6)));return dot(q,q);}
  const denominator=va+vb+vc;
  if(Math.abs(denominator)<1e-14)return Math.min(dot(ap,ap),dot(bp,bp),dot(cp,cp));
  const q=sub(p,add(add(a,ab,vb/denominator),ac,vc/denominator));return dot(q,q);
}
function segmentSegment(a,b,c,d){
  const u=sub(b,a),v=sub(d,c),w=sub(a,c),aa=dot(u,u),bb=dot(u,v),cc=dot(v,v),dd=dot(u,w),ee=dot(v,w);
  let s=aa*cc-bb*bb>1e-14?clamp((bb*ee-cc*dd)/(aa*cc-bb*bb)):0;
  let t=cc>1e-14?(bb*s+ee)/cc:0;
  if(t<0){t=0;s=aa>1e-14?clamp(-dd/aa):0;}else if(t>1){t=1;s=aa>1e-14?clamp((bb-dd)/aa):0;}
  const q=sub(add(a,u,s),add(c,v,t));return dot(q,q);
}
function segmentTriangle(p,q,a,b,c){
  const direction=sub(q,p),ab=sub(b,a),ac=sub(c,a),h=cross(direction,ac),det=dot(ab,h);
  if(Math.abs(det)>1e-12){const s=sub(p,a),u=dot(s,h)/det,v=dot(direction,cross(s,ab))/det,t=dot(ac,cross(s,ab))/det;if(u>=0&&v>=0&&u+v<=1&&t>=0&&t<=1)return 0;}
  return Math.min(pointTriangle(p,a,b,c),pointTriangle(q,a,b,c),segmentSegment(p,q,a,b),segmentSegment(p,q,b,c),segmentSegment(p,q,c,a));
}

/** Read-only local route queries over the normal player's released collision.
 * All movement still goes through server-integrated ordinary input. */
export class NavigationMesh {
  constructor(positions,indices,{radius=.5,height=2.1}={}){this.positions=positions;this.indices=indices;this.radius=radius;this.height=height;this.patch=null;}
  prepare(origin){
    if(this.patch&&distance(origin,this.patch.origin)<32&&Math.abs(origin.y-this.patch.origin.y)<4)return;
    const bins=new Map(),triangles=[];const p=this.positions,ids=this.indices;
    for(let n=0;n<ids.length;n+=3){
      const vertices=[ids[n],ids[n+1],ids[n+2]].map(i=>[p[i*3],p[i*3+1],p[i*3+2]]);
      if(vertices.some(v=>!v.every(Number.isFinite)))throw Error('Non-finite navigation triangle');
      const min=vertices[0].map((_,i)=>Math.min(...vertices.map(v=>v[i]))),max=vertices[0].map((_,i)=>Math.max(...vertices.map(v=>v[i])));
      if(min[0]>origin.x+100||max[0]<origin.x-100||min[2]>origin.z+100||max[2]<origin.z-100||min[1]>origin.y+96||max[1]<origin.y-96)continue;
      const id=triangles.length,normal=cross(sub(vertices[1],vertices[0]),sub(vertices[2],vertices[0]));
      triangles.push({vertices,min,max,walkable:normal[1]/Math.hypot(...normal)>.6});
      for(let x=Math.floor(Math.max(min[0],origin.x-101)/4);x<=Math.floor(Math.min(max[0],origin.x+101)/4);x++)for(let z=Math.floor(Math.max(min[2],origin.z-101)/4);z<=Math.floor(Math.min(max[2],origin.z+101)/4);z++){
        const key=x+':'+z;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(id);
      }
    }
    this.patch={origin:{...origin},bins,triangles};
  }
  candidates(x,z,r=0){
    const ids=new Set();for(let bx=Math.floor((x-r)/4);bx<=Math.floor((x+r)/4);bx++)for(let bz=Math.floor((z-r)/4);bz<=Math.floor((z+r)/4);bz++)for(const id of this.patch.bins.get(bx+':'+bz)??[])ids.add(id);
    return [...ids].map(id=>this.patch.triangles[id]);
  }
  floor(x,z,referenceY){
    const cacheKey=[x,z,referenceY].map(v=>v.toFixed(4)).join(':');
    if(this.floorCache?.has(cacheKey))return this.floorCache.get(cacheKey);
    let best=null;
    for(const {vertices:[a,b,c],walkable} of this.candidates(x,z)){
      if(!walkable)continue;
      const d=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(d)<1e-10)continue;
      const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/d,v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/d;
      if(u<-.00001||v<-.00001||u+v>1.00001)continue;
      const y=u*a[1]+v*b[1]+(1-u-v)*c[1];
      // Never snap to a roof or another storey. Individual steps are bounded.
      if(y>referenceY+.65||y<referenceY-1.2)continue;
      if(best===null||y>best)best=y;
    }
    this.floorCache?.set(cacheKey,best);return best;
  }
  clear(p){
    const cacheKey=[p.x,p.y,p.z].map(v=>v.toFixed(4)).join(':');
    if(this.clearCache?.has(cacheKey))return this.clearCache.get(cacheKey);
    if(this.avoid?.some(zone=>Math.abs(zone.y-p.y)<4&&Math.hypot(zone.x-p.x,zone.z-p.z)<zone.radius))return false;
    const r=this.radius,a=[p.x,p.y+r+.025,p.z],b=[p.x,p.y+this.height-r,p.z];
    const clear=!this.candidates(p.x,p.z,r).some(t=>t.max[1]>p.y+.08&&t.min[1]<p.y+this.height&&
      segmentTriangle(a,b,...t.vertices)<(r-.015)**2);
    this.clearCache?.set(cacheKey,clear);return clear;
  }
  segment(from,to){
    const length=distance(from,to),steps=Math.max(1,Math.ceil(length/.25));let y=from.y;
    for(let i=1;i<=steps;i++){
      const t=i/steps,x=from.x+(to.x-from.x)*t,z=from.z+(to.z-from.z)*t,nextY=this.floor(x,z,y);
      if(nextY===null||Math.abs(nextY-y)>.65||!this.clear({x,y:nextY,z}))return null;y=nextY;
    }
    return {...to,y};
  }
  lineClear(from,to){
    const a=[from.x,from.y+1.2,from.z],b=[to.x,to.y+1.2,to.z],candidates=new Set(),steps=Math.max(1,Math.ceil(distance(from,to)/2));
    for(let i=0;i<=steps;i++){const t=i/steps;for(const triangle of this.candidates(from.x+(to.x-from.x)*t,from.z+(to.z-from.z)*t,.05))candidates.add(triangle);}
    return ![...candidates].some(t=>segmentTriangle(a,b,...t.vertices)<1e-8);
  }
  route(from,to,options={}){
    this.floorCache=new Map();this.clearCache=new Map();
    this.avoid=(options.avoid??[]).slice(0,40).filter(z=>[z.x,z.y,z.z,z.radius].every(Number.isFinite)&&z.radius>0&&z.radius<=30)
      .map(z=>({...z,radius:Math.max(0,Math.min(z.radius,Math.hypot(z.x-from.x,z.z-from.z)-.5))}));
    try{return this.findRoute(from,to,options);}finally{this.floorCache=null;this.clearCache=null;this.avoid=null;}
  }
  findRoute(from,to,{maxNodes=14000,maxMs=6000,reach=.4,exactY=true}={}){
    if(!Number.isFinite(reach)||reach<.1||reach>3)return {status:'invalid'};
    if(![from.x,from.y,from.z,to.x,to.y,to.z].every(Number.isFinite))return {status:'invalid'};
    this.prepare(from);
    const y=this.floor(from.x,from.z,from.y);if(y===null)return {status:'no-floor'};
    const start={...from,y},range=distance(start,to),goal=range>72?{x:start.x+(to.x-start.x)*72/range,y:to.y,z:start.z+(to.z-start.z)*72/range}:to;
    const heightKnown=exactY&&range<=72,radius=range>72?.4:reach,shorten=Math.max(0,distance(start,goal)-Math.max(0,radius-.2)),d=distance(start,goal);
    const endpoint=d?{x:start.x+(goal.x-start.x)*shorten/d,y:goal.y,z:start.z+(goal.z-start.z)*shorten/d}:goal;
    const direct=this.segment(start,endpoint);
    if(direct&&(!heightKnown||Math.abs(direct.y-goal.y)<1.2&&this.lineClear(direct,goal)))return {status:'route',waypoints:[direct],partial:range>72};
    const cell=.75,key=p=>Math.round((p.x-from.x)/cell)+':'+Math.round((p.z-from.z)/cell)+':'+Math.round(p.y*2);
    const heuristic=p=>distance(p,goal)+(heightKnown?Math.abs(p.y-goal.y):0),nodes=[{...start,g:0,f:heuristic(start),parent:-1}],scores=new Map([[key(start),0]]),heap=[0];
    const push=id=>{heap.push(id);let i=heap.length-1;while(i){const p=(i-1)>>1;if(nodes[heap[p]].f<=nodes[id].f)break;heap[i]=heap[p];i=p;}heap[i]=id;};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;heap[0]=last;for(;;){let c=i*2+1;if(c>=heap.length)break;if(c+1<heap.length&&nodes[heap[c+1]].f<nodes[heap[c]].f)c++;if(nodes[last].f<=nodes[heap[c]].f)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;};
    const began=performance.now();let found=-1,finish=null;
    while(heap.length&&nodes.length<maxNodes){
      if(performance.now()-began>maxMs)return {status:'budget',nodes:nodes.length};
      const id=pop(),p=nodes[id];if(p.g>scores.get(key(p)))continue;
      if(distance(p,goal)<=radius&&(!heightKnown||Math.abs(p.y-goal.y)<1.2&&this.lineClear(p,goal))){found=id;break;}
      if(distance(p,goal)<1.1&&(!heightKnown||Math.abs(p.y-goal.y)<1.2)){const last=this.segment(p,goal);if(last){found=id;finish=last;break;}}
      for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++){
        if(!dx&&!dz)continue;
        const q=this.segment(p,{x:p.x+dx*cell,y:p.y,z:p.z+dz*cell});
        if(!q||distance(q,start)>92)continue;
        const g=p.g+distance(p,q)+Math.abs(p.y-q.y)*.5,k=key(q);if(g>=(scores.get(k)??Infinity))continue;
        scores.set(k,g);nodes.push({...q,g,f:g+heuristic(q),parent:id});push(nodes.length-1);
      }
    }
    if(found<0)return {status:nodes.length>=maxNodes?'budget':'unreachable',nodes:nodes.length};
    const path=finish?[finish]:[];for(let id=found;id>=0;id=nodes[id].parent)path.push({x:nodes[id].x,y:nodes[id].y,z:nodes[id].z});path.reverse();
    const waypoints=[];let anchor=0;
    while(anchor<path.length-1){let end=Math.min(path.length-1,anchor+20);while(end>anchor+1&&!this.segment(path[anchor],path[end]))end--;waypoints.push(path[end]);anchor=end;}
    return {status:'route',waypoints,partial:range>72,nodes:nodes.length};
  }
}
