import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {NavigationMesh,decodeNavigationCollision} from '../src/navigation-mesh.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function room(){
  const positions=[],indices=[];
  const triangle=(a,b,c)=>{const n=positions.length/3;positions.push(...a,...b,...c);indices.push(n,n+1,n+2);};
  const quad=(a,b,c,d)=>{triangle(a,b,c);triangle(a,c,d);};
  quad([-30,0,-30],[-30,0,30],[30,0,30],[30,0,-30]);
  const wall=(x1,z1,x2,z2)=>quad([x1,0,z1],[x2,0,z2],[x2,3,z2],[x1,3,z1]);
  wall(-6,-6,6,-6);wall(-6,-6,-6,6);wall(6,-6,6,6);
  wall(-6,6,-1.5,6);wall(1.5,6,6,6);
  return {positions:new Float32Array(positions),indices:new Uint32Array(indices),quad};
}
test('a route can initially move away from its goal to leave a room through its only doorway',()=>{
  const {positions,indices}=room(),mesh=new NavigationMesh(positions,indices),from={x:0,y:0,z:0},to={x:0,y:0,z:-14};
  const result=mesh.route(from,to,{maxMs:4000});
  assert.equal(result.status,'route');assert.ok(result.waypoints.some(p=>p.z>6));
  let previous=from;for(const point of result.waypoints){assert.ok(mesh.segment(previous,point),'every leg must clear the real walls');previous=point;}
  assert.ok(Math.hypot(previous.x-to.x,previous.z-to.z)<.1);
  assert.equal(mesh.segment(from,to),null,'straight steering would hit the rear wall');
});
test('capsule clearance rejects walls, narrow gaps and another floor instead of crossing them',()=>{
  const {positions,indices}=room(),mesh=new NavigationMesh(positions,indices);mesh.prepare({x:0,y:0,z:0});
  assert.equal(mesh.clear({x:5.8,y:0,z:0}),false);assert.equal(mesh.clear({x:0,y:0,z:6}),true);
  assert.equal(mesh.floor(0,0,6),null,'a missing storey is not the ground below');
  assert.equal(mesh.route({x:0,y:6,z:0},{x:0,y:6,z:10}).status,'no-floor');
});
test('an interaction radius cannot authorize a destination behind a wall without sight through the doorway',()=>{
  const {positions,indices}=room(),mesh=new NavigationMesh(positions,indices),from={x:0,y:0,z:0},to={x:0,y:0,z:-7};
  const result=mesh.route(from,to,{reach:2.2,maxMs:4000});
  assert.equal(result.status,'route');assert.ok(result.waypoints.some(p=>p.z>6));
  assert.equal(mesh.lineClear({x:0,y:0,z:-5},to),false);
  const end=result.waypoints.at(-1);assert.ok(Math.hypot(end.x-to.x,end.z-to.z)<=2.2);assert.equal(mesh.lineClear(end,to),true);
});
test('an unreachable goal and an exhausted search budget never return a fake straight route',()=>{
  const {positions,indices}=room(),mesh=new NavigationMesh(positions,indices);
  const from={x:0,y:0,z:0},to={x:5.9,y:0,z:-5.9};
  assert.notEqual(mesh.route(from,to,{maxMs:1000,maxNodes:500}).status,'route');
  assert.equal(mesh.route(from,{x:0,y:0,z:-14},{maxNodes:1}).status,'budget');
});
test('exploration follows the actual sloping ground instead of inventing the distant floor height',()=>{
  const mesh=new NavigationMesh(new Float32Array([-30,-7.5,-30,-30,7.5,30,30,7.5,30,30,-7.5,-30]),new Uint32Array([0,1,2,0,2,3]));
  const result=mesh.route({x:0,y:0,z:0},{x:0,y:0,z:10},{exactY:false});
  assert.equal(result.status,'route');assert.ok(result.waypoints.at(-1).y>2.4);
});
test('routes detour around an observed dangerous creature while permitting escape from an existing danger radius',()=>{
  const positions=new Float32Array([-40,0,-40,-40,0,40,40,0,40,40,0,-40]),indices=new Uint32Array([0,1,2,0,2,3]);
  const mesh=new NavigationMesh(positions,indices),zone={x:0,y:0,z:0,radius:8};
  const result=mesh.route({x:0,y:0,z:-15},{x:0,y:0,z:15},{avoid:[zone],maxMs:4000});
  assert.equal(result.status,'route');assert.ok(result.waypoints.some(p=>Math.abs(p.x)>=7));
  const escape=mesh.route({x:0,y:0,z:3},{x:0,y:0,z:15},{avoid:[zone]});assert.equal(escape.status,'route');
});
test('navigation consumes only the pinned public collision and validates stored and decoded bytes',()=>{
  const raw=Buffer.alloc(32+36+12);raw.write('DQTM');raw.writeUInt32LE(1,4);raw.writeUInt32LE(3,8);raw.writeUInt32LE(3,12);raw.writeUInt32LE(raw.length,16);raw.writeUInt32LE(32,24);raw.writeUInt32LE(68,28);
  for(let i=0;i<3;i++)raw.writeUInt32LE(i,68+i*4);
  const encoded=deflateSync(raw),record={schema:'dq-triangle-mesh-v1',asset:'collision',vertexCount:3,indexCount:3,assetStorage:{storageEncoding:'deflate',decodedBytes:raw.length,decodedSha256:hash(raw)}};
  const metadata={audience:'presentation',kind:'zone',packId:'world',requires:{title:{packHash:'t'}},content:{'world.json':{physics:{staticCollision:record}}}};
  const assets={collision:{off:0,len:encoded.length,sha256:hash(encoded)}},storeBytes=encoded.length;
  const index={format:'DQP1',contentVersion:1,...metadata,assets,storeBytes,packHash:hash(JSON.stringify({...metadata,assets,storeBytes}))};
  const config={world:'world',nativeSession:{presentationPackHash:index.packHash,titlePackHash:'t'}};
  assert.equal(decodeNavigationCollision(encoded,index,config).indices.length,3);
  assert.throws(()=>decodeNavigationCollision(Buffer.alloc(encoded.length),index,config),/integrity/);
  assert.throws(()=>decodeNavigationCollision(encoded,{...index,packId:'other'},config),/release/);
  const altered=structuredClone(index);altered.content['world.json'].physics.staticCollision.assetStorage.decodedSha256='0'.repeat(64);
  altered.packHash=hash(JSON.stringify({...metadata,content:altered.content,assets,storeBytes}));
  assert.throws(()=>decodeNavigationCollision(encoded,altered,{...config,nativeSession:{...config.nativeSession,presentationPackHash:altered.packHash}}),/decoded collision integrity/);
});
