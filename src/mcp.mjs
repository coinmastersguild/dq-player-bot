import {randomUUID} from 'node:crypto';
import {redact} from './recording.mjs';
const object = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const action = {oneOf: [
  object({kind: {const: 'move'}, facing: {type: 'number', minimum: -Math.PI, maximum: Math.PI}, seconds: {type: 'number', minimum: 0.1, maximum: 3},jump:{type:'boolean'}}, ['kind', 'facing', 'seconds']),
  ...['stop', 'attack', 'stopattack', 'interact', 'release'].map(kind => object({kind: {const: kind}}, ['kind'])),
  ...['accept','turnin'].map(kind=>object({kind:{const:kind},quest:{type:'string'}},['kind','quest'])),
  object({kind: {const: 'target'}, id: {type: ['integer', 'null']}}, ['kind', 'id']),
  object({kind: {const: 'cast'}, ability: {type: 'string'}}, ['kind', 'ability']),
  object({kind: {const: 'talk'}, npcId: {type: 'integer'}}, ['kind', 'npcId']),
  object({kind: {const: 'choose'}, npcId: {type: 'integer'}, nodeId: {type: 'string'}, idx: {type: 'integer'}}, ['kind', 'npcId', 'nodeId', 'idx']),
  object({kind: {const: 'loot'}, id: {type: 'integer'}}, ['kind', 'id'])
]};
export const playerTools = [
  {name: 'read_docs', description: 'Read the local MAD player adapter contract and limitations.', inputSchema: object()},
  {name: 'rules', description: 'List supported main-game actions and the observed learned abilities. Does not invent a spell catalog.', inputSchema: object()},
  {name: 'observe', description: 'Observe your ordinary character, current interest entities, server events and connection health.', inputSchema: object()},
  {name: 'act', description: 'Submit one ordinary player intent. A submitted receipt is not a confirmed outcome. Movement stops automatically within 3 seconds.', inputSchema: object({action, commandId: {type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$'}}, ['action'])},
  {name: 'wait', description: 'Wait 1..20 seconds and observe; simulation and movement deadlines continue.', inputSchema: object({seconds: {type: 'number', minimum: 1, maximum: 20}}, ['seconds'])}
];

export class PlayerMcp {
  constructor(bridge, docs, {sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
    Object.assign(this, {bridge, docs, sleep}); this.cursor = 0; this.envelopes = new Map();
  }
  observe() {
    const observation = this.bridge.observe(this.cursor); this.cursor = observation.nextEvent;
    return redact(observation);
  }
  async call(name, args = {}) {
    if (name === 'read_docs') return this.docs;
    if (name === 'rules') return {protocol: 'mad-player-v0.1', actions: action,
      knownAbilities: this.bridge.world.self?.known ?? [], spellDefinitions: 'Resolved ability details come from self.known; legality and effects remain authoritative on the realm',
      receipts: 'submitted/unknown only; no durable server receipt or automatic command replay'};
    if (name === 'observe') return this.observe();
    if (name === 'wait') {
      if (!Number.isFinite(args.seconds) || args.seconds < 1 || args.seconds > 20) throw Error('seconds must be 1..20');
      await this.sleep(args.seconds * 1000); return this.observe();
    }
    if (name === 'act') {
      const observation = this.bridge.observe();
      const commandId = args.commandId ?? randomUUID();
      const prior = this.envelopes.get(commandId);
      if (prior && JSON.stringify(prior.action) !== JSON.stringify(args.action)) throw Error('command_id_conflict');
      if (!prior && this.envelopes.size >= 1000) throw Error('Run command limit reached');
      const envelope = prior ?? {commandId, generation: observation.generation, observedTick: observation.tick, action: structuredClone(args.action)};
      this.envelopes.set(commandId, envelope);
      return this.bridge.act(envelope);
    }
    throw Error('Unknown player tool');
  }
  async handle(message) {
    if (message.method === 'initialize') return {protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'dq-mad-player', version: '0.1.0'}};
    if (message.method === 'ping') return {};
    if (message.method === 'tools/list') return {tools: playerTools};
    if (message.method === 'tools/call') {
      try {
        const result = await this.call(message.params.name, message.params.arguments ?? {});
        return {content: [{type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result)}]};
      } catch (e) { return {isError: true, content: [{type: 'text', text: e.message}]}; }
    }
    throw Error('Method not found');
  }
}
