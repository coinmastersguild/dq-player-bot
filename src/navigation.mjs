const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Small reactive navigator, not a navmesh/pathfinding implementation. */
export class Navigator {
  constructor({tickHz = 20, onDiagnostic = () => {}} = {}) {
    this.tickHz = tickHz;
    this.onDiagnostic = onDiagnostic;
    this.reset();
  }
  reset() {
    this.offset = null;
    this.probe = null;
    this.anchor = null;
    this.moving = false;
    this.recovery = null;
    this.attempts = 0;
    this.blocked = false;
    this.preferredAngle = null;
    this.blockedUntil = 0; this.blockedOrigin = null; this.retries = 0; this.progress = null;
  }
  pause() { this.moving = false; this.anchor = null; this.probe = null; this.progress = null; }
  block(tick, reason) {
    this.blocked = true; this.blockedUntil = tick + this.tickHz * 5;
    this.blockedOrigin = null; this.moving = false;
    this.onDiagnostic({type: 'navigation-blocked', tick, reason, retryAt: this.blockedUntil});
  }
  observe(position, tick) {
    if (!this.moving) { this.anchor = null; return; }
    if (!this.anchor) { this.anchor = {...position, tick}; return; }
    if (distance(position, this.anchor) >= 0.5) {
      this.anchor = {...position, tick};
    }
  }
  escape(tick, heading, reason) {
    if (this.blocked || this.recovery) return;
    if (this.attempts >= 4) {
      this.block(tick, reason);
      return;
    }
    const lateral = this.preferredAngle ?? Math.PI / 2;
    const angles = [lateral, -lateral, lateral * 1.5, -lateral * 1.5];
    const angle = angles[this.attempts++] + (this.retries % 4) * Math.PI / 4;
    this.recovery = {heading: heading + angle, angle, until: tick + this.tickHz * 2};
    this.anchor = null;
    this.onDiagnostic({type: 'navigation-recovery', tick, reason, attempt: this.attempts});
  }
  plan(me, target, tick, {retreat = false} = {}) {
    if (this.blocked) {
      this.blockedOrigin ??= {x: me.x, z: me.z};
      if (tick < this.blockedUntil && distance(me, this.blockedOrigin) < 2) return {facing: me.f || 0, forward: 0};
      this.blocked = false; this.attempts = 0; this.recovery = null; this.anchor = null; this.probe = null;
      this.progress = null; this.retries++;
      this.onDiagnostic({type: 'navigation-retry', tick, cycle: this.retries});
      if (this.offset !== null) this.escape(tick, Math.atan2(target.x - me.x, target.z - me.z) - this.offset + (retreat ? Math.PI : 0), 'retry after bounded pause');
    }
    if (this.offset === null) {
      if (!this.probe) this.probe = {...me, tick, facing: (this.attempts + this.retries) * Math.PI / 2};
      const elapsed = tick - this.probe.tick;
      const moved = distance(me, this.probe);
      if (elapsed >= this.tickHz * 0.3 && moved > 0.15) {
        this.offset = Math.atan2(me.x - this.probe.x, me.z - this.probe.z) - this.probe.facing;
        this.onDiagnostic({type: 'navigation-calibrated', tick, offset: this.offset});
        this.probe = null;
        this.moving = false;
        this.attempts = 0;
        return {facing: me.f || 0, forward: 0};
      }
      if (elapsed > this.tickHz * 1.5) {
        this.probe = null;
        if (++this.attempts >= 4) {
          this.block(tick, 'calibration failed');
        }
        return {facing: me.f || 0, forward: 0};
      }
      this.moving = true;
      return {facing: this.probe.facing, forward: 1};
    }
    const heading = Math.atan2(target.x - me.x, target.z - me.z) - this.offset + (retreat ? Math.PI : 0);
    // Displacement alone misses loops along a wall. Measure approach to a stable goal too.
    if (retreat) this.progress = null;
    else {
      const range = distance(me, target);
      if (!this.progress || this.progress.id !== target.id || distance(target, this.progress.goal) > 4 ||
          range < this.progress.best - 2) {
        if(this.progress?.id===target.id&&range<this.progress.best-2)this.attempts=0;
        this.progress = {id: target.id, goal: {...target}, best: range, tick, failures: 0};
      }
      else if (tick - this.progress.tick >= this.tickHz * 8 && !this.recovery) {
        // Walking in circles must not reset the route-attempt budget merely by moving.
        this.attempts = Math.max(this.attempts, this.progress.failures++);
        this.escape(tick, heading, 'no approach progress'); this.progress.tick = tick;
      }
    }
    this.observe(me, tick);
    if (this.recovery && !this.recovery.origin) {
      this.recovery.origin = {...me}; this.recovery.started = tick;
    }
    if (this.recovery && tick - this.recovery.started >= this.tickHz * 0.6 && distance(me, this.recovery.origin) < 0.2) {
      this.recovery = null; this.anchor = null;
      this.escape(tick, heading, 'escape produced no displacement');
    }
    if (this.recovery && tick >= this.recovery.until) {
      if (this.recovery.origin && distance(me, this.recovery.origin) >= 0.5) this.preferredAngle = Math.sign(this.recovery.angle) * Math.PI / 2;
      this.recovery = null;
      this.anchor = {...me, tick};
    }
    // LOS recovery is triggered once by a server error, not every cooldown frame.
    // Repeating it here consumed all escape attempts even while moving freely.
    if (this.anchor && tick - this.anchor.tick >= this.tickHz * 1.5) this.escape(tick, heading, 'no displacement');
    if (this.blocked) { this.moving = false; return {facing: me.f || 0, forward: 0}; }
    this.moving = true;
    return {facing: this.recovery?.heading ?? heading, forward: 1};
  }
}
