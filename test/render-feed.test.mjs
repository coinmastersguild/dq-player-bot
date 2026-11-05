import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderFeed} from '../src/render-feed.mjs';
import {hello,snap,self,mob} from './fixtures.mjs';
test('late renderer attachment reconstructs actual full/lite/keep state and preserves avatar identity',()=>{
  const feed=new RenderFeed(),nvi={ownerId:'character:7',appearanceSha256:'a'.repeat(64)};
  feed.receive({kind:'render-entry',data:{worldId:'coinfall',runId:'actual-run',entry:{ticket:'do-not-expose'},character:{id:7}}});
  feed.receive({kind:'render-frame',data:hello()});
  feed.receive({kind:'render-frame',data:snap({self:self({nvi,app:{base:'actual-body'},qlog:[{questId:'real-quest'}]})})});
  feed.receive({kind:'render-frame',data:snap({tick:11,time:.55,self:{id:1,x:1,y:0,z:0,f:.1},ents:[{id:2,x:2,y:0,z:2,f:.2}],keep:[3]})});
  assert.equal(feed.ready(),true);assert.deepEqual(feed.snap.self.nvi,nvi);assert.equal(feed.snap.self.x,1);
  assert.deepEqual(feed.snap.self.qlog,[{questId:'real-quest'}]);assert.equal(feed.snap.ents.find(e=>e.id===2).nm,'Rat');assert.ok(feed.snap.ents.some(e=>e.id===3));
  assert.equal(feed.hello.ticket,undefined);assert.equal(feed.bootstrap.entry.ticket,undefined);
  feed.receive({kind:'render-frame',data:snap({tick:12,time:.6,self:{id:1,x:1,y:0,z:0,f:.1},ents:[]})});
  assert.equal(feed.snap.ents.length,0);
});
test('an actual new bot run retires the old render context instead of fabricating continuation',()=>{
  const feed=new RenderFeed();feed.receive({kind:'render-entry',data:{runId:'one'}});feed.receive({kind:'render-frame',data:hello()});feed.receive({kind:'render-frame',data:snap()});
  let ended=0;feed.on('end',()=>ended++);feed.receive({kind:'render-entry',data:{runId:'two'}});
  assert.equal(ended,1);assert.equal(feed.ready(),false);assert.equal(feed.hello,null);assert.equal(feed.snap,null);
});
test('late attachment keeps another player’s native body and equipment across sparse movement frames',()=>{
  const feed=new RenderFeed(),nvi={ownerId:'character:8',appearanceSha256:'e'.repeat(64)},eqs=[{slot:'mainHand',itemId:'actual-staff'}];
  feed.receive({kind:'render-entry',data:{runId:'real-run'}});feed.receive({kind:'render-frame',data:hello()});
  feed.receive({kind:'render-frame',data:snap({ents:[mob({k:'player',nvi,eqs,companion:'actual-companion',pic:'actual-portrait'})]})});
  feed.receive({kind:'render-frame',data:snap({ents:[{id:2,x:4,y:0,z:5,f:1}]})});
  const other=feed.snap.ents[0];assert.deepEqual(other.nvi,nvi);assert.deepEqual(other.eqs,eqs);
  assert.equal(other.companion,'actual-companion');assert.equal(other.pic,'actual-portrait');assert.equal(other.x,4);
});
