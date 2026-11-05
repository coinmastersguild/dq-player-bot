import fs from'node:fs';import path from'node:path';import{execFileSync}from'node:child_process';import{randomUUID}from'node:crypto';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Signature(raw){if(raw.length!==64)throw Error('Invalid protected signature length');let n=BigInt('0x'+raw.toString('hex')),s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}let zeros=0;while(raw[zeros]===0)zeros++;return'1'.repeat(zeros)+s;}
export async function renewProtectedLogin(config,{fetchImpl=fetch,signerImpl}={}){
 if(config.origin!=='https://play.degenquest.ai'||config.loginProvider!=='agent-wallet'||!config.tokenFile||config.cookieFile||!['ethereum','solana'].includes(config.walletChain))throw Error('Configure the pinned protected native login profile');
 const signer=signerImpl??(request=>{try{return JSON.parse(execFileSync('agent-wallet',['request'],{input:JSON.stringify(request),encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30000}));}catch{throw Error('Protected signer unavailable; no key export fallback');}});
 const addresses=signer({operation:'addresses'}).addresses??{},address=config.walletAddress;
 if(typeof address!=='string'||(config.walletChain==='solana'?addresses.solana!==address:!Object.values(addresses).some(a=>typeof a==='string'&&a.toLowerCase()===address.toLowerCase())))throw Error('Wallet is not owned by this protected runtime');
 const post=async(route,body)=>{const r=await fetchImpl(config.origin+route,{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('Protected login HTTP '+r.status);return r;};
 const challenge=await(await post('/api/auth/nonce',{address,chain:config.walletChain})).json();const expected=`Welcome to DegenQuest!\n\nSign this message to authenticate your wallet.\n\nThis request will not trigger a blockchain transaction or cost any gas fees.\n\nNonce: ${challenge.nonce}`;
 if(typeof challenge.nonce!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(challenge.nonce)||challenge.message!==expected)throw Error('Invalid protected login challenge');
 const operation_id='dq-player-login-'+randomUUID();const signature=config.walletChain==='ethereum'?signer({operation:'evm_personal_sign',operation_id,message:expected}).signature:base58Signature(Buffer.from(signer({operation:'solana_sign_message',operation_id,message_base64:Buffer.from(expected).toString('base64')}).signature_base64,'base64'));
 const verified=await post('/api/auth/verify',{...challenge,address,chain:config.walletChain,signature});const cookie=verified.headers.getSetCookie().find(c=>c.startsWith('__Host-dq-session=')),token=cookie&&/^__Host-dq-session=([a-f0-9]{64});/i.exec(cookie)?.[1];
 if(!token||!/;\s*Secure(?:;|$)/i.test(cookie)||!/;\s*HttpOnly(?:;|$)/i.test(cookie)||!/;\s*Path=\/(?:;|$)/i.test(cookie))throw Error('No secure protected native session');
 fs.mkdirSync(path.dirname(config.tokenFile),{recursive:true,mode:0o700});const temporary=config.tokenFile+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,token+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,config.tokenFile);
 return{renewedAt:Date.now(),expiresAt:Date.now()+Math.min(604800,Number(/Max-Age=(\d+)/i.exec(cookie)?.[1]??3600))*1000};
}
