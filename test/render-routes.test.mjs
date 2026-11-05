import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {createConsoleServer} from '../src/console-server.mjs';
import {createRenderRoutes} from '../src/render-routes.mjs';
import {RenderFeed} from '../src/render-feed.mjs';
import {hello,snap} from './fixtures.mjs';

async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dq-render-'));
  const bundle=path.join(root,'.local/render-bundle');fs.mkdirSync(bundle,{recursive:true});
  const sha='a'.repeat(64),release='b'.repeat(64),requests=[];
  fs.writeFileSync(path.join(bundle,'presentation-pins.json'),JSON.stringify([{sha256:sha}]));
  fs.writeFileSync(path.join(bundle,'observer.js'),'// real local bundle fixture');
  const upstream=http.createServer((req,res)=>{
    requests.push({url:req.url,headers:req.headers});
    if(req.url.startsWith('/packs/')){
      const bytes=Buffer.from('pack-header!');
      res.writeHead(206,{'Content-Type':'application/octet-stream','Content-Range':'bytes 0-11/1000','Content-Length':bytes.length,'X-Dq-Pack-Sha256':sha});res.end(bytes);
    }else{
      const bytes=gzipSync(JSON.stringify({released:true}));
      res.writeHead(200,{'Content-Type':'application/json','Content-Encoding':'gzip','Content-Length':bytes.length});res.end(bytes);
    }
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const configFile=path.join(root,'config.json');
  fs.writeFileSync(configFile,JSON.stringify({origin:`http://127.0.0.1:${upstream.address().port}`,contentLockSha256:release}));
  const feed=new RenderFeed();
  const app=createConsoleServer({port:0,run:async()=>({at:Date.now()}),renderRoutes:createRenderRoutes({root,configFile,renderFeed:feed})});
  const address=await app.listen(),origin=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{app.server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(resolve=>app.server.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);fs.rmSync(root,{recursive:true,force:true});});
  return {origin,sha,release,requests,feed};
}
test('public pack proxy preserves exact byte ranges and release pins without forwarding credentials',async t=>{
  const f=await fixture(t);
  const r=await fetch(`${f.origin}/packs/${f.sha}`,{headers:{range:'bytes=0-11',cookie:'private-cookie',authorization:'Bearer private-token'}});
  assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-11/1000');assert.equal(await r.text(),'pack-header!');
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].headers.range,'bytes=0-11');
  assert.equal(f.requests[0].headers.cookie,undefined);assert.equal(f.requests[0].headers.authorization,undefined);
  assert.equal(new URL(f.requests[0].url,'http://fixture').searchParams.get('release'),f.release);
});
test('private packs, mismatched pins and malformed ranges cannot reach the upstream',async t=>{
  const f=await fixture(t),url=`${f.origin}/packs/${f.sha}`;
  assert.equal((await fetch(`${f.origin}/packs/${'c'.repeat(64)}`)).status,404);
  assert.equal((await fetch(url+'?release='+('d'.repeat(64)))).status,409);
  assert.equal((await fetch(url,{headers:{range:'bytes=0-1,5-7'}})).status,400);
  assert.equal((await fetch(`${f.origin}/bundle/%zz`)).status,400);
  assert.equal((await fetch(`${f.origin}/bundle/%2f..%2f..%2fconfig.json`)).status,404);
  assert.equal(f.requests.length,0);
});
test('compressed presentation metadata is decoded without advertising its old encoded length',async t=>{
  const f=await fixture(t),r=await fetch(`${f.origin}/content/manifest.json`);
  assert.equal(r.status,200);assert.equal(r.headers.get('content-encoding'),null);assert.equal(r.headers.get('content-length'),null);
  assert.deepEqual(await r.json(),{released:true});
});
test('observer stream requires the actual live run and ends when that run retires',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.origin+'/render/bootstrap')).status,503);
  f.feed.receive({kind:'render-entry',data:{worldId:'coinfall',runId:'real-run',entry:{ticket:'private-ticket'}}});
  f.feed.receive({kind:'render-frame',data:hello()});f.feed.receive({kind:'render-frame',data:snap()});
  const boot=await(await fetch(f.origin+'/render/bootstrap')).json();assert.equal(boot.entry.ticket,undefined);
  assert.equal((await fetch(f.origin+'/render/stream?world=coinfall&runId=old-run')).status,409);
  const controller=new AbortController();t.after(()=>controller.abort());
  const r=await fetch(f.origin+'/render/stream?world=coinfall&runId=real-run',{signal:controller.signal});
  const reader=r.body.getReader();let stream='';
  while(!stream.includes('"t":"snap"')){const next=await reader.read();assert.equal(next.done,false);stream+=new TextDecoder().decode(next.value);}
  assert.match(stream,/"t":"hello"/);assert.match(stream,/"t":"snap"/);
  f.feed.reset();
  for(;;){const next=await reader.read();if(next.done)break;stream+=new TextDecoder().decode(next.value);}
  assert.match(stream,/event: session-end/);assert.equal(f.feed.listenerCount('frame'),0);
});
