import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {connectPlayer} from '../src/transport.mjs';
import {PlayerSession} from '../src/session.mjs';
import {PlayerMcp} from '../src/mcp.mjs';
import {config, hello, snap, self} from './fixtures.mjs';

test('loopback ordinary entry, auth, observe, move/stop, target and damage event', async t => {
  const calls = [], commands = [], recorded = [];
  let resolveStop, peer;
  const stopped = new Promise(resolve => { resolveStop = resolve; });
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push({method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined});
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/account') return res.end(JSON.stringify({paidAccess: true, claimedName: 'Fixture'}));
    if (req.url === '/api/characters') return res.end(JSON.stringify({realm: config.realm, characters: [{id: 7, name: 'Fixture', location: {worldId: 'coinfall'}}]}));
    if (req.url === '/api/zone/enter') return res.end(JSON.stringify({worldId: 'coinfall', endpoint: `ws://127.0.0.1:${server.address().port}/ws`, ticket: 'FIXTURE-TICKET'}));
    res.statusCode = 404; res.end('{}');
  });
  const wss = new WebSocketServer({server});
  wss.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); commands.push(message);
      if (message.t === 'auth') {
        socket.send(JSON.stringify(hello())); socket.send(JSON.stringify(snap()));
      }
      if (message.t === 'input' && message.mi.f === false) resolveStop();
      if (message.cmd === 'target') socket.send(JSON.stringify(snap({tick: 11, time: 0.55, self: self({target: 2})})));
      if (message.cmd === 'attack') socket.send(JSON.stringify({t: 'events', list: [{type: 'damage', sourceId: 1, targetId: 2, amount: 5}]}));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = new PlayerSession({origin, tokenFile: '/unused-test-session'});
  session.headers = () => ({Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer FIXTURE'});
  const bridge = await connectPlayer(session, {...config, origin}, {record: (kind, data) => recorded.push({kind, data})});
  t.after(() => bridge.stop('Test finished'));
  async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > deadline) throw Error('Loopback fixture timed out'); await new Promise(r => setTimeout(r, 5)); }
  }
  await until(() => bridge.phase === 'playing');
  assert.deepEqual(calls, [
    {method: 'GET', path: '/api/account', body: undefined},
    {method: 'GET', path: '/api/characters', body: undefined},
    {method: 'POST', path: '/api/zone/enter', body: {characterId: 7, world: 'coinfall'}}
  ]);
  assert.deepEqual(commands[0], {t: 'auth', ticket: 'FIXTURE-TICKET'});
  const mcp = new PlayerMcp(bridge, 'LOCAL');
  await mcp.call('act', {action: {kind: 'move', facing: 0, seconds: 0.1}});
  await Promise.race([stopped, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Missing movement stop')), 2000); timer.unref(); })]);
  assert(commands.some(c => c.t === 'input' && c.mi.f === true));
  await mcp.call('act', {action: {kind: 'target', id: 2}}); await until(() => bridge.world.self.target === 2);
  const receipt = await mcp.call('act', {action: {kind: 'attack'}}); assert.equal(receipt.outcome, 'unconfirmed');
  await until(() => bridge.events.some(e => e.data?.type === 'damage'));
  assert((await mcp.call('observe')).events.some(e => e.data?.amount === 5));
  assert(!JSON.stringify(recorded).includes('FIXTURE-TICKET'));
  peer.close(); await until(() => bridge.phase === 'stopped');
  assert.equal(bridge.observe().self, null);
});
