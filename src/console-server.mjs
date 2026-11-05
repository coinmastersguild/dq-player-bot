import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../console');
export function createConsoleServer({run,renderRoutes,port=4783,pollMs=1000}={}) {
  if(typeof run!=='function')throw Error('A local bot controller is required');
  const token=randomBytes(32).toString('hex');
  let snapshot=null,error=null,readPending=null,controlPending=null,closed=false;
  const refresh=()=>{
    if(readPending)return readPending;
    if(controlPending)return Promise.resolve();
    readPending=Promise.resolve().then(()=>run('snapshot')).then(s=>{snapshot=s;error=null;}).catch(()=>{error='Local bot controller unavailable. Reconnecting…';}).finally(()=>{readPending=null;});
    return readPending;
  };
  const server=http.createServer(async(req,res)=>{
    const origin=`http://127.0.0.1:${server.address().port}`;
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};
    const json=(status,value)=>{res.writeHead(status,{...headers,'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    // Exact Host validation also blocks DNS rebinding to the local control API.
    if(req.headers.host!==`127.0.0.1:${server.address().port}`)return json(403,{error:'Invalid host'});
    if(req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'Cross-site request refused'});
    const url=new URL(req.url,origin);
    if(renderRoutes&&await renderRoutes(req,res,url,headers))return;
    if(req.method==='GET'&&url.pathname==='/api/state') {
      if(!snapshot)await refresh();
      const cachedAge=snapshot?Math.max(0,Date.now()-snapshot.at):0;
      return json(200,{...snapshot,observationAgeMs:snapshot?.observationAgeMs==null?null:snapshot.observationAgeMs+cachedAge,live:!error&&snapshot?.live===true&&cachedAge<6000,connectionError:error,controlPending:controlPending?.action??null,csrfToken:token});
    }
    if(req.method==='POST'&&url.pathname==='/api/control') {
      const supplied=Buffer.from(String(req.headers['x-console-token']??''));
      if(req.headers.origin!==origin||supplied.length!==token.length||!timingSafeEqual(supplied,Buffer.from(token)))return json(403,{error:'Invalid control session'});
      if(req.headers['content-type']!=='application/json')return json(415,{error:'Use JSON'});
      let body='';
      try {
        for await(const chunk of req){body+=chunk;if(body.length>128)return json(413,{error:'Request too large'});}
        let parsed;
        try{parsed=JSON.parse(body);}catch{return json(400,{error:'Invalid JSON'});}
        if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return json(400,{error:'Invalid control action'});
        if(Object.keys(parsed).join(',')!=='action'||!['start','stop'].includes(parsed.action))return json(400,{error:'Choose start or stop'});
        if(controlPending)return json(409,{error:'A control action is already pending'});
        const action=parsed.action;
        // Wait for any earlier read to finish so stale data cannot overwrite a control result.
        const previousRead=readPending;
        const task=(async()=>{if(previousRead)await previousRead;snapshot=await run(action);error=null;})();
        controlPending={action,task};
        try{await task;return json(200,{ok:true,action});}
        finally{controlPending=null;}
      }catch{return json(502,{error:'Control not confirmed. Check the live service state before trying again.'});}
    }
    const file={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/icon.svg':'icon.svg'}[url.pathname];
    if(req.method!=='GET'||!file)return json(404,{error:'Not found'});
    res.writeHead(200,{...headers,'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/javascript'});
    fs.createReadStream(path.join(assets,file)).pipe(res);
  });
  server.requestTimeout=10000;
  const timer=setInterval(()=>{if(!closed)refresh();},pollMs);timer.unref();
  server.once('close',()=>{closed=true;clearInterval(timer);});
  return {server,refresh,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{refresh();resolve(server.address());});})};
}
