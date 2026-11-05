import {randomUUID} from 'node:crypto';
import {Navigator} from './navigation.mjs';
import {readyQuestForNpc} from './quests.mjs';
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const angle = value => Math.atan2(Math.sin(value), Math.cos(value));

export class PlayerExecutor {
  constructor(bridge, {now = Date.now, diagnostic = () => {}, router = null, blockedGoals = []} = {}) {
    Object.assign(this, {bridge, now, diagnostic, router});
    this.nav = new Navigator({onDiagnostic: diagnostic}); this.lastAction = 0; this.lastInteract = 0; this.goal = null;
    this.visited = []; this.history = []; this.nextCastAt = 0; this.lastDeathRelease = 0;
    this.blockedGoals=(Array.isArray(blockedGoals)?blockedGoals:[]).filter(g=>Number.isFinite(g.until)&&g.until>now()&&g.until<now()+300001&&Number.isFinite(g.origin?.x)&&Number.isFinite(g.origin?.z));
    this.route=null;this.routeRequest=null;this.routeGeneration=0;this.probe=null;this.probeUsed=false;
  }
  goalKey(goal){return goal.kind+':'+(goal.targetId??Math.round((goal.heading??0)*8));}
  avoidGoals(){this.blockedGoals=this.blockedGoals.filter(g=>g.until>this.now()).slice(-30);return this.blockedGoals;}
  install(plan) {
    const key=this.goalKey(plan.goal),self=this.bridge.world.self;
    if(this.avoidGoals().some(g=>g.key===key&&distance(self,g.origin)<12))throw Error('GLM selected a recently unreachable goal');
    const changed=!this.goal||this.goalKey(this.goal)!==key||this.goal.expiresAt<=this.now();
    if(changed){this.route=null;this.probe=null;this.probeUsed=false;this.routeGeneration++;this.nav.reset();}
    this.goal = {...plan.goal, at: this.now(), expiresAt: this.now() + 120000}; this.priority = plan.abilityPriority;
    if (plan.goal.kind === 'explore' && changed) {
      this.destination = {id: -1, x: self.x + Math.sin(plan.goal.heading) * 45, y:self.y, z: self.z + Math.cos(plan.goal.heading) * 45};
    }
    this.history.push({at: this.now(), goal: plan.goal, rationale: plan.rationale}); this.history = this.history.slice(-12);
  }
  act(action) {
    if (this.now() - this.lastAction < 300) return false;
    const o = this.bridge.observe();
    try {
      const receipt = this.bridge.act({commandId: randomUUID(), generation: o.generation, observedTick: o.tick, action});
      this.lastAction = this.now(); return receipt.status === 'submitted';
    } catch (error) { this.diagnostic({type: 'local-action-rejection', action: action.kind, reason: error.message}); return false; }
  }
  stopMoving() { if (this.bridge.movement) this.act({kind: 'stop'}); this.nav.pause(); }
  finishRoute(){if(this.route||this.routeRequest||this.probe){this.route=null;this.probe=null;this.routeGeneration++;}}
  abandon(reason,target){
    if(!this.goal||this.goal.expiresAt===0)return;
    const entry={key:this.goalKey(this.goal),kind:this.goal.kind,targetId:this.goal.targetId,heading:this.goal.heading,origin:{x:this.bridge.world.self.x,z:this.bridge.world.self.z},until:this.now()+300000,reason};
    this.blockedGoals.push(entry);this.routeGeneration++;this.route=null;this.probe=null;this.goal.expiresAt=0;this.stopMoving();
    this.diagnostic({type:'navigation-blocked',reason,targetId:target?.id,goalKey:entry.key,cooldownUntil:entry.until});
  }
  meshWalk(target){
    const me=this.bridge.world.self;
    const avoid=[...this.bridge.world.entities.values()].filter(e=>e.k==='mob'&&e.h===1&&e.dead!==1&&e.lv>(me.lv??1)+2&&e.own==null&&Math.abs(e.y-me.y)<4&&distance(e,me)<72).map(e=>({id:e.id,x:e.x,y:e.y,z:e.z,radius:24}));
    const avoidKey=avoid.map(e=>e.id+':'+Math.round(e.x/6)+':'+Math.round(e.z/6)).sort().join(',');
    const next=this.route?.points[this.route.index];
    if(next&&avoid.some(zone=>{
      const dx=next.x-me.x,dz=next.z-me.z,length2=dx*dx+dz*dz,t=length2?Math.max(0,Math.min(1,((zone.x-me.x)*dx+(zone.z-me.z)*dz)/length2)):0;
      const closest=Math.hypot(zone.x-me.x-t*dx,zone.z-me.z-t*dz),start=distance(zone,me),end=distance(zone,next);
      if(start<24&&end>start+1&&closest>=start-.5)return false;
      return closest<22;
    })){this.route=null;this.routeGeneration++;}
    if(this.route&&distance(target,this.route.target)>4){this.route=null;this.routeGeneration++;}
    if(!this.route){
      this.stopMoving();
      if(this.routeRequest)return;
      const generation=this.routeGeneration,from={...this.bridge.world.self},requested={...target};
      this.diagnostic({type:'navigation-route-planning',targetId:target.id});
      this.routeRequest=this.router.route(from,requested,{reach:this.goal.kind==='visit'?2.2:.4,exactY:this.goal.kind!=='explore',avoid}).then(result=>{
        if(this.bridge.phase!=='playing'||generation!==this.routeGeneration||this.goal?.expiresAt<=this.now()||distance(from,this.bridge.world.self)>3)return;
        if(result.status!=='route'){
          // A conservative floor query cannot model every ordinary fall/step.
          // Try one short server-integrated exploration probe, then re-query
          // from the actual resulting pose. It never reports a player pose.
          if(this.goal.kind==='explore'&&!this.probeUsed&&['budget','unreachable','no-floor'].includes(result.status)){
            this.probeUsed=true;this.probe={from:{...this.bridge.world.self},target:requested,until:this.now()+6000};this.nav.reset();this.nav.offset=0;
            this.diagnostic({type:'navigation-probe',reason:'Collision query '+result.status+'; bounded ordinary exploration input',seconds:6});return;
          }
          this.abandon('Public collision route query: '+result.status,requested);return;
        }
        if(!Array.isArray(result.waypoints)||!result.waypoints.length||result.waypoints.length>2048||result.waypoints.some(p=>!['x','y','z'].every(k=>Number.isFinite(p[k])))){this.abandon('Invalid collision route response',requested);return;}
        this.route={target:requested,points:result.waypoints,index:0,partial:result.partial,progressAt:this.now(),best:Infinity,avoidKey};
        this.diagnostic({type:'navigation-route',targetId:requested.id,waypoints:result.waypoints.length,partial:result.partial===true,elapsedMs:result.elapsedMs});
      }).catch(error=>{if(generation===this.routeGeneration)this.abandon('Collision route worker failed: '+error.message,requested);}).finally(()=>{this.routeRequest=null;});
      return;
    }
    const route=this.route;
    while(route.index<route.points.length&&distance(me,route.points[route.index])<.45&&Math.abs(me.y-route.points[route.index].y)<1){route.index++;route.best=Infinity;route.progressAt=this.now();}
    if(route.index>=route.points.length){this.route=null;return this.stopMoving();}
    const waypoint=route.points[route.index],range=distance(me,waypoint);
    if(range<route.best-.2){route.best=range;route.progressAt=this.now();}
    if(this.now()-route.progressAt>8000)return this.abandon('No authoritative progress along the collision route',target);
    const facing=Math.atan2(waypoint.x-me.x,waypoint.z-me.z);
    // Short leases stop at a doorway/corner instead of overshooting it by 4m.
    this.act({kind:'move',facing:angle(facing),seconds:Math.max(.1,Math.min(.6,range/7))});
  }
  walk(target, retreat = false) {
    if(this.probe&&!retreat){
      const me=this.bridge.world.self;
      const danger=[...this.bridge.world.entities.values()].some(e=>e.k==='mob'&&e.h===1&&e.dead!==1&&e.lv>(me.lv??1)+2&&Math.abs(e.y-me.y)<4&&distance(e,me)<24);
      if(danger)return this.abandon('Stronger creature blocks the exploration probe',target);
      if(this.now()>=this.probe.until){
        const moved=distance(me,this.probe.from);this.probe=null;this.nav.pause();
        if(moved<2)return this.abandon('Ordinary exploration probe made no progress',target);
        return this.meshWalk(target);
      }
      const p=this.nav.plan(me,target,Math.floor(this.now()/50));
      if(!p.forward)return this.stopMoving();
      const jump=!this.probe.jumped;
      if(this.act({kind:'move',facing:angle(p.facing),seconds:jump?.3:.6,...(jump?{jump:true}:{})})&&jump)this.probe.jumped=true;
      return;
    }
    if(this.router?.ready&&!retreat)return this.meshWalk(target);
    if(retreat&&this.nav.offset===null)this.nav.offset=0; // Ordinary input uses sin(facing), cos(facing).
    const self = this.bridge.world.self;
    const p = this.nav.plan(self, target, Math.floor(this.now()/50), {retreat});
    if(this.nav.blocked&&!retreat)return this.abandon('Reactive movement exhausted its recovery budget',target);
    if (!p.forward) return this.stopMoving();
    this.act({kind: 'move', facing: angle(p.facing), seconds: 0.6});
  }
  step() {
    if (this.bridge.phase !== 'playing') return;
    const world = this.bridge.world, self = world.self;
    if (!self || this.now() - this.bridge.lastSnapshotAt > 1500) return;
    if (self.dead === 1) {
      this.stopMoving();
      if (this.now()-this.lastDeathRelease>15000 && this.act({kind: 'release'})) this.lastDeathRelease = this.now();
      return;
    }
    if(self.charge||self.auras?.some(a=>['root','stun','incapacitate','polymorph','fear'].includes(a.kind))){
      this.stopMoving();if(this.route)this.route.progressAt=this.now();return;
    }
    if (!this.goal || this.now() > this.goal.expiresAt) return this.stopMoving();
    // Observe actual combat threats even if the current GLM goal was social.
    const threat = [...world.entities.values()].filter(e => e.k === 'mob' && e.h === 1 && e.dead !== 1 && e.own == null && e.kg !== 1 && (e.tgt === self.id || e.aggro === self.id))
      .sort((a, b) => distance(a, self)-distance(b, self))[0];
    const goalTarget = world.entities.get(this.goal.targetId);
    const target = threat ?? (this.goal.kind === 'hunt' ? goalTarget : null);
    if (target && target.dead !== 1 && target.h === 1) {
      if (self.hp / Math.max(1, self.mhp) < 0.4 || threat&&threat.lv>(self.lv??1)+2) {this.finishRoute();return this.walk(target, true);}
      if (self.target !== target.id) return this.act({kind: 'target', id: target.id});
      const abilities = (this.priority ?? []).map(id => self.known?.find(a => a.id === id)).filter(Boolean);
      const ability = abilities.find(a => a.requiresTarget && a.targetType === 'enemy' && !a.travel && (self.cds?.[a.id] ?? 0) <= world.time && (a.cost ?? 0) <= self.res);
      if (ability) {
        if (distance(self, target) > ability.range * 0.9) return this.walk(target);
        this.finishRoute();
        this.stopMoving();
        if (!self.cast && (self.gcdEnd ?? 0) <= world.time && this.now() > this.nextCastAt && this.act({kind: 'cast', ability: ability.id})) this.nextCastAt = this.now() + 1000;
      } else if (distance(self, target) > 2) this.walk(target);
      else if (!self.auto) this.act({kind: 'attack'});
      return;
    }
    const loot = [...world.entities.values()].find(e => e.loot === 1 && distance(e, self) < 4);
    if (loot && this.now() - this.lastInteract > 2000) { if (this.act({kind: 'loot', id: loot.id})) this.lastInteract = this.now(); return; }
    if (this.goal.kind === 'rest') { this.stopMoving(); if (self.auto) this.act({kind: 'stopattack'}); return; }
    if (this.goal.kind === 'visit' && goalTarget) {
      if (distance(self, goalTarget) > 3) return this.walk(goalTarget);
      this.finishRoute();
      this.stopMoving();
      // The actual server refuses conversations through adjacent storeys.
      // This reactive navigator has no vertical route; report that limitation
      // rather than submitting quest/talk actions through a floor.
      if (Math.abs(self.y-goalTarget.y)>2) {
        this.diagnostic({type:'navigation-blocked',reason:'NPC is on another storey; a vertical route is required',targetId:goalTarget.id,selfY:self.y,targetY:goalTarget.y});
        this.goal.expiresAt=0;return;
      }
      if (this.now() - this.lastInteract < 8000) return;
      // Existing observed quests are finite and validated again by the game.
      const ready = readyQuestForNpc(self,goalTarget);
      const offer = self.qoffers?.find(q => q.npcId === goalTarget.id);
      const dialog = world.dialog;
      let action = ready ? {kind:'turnin',quest:ready.id} : offer ? {kind: 'accept', quest: offer.id} : {kind: 'talk', npcId: goalTarget.id};
      if (!ready && !offer && dialog?.npcId === goalTarget.id) {
        const choice = dialog.choices?.find(c => c.enabled === true && !/\b(?:king|crown|brib\w*|buy|purchase|pay|trade|bank)\b/i.test(c.text ?? ''));
        if (choice) action = {kind: 'choose', npcId: dialog.npcId, nodeId: dialog.nodeId, idx: choice.idx};
      }
      if (this.act(action)) {
        this.lastInteract = this.now();
        this.visited.push({id: goalTarget.id, templateId: goalTarget.tid, at: this.now()}); this.visited = this.visited.slice(-30);
        // Submission is not completion. A new GLM decision over a fresh quest
        // snapshot must authorize another attempt; do not repeat this visit loop.
        if (action.kind==='accept' || action.kind==='turnin') this.goal.expiresAt=0;
      }
      return;
    }
    if (this.goal.kind === 'explore' && this.destination) {
      if (distance(self, this.destination) < 3) { this.goal.expiresAt = 0; this.finishRoute(); return this.stopMoving(); }
      this.walk(this.destination);
    } else this.stopMoving();
  }
  memory() {
    const self=this.bridge.world.self;
    const huntingGrounds=(this.router?.huntingSites??[]).filter(site=>site.levels[0]<=(self?.lv??1)+2).map(site=>({id:site.id,levels:site.levels,distance:Math.hypot(site.position[0]-self.x,site.position[2]-self.z),heading:Math.atan2(site.position[0]-self.x,site.position[2]-self.z),source:'released public habitat; actual creatures must still be observed'})).sort((a,b)=>a.distance-b.distance).slice(0,3);
    return {visited: this.visited, recentGoals: this.history, navigationBlocked: this.nav.blocked, calibration: this.nav.offset,blockedGoals:this.avoidGoals(),navigationMode:this.router?.ready?'released-collision':'reactive',huntingGrounds,route:this.route&&{targetId:this.route.target.id,waypoint:this.route.index,total:this.route.points.length},navigationProbe:this.probe&&{until:this.probe.until},at:this.now()};
  }
}
