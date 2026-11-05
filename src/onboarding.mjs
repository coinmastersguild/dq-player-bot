import fs from 'node:fs';import path from 'node:path';import{createHash,randomUUID}from'node:crypto';
import{Account,GAME_ORIGIN}from'./account.mjs';import{savePrivateJson}from'./private-store.mjs';import{saveJson}from'./durable.mjs';import{validateConfig}from'./world.mjs';import{GLM_MODEL,GlmClient}from'./glm.mjs';import{decodeNavigationCollision}from'./navigation-mesh.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export class Onboarding{
 constructor(root,{account=new Account(root),fetchImpl=fetch}={}){this.root=root;this.account=account;this.fetch=fetchImpl;this.release=JSON.parse(fs.readFileSync(path.join(root,'assets/release.json')));}
 async index(world='degenquest'){
  const pin=this.release.files[world==='degenquest'?'degenquest.dqz':world+'.dqz'];if(!pin)throw Error('World is not pinned in this release');
  const url=`${GAME_ORIGIN}/content/packs/${world}/index?sha256=${pin.sha256}&release=${this.release.contentLockSha256}`;
  const response=await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error(`Public content HTTP ${response.status}; update release pins through a reviewed release`);
  const text=await response.text();if(Buffer.byteLength(text)>16*1024*1024)throw Error('Public index too large');const index=JSON.parse(text);
  const{format,contentVersion,packHash,storeBytes,assets,...metadata}=index;
  if(format!=='DQP1'||contentVersion!==1||index.audience!=='presentation'||index.packId!==world||packHash!==pin.packHash||hash(JSON.stringify({...metadata,assets,storeBytes}))!==pin.packHash)throw Error('Public content identity mismatch');
  return index;
 }
 async options(){const i=await this.index();return i.content['native-player-identity.json'].offerings.map(o=>({baseId:o.baseId,class:o.classId,race:o.raceId,gender:o.gender}));}
 async claimName(name){if(!/^[a-zA-Z0-9_]{3,24}$/.test(name))throw Error('Account name must be 3–24 ASCII letters, digits or underscores');return(await this.account.request('/api/account/name',{body:{name}})).data;}
 async createCharacter({name,baseId='high-elf-male',classId='mage'}){
  if(!/^[a-zA-Z]{2,16}$/.test(name))throw Error('Character name must be 2–16 letters');
  const roster=await this.account.roster();if(roster.characters?.some(c=>c.name.toLowerCase()===name.toLowerCase()))return{alreadyExists:true,character:roster.characters.find(c=>c.name.toLowerCase()===name.toLowerCase())};
  const pending=path.join(this.root,'.secrets/character-pending.json');if(fs.existsSync(pending))throw Error('A previous character creation has an uncertain outcome. Inspect your roster and reconcile .secrets/character-pending.json before another create.');
  const index=await this.index(),record=index.content['native-player-identity.json'],controls=index.content['native-v50-controls.json'];
  if(!record.offerings.some(o=>o.baseId===baseId&&o.classId===classId))throw Error('Select an offered base/class from character_options');
  const d=controls.descriptors[baseId];if(!d||d.bodyRevision!==d.sourceSha256||d.faceRevision!==record.sourceSeal)throw Error('Native appearance descriptors differ');
  const appearance={base:'v2-'+d.gender,race:d.race,gender:d.gender,coverage:'outfit',height:0,semantic:{schema:'dq-player-customization-v1',baseId,sourceSha256:d.sourceSha256,bodyRevision:d.bodyRevision,faceRevision:d.faceRevision,body:Object.fromEntries(d.bodyControls.map(c=>[c.id,c.default])),face:Object.fromEntries(d.faceControls.map(c=>[c.id,c.default]))}};
  const body={name,class:classId,appearance,requestId:randomUUID()};savePrivateJson(pending,{at:new Date().toISOString(),body});
  const result=(await this.account.request('/api/characters',{body})).data;fs.rmSync(pending);return result;
 }
 async configure({characterId,glmBaseUrl,glmTokenFile}){
  const roster=await this.account.roster(),c=roster.characters?.find(c=>c.id===characterId);if(!c)throw Error('Choose a character from your authenticated owned roster');
  if(!c.nativeV50)throw Error('Character lacks native V50 identity; use the official character creator');
  const index=await this.index(),starts=index.content['character-starts.json'].destinations;
  const matches=starts.filter(s=>s.raceId===c.appearance?.race&&(!s.faction||s.faction===c.faction));
  const world=!c.pendingFirstArrival&&c.location?.worldId?c.location.worldId:matches.length===1?matches[0].worldId:null;
  if(!world)throw Error('No unique authored arrival or saved world found');
  const r=this.release,zone=r.files[world+'.dqz'],server=r.files[world+'.dqz-server'];if(!zone||!server)throw Error('World is not in this reviewed release');
  const inference={baseUrl:glmBaseUrl,model:GLM_MODEL,decisionSeconds:30,requestsPerHour:120,...(glmTokenFile?{authTokenFile:path.resolve(glmTokenFile)}:{})};
  // Validate endpoint, credentials and exact model availability before enabling play.
  const glm=new GlmClient(inference,path.join(this.root,'.local/state'));const catalog=await glm.request('/models');if(!catalog.data?.some(m=>m.id===GLM_MODEL))throw Error('Pinned GLM model unavailable');
  const config=validateConfig({origin:GAME_ORIGIN,socketOrigin:'wss://api.degenquest.ai',cookieFile:'game-cookies.txt',signerFile:'bot-signer.json',walletAddress:this.account.wallet().address,characterId,world,realm:roster.realm,contentLockSha256:r.contentLockSha256,nativeSession:{schema:'dq-native-content-session-v1',catalogSha256:r.prealphaRelease.releaseSha256,titlePackHash:r.titleHash,gameVersion:r.gameVersion,worldId:world,presentationPackHash:zone.packHash,serverPackHash:server.packHash},stateDirectory:'../.local/state',runSeconds:1800,inference,feedback:{enabled:false}});
  const zi=await this.index(world),record=zi.content?.['world.json']?.physics?.staticCollision,asset=zi.assets?.[record?.asset];if(!asset)throw Error('World has no public navigation collision');
  const response=await this.fetch(`${GAME_ORIGIN}/content/packs/${world}/asset?name=${encodeURIComponent(record.asset)}&sha256=${asset.sha256}&release=${r.contentLockSha256}`,{redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Navigation download failed');
  const bytes=Buffer.from(await response.arrayBuffer());decodeNavigationCollision(bytes,zi,config);
  const directory=path.join(this.root,'.local/state/navigation',world);fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.writeFileSync(path.join(directory,'collision.bin'),bytes,{mode:0o600});saveJson(path.join(directory,'index.json'),zi);
  savePrivateJson(path.join(this.root,'.secrets/player.local.json'),config);
  // Fresh installs wait for an explicit Start. Reconfiguration never clears Stop.
  const halt=path.join(this.root,'.local/state/service.halt');fs.writeFileSync(halt,'Ready; waiting for Start\n',{flag:'a',mode:0o600});
  return{configured:true,character:{id:c.id,name:c.name,class:c.class},world,realm:roster.realm,model:GLM_MODEL,next:'Open the desktop app and press Start'};
 }
}
