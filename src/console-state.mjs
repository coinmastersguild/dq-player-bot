import fs from 'node:fs';
import path from 'node:path';

// The observer reads recorded public gameplay only. It never opens private/
// or connects another game client with the player's identity.
const text = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export function tailRecords(file, bytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(Math.min(size, bytes));
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    let lines = buffer.subarray(0, count).toString('utf8').split('\n');
    if (start) lines.shift();
    lines.pop(); // A writer may currently be appending the final line.
    return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function entity(value) {
  if (!Number.isSafeInteger(value?.id) || !['x','y','z'].every(k => Number.isFinite(value[k]))) return null;
  const e = pick(value, ['id','x','y','z','f','lv','hp','mhp','h','dead','kg','tgt','target','cast','res','mres','xp','nxp']);
  e.k = text(value.k, 30); e.nm = text(value.nm, 100);
  return e;
}
function activity(record) {
  const d = record.data;
  if (record.kind === 'intent') {
    const a = d?.action;
    if (!a) return null;
    const id = a.npcId ?? a.id ?? a.quest ?? a.ability;
    return {at: record.at, type: 'action', label: text(a.kind, 40), detail: id == null ? '' : String(id).slice(0,100), outcome: 'submitted'};
  }
  if (record.kind === 'event' && d?.type === 'game') {
    const e = d.data;
    return {at: record.at, type: 'game', label: text(e?.type, 60), detail: text(e?.text ?? e?.message ?? e?.npcName ?? e?.questName, 800)};
  }
  if (['diagnostic','glm-error','executor-error'].includes(record.kind)) {
    return {at: record.at, type: 'diagnostic', label: text(d?.type ?? record.kind, 60), detail: text(d?.reason ?? d?.error, 500)};
  }
  return null;
}
export function collectConsoleState(root, service, now = Date.now()) {
  const state = path.join(root, 'state'), raw = read(path.join(state, 'status.json'));
  const status = raw ? pick(raw, ['at','phase','characterId','world','runId','tick','model','playtestRole','openFindings','snapshotAgeMs']) : null;
  if (status) {
    status.statistics = pick(raw.statistics, ['connections','snapshots','decisions','findings','distance','castsSubmitted','deaths','planningFailures']);
    status.goal = pick(raw.goal, ['kind','targetId','heading','at','expiresAt']);
    status.inference = pick(raw.inference, ['model','calls','completed','failed','lastSuccessAt','lastModel']);
    status.botVersion = text(raw.botSource?.version, 30);
  }
  const runs = path.join(state, 'runs');
  const names = fs.existsSync(runs) ? fs.readdirSync(runs).filter(n => /^\d{4}-[\w.:-]+$/.test(n)).sort().reverse() : [];
  const run = names.find(n => raw?.runId && read(path.join(runs, n, 'manifest.json'))?.runId === raw.runId) ?? (raw?.phase !== 'playing' ? names[0] : null);
  const records = run ? tailRecords(path.join(runs, run, 'events.jsonl')) : [];
  const snap = records.findLast(r => r.kind === 'snapshot');
  const plan = records.findLast(r => r.kind === 'glm-plan');
  const dialogRecord = records.findLast(r => r.kind === 'event' && ['dialog','dialogEnd'].includes(r.data?.data?.type));
  const d = dialogRecord?.data?.data;
  const dialog = d?.type === 'dialog' ? {npcId:d.npcId, text:text(d.text,4000), choices:(d.choices??[]).slice(0,20).map(c=>({text:text(c.text,300),enabled:c.enabled===true}))} : null;
  const observation = snap ? {at:snap.at, tick:snap.data.tick, self:entity(snap.data.self), entities:(snap.data.entities??[]).slice(0,512).map(entity).filter(Boolean)} : null;
  const findingsPath = path.join(state,'findings');
  const findings = fs.existsSync(findingsPath) ? fs.readdirSync(findingsPath).filter(n=>/^[a-f0-9]{24}\.json$/.test(n)).map(n=>read(path.join(findingsPath,n))).filter(Boolean)
    .sort((a,b)=>String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).slice(0,20).map(f=>({id:f.id,category:text(f.category,30),title:text(f.title,200),detail:text(f.detail,600),status:text(f.status,80),jobState:text(f.dispatch?.state,40),occurrences:f.occurrences,suspected:f.suspected!==false,lastSeenAt:f.lastSeenAt})) : [];
  const feedback = read(path.join(state,'feedback-status.json'));
  const company = read(path.join(state,'company-feedback-status.json'));
  const published = company?.publication?.source;
  const companyFeedback = company ? {enabled:company.enabled===true,at:company.at,receivedByPublisher:company.receivedByPublisher===true,
    sourceId:text(company.sourceId,30),findingRecords:company.findingRecords,stale:now-Date.parse(company.at)>600000,
    publishedAt:company.publication?.at,playerAt:published?.playerAt,
    boardTasks:(published?.boardTasks??[]).slice(0,30).map(t=>pick(t,['id','number','lastPublishedAt','findingCount']))} : null;
  const age = observation ? Math.max(0,now-observation.at) : null;
  const entries = records.map(activity).filter(Boolean);
  const recent = ['game','action','diagnostic'].flatMap(type=>entries.filter(e=>e.type===type).slice(type==='action'?-35:-20)).sort((a,b)=>b.at-a.at);
  return {schema:'dq-bot-console-v1',at:now,service:{...service,halted:fs.existsSync(path.join(state,'service.halt'))},status,observation,
    live:service.activeState==='active' && status?.phase==='playing' && age!==null && age<6000 && now-Date.parse(status.at)<6000,
    observationAgeMs:age,
    plan:plan ? {at:plan.at,model:text(plan.data.model,80),goal:pick(plan.data.plan?.goal,['kind','targetId','heading']),rationale:text(plan.data.plan?.rationale,1600)} : null,
    dialog,activity:recent,findings,companyFeedback,
    feedback:feedback ? {at:feedback.at,workerModel:text(feedback.workerModel,80),jobs:(feedback.events??[]).slice(0,20).map(j=>pick(j,['findingId','jobId','state']))} : null};
}
