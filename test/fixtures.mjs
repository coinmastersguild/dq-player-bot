export const config = {
  origin: 'http://127.0.0.1:17987', characterId: 7, world: 'coinfall', realm: 'test-realm', runSeconds: 30,
  nativeSession: {schema: 'dq-native-content-session-v1', catalogSha256: 'a'.repeat(64), titlePackHash: 'b'.repeat(64),
    gameVersion: '0.0.55', worldId: 'coinfall', presentationPackHash: 'c'.repeat(64), serverPackHash: 'd'.repeat(64)}
};
export const hello = () => ({t: 'hello', pid: 1, realm: config.realm, world: {id: 'coinfall'}, nativeSession: {...config.nativeSession}, ticket: 'TEST-RESUME-TICKET'});
export const self = (extra = {}) => ({id: 1, k: 'player', tid: 'warrior', x: 0, y: 0, z: 0, f: 0, hp: 100, mhp: 100,
  known: [{id: 'strike', requiresTarget: true, targetType: 'enemy', range: 3, cost: 10}], ...extra});
export const mob = (extra = {}) => ({id: 2, k: 'mob', tid: 'rat', nm: 'Rat', lv: 1, x: 0, y: 0, z: 2, f: 0, hp: 30, mhp: 30, h: 1, ...extra});
export const npc = () => ({id: 3, k: 'npc', tid: 'innkeeper', nm: 'Innkeeper', x: 3, y: 0, z: 0, f: 0, hp: 100});
export const snap = (extra = {}) => ({t: 'snap', tick: 10, time: 0.5, ents: [mob(), npc()], self: self(), ...extra});
