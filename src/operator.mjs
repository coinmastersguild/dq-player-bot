import fs from 'node:fs';import path from 'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';import{createHash}from'node:crypto';import{Account,CUSTODY_ORIGIN}from'./account.mjs';import{Onboarding}from'./onboarding.mjs';
const execute=promisify(execFile),object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false}),string={type:'string'};
export const operatorTools=[
 {name:'read_docs',description:'Read onboarding, contracts and funding documentation.',inputSchema:object({document:{enum:['README.md','docs/CLAUDE.md','docs/FUNDING.md','docs/CONTRACTS.md','docs/RUNTIME.md']}})},
 {name:'create_wallet',description:'Create or reuse an owner-only dedicated Base wallet. Returns only its public address. Never prints a key.',inputSchema:object()},
 {name:'authenticate',description:'Sign the official fresh DegenQuest login challenge with the dedicated wallet. This is not a payment.',inputSchema:object()},
 {name:'account_status',description:'Read your authenticated account, owned roster and admission slots.',inputSchema:object()},
 {name:'funding_address',description:'Show your bot wallet address and Base ETH balance. Does not move funds.',inputSchema:object()},
 {name:'admission_quote',description:'Review a fresh signed Base admission quote. Existing characters or slots skip purchase. Does not spend.',inputSchema:object()},
 {name:'purchase_access',description:'Spend only after the OWNER explicitly approved this quote and maximum TOTAL ETH including gas. Never infer permission from a gameplay objective. Retries reconcile the existing hash.',inputSchema:object({maxTotalEth:string,ownerApproved:{const:true}},['maxTotalEth','ownerApproved'])},
 {name:'recover_payment',description:'Confirm the saved exact admission payment hash without signing another transaction.',inputSchema:object()},
 {name:'claim_name',description:'Claim the owner-selected 3–24 character account name.',inputSchema:object({name:string},['name'])},
 {name:'character_options',description:'Read native character choices from the verified released title pack.',inputSchema:object()},
 {name:'create_character',description:'Create one owner-selected ordinary hero using available paid slots. Reconcile an uncertain result by reading the roster.',inputSchema:object({name:string,baseId:string,classId:string},['name'])},
 {name:'configure_bot',description:'Bind one owned character, verified release and available pinned GLM endpoint. Downloads verified public navigation. Leaves Stop selected.',inputSchema:object({characterId:{type:'integer',minimum:1},glmBaseUrl:string,glmTokenFile:string},['characterId','glmBaseUrl'])},
 {name:'open_app',description:'Open the locally built macOS desktop viewer. Does not create another game socket.',inputSchema:object()},
 {name:'bot_status',description:'Observe the existing local controller and GLM runtime. Does not log into another player session.',inputSchema:object()},
 {name:'start_bot',description:'Start/resume the configured GLM player through its existing local controller.',inputSchema:object()},
 {name:'stop_bot',description:'Stop gameplay and persist Stop through restarts.',inputSchema:object()},
 {name:'custody_status',description:'Authenticate separately at the official token service and read linked wallets, live custody configuration, balances and readiness. No token transfers or withdrawals.',inputSchema:object()}
];
export class Operator{
 constructor(root,{account=new Account(root),onboarding}={}){this.root=root;this.account=account;this.onboarding=onboarding??new Onboarding(root,{account});this.instanceId=createHash('sha256').update(root).digest('hex').slice(0,24);this.url=`http://127.0.0.1:${process.env.DQ_CONSOLE_PORT??4783}`;}
 async state(){const response=await fetch(this.url+'/api/state',{signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error('Local controller unavailable');const state=await response.json();if(state.runtime?.instanceId!==this.instanceId)throw Error('The local port belongs to a different bot checkout. Use that app or stop its controller before switching.');return state;}
 async control(action){const s=await this.state(),r=await fetch(this.url+'/api/control',{method:'POST',headers:{Origin:this.url,'Content-Type':'application/json','X-Console-Token':s.csrfToken},body:JSON.stringify({action}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Control not confirmed; read status before retrying');return r.json();}
 async call(name,args={}){
  if(!operatorTools.some(t=>t.name===name))throw Error('Unknown operator tool');
  if(name==='read_docs'){const document=args.document??'README.md';if(!operatorTools[0].inputSchema.properties.document.enum.includes(document))throw Error('Unknown document');return fs.readFileSync(path.join(this.root,document),'utf8');}
  if(name==='create_wallet')return this.account.createWallet();
  if(name==='authenticate')return this.account.login();
  if(name==='account_status')return{account:await this.account.profile(),roster:await this.account.roster(),access:await this.account.access()};
  if(name==='funding_address')return this.account.funding();
  if(name==='admission_quote')return this.account.quote();
  if(name==='purchase_access'){if(args.ownerApproved!==true)throw Error('Explicit owner budget approval is required');return this.account.purchase(args.maxTotalEth);}
  if(name==='recover_payment')return this.account.confirm();
  if(name==='claim_name')return this.onboarding.claimName(args.name);
  if(name==='character_options')return this.onboarding.options();
  if(name==='create_character')return this.onboarding.createCharacter(args);
  if(name==='configure_bot')return this.onboarding.configure(args);
  if(name==='open_app'){if(process.platform!=='darwin')throw Error('Native viewer requires macOS');const app=path.join(this.root,'DegenQuest Bot.app');if(!fs.existsSync(path.join(app,'Contents/MacOS/DegenQuestBot')))throw Error('Run npm run bootstrap first');await execute('open',[app]);return{opened:true,url:this.url};}
  if(name==='bot_status'){const s=await this.state();delete s.csrfToken;return s;}
  if(name==='start_bot')return this.control('start');
  if(name==='stop_bot')return this.control('stop');
  if(name==='custody_status'){await this.account.login(CUSTODY_ORIGIN);return(await this.account.request('/api/wallet',{origin:CUSTODY_ORIGIN})).data;}
 }
 async handle(message){
  if(message.method==='initialize')return{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'dq-player-operator',version:'0.4.0'}};
  if(message.method==='ping')return{};
  if(message.method==='tools/list')return{tools:operatorTools};
  if(message.method==='tools/call'){try{const value=await this.call(message.params.name,message.params.arguments??{});return{content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]};}catch(e){return{isError:true,content:[{type:'text',text:e.message}]};}}
  throw Error('Method not found');
 }
}
