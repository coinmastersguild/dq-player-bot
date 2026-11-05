import fs from 'node:fs';
import path from 'node:path';
import {Wallet} from 'ethers';
import {readPrivateFile, validateOrigin} from './session.mjs';

// Dedicated bot signer is an operator-only port, never a player/model tool.
// This module signs only the configured game's fresh login message. No chain RPC,
// transaction signing, purchases, transfer or generic signing API exists here.
export async function renewLogin(config, {fetchImpl = fetch} = {}) {
  if(config.loginProvider==='agent-wallet'){
    const {renewProtectedLogin}=await import('./protected-login.mjs');
    return renewProtectedLogin(config,{fetchImpl});
  }
  const origin = validateOrigin(config.origin);
  if (origin !== 'https://play.degenquest.ai') throw Error('Automatic login is pinned to the production game');
  if (!config.signerFile || !config.walletAddress || !config.cookieFile) throw Error('Bot login signer is not configured');
  const stored = JSON.parse(readPrivateFile(config.signerFile));
  let signer;
  try { signer = new Wallet(stored.privateKey); } catch { throw Error('Bot login signer is unavailable'); }
  if (signer.address.toLowerCase() !== config.walletAddress.toLowerCase()) throw Error('Bot signer identity mismatch');
  const post = async (route, body) => {
    const response = await fetchImpl(origin + route, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: {Origin: origin, 'Content-Type': 'application/json', 'User-Agent': 'dq-player-bot/0.2.0'}, body: JSON.stringify(body)});
    if (!response.ok) throw Error(`Bot login HTTP ${response.status}`);
    return response;
  };
  const address = signer.address;
  const challenge = await (await post('/api/auth/nonce', {address, chain: 'ethereum'})).json();
  if (typeof challenge.message !== 'string' || challenge.message.length > 4096 || typeof challenge.nonce !== 'string' ||
      !challenge.message.includes(challenge.nonce) || !/DegenQuest/i.test(challenge.message)) throw Error('Invalid game login challenge');
  const signature = await signer.signMessage(challenge.message);
  const verified = await post('/api/auth/verify', {address, chain: 'ethereum', nonce: challenge.nonce, message: challenge.message, signature});
  const cookie = verified.headers.getSetCookie().find(value => value.startsWith('__Host-dq-session='));
  const match = cookie && /^__Host-dq-session=([a-f0-9]{64});/i.exec(cookie);
  if (!match || !/;\s*Secure(?:;|$)/i.test(cookie) || !/;\s*Path=\/(?:;|$)/i.test(cookie)) throw Error('Game did not grant a valid secure session');
  const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(cookie)?.[1] ?? 3600);
  const expires = Math.floor(Date.now()/1000) + Math.min(maxAge, 7*86400);
  fs.mkdirSync(path.dirname(config.cookieFile), {recursive: true, mode: 0o700});
  const temporary = config.cookieFile + '.renew.tmp';
  fs.writeFileSync(temporary, `# Netscape HTTP Cookie File\n#HttpOnly_${new URL(origin).hostname}\tFALSE\t/\tTRUE\t${expires}\t__Host-dq-session\t${match[1]}\n`, {mode: 0o600});
  fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, config.cookieFile);
  return {renewedAt: Date.now(), expiresAt: expires*1000};
}
