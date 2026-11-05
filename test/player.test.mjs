import test from 'node:test';
import assert from 'node:assert/strict';
import {PlayerBridge} from '../src/bridge.mjs';
import {WorldMirror, validateConfig} from '../src/world.mjs';
import {playerAction} from '../src/actions.mjs';
import {PlayerMcp} from '../src/mcp.mjs';
import {config, hello, snap, self, mob, npc} from './fixtures.mjs';

function setup({sendFailure = false, runSeconds = 30} = {}) {
  let now = 1000; const sent = [], recorded = []; let closes = 0;
  const bridge = new PlayerBridge({...config, runSeconds}, {send: m => { if (sendFailure) throw Error('test'); sent.push(m); },
    close: () => { closes++; }, record: (kind, data) => recorded.push({kind, data}), now: () => now,
    setIntervalImpl: () => 1, clearIntervalImpl: () => {}});
  bridge.receive(hello()); bridge.receive(snap());
  const act = (action, commandId = 'test-1', fields = {}) => bridge.act({commandId, generation: bridge.generation, observedTick: bridge.world.tick, action, ...fields});
  return {bridge, sent, recorded, act, advance: ms => { now += ms; }, closes: () => closes};
}

test('main-game sparse records preserve identity/HP but clear expired dynamic state', () => {
  const world = new WorldMirror(); world.apply(snap({ents: [mob({cast: 'fireball', own: 9})]}), 1);
  world.apply(snap({tick: 11, time: 0.55, ents: [{id: 2, x: 1, y: 0, z: 2, f: 1}], self: self({known: undefined})}), 1);
  assert.equal(world.entities.get(2).nm, 'Rat'); assert.equal(world.entities.get(2).hp, 30);
  for (const field of ['cast', 'h', 'own']) assert.equal(world.entities.get(2)[field], undefined);
  assert.equal(world.self.known[0].id, 'strike');
});
test('keep retains entities, missing interest removes them, unknown lite cannot create them', () => {
  const world = new WorldMirror(); world.apply(snap(), 1);
  world.apply(snap({ents: [{id: 99, x: 0, y: 0, z: 0, f: 0}], keep: [2]}), 1);
  assert.deepEqual([...world.entities.keys()].sort(), [1, 2]);
  world.apply(snap({ents: []}), 1); assert.deepEqual([...world.entities.keys()], [1]);
});
test('bad content identity and snapshot-before-hello prevent gameplay', () => {
  const {bridge} = setup(); bridge.receive({...hello(), nativeSession: {...config.nativeSession, gameVersion: '0.0.50'}});
  assert.equal(bridge.phase, 'stopped'); assert.equal(bridge.world.self, null);
  const fresh = new PlayerBridge(config, {send: () => {}, setIntervalImpl: () => 1, clearIntervalImpl: () => {}});
  fresh.receive(snap()); assert.equal(fresh.phase, 'stopped');
});
test('world/realm mismatch, extra identity fields and unsupported feature readiness reject', () => {
  for (const change of [{world: {id: 'freehold'}}, {realm: 'wrong'}, {nativeSession: {...config.nativeSession, extra: 1}}, {features: {voice: true}}]) {
    const bridge = new PlayerBridge(config, {send: () => {}, setIntervalImpl: () => 1, clearIntervalImpl: () => {}});
    bridge.receive({...hello(), ...change}); assert.equal(bridge.phase, 'stopped');
  }
});
test('the real server empty feature registry admits without any fabricated readiness ACK', () => {
  const sent = [];
  const bridge = new PlayerBridge(config, {send: m => sent.push(m), setIntervalImpl: () => 1, clearIntervalImpl: () => {}});
  bridge.receive({...hello(), features: {schema: 'dq-content-features-v1', features: []}});
  bridge.receive(snap());
  assert.equal(bridge.phase, 'playing'); assert.deepEqual(sent, []);
});
test('movement streams ordinary input and stops automatically at its lease', () => {
  const {bridge, sent, act, advance} = setup();
  assert.equal(act({kind: 'move', facing: 0, seconds: 0.5}).status, 'submitted');
  advance(50); bridge.pulse(); advance(450); bridge.pulse();
  assert.deepEqual(sent.map(m => m.mi.f), [true, true, false]);
  assert.deepEqual(sent.map(m => m.seq), [1, 2, 3]);
  assert(sent.every(m => m.t === 'input' && m.movementMode === 'server'));
  assert.equal(bridge.movement, null);
});
test('stale stream stops movement and retires all playable state', () => {
  const {bridge, sent, act, advance, closes} = setup(); act({kind: 'move', facing: 0, seconds: 3});
  advance(2001); bridge.pulse(); assert.equal(bridge.phase, 'stopped'); assert.equal(closes(), 1);
  assert.equal(sent.at(-2).mi.f, false); assert.equal(sent.at(-1).cmd, 'stopattack');
  assert.equal(bridge.observe().self, null);
});
test('death sends a stop; movement can never outlive the run deadline', () => {
  const {bridge, act, sent, advance} = setup({runSeconds: 1});
  act({kind: 'move', facing: 0, seconds: 3}); bridge.receive(snap({tick: 11, self: self({dead: 1})}));
  assert.equal(sent.at(-1).mi.f, false); assert.throws(() => act({kind: 'interact'}, 'dead'), /actor_dead/);
  advance(1000); bridge.pulse(); assert.equal(bridge.phase, 'stopped');
});
test('zone handoff stops without logging its one-use credential or following it', () => {
  const {bridge, recorded} = setup(); bridge.receive({t: 'handoff', e: 'wss://other.test/ws', ticket: 'SECRET'});
  assert.equal(bridge.phase, 'stopped'); assert(!JSON.stringify(recorded).includes('SECRET'));
});
test('stale control and future/stale observations cannot issue commands', () => {
  const {act, sent} = setup();
  assert.throws(() => act({kind: 'interact'}, 'wrong', {generation: 'other'}), /stale_control/);
  for (const observedTick of [11, -31]) assert.throws(() => act({kind: 'interact'}, 'stale', {observedTick}), /stale_observation/);
  assert.equal(sent.length, 0);
});
test('same command ID does not resend; conflicting body is rejected', () => {
  const {act, sent} = setup(); const first = act({kind: 'talk', npcId: 3});
  assert.deepEqual(act({kind: 'talk', npcId: 3}), first); assert.equal(sent.length, 1);
  assert.throws(() => act({kind: 'target', id: 2}), /command_id_conflict/);
  assert.equal(first.outcome, 'unconfirmed');
});
test('unknown sends are retained without a retry and stop the session', () => {
  const {act, bridge} = setup({sendFailure: true});
  const receipt = act({kind: 'talk', npcId: 3}); assert.equal(receipt.status, 'unknown');
  assert.deepEqual(act({kind: 'talk', npcId: 3}, 'test-1', {observedTick: 10}), receipt); assert.equal(bridge.phase, 'stopped');
});
test('combat uses server-observed targets and resolved learned abilities', () => {
  const {bridge, act, sent} = setup(); bridge.receive(snap({self: self({target: 2})}));
  act({kind: 'attack'}, 'attack'); act({kind: 'cast', ability: 'strike'}, 'strike');
  assert.deepEqual(sent.map(s => s.cmd), ['attack', 'cast']);
  assert.throws(() => act({kind: 'cast', ability: 'invented'}, 'invented'), /unavailable/);
  for (const extra of [{own: 4}, {h: 0}, {k: 'player'}, {kg: 1}, {dead: 1}]) {
    bridge.receive(snap({ents: [mob(extra)], self: self({target: 2})}));
    assert.throws(() => playerAction({kind: 'attack'}, bridge.world), /hostile unowned mob/);
  }
});
test('unknown entities, privileged commands, coordinate teleport and long moves reject', () => {
  const {bridge} = setup();
  for (const action of [{kind: 'target', id: 999}, {kind: 'treasury_withdraw'}, {kind: 'pos', x: 9},
    {kind: 'move', facing: 0, seconds: 10}, {kind: 'move', facing: 0, seconds: 1, debug: true}]) {
    assert.throws(() => playerAction(action, bridge.world));
  }
});
test('dialogue choices use current observed enabled authored indices', () => {
  const {bridge, act, sent} = setup();
  bridge.receive({t: 'events', list: [{type: 'dialog', npcId: 3, nodeId: 'greeting', choices: [{idx: 2, enabled: true}, {idx: 3, enabled: false}]}]});
  act({kind: 'choose', npcId: 3, nodeId: 'greeting', idx: 2});
  assert.deepEqual(sent.at(-1), {t: 'cmd', cmd: 'dialogChoice', npcId: 3, nodeId: 'greeting', idx: 2});
  assert.throws(() => playerAction({kind: 'choose', npcId: 3, nodeId: 'greeting', idx: 3}, bridge.world));
  bridge.receive({t: 'events', list: [{type: 'dialogEnd', npcId: 3}]});
  assert.throws(() => playerAction({kind: 'choose', npcId: 3, nodeId: 'greeting', idx: 2}, bridge.world));
});
test('bounded event history reports loss and excludes nested credentials', () => {
  const {bridge} = setup();
  bridge.receive({t: 'events', list: Array.from({length: 300}, (_, i) => ({type: 'log', i, token: 'SECRET', nested: {ticket: 'SECRET'}}))});
  const observation = bridge.observe(); assert.equal(observation.events.length, 256);
  assert.equal(observation.eventsTruncated, true); assert(!JSON.stringify(observation).includes('SECRET'));
  assert.throws(() => bridge.observe(observation.nextEvent + 1));
});
test('command rate limit leaves stop available', () => {
  const {act, sent} = setup(); for (let i = 0; i < 5; i++) act({kind: 'interact'}, `interact-${i}`);
  assert.throws(() => act({kind: 'interact'}, 'sixth'), /rate_limited/);
  act({kind: 'stop'}, 'stop'); assert.equal(sent.at(-1).mi.f, false);
});
test('MCP preserves exact retry envelope as snapshots advance', async () => {
  const {bridge, sent} = setup(); const mcp = new PlayerMcp(bridge, 'LOCAL DOCS');
  const args = {commandId: 'talk', action: {kind: 'talk', npcId: 3}};
  const first = await mcp.call('act', args); bridge.receive(snap({tick: 11, time: 0.55}));
  assert.deepEqual(await mcp.call('act', args), first); assert.equal(sent.length, 1);
  assert.equal(await mcp.call('read_docs'), 'LOCAL DOCS');
  assert.equal((await mcp.call('rules')).knownAbilities[0].id, 'strike');
  assert.equal((await mcp.handle({method: 'tools/list'})).tools.length, 5);
  await assert.rejects(mcp.call('wait', {seconds: 21}));
  const failed = await mcp.handle({method: 'tools/call', params: {name: 'act', arguments: {action: {kind: 'admin'}}}});
  assert.equal(failed.isError, true);
});
test('invalid example pins and unbounded run configurations reject', () => {
  assert.throws(() => validateConfig({...config, runSeconds: 1801}));
  assert.throws(() => validateConfig({...config, nativeSession: {...config.nativeSession, catalogSha256: 'placeholder'}}));
});
