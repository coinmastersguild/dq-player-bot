import WebSocket from 'ws';
import {PlayerBridge} from './bridge.mjs';
import {redact} from './recording.mjs';

export function validateEndpoint(endpoint, origin, world, socketOrigin) {
  const url = new URL(endpoint);
  const http = new URL(origin);
  const expected = new URL(socketOrigin ?? origin.replace(/^http/, 'ws'));
  if (!['ws:', 'wss:'].includes(expected.protocol) || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (http.protocol === 'https:' && expected.protocol !== 'wss:') ||
      (expected.protocol === 'ws:' && !['127.0.0.1', '[::1]', 'localhost'].includes(expected.hostname))) throw Error('Invalid configured world socket origin');
  const zone = /^\/z\/([a-z0-9][a-z0-9_-]{0,63})\/ws$/.exec(url.pathname);
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/ws' && (!zone || zone[1] !== world))) throw Error('Ticket endpoint must belong to the selected realm origin and world');
  return url.href;
}

export async function checkPlayer(session, config, {includeCharacter=false}={}) {
  const account = await session.request('/api/account');
  const roster = await session.request('/api/characters');
  if (roster.realm !== config.realm) throw Error('Account roster realm does not match selected realm');
  if (!Array.isArray(roster.characters)) throw Error('Invalid account roster');
  const owned = roster.characters.filter(c => c.id === config.characterId);
  if (owned.length !== 1) throw Error('Select an existing character from this account and realm');
  if (owned[0].location?.worldId && owned[0].location.worldId !== config.world) throw Error('Configured world differs from saved character location');
  return {account: {paidAccess: account.paidAccess === true, claimedName: account.claimedName ?? null},
    realm: roster.realm, character: {id: owned[0].id, name: owned[0].name, class: owned[0].class, level: owned[0].level, location: owned[0].location ?? null},
    ...(includeCharacter?{renderCharacter:Object.fromEntries(['id','name','class','level','appearance','nativeV50','v50','equipment','faction','pendingFirstArrival','deity'].filter(k=>owned[0][k]!==undefined).map(k=>[k,owned[0][k]]))}:{})};
}

export async function connectPlayer(session, config, {record = () => {}, WebSocketImpl = WebSocket,observer} = {}) {
  const checked = await checkPlayer(session, config,{includeCharacter:!!observer});
  if (checked.realm !== config.realm) throw Error('Account roster realm does not match selected realm');
  const entryPath = '/api/zone/enter' + (config.contentLockSha256 ? '?release=' + config.contentLockSha256 : '');
  const entry = await session.request(entryPath, {characterId: config.characterId, world: config.world});
  if (entry.worldId !== config.world || typeof entry.ticket !== 'string' || !entry.ticket) throw Error('Invalid ordinary entry response');
  const endpoint = validateEndpoint(entry.endpoint, session.origin, config.world, config.socketOrigin);
  observer?.({kind:'render-entry',data:{characterId:config.characterId,worldId:config.world,realm:config.realm,
    contentLockSha256:config.contentLockSha256,nativeSession:config.nativeSession,
    roster:{realm:checked.realm,characters:[checked.renderCharacter]},character:checked.renderCharacter,
    entry:redact(entry)}});
  const socket = new WebSocketImpl(endpoint, {origin: session.origin, followRedirects: false, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 20000});
  const bridge = new PlayerBridge(config, {record,
    send: message => { if (socket.readyState !== WebSocket.OPEN) throw Error('World socket closed'); socket.send(JSON.stringify(message)); },
    close: () => { socket.close(); const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref(); }});
  socket.on('open', () => socket.send(JSON.stringify({t: 'auth', ticket: entry.ticket})));
  socket.on('message', (data, binary) => {
    if (binary) return bridge.stop('Unexpected binary world frame');
    try {const frame=JSON.parse(data.toString());bridge.receive(frame);if(bridge.phase!=='stopped')observer?.({kind:'render-frame',data:redact(frame)});} catch { bridge.stop('Invalid world JSON frame'); }
  });
  socket.on('error', () => bridge.stop('World socket failed'));
  socket.on('close', () => bridge.stop('World socket closed'));
  return bridge;
}
