function shape(action, keys) {
  if (Object.keys(action).some(key => !['kind', ...keys].includes(key))) throw Error('Unexpected action field');
}
function entity(id, world) {
  if (!Number.isSafeInteger(id) || !world.entities.has(id) || id === world.self?.id) throw Error('Target is not currently observed');
  return world.entities.get(id);
}
function hostile(id, world) {
  const target = entity(id, world);
  if (target.dead === 1 || target.h !== 1 || target.k !== 'mob' || target.own != null || target.kg === 1) throw Error('Attack requires an observed hostile unowned mob');
  return target;
}

export function playerAction(action, world) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw Error('Expected action object');
  switch (action.kind) {
    case 'move':
      shape(action, ['facing', 'seconds', 'jump']);
      if(action.jump!==undefined&&typeof action.jump!=='boolean')throw Error('Jump must be a boolean');
      if (!Number.isFinite(action.facing) || Math.abs(action.facing) > Math.PI ||
          !Number.isFinite(action.seconds) || action.seconds < 0.1 || action.seconds > 3) throw Error('Move needs facing (-PI..PI) and seconds (0.1..3)');
      return {movement: {facing: action.facing, seconds: action.seconds,...(action.jump?{jump:true}:{})}};
    case 'stop': shape(action, []); return {stop: true};
    case 'target':
      shape(action, ['id']); if (action.id !== null) entity(action.id, world);
      return {wire: {t: 'cmd', cmd: 'target', id: action.id}};
    case 'attack': {
      shape(action, []);
      hostile(world.self.target, world);
      return {wire: {t: 'cmd', cmd: 'attack'}};
    }
    case 'stopattack': shape(action, []); return {wire: {t: 'cmd', cmd: 'stopattack'}};
    case 'cast': {
      shape(action, ['ability']);
      const ability = world.self.known?.find(known => known?.id === action.ability);
      if (typeof action.ability !== 'string' || !ability || ability.travel) throw Error('Ability is unavailable or requires the travel adapter');
      if (ability.requiresTarget && ability.targetType === 'enemy') hostile(world.self.target, world);
      // Legality, resources, range, cooldowns and outcomes remain server-owned.
      return {wire: {t: 'cmd', cmd: 'cast', ability: action.ability}};
    }
    case 'talk':
      shape(action, ['npcId']);
      if (entity(action.npcId, world).k !== 'npc') throw Error('Talk requires an observed NPC');
      return {wire: {t: 'cmd', cmd: 'talk', npcId: action.npcId}};
    case 'interact': shape(action, []); return {wire: {t: 'cmd', cmd: 'interact'}};
    case 'release':
      shape(action, []);
      if (world.self?.dead !== 1) throw Error('Release requires the observed dead player');
      return {wire: {t: 'cmd', cmd: 'release'}};
    case 'accept':
      shape(action, ['quest']);
      if (typeof action.quest !== 'string' || !world.self.qoffers?.some(q => q.id === action.quest)) throw Error('Quest is not currently offered');
      return {wire: {t: 'cmd', cmd: 'accept', quest: action.quest}};
    case 'turnin':
      shape(action, ['quest']);
      if (typeof action.quest !== 'string' || !world.self.qlog?.some(q => q.questId === action.quest && q.state === 'ready')) throw Error('Quest is not observed ready');
      return {wire: {t: 'cmd', cmd: 'turnin', quest: action.quest}};
    case 'choose': {
      shape(action, ['npcId', 'nodeId', 'idx']);
      const dialog = world.dialog;
      entity(action.npcId, world);
      if (!dialog || action.npcId !== dialog.npcId || action.nodeId !== dialog.nodeId ||
          !Number.isSafeInteger(action.idx) || !dialog.choices?.some(c => c.idx === action.idx && c.enabled === true)) throw Error('Choice is not enabled in the current observed dialogue');
      return {wire: {t: 'cmd', cmd: 'dialogChoice', npcId: action.npcId, nodeId: action.nodeId, idx: action.idx}};
    }
    case 'loot':
      shape(action, ['id']);
      if (entity(action.id, world).loot !== 1) throw Error('Target is not observed lootable');
      return {wire: {t: 'cmd', cmd: 'loot', id: action.id}};
    default: throw Error('Unsupported player action');
  }
}
