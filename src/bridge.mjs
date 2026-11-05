import {randomUUID} from 'node:crypto';
import {WorldMirror, validateConfig, validateIdentity} from './world.mjs';
import {playerAction} from './actions.mjs';
import {redact} from './recording.mjs';

export class PlayerBridge {
  constructor(config, {send, close = () => {}, record = () => {}, now = Date.now,
    setIntervalImpl = setInterval, clearIntervalImpl = clearInterval} = {}) {
    this.config = validateConfig(config);
    Object.assign(this, {send, close, record, now, setIntervalImpl, clearIntervalImpl});
    this.generation = randomUUID(); this.world = new WorldMirror(); this.phase = 'connecting';
    this.events = []; this.eventId = 0; this.receipts = new Map(); this.inputSeq = 0; this.actionTimes = [];
    this.startedAt = now(); this.lastSnapshotAt = null; this.movement = null; this.reason = null;
    this.timer = this.setIntervalImpl(() => this.pulse(), 50);
  }
  emit(event) {
    // Record only an explicit non-credential envelope, never raw hello/auth/handoff.
    const entry = redact({sequence: ++this.eventId, ...event});
    if (Buffer.byteLength(JSON.stringify(entry)) > 32768) entry.data = {omitted: 'event exceeds 32 KiB'};
    this.events.push(entry); this.events = this.events.slice(-256);
    if (entry.type === 'game' && entry.data?.type === 'dialog') this.world.dialog = structuredClone(entry.data);
    if (entry.type === 'game' && entry.data?.type === 'dialogEnd') this.world.dialog = null;
    this.record('event', entry);
  }
  receive(message) {
    if (this.phase === 'stopped') return;
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Invalid world message');
      if (message.t === 'hello') {
        if (this.hello) throw Error('Repeated world handshake');
        if (!Number.isSafeInteger(message.pid) || message.pid < 1 || message.world?.id !== this.config.world || message.realm !== this.config.realm) throw Error('Player world/realm handshake mismatch');
        validateIdentity(message.nativeSession, this.config.nativeSession);
        // The server sends a registry envelope even when this world has no
        // features. An empty registry requires no renderer/voice readiness ACK.
        if (message.features && (message.features.schema !== 'dq-content-features-v1' ||
            !Array.isArray(message.features.features) || message.features.features.length > 0)) throw Error('This world requires unsupported feature readiness');
        this.pid = message.pid; this.hello = true; this.phase = 'awaiting-snapshot';
        this.emit({type: 'hello', world: this.config.world, realm: message.realm});
        return;
      }
      if (message.t === 'snap') {
        if (!this.hello) throw Error('Snapshot before authenticated world handshake');
        if (this.world.tick !== undefined && (message.tick < this.world.tick || message.time < this.world.time)) throw Error('World clock regressed');
        this.world.apply(message, this.pid); this.lastSnapshotAt = this.now(); this.phase = 'playing';
        this.record('snapshot', this.world.observation());
        if (this.world.self.dead === 1) this.stopMovement();
        for (const e of message.evs ?? []) this.emit({type: 'game', data: e});
        return;
      }
      if (['handoffPending', 'handoff'].includes(message.t)) {
        this.stop('Zone transition requires the next adapter milestone'); return;
      }
      if (message.t === 'error') { this.emit({type: 'server-error', data: {error: message.error ?? message.message}}); return; }
      if (message.t === 'events' && this.hello && Array.isArray(message.list)) {
        for (const e of message.list) this.emit({type: 'game', data: e});
      }
    } catch (e) { this.stop(e.message); }
  }
  fresh() {
    if (this.phase !== 'playing' || this.lastSnapshotAt === null || this.now() - this.lastSnapshotAt > 2000) throw Error('No fresh playable observation');
    if (this.now() - this.startedAt >= this.config.runSeconds * 1000) throw Error('Run deadline reached');
  }
  observe(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.eventId) throw Error('Invalid event cursor');
    return structuredClone({protocol: 'mad-player-v0.1', generation: this.generation, phase: this.phase,
      reason: this.reason, world: this.config.world, realm: this.config.realm, nativeSession: this.config.nativeSession,
      snapshotAgeMs: this.lastSnapshotAt === null ? null : this.now() - this.lastSnapshotAt,
      ...this.world.observation(), dialog: this.world.dialog ?? null, events: this.events.filter(e => e.sequence > after), nextEvent: this.eventId,
      eventsTruncated: this.events.length > 0 && after < this.events[0].sequence - 1,
      movement: this.movement ? {until: this.movement.until, facing: this.movement.facing} : null});
  }
  act({commandId, generation, observedTick, action}) {
    if (typeof commandId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(commandId)) throw Error('Invalid commandId');
    const body = JSON.stringify({generation, observedTick, action});
    const prior = this.receipts.get(commandId);
    if (prior) {
      if (prior.body !== body) throw Error('command_id_conflict');
      return structuredClone(prior.receipt);
    }
    const stopping = action?.kind === 'stop' || action?.kind === 'stopattack';
    if (generation !== this.generation) throw Error('stale_control');
    if (!stopping) {
      this.fresh();
      if (!Number.isSafeInteger(observedTick) || observedTick > this.world.tick || this.world.tick - observedTick > 40) throw Error('stale_observation');
      if (this.world.self.dead === 1 && action?.kind !== 'release') throw Error('actor_dead');
      if (this.receipts.size >= (this.config.commandLimit ?? 1000)) throw Error('Run command limit reached');
      const now = this.now(); this.actionTimes = this.actionTimes.filter(t => now - t < 1000);
      if (this.actionTimes.length >= 5) throw Error('rate_limited');
      this.actionTimes.push(now);
    } else if (this.phase !== 'playing') throw Error('Player is not connected');
    const intent = playerAction(action, this.world);
    const receipt = {commandId, generation, status: 'submitted', observedTick: this.world.tick,
      outcome: 'unconfirmed', note: 'Socket submission is not server acceptance or an action outcome'};
    // An uncertain send is never automatically retried, even with the same ID.
    this.receipts.set(commandId, {body, receipt});
    try {
      this.record('intent', {commandId, generation, observedTick, action});
      if (intent.stop) this.stopMovement(true);
      else if (intent.movement) {
        this.stopMovement();
        this.movement = {...intent.movement, until: this.now() + intent.movement.seconds * 1000};
        this.input(true, intent.movement.facing,intent.movement.jump===true);
      } else this.send(intent.wire);
    } catch {
      receipt.status = 'unknown'; this.stop('Command transport failed; reconcile observations before another run');
    }
    return structuredClone(receipt);
  }
  input(forward, facing = this.world.self?.f ?? 0, jump = false) {
    this.send({t: 'input', movementMode: 'server', seq: ++this.inputSeq, facing,
      mi: {f: forward, b: false, sl: false, sr: false, tl: false, tr: false, j: jump, dv: false}});
  }
  stopMovement(force = false) {
    const moving = this.movement; this.movement = null;
    if (moving || force) this.input(false, moving?.facing);
  }
  pulse() {
    if (this.phase === 'stopped') return;
    try {
      if (this.now() - this.startedAt >= this.config.runSeconds * 1000) return this.stop('Run deadline reached');
      if (this.phase !== 'playing' && this.now() - this.startedAt > 20000) return this.stop('World handshake timed out');
      if (this.phase === 'playing' && this.now() - this.lastSnapshotAt > 2000) return this.stop('Snapshot stream stalled');
      if (this.movement) {
        if (this.now() >= this.movement.until) this.stopMovement();
        else this.input(true, this.movement.facing,this.movement.jump===true);
      }
    } catch { this.stop('Player transport failed'); }
  }
  stop(reason = 'Operator stopped') {
    if (this.phase === 'stopped') return;
    this.phase = 'stopped'; this.reason = reason; this.clearIntervalImpl(this.timer);
    try { this.stopMovement(true); this.send({t: 'cmd', cmd: 'stopattack'}); } catch { /* server owns disconnect recovery */ }
    this.world = new WorldMirror(); this.lastSnapshotAt = null;
    try { this.emit({type: 'stopped', reason}); } catch { /* recording failure still closes transport */ }
    this.close();
  }
}
