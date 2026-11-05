const IDENTITY = ['k', 'tid', 'nm', 'lv', 'fac', 'kg', 'obj', 'cpo', 'rk'];
const DYNAMIC = ['x', 'y', 'z', 'f', 'hp', 'mhp', 'dead', 'ic', 'cast', 'castEnd', 'castTot', 'chan', 'auras', 'h', 'tgt', 'aggro', 'loot', 'lootList', 'tap', 'own'];
const SELF_EXTRAS = ['known', 'res', 'mres', 'rtype', 'cds', 'gcdEnd', 'target', 'inv', 'bag', 'eqs', 'equip', 'xp', 'nxp', 'qlog', 'qoffers', 'qtargets', 'qview', 'qdone', 'qmarks', 'corpses', 'auto', 'ack', 'pe'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const pose = wire => wire && Number.isSafeInteger(wire.id) && ['x', 'y', 'z', 'f'].every(k => finite(wire[k]));

// The main game uses full/lite/keep/interest-removal, not Arena replacement rows.
export class WorldMirror {
  constructor() { this.entities = new Map(); this.self = null; this.revision = 0; }
  apply(message, pid) {
    if (!Array.isArray(message.ents) || !pose(message.self) || message.self.id !== pid ||
        !Number.isSafeInteger(message.tick) || !finite(message.time)) throw Error('Invalid player snapshot');
    const next = new Map();
    for (const id of message.keep ?? []) if (Number.isSafeInteger(id) && this.entities.has(id)) next.set(id, this.entities.get(id));
    for (const wire of [...message.ents, message.self]) {
      if (!pose(wire)) continue;
      const old = this.entities.get(wire.id);
      if (!old && typeof wire.k !== 'string') continue;
      const entity = {};
      for (const key of IDENTITY) if (old?.[key] !== undefined) entity[key] = old[key];
      if (typeof wire.k === 'string') for (const key of IDENTITY) if (wire[key] !== undefined) entity[key] = structuredClone(wire[key]);
      entity.id = wire.id;
      for (const key of DYNAMIC) if (wire[key] !== undefined) entity[key] = structuredClone(wire[key]);
      if (wire.id === pid) for (const key of SELF_EXTRAS) {
        if (wire[key] !== undefined) entity[key] = structuredClone(wire[key]);
        else if (this.self?.[key] !== undefined) entity[key] = structuredClone(this.self[key]);
      }
      // HP is sparse; transient cast/hostile/loot state is cleared on absence.
      for (const key of ['hp', 'mhp']) if (entity[key] === undefined && old?.[key] !== undefined) entity[key] = old[key];
      next.set(wire.id, entity);
    }
    if (!next.has(pid)) throw Error('Player identity is missing from snapshot');
    this.entities = next; this.self = next.get(pid); this.tick = message.tick; this.time = message.time; this.revision++;
  }
  observation() { return {revision: this.revision, tick: this.tick, time: this.time, self: this.self, entities: [...this.entities.values()].filter(e => e.id !== this.self?.id)}; }
}

export function validateIdentity(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, pin]) => value[key] !== pin)) throw Error('World content identity mismatch');
}

export function validateConfig(config) {
  if (config.contentLockSha256 !== undefined && !/^[a-f0-9]{64}$/.test(config.contentLockSha256)) throw Error('Invalid configured content lock');
  if (!Number.isSafeInteger(config.characterId) || config.characterId < 1 ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.world ?? '') || typeof config.realm !== 'string' || !config.realm ||
      !Number.isInteger(config.runSeconds) || config.runSeconds < 1 || config.runSeconds > 1800) throw Error('Configure characterId, world, realm and runSeconds (1..1800)');
  const s = config.nativeSession;
  if (!s || Object.keys(s).sort().join(',') !== 'catalogSha256,gameVersion,presentationPackHash,schema,serverPackHash,titlePackHash,worldId' ||
      s.schema !== 'dq-native-content-session-v1' || s.worldId !== config.world ||
      !/^\d+\.\d+\.\d+$/.test(s.gameVersion ?? '') ||
      !['catalogSha256', 'titlePackHash', 'presentationPackHash', 'serverPackHash'].every(k => /^[a-f0-9]{64}$/.test(s[k] ?? ''))) {
    throw Error('Configure the exact trusted seven-field nativeSession identity');
  }
  return config;
}
