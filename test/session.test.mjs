import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PlayerSession, cookieHeader, validateOrigin, readPrivateFile} from '../src/session.mjs';
import {validateEndpoint, checkPlayer} from '../src/transport.mjs';
import {config} from './fixtures.mjs';

test('cookie selection respects domain, expiry, HTTPS and HttpOnly prefix', () => {
  const jar = '#HttpOnly_.example.test\tTRUE\t/\tTRUE\t0\tsession\ttest-value\n' +
    'evil.test\tFALSE\t/\tFALSE\t0\tsession\tother\n' +
    'example.test\tFALSE\t/\tTRUE\t1\texpired\told';
  assert.equal(cookieHeader(jar, 'https://play.example.test'), 'session=test-value');
  assert.equal(cookieHeader(jar, 'http://play.example.test'), '');
});
test('only HTTPS or explicit loopback origins and matching world sockets are allowed', () => {
  assert.equal(validateOrigin('http://127.0.0.1:17987'), config.origin);
  for (const origin of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path']) assert.throws(() => validateOrigin(origin));
  assert.equal(validateEndpoint('ws://127.0.0.1:17987/z/coinfall/ws', config.origin, 'coinfall'), 'ws://127.0.0.1:17987/z/coinfall/ws');
  for (const endpoint of ['ws://evil.test/ws', 'ws://127.0.0.1:17987/z/freehold/ws', 'ws://127.0.0.1:17987/ws?ticket=secret']) {
    assert.throws(() => validateEndpoint(endpoint, config.origin, 'coinfall'));
  }
  assert.equal(validateEndpoint('wss://api.degenquest.ai/z/coinfall/ws', 'https://play.degenquest.ai', 'coinfall', 'wss://api.degenquest.ai'), 'wss://api.degenquest.ai/z/coinfall/ws');
  assert.throws(() => validateEndpoint('wss://evil.test/ws', 'https://play.degenquest.ai', 'coinfall', 'wss://api.degenquest.ai'));
  assert.throws(() => validateEndpoint('ws://api.degenquest.ai/ws', 'https://play.degenquest.ai', 'coinfall', 'ws://api.degenquest.ai'));
});
test('HTTP adapter never sends credentials to arbitrary paths or replays entry', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-player-session-')); t.after(() => fs.rmSync(dir, {recursive: true}));
  const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, 'a'.repeat(64), {mode: 0o600});
  const requests = [];
  const session = new PlayerSession({origin: config.origin, tokenFile, fetchImpl: async (url, options) => {
    requests.push({url, options}); return {ok: true, json: async () => ({realm: 'test'})};
  }});
  await session.request('/api/account');
  assert.equal(requests[0].options.redirect, 'error'); assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
  for (const route of ['//evil.test/api/account', '/api/wallet', '/api/crypto-admin']) await assert.rejects(session.request(route));
  await assert.rejects(session.request('/api/zone/enter', {characterId: 7, world: 'coinfall', debug: true}));
  assert.equal(requests.length, 1);
  await session.request('/api/zone/enter?release=' + 'b'.repeat(64), {characterId: 7, world: 'coinfall'});
  assert.equal(requests[1].options.body, JSON.stringify({characterId: 7, world: 'coinfall'}));
  await assert.rejects(session.request('/api/zone/enter?debug=true', {characterId: 7, world: 'coinfall'}));
  session.fetch = async () => { requests.push({}); throw Error('lost response'); };
  await assert.rejects(session.request('/api/zone/enter', {characterId: 7, world: 'coinfall'}), /no automatic replay/);
  assert.equal(requests.length, 3);
  fs.chmodSync(tokenFile, 0o644); assert.throws(() => readPrivateFile(tokenFile), /owner-only/);
});
test('roster authority and saved location are checked before entry', async () => {
  const responses = {'/api/account': {paidAccess: true}, '/api/characters': {realm: config.realm, characters: [{id: 7, name: 'Player', location: {worldId: 'coinfall'}}]}};
  const requests = []; const session = {request: async route => { requests.push(route); return responses[route]; }};
  assert.equal((await checkPlayer(session, config)).character.id, 7);
  assert.deepEqual(requests, ['/api/account', '/api/characters']);
  responses['/api/characters'].characters[0].location.worldId = 'freehold'; await assert.rejects(checkPlayer(session, config), /saved character/);
  responses['/api/characters'].characters = []; await assert.rejects(checkPlayer(session, config), /existing character/);
});
