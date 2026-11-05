import fs from 'node:fs';
import path from 'node:path';
import {PlayerSession} from '../src/session.mjs';
import {connectPlayer} from '../src/transport.mjs';
import {validateConfig} from '../src/world.mjs';
const filename = path.resolve(process.argv[2] ?? 'player.production.json');
const config = validateConfig(JSON.parse(fs.readFileSync(filename, 'utf8')));
for (const key of ['cookieFile', 'tokenFile']) if (config[key]) config[key] = path.resolve(path.dirname(filename), config[key]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bridge;
try {
  bridge = await connectPlayer(new PlayerSession(config), config);
  const deadline = Date.now() + 25000;
  while (bridge.phase !== 'playing' && bridge.phase !== 'stopped' && Date.now() < deadline) await sleep(100);
  let result = bridge.observe();
  if (bridge.phase !== 'playing') {
    console.log(JSON.stringify({phase: bridge.phase, reason: bridge.reason, events: result.events})); process.exitCode = 1;
  } else {
    const start = {x: result.self.x, y: result.self.y, z: result.self.z};
    bridge.act({commandId: 'production-first-move', generation: result.generation, observedTick: result.tick,
      action: {kind: 'move', facing: result.self.f, seconds: 0.5}});
    await sleep(1500); result = bridge.observe();
    console.log(JSON.stringify({phase: result.phase, reason: result.reason, world: result.world, characterId: config.characterId,
      start, end: result.self && {x: result.self.x, y: result.self.y, z: result.self.z},
      displacement: result.self && Math.hypot(result.self.x - start.x, result.self.z - start.z),
      knownAbilities: result.self?.known?.map(a => a.id), entities: result.entities?.map(e => ({id: e.id, name: e.nm, kind: e.k, hostile: e.h === 1})),
      events: result.events}));
    if (result.phase !== 'playing') process.exitCode = 1;
  }
} catch (error) { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; }
finally { bridge?.stop('Initial production probe finished'); }
