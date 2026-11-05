#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PlayerSession} from '../src/session.mjs';
import {connectPlayer} from '../src/transport.mjs';
import {PlayerExecutor} from '../src/executor.mjs';
import {GlmClient, GLM_MODEL} from '../src/glm.mjs';
import {FeedbackQueue} from '../src/feedback.mjs';
import {loadJson, saveJson, acquireLock} from '../src/durable.mjs';
import {renewLogin} from '../src/login.mjs';
import {validateConfig} from '../src/world.mjs';
import {createRecorder} from '../src/recording.mjs';
import {NavigationRouter} from '../src/navigation-router.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const configFile = path.resolve(process.argv[2] ?? 'player.production.json');
const base = path.dirname(configFile);
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceFiles=['package.json','package-lock.json','bin/service.mjs',...fs.readdirSync(path.join(packageRoot,'src')).filter(name=>name.endsWith('.mjs')).sort().map(name=>'src/'+name)];
const botSource={version:JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version,
  sha256:createHash('sha256').update(sourceFiles.map(name=>name+'\0'+createHash('sha256').update(fs.readFileSync(path.join(packageRoot,name))).digest('hex')).join('\n')).digest('hex')};
const readConfig = () => {
  const config = validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
  for (const key of ['cookieFile', 'tokenFile', 'signerFile', 'stateDirectory']) if (config[key]) config[key] = path.resolve(base, config[key]);
  config.stateDirectory ??= path.join(base, 'state');
  if (!config.inference || config.inference.model !== GLM_MODEL) throw Error('Configure the pinned GLM inference service');
  if (config.inference.authTokenFile) config.inference.authTokenFile = path.resolve(base, config.inference.authTokenFile);
  config.commandLimit = 10000;
  return config;
};
async function main() {
  let config = readConfig();
  const stateRoot = config.stateDirectory;
  const unlock = acquireLock(path.join(stateRoot, 'player-service.lock'));
  const statistics = loadJson(path.join(stateRoot, 'statistics.json'), {connections: 0, snapshots: 0, decisions: 0, findings: 0, distance: 0, castsSubmitted: 0, deaths: 0, events: {}});
  let stopping = false, bridge, recorder, priorPose, failures = 0, lastStatus = 0;
  const stop = () => { stopping = true; bridge?.stop('Service shutdown'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  // The local app owns the player over a Node IPC channel. Losing the console
  // process disconnects the character instead of leaving an orphan controller.
  if(process.send)process.once('disconnect',stop);
  const status = data => {
    const result = {at: new Date().toISOString(), pid: process.pid, botSource, model: GLM_MODEL, playtestRole:config.inference.playtest?.role??null, characterId: config.characterId, world: config.world, statistics, ...data};
    saveJson(path.join(stateRoot, 'status.json'), result); saveJson(path.join(stateRoot, 'statistics.json'), statistics);
  };
  try {
    while (!stopping) {
      if (fs.existsSync(path.join(stateRoot, 'service.halt'))) { status({phase: 'paused', reason: 'Durable operator halt'}); await sleep(1000); continue; }
      config = readConfig();
      const identity = {characterId: config.characterId, world: config.world, realm: config.realm, botSource, nativeSession: config.nativeSession};
      const feedback = new FeedbackQueue(path.join(stateRoot, 'findings'), identity);
      const glm = new GlmClient(config.inference, stateRoot);
      let executor, router, lastPlan = 0, cursor = 0, planning = null, lastError = 0, lastSnapshotRecord = 0, alive = true;
      const runId = randomUUID();
      try {
        recorder = createRecorder(path.join(stateRoot, 'runs'), {version: botSource.version, runId, model: GLM_MODEL, ...identity});
        const record = (kind, data) => {
          if (kind === 'snapshot') {
            statistics.snapshots++;
            const pose = data.self;
            if (pose && priorPose) { const delta = Math.hypot(pose.x-priorPose.x,pose.z-priorPose.z); if (delta<20) statistics.distance += delta; }
            priorPose = pose;
            if (Date.now()-lastSnapshotRecord < 1000) return; lastSnapshotRecord=Date.now();
          }
          if (kind === 'intent' && data.action.kind === 'cast') statistics.castsSubmitted++;
          if (kind === 'event' && data.data?.type) {
            const type=data.data.type; statistics.events[type]=(statistics.events[type]??0)+1;
            if (type==='death' && data.data.entityId===bridge?.pid) statistics.deaths++;
            if (type==='error' && Date.now()-lastError>15000) {
              lastError=Date.now(); feedback.report({category:'runtime',title:'Server rejected an ordinary player action',detail:String(data.data.text??'Unknown action error'),
                evidence:{runId,tick:bridge?.world.tick,event:data,goal:executor?.goal},suspected:true});
            }
          }
          recorder.write(kind,data);
        };
        router=new NavigationRouter(config,stateRoot,{diagnostic:data=>record('diagnostic',data)});
        bridge = await connectPlayer(new PlayerSession(config), config, {record,observer:packet=>{
          if(process.connected)process.send?.({...packet,runId},()=>{});
        }});
        statistics.connections++;
        const navigationMemory=loadJson(path.join(stateRoot,'navigation-memory.json'),null);
        executor = new PlayerExecutor(bridge, {router,blockedGoals:navigationMemory?.world===config.world&&navigationMemory?.release===config.contentLockSha256&&navigationMemory?.sourceSha256===botSource.sha256?navigationMemory.blockedGoals:[],diagnostic: diagnostic => {
          record('diagnostic', diagnostic);
          if (diagnostic.type==='navigation-blocked') feedback.report({category:'navigation',title:'Bounded movement recovery could not find a route',detail:diagnostic.reason,
            target:executor?.goal?.targetId??null,evidence:{runId,diagnostic,goal:executor?.goal,observation:bridge.observe(cursor)},suspected:true});
        }});
        let executorError = null;
        const reaction = setInterval(() => { try { if (alive) executor.step(); } catch(error) { executorError=error.message; } }, 300);
        try {
          while (!stopping && bridge.phase !== 'stopped') {
            if (fs.existsSync(path.join(stateRoot,'service.halt'))) { bridge.stop('Durable operator halt'); break; }
            executor.step();
            if (executorError) { record('executor-error',{reason:executorError}); executorError=null; }
            if (bridge.phase==='playing' && !planning && Date.now()-lastPlan >= (config.inference.decisionSeconds??30)*1000) {
              const observation=bridge.observe(cursor);cursor=observation.nextEvent;lastPlan=Date.now();
              planning=glm.plan(observation,executor.memory()).then(response=>{
                if (!alive || bridge.phase!=='playing') return;
                // Plans referring to entities no longer in interest are rejected by the executor/server.
                executor.install(response.value);statistics.decisions++;
                record('glm-plan',{runId,model:response.model,usage:response.usage,plan:response.value});
                for (const finding of response.value.findings) {
                  feedback.report({...finding,model:response.model,evidence:{runId,tick:observation.tick,events:observation.events.filter(e=>finding.eventSequences.includes(e.sequence)),self:observation.self,goal:response.value.goal}});statistics.findings++;
                }
              }).catch(error=>{
                record('glm-error',{model:GLM_MODEL,error:error.message,proposal:error.proposal});
                statistics.planningFailures=(statistics.planningFailures??0)+1;
                feedback.report({category:error.proposal?'bot':'runtime',title:error.proposal?'GLM play plan failed actor-scoped validation':'GLM planner could not return a usable decision',
                  detail:error.message,model:GLM_MODEL,suspected:true,evidence:{runId,tick:observation.tick,proposal:error.proposal,
                    observedEntityIds:observation.entities.map(e=>({id:e.id,kind:e.k})),goal:executor.goal}});
              }).finally(()=>{planning=null;});
            }
            if (Date.now()-lastStatus>2000) {
              lastStatus=Date.now();const o=bridge.observe(cursor);
              saveJson(path.join(stateRoot,'navigation-memory.json'),{world:config.world,release:config.contentLockSha256,sourceSha256:botSource.sha256,blockedGoals:executor.avoidGoals()});
              status({phase:bridge.phase,runId,snapshotAgeMs:o.snapshotAgeMs,tick:o.tick,self:o.self&&{id:o.self.id,hp:o.self.hp,mhp:o.self.mhp,level:o.self.lv,x:o.self.x,y:o.self.y,z:o.self.z,xp:o.self.xp},goal:executor.goal,inference:glm.ledger,openFindings:feedback.list().filter(f=>f.status!=='closed').length});
            }
            await sleep(100);
          }
        } finally { alive=false;clearInterval(reaction); if(planning)await planning; }
        if (!stopping && bridge.reason!=='Run deadline reached') {
          feedback.report({category:'runtime',title:'Ordinary player connection stopped',detail:bridge.reason??'Unknown',evidence:{runId,events:bridge.observe().events},suspected:true});
        }
        failures=0;
      } catch(error) {
        failures++;
        feedback.report({category:'runtime',title:'Player could not enter the production world',detail:error.message,evidence:{runId},suspected:true});
        status({phase:'reconnecting',error:error.message,failures});
        if ((error.status===401 || /unexpired|session token/i.test(error.message)) && (config.signerFile||config.loginProvider==='agent-wallet')) {
          try { const renewal=await renewLogin(config);saveJson(path.join(stateRoot,'login-status.json'),renewal); }
          catch(loginError){status({phase:'authentication-blocked',error:loginError.message});}
        }
      } finally {
        alive=false;bridge?.stop('Connection cycle complete');await router?.close();recorder?.close();recorder=null;bridge=null;priorPose=null;
        // Bound recordings; findings and aggregate history have independent durable ownership.
        const runs=path.join(stateRoot,'runs');
        const names=fs.existsSync(runs)?fs.readdirSync(runs).filter(n=>/^\d{4}-/.test(n)).sort():[];
        for(const name of names.slice(0,-48))fs.rmSync(path.join(runs,name),{recursive:true});
      }
      if(!stopping)await sleep(Math.min(300000,2000*2**Math.min(failures,7)));
    }
    status({phase:'stopped'});
  } finally { bridge?.stop();recorder?.close();unlock(); }
}
main().then(()=>{if(process.connected)process.disconnect();}).catch(error=>{process.stderr.write(JSON.stringify({at:new Date().toISOString(),type:'service-failed',error:error.message})+'\n');process.exitCode=1;if(process.connected)process.disconnect();});
