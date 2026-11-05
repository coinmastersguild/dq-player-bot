import fs from 'node:fs';import path from 'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),assets=path.join(root,'assets'),manifest=JSON.parse(fs.readFileSync(path.join(assets,'renderer-manifest.json')));
const hash=b=>createHash('sha256').update(b).digest('hex'),archive=path.join(assets,manifest.archive),bytes=fs.readFileSync(archive);
if(bytes.length!==manifest.bytes||hash(bytes)!==manifest.sha256)throw Error('Renderer archive integrity failure');
const expected=new Set(manifest.files.map(f=>f.path));for(const name of expected)if(name.startsWith('/')||name.split('/').includes('..'))throw Error('Invalid renderer path');
const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');if(entries.length!==expected.size||entries.some(n=>!expected.has(n)))throw Error('Renderer archive entries differ');
const out=path.join(root,'.local/render-bundle');fs.mkdirSync(out,{recursive:true,mode:0o700});
execFileSync('tar',['-xzf',archive,'-C',out]);
for(const f of manifest.files){const filename=path.join(out,f.path),s=fs.lstatSync(filename);if(!s.isFile()||s.isSymbolicLink())throw Error('Invalid renderer file');const b=fs.readFileSync(filename);if(b.length!==f.bytes||hash(b)!==f.sha256)throw Error('Renderer file integrity failure: '+f.path);}
console.log(`Installed verified first-person renderer (${manifest.files.length} files).`);
