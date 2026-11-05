import fs from 'node:fs';
import path from 'node:path';
import {Wallet,JsonRpcProvider,Transaction,parseEther,formatEther} from 'ethers';
import {cookieHeader,readPrivateFile} from './session.mjs';
import {loadJson,saveJson,acquireLock} from './durable.mjs';
import {purchaseTransaction} from './admission.mjs';
import {savePrivateJson} from './private-store.mjs';
export const GAME_ORIGIN='https://play.degenquest.ai',CUSTODY_ORIGIN='https://degenquest.ai';
export const loginMessage=nonce=>`Welcome to DegenQuest!\n\nSign this message to authenticate your wallet.\n\nThis request will not trigger a blockchain transaction or cost any gas fees.\n\nNonce: ${nonce}`;
export class Account {
  constructor(root,{fetchImpl=fetch,provider}={}){this.root=root;this.private=path.join(root,'.secrets');this.fetch=fetchImpl;this.provider=provider??new JsonRpcProvider('https://mainnet.base.org',8453,{staticNetwork:true});fs.mkdirSync(this.private,{recursive:true,mode:0o700});}
  walletFile(){return path.join(this.private,'bot-signer.json');}
  wallet(){return new Wallet(JSON.parse(readPrivateFile(this.walletFile())).privateKey);}
  createWallet(){
    const unlock=acquireLock(path.join(this.private,'wallet-creation.lock'));
    try{
    if(fs.existsSync(this.walletFile()))return{address:this.wallet().address,created:false,chain:'Base',chainId:8453};
    const wallet=Wallet.createRandom();savePrivateJson(this.walletFile(),{address:wallet.address,privateKey:wallet.privateKey});
    return{address:wallet.address,created:true,chain:'Base',chainId:8453};
    }finally{unlock();}
  }
  cookieFile(origin=GAME_ORIGIN){if(![GAME_ORIGIN,CUSTODY_ORIGIN].includes(origin))throw Error('Unsupported account origin');return path.join(this.private,origin===GAME_ORIGIN?'game-cookies.txt':'custody-cookies.txt');}
  async request(route,{origin=GAME_ORIGIN,body}={}){
    if(![GAME_ORIGIN,CUSTODY_ORIGIN].includes(origin))throw Error('Unsupported account origin');
    const url=new URL(route,origin);
    const allowed=['/api/account','/api/characters','/api/alpha-access','/api/auth/nonce','/api/auth/verify','/api/alpha-admission/orders','/api/account/name','/api/wallet','/api/wallet/deposit-transaction','/api/wallet/deposits','/api/wallet/withdrawal-challenge','/api/wallet/withdrawals'];
    if(url.origin!==origin||!allowed.includes(url.pathname)&&!/^\/api\/alpha-admission\/orders\/[0-9a-f-]+\/(confirm|progress)$/.test(url.pathname))throw Error('Unsupported account API route');
    const headers={Origin:origin,'Content-Type':'application/json'};
    const file=this.cookieFile(origin);if(fs.existsSync(file)){const cookie=cookieHeader(readPrivateFile(file),origin);if(cookie)headers.Cookie=cookie;}
    const response=await this.fetch(url,{method:body===undefined?'GET':'POST',headers,redirect:'error',signal:AbortSignal.timeout(30000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw Object.assign(Error(`Account HTTP ${response.status}: ${String(data.error??'Request refused').slice(0,300)}`),{status:response.status});
    return{data,response};
  }
  async login(origin=GAME_ORIGIN){
    const wallet=this.wallet(),address=wallet.address;
    const challenge=(await this.request('/api/auth/nonce',{origin,body:{address,chain:'ethereum'}})).data;
    if(typeof challenge.nonce!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(challenge.nonce)||challenge.message!==loginMessage(challenge.nonce))throw Error('Invalid wallet login challenge');
    const signature=await wallet.signMessage(challenge.message);
    const {response}=await this.request('/api/auth/verify',{origin,body:{address,chain:'ethereum',nonce:challenge.nonce,message:challenge.message,signature}});
    const cookie=response.headers.getSetCookie().find(c=>c.startsWith('__Host-dq-session='));
    const match=cookie&&/^__Host-dq-session=([a-f0-9]{64});/i.exec(cookie);
    if(!match||!/;\s*Secure(?:;|$)/i.test(cookie)||!/;\s*HttpOnly(?:;|$)/i.test(cookie))throw Error('No secure native game session granted');
    const age=Math.min(604800,Number(/Max-Age=(\d+)/i.exec(cookie)?.[1]??3600)),expires=Math.floor(Date.now()/1000)+age;
    fs.writeFileSync(this.cookieFile(origin),`# Netscape HTTP Cookie File\n#HttpOnly_${new URL(origin).hostname}\tFALSE\t/\tTRUE\t${expires}\t__Host-dq-session\t${match[1]}\n`,{mode:0o600});fs.chmodSync(this.cookieFile(origin),0o600);
    return{authenticated:true,address,origin,expiresAt:expires*1000};
  }
  async profile(){return(await this.request('/api/account')).data;}
  async roster(){return(await this.request('/api/characters')).data;}
  async access(){return(await this.request('/api/alpha-access?chain=base&address='+this.wallet().address)).data;}
  async funding(){const address=this.wallet().address,balance=await this.provider.getBalance(address);return{address,chain:'Base mainnet',chainId:8453,currency:'ETH',balanceEth:formatEther(balance),purpose:'Fund this wallet with Base ETH for a reviewed access quote and gas. GOLD/DQS deposits are separate.'};}
  async quote(){
    const access=await this.access(),roster=await this.roster();if(access.slots?.available>0||roster.characters?.length)return{purchaseRequired:false,slots:access.slots,characters:roster.characters?.map(c=>({id:c.id,name:c.name,class:c.class})),reason:'Use your existing character or available slot. Extra slots require a separate deliberate purchase.'};
    if(access.status==='disabled')throw Error(access.reason??'Admission is disabled');
    const {order}=(await this.request('/api/alpha-admission/orders',{body:{}})).data;
    purchaseTransaction(order,this.wallet().address);saveJson(path.join(this.private,'admission-order.json'),order);
    return{purchaseRequired:true,orderId:order.id,chainId:order.payment.chainId,contract:order.payment.contract,targetUsdCents:order.payment.quoteV3.targetUsdCents,ethValueWei:order.payment.ethValueWei,priceEth:formatEther(order.payment.ethValueWei),expiresAt:order.payment.expiresAt,transactionHash:order.transactionHash};
  }
  async purchase(maxTotalEth){
    if(typeof maxTotalEth!=='string'||!/^\d+(\.\d{1,18})?$/.test(maxTotalEth)||parseEther(maxTotalEth)<=0n)throw Error('Supply an owner-approved maximum total ETH including gas');
    const unlock=acquireLock(path.join(this.private,'admission-purchase.lock'));
    try{
      const confirmed=loadJson(path.join(this.private,'admission-confirmed.json'),null);if(confirmed)return{admitted:true,alreadyConfirmed:true,transactionHash:confirmed.hash};
      const pendingFile=path.join(this.private,'admission-pending.json'),prior=loadJson(pendingFile,null);
      if(prior)return this.confirm(prior);
      const access=await this.access();if(access.slots?.available>0)return{admitted:true,purchaseSkipped:true,slots:access.slots};
      const order=loadJson(path.join(this.private,'admission-order.json'),null);if(!order)throw Error('Review a fresh quote before purchase');
      if(order.transactionHash)return this.confirm({orderId:order.id,hash:order.transactionHash});
      const wallet=this.wallet().connect(this.provider);
      if(BigInt(await this.provider.send('eth_chainId',[]))!==8453n)throw Error('Wrong payment chain');
      const intent=purchaseTransaction(order,wallet.address),tx=await wallet.populateTransaction(intent);
      const maximum=tx.value+tx.gasLimit*(tx.maxFeePerGas??tx.gasPrice);
      if(maximum>parseEther(maxTotalEth))throw Error('Quote plus maximum gas exceeds the approved budget');
      if(await this.provider.getBalance(wallet.address,'pending')<maximum)throw Error('Insufficient Base ETH for purchase and gas');
      purchaseTransaction(order,wallet.address);
      const raw=await wallet.signTransaction(tx),hash=Transaction.from(raw).hash,pending={orderId:order.id,hash,raw,address:wallet.address,maximumCostWei:maximum.toString()};
      savePrivateJson(pendingFile,pending);
      // The durable exact bytes/hash own recovery. Never sign another payment
      // after an uncertain broadcast or confirmation response.
      await this.provider.broadcastTransaction(raw);
      return this.confirm(pending);
    }finally{unlock();}
  }
  async confirm(pending=loadJson(path.join(this.private,'admission-pending.json'),null)){
    if(!pending)throw Error('No saved pending payment');
    const confirmed=loadJson(path.join(this.private,'admission-confirmed.json'),null);
    if(confirmed?.hash===pending.hash&&confirmed.orderId===pending.orderId)return{admitted:true,alreadyConfirmed:true,transactionHash:confirmed.hash};
    const result=(await this.request(`/api/alpha-admission/orders/${pending.orderId}/confirm`,{body:{transactionHash:pending.hash}})).data;
    if(result.admitted!==true)throw Error('Payment confirmation is pending; retain the same transaction hash');
    const access=await this.access();if(access.slots?.available<1)throw Error('Payment acknowledged but no open slot was confirmed');
    saveJson(path.join(this.private,'admission-confirmed.json'),{orderId:pending.orderId,hash:pending.hash,at:new Date().toISOString(),slots:access.slots});
    return{admitted:true,transactionHash:pending.hash,slots:access.slots};
  }
}
