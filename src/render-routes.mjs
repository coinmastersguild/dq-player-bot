import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
const mime={'.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg'};
const policy="default-src 'self' blob: data:; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: data:; frame-src 'self'; object-src 'none'; base-uri 'none'";
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle/observer.css"></head><body><canvas aria-label="DegenQuest first person world"></canvas><iframe id="hud" src="/game-ui" title="Game interface" tabindex="-1"></iframe><div id="loading"></div><script type="module" src="/bundle/observer.js"></script></body></html>';
const hud='<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle/wocHud.css"><link rel="stylesheet" href="/bundle/overlay.css"><link rel="stylesheet" href="/bundle/worldAtlas.css"><link rel="stylesheet" href="/bundle/entry.css"><link rel="stylesheet" href="/bundle/browser.css"></head><body><div id="react-root"></div><script type="module" src="/bundle/entry.js"></script></body></html>';
export function createRenderRoutes(player){
  const bundle=path.join(player.root,'.local/render-bundle');
  const feed=player.renderFeed;
  return async(req,res,url,baseHeaders)=>{
    if(!['GET','HEAD'].includes(req.method))return false;
    const headers={...baseHeaders,'Content-Security-Policy':policy,'Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Opener-Policy':'same-origin'};
    const json=(code,value)=>{res.writeHead(code,{...headers,'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/render/setup-wait.js'){res.writeHead(200,{...headers,'Content-Type':'text/javascript'});res.end("setInterval(async()=>{try{if((await fetch('/render/bootstrap')).ok)location.reload();}catch{}},2000);");return true;}
    if(!fs.existsSync(player.configFile)||!fs.existsSync(path.join(bundle,'presentation-pins.json'))){
      if(url.pathname==='/render'){res.writeHead(200,{...headers,'Content-Type':'text/html'});res.end('<body style="background:#111716;color:#d6f58a;font:18px system-ui;padding:40px">Complete the setup with Claude using this repository’s README, then press Start. The first-person view appears after the character enters the game.<script src="/render/setup-wait.js"></script></body>');return true;}
      if(url.pathname.startsWith('/render/')||url.pathname==='/game-ui'||url.pathname.startsWith('/bundle/')||url.pathname.startsWith('/content/')||url.pathname.startsWith('/packs/')){json(503,{error:'Complete account and renderer setup first'});return true;}
      return false;
    }
    const config=JSON.parse(fs.readFileSync(player.configFile,'utf8'));
    const publicPacks=new Set(JSON.parse(fs.readFileSync(path.join(bundle,'presentation-pins.json'),'utf8')).map(p=>p.sha256));
    if(url.pathname==='/render/bootstrap'){
      if(!feed.ready()){json(503,{error:'Waiting for the local bot’s authenticated live session'});return true;}
      json(200,feed.bootstrap);return true;
    }
    if(url.pathname==='/render/stream'){
      if(!feed.ready()||url.searchParams.get('runId')!==feed.bootstrap.runId||url.searchParams.get('world')!==feed.bootstrap.worldId){json(409,{error:'Bot render session changed'});return true;}
      res.writeHead(200,{...headers,'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      const send=frame=>{if(res.writableLength>2*1024*1024){end();return;}res.write('data: '+JSON.stringify(frame)+'\n\n');};
      const end=()=>{res.write('event: session-end\ndata: {}\n\n');res.end();};
      feed.on('frame',send);feed.once('end',end);
      const pulse=setInterval(()=>res.write(': heartbeat\n\n'),15000);pulse.unref();
      res.once('close',()=>{clearInterval(pulse);feed.off('frame',send);feed.off('end',end);});
      send(feed.hello);send(feed.snap);return true;
    }
    if(url.pathname==='/render'||url.pathname==='/game-ui'){
      res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8'});res.end(url.pathname==='/render'?html:hud);return true;
    }
    if(url.pathname.startsWith('/bundle/')){
      let name;
      try{name=decodeURIComponent(url.pathname.slice(8));}catch{json(400,{error:'Invalid renderer resource path'});return true;}
      const file=path.resolve(bundle,name);
      if(!file.startsWith(bundle+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)||!fs.statSync(file).isFile()){json(404,{error:'Renderer resource missing'});return true;}
      res.writeHead(200,{...headers,'Content-Type':mime[path.extname(file)],'Content-Length':fs.statSync(file).size});
      if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);return true;
    }
    const packed=/^\/packs\/([a-f0-9]{64})$/.exec(url.pathname);
    if(url.pathname.startsWith('/content/')||packed){
      if(packed&&!publicPacks.has(packed[1])){json(404,{error:'No public presentation pack'});return true;}
      if(url.searchParams.getAll('release').some(pin=>pin!==config.contentLockSha256)){json(409,{error:'Renderer and bot release differ'});return true;}
      url.searchParams.set('release',config.contentLockSha256);
      try{
        const requestHeaders={};
        if(req.headers.range){if(!/^bytes=\d+-\d*$/.test(req.headers.range)){json(400,{error:'Invalid asset range'});return true;}requestHeaders.Range=req.headers.range;}
        // Public presentation bytes only; never forward local/game credentials.
        const upstream=await fetch(new URL(url.pathname+url.search,config.origin),{method:req.method,headers:requestHeaders,redirect:'error',signal:AbortSignal.timeout(120000)});
        if(req.headers.range&&upstream.headers.get('content-encoding')&&!['identity'].includes(upstream.headers.get('content-encoding'))){await upstream.body?.cancel();json(502,{error:'Packed range encoding changed upstream'});return true;}
        const forwarded={...headers};
        for(const key of ['content-type','content-length','content-range','accept-ranges','cache-control','etag','x-dq-content-release','x-dq-pack-sha256']){if(key==='content-length'&&upstream.headers.has('content-encoding'))continue;const value=upstream.headers.get(key);if(value)forwarded[key]=value;}
        res.writeHead(upstream.status,forwarded);
        if(upstream.body)Readable.fromWeb(upstream.body).on('error',()=>res.destroy()).pipe(res);else res.end();
      }catch{if(!res.headersSent)json(502,{error:'Released game asset unavailable'});else res.destroy();}
      return true;
    }
    return false;
  };
}
