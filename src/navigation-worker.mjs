import fs from 'node:fs';
import path from 'node:path';
import {parentPort,workerData} from 'node:worker_threads';
import {decodeNavigationCollision,NavigationMesh} from './navigation-mesh.mjs';
try{
  const index=JSON.parse(fs.readFileSync(path.join(workerData.directory,'index.json'),'utf8'));
  const encoded=fs.readFileSync(path.join(workerData.directory,'collision.bin'));
  const {positions,indices,pin,record}=decodeNavigationCollision(encoded,index,workerData.config);
  const mesh=new NavigationMesh(positions,indices);
  parentPort.on('message',({id,from,to,reach,exactY,avoid})=>{
    try{const began=performance.now(),result=mesh.route(from,to,{reach,exactY,avoid});parentPort.postMessage({id,...result,elapsedMs:performance.now()-began});}
    catch(error){parentPort.postMessage({id,status:'error',reason:error.message});}
  });
  const huntingSites=(index.content['region-population-authoring.json']?.sites??[])
    .filter(site=>site.disposition==='hostile'&&Array.isArray(site.levelRange)&&Array.isArray(site.position)&&site.position.length===3&&site.position.every(Number.isFinite))
    .map(site=>({id:site.id,position:site.position,levels:site.levelRange}));
  parentPort.postMessage({ready:true,world:workerData.config.world,collisionSha256:pin.sha256,asset:record.asset,huntingSites});
}catch(error){parentPort.postMessage({ready:false,reason:error.message});parentPort.close();}
