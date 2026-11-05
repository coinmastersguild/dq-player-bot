const $=id=>document.getElementById(id);

let state=null,receivedAt=0,filter='all',selected=null,isometric=true,follow=true,zoom=3,pan={x:0,z:0},trail=[],runId=null,controlBusy=false,polling=false,localError=null;
let lastObservationAt=null,hitTargets=[],drag=null,frameNeeded=true,controlError=null,anchor=null;
const fmt=n=>Number.isFinite(n)?new Intl.NumberFormat('en',{maximumFractionDigits:0}).format(n):'—';
const seconds=ms=>ms<60000?`${Math.floor(ms/1000)}s`:`${Math.floor(ms/60000)}m`;
const label=e=>e?.nm||`${e?.k||'Entity'} #${e?.id??'?'}`;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const set=(id,t)=>{$(id).textContent=t;};
function node(tag,cls,content){const e=document.createElement(tag);if(cls)e.className=cls;if(content!==undefined)e.textContent=content;return e;}
const age=()=>state?.observationAgeMs==null?Infinity:state.observationAgeMs+Date.now()-receivedAt;
const live=()=>state?.live===true&&!localError&&age()<6500;
function notice(message){$('notice').hidden=!message;set('notice',message??'');}
function serviceLabel(){
  if(localError||state?.connectionError)return 'Local controller offline';
  const s=state?.service;
  if(!s)return 'Connecting';
  if(s.activeState==='deactivating')return 'Stopping';
  if(s.activeState==='activating')return 'Starting';
  if(s.activeState==='failed')return 'Service failed';
  if(s.activeState==='inactive')return 'Stopped';
  if(s.halted||state.status?.phase==='paused')return 'Paused';
  if(live())return 'Playing';
  if(state.status?.phase==='reconnecting')return 'Reconnecting';
  if(state.status?.phase==='authentication-blocked')return 'Login blocked';
  return 'Waiting for feed';
}
function renderStatus(){
  const playing=live(),service=state?.service,connected=!!service&&!localError&&!state.connectionError;
  const pill=$('service-state');pill.classList.toggle('live',playing);pill.replaceChildren(node('i'),document.createTextNode(serviceLabel()));
  $('start').disabled=controlBusy||!connected||service.activeState==='deactivating'||(['active','activating'].includes(service.activeState)&&!service.halted);
  $('stop').disabled=controlBusy||!connected||!['active','activating'].includes(service.activeState);
  const busy=state?.controlPending;
  if(busy){$('start').disabled=true;$('stop').disabled=true;}
  const badge=$('feed-badge');badge.textContent=playing?'LIVE':state?.observation?'LAST FRAME':'WAITING';badge.classList.toggle('live',playing);
  set('feed-age',age()===Infinity?'No feed yet':`${playing?'Updated':'Last observation'} ${seconds(age())} ago`);
  const empty=$('view-empty');empty.hidden=playing;
  empty.classList.toggle('stale',!!state?.observation);
  if(!playing){empty.querySelector('h3').textContent=serviceLabel();empty.querySelector('p').textContent=state?.observation?'Showing the last recorded observation.':localError||state?.connectionError||'Waiting for a live observation from the bot.';}
  const at=state?.plan?.at;
  set('plan-age',at?`Chosen ${seconds(Math.max(0,Date.now()-at))} ago`:'No plan in recent recording');
  $('goal-type').textContent=state?.status?.goal?.expiresAt<Date.now()?'GOAL EXPIRED / WAITING':state?.status?.goal?.kind?.toUpperCase()??'AWAITING GOAL';
  if(!controlBusy)notice(controlError||localError||state?.connectionError||state?.controllerError||null);
}
function render(){
  const o=state?.observation,s=state?.status,p=o?.self,entities=o?.entities??[];
  if(p?.nm)set('character-name',p.nm);
  set('character-level',`Level ${p?.lv??s?.self?.level??'—'}`);
  set('health-label',p?`${p.hp??'—'} / ${p.mhp??'—'}`:'—');$('health').max=Math.max(1,p?.mhp??1);$('health').value=p?.hp??0;
  set('decisions',fmt(s?.statistics?.decisions));set('finding-count',fmt(s?.openFindings));
  set('coordinates',p?`X ${p.x.toFixed(1)}   Y ${p.y.toFixed(1)}   Z ${p.z.toFixed(1)}   /   TICK ${o.tick}`:'Waiting for the bot’s observation…');
  set('visible-count',`${entities.length} nearby entities`);set('nearby-count',entities.length);
  set('model',s?.model??'glm-5.3-flash-local');
  set('last-sync',`LOCAL SYNC ${new Date().toLocaleTimeString('en-GB')}`);
  const goal=s?.goal,target=entities.find(e=>e.id===goal?.targetId);
  set('goal-title',goal?.kind==='visit'?`Visit ${target?label(target):`entity #${goal.targetId}`}`:goal?.kind==='hunt'?`Hunt ${target?label(target):`entity #${goal.targetId}`}`:goal?.kind==='explore'?'Explore the surroundings':goal?.kind==='rest'?'Rest and recover':'Listening to the world');
  const currentPlan=state.plan&&state.plan.at>=(goal?.at??0)-3000;
  set('rationale',currentPlan?state.plan.rationale:'Waiting for a brief decision summary from GLM.');
  set('goal-distance',target&&p?`${Math.round(distance(target,p))} m away`:'');
  if(runId!==s?.runId){runId=s?.runId;trail=[];selected=null;lastObservationAt=null;}
  if(p&&o.at!==lastObservationAt){lastObservationAt=o.at;const prior=trail.at(-1);if(prior&&distance(prior,p)>25)trail=[];if(!prior||distance(prior,p)>.15)trail.push({x:p.x,z:p.z});trail=trail.slice(-350);}
  const nearby=$('nearby');nearby.replaceChildren();
  for(const e of [...entities].sort((a,b)=>p?distance(a,p)-distance(b,p):a.id-b.id).slice(0,20)){
    const b=node('button',`nearby-row ${e.h===1?'hostile':e.k==='object'?'object':''} ${selected===e.id?'chosen':''}`);b.append(node('i','nearby-icon'),node('span','',label(e)),node('small','',p?`${Math.round(distance(e,p))} m`:''));
    b.addEventListener('click',()=>{selected=e.id;frameNeeded=true;renderSelected();});nearby.append(b);
  }
  if(!entities.length)nearby.append(node('p','empty-copy','No entities in the current observation.'));
  const d=state.dialog;$('dialog-panel').hidden=!d;
  if(d){set('dialog-name',label(entities.find(e=>e.id===d.npcId))||'Conversation');set('dialog-text',d.text);$('dialog-choices').replaceChildren(...d.choices.map(c=>node('span','',c.text)));}
  renderActivity();renderFindings();renderStatus();renderSelected();frameNeeded=true;
}
function renderActivity(){
  const box=$('activity');box.replaceChildren();
  const all=(state?.activity??[]).filter(e=>filter==='all'||e.type===filter);
  // Keep repeated locomotion readable while preserving the latest real event time.
  const events=[];
  for(const e of all){const last=events.at(-1);if(last&&e.type==='action'&&last.type==='action'&&['move','stop'].includes(e.label)&&['move','stop'].includes(last.label)){last.repeated=(last.repeated??1)+1;continue;}events.push({...e});}
  for(const e of events){const row=node('div',`activity-row ${e.type}`);row.append(node('time','',new Date(e.at).toLocaleTimeString('en-GB')),node('i'),node('b','',e.label),node('span','',`${e.detail|| (e.type==='action'?'Submitted to game':'Observed in game')}${e.repeated?` · ${e.repeated} movement inputs`:''}`));box.append(row);}
  if(!events.length)box.append(node('p','empty-copy','No recent events for this filter.'));
}
function renderFindings(){
  const box=$('findings'),findings=state?.findings??[];box.replaceChildren();set('issue-count',state?.status?.openFindings??findings.length);
  const company=state?.companyFeedback;
  const footer=document.querySelector('.findings-footer');
  if(footer)footer.textContent=company?`${company.stale?'Company collection stale':company.receivedByPublisher?'Company received':'Company delivery pending'} · ${(company.boardTasks??[]).map(t=>'#'+t.number).join(', ')||'Board publication pending'} · ${company.publishedAt??company.at}`:'Play → observe → investigate → repair → retest';
  for(const f of findings){const d=node('details','finding'),summary=node('summary');const top=node('div','finding-top');const status=f.status==='assigned'&&f.jobState?f.jobState:f.status;top.append(node('span','',`${f.category.toUpperCase()} · ${f.suspected?'SUSPECTED':'CONFIRMED'}`),node('span','state',status.replaceAll('-',' ')));summary.append(top,node('h3','',f.title));d.append(summary,node('p','',`${f.detail}\nObserved ${f.occurrences} time${f.occurrences===1?'':'s'}.`));box.append(d);}
  if(!findings.length)box.append(node('p','empty-copy','No playtest findings in the current feed.'));
}
function renderSelected(){const p=state?.observation?.self,e=(state?.observation?.entities??[]).find(e=>e.id===selected),box=$('selected-entity');box.hidden=!e;if(e)box.textContent=`${label(e)} · #${e.id} · Level ${e.lv??'?'}${p?` · ${Math.round(distance(e,p))} m`:''}`;}
async function poll(){
  if(polling)return;polling=true;
  try{const r=await fetch('/api/state',{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();const result=await r.json();state=result;receivedAt=Date.now();localError=null;render();}
  catch{localError='Console connection interrupted. Reconnecting…';renderStatus();}
  finally{polling=false;}
}
async function control(action){
  if(controlBusy||!state?.csrfToken)return;
  controlBusy=true;controlError=null;renderStatus();notice(action==='start'?'Starting the bot on this Mac…':'Stopping the local bot and disconnecting its character…');
  try{const r=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrfToken},body:JSON.stringify({action}),signal:AbortSignal.timeout(20000)});const result=await r.json();if(!r.ok)throw Error(result.error);await poll();}
  catch(error){controlError=error.message||'Control not confirmed. Check the service status.';return;}
  finally{controlBusy=false;renderStatus();}
}
$('start').addEventListener('click',()=>control('start'));$('stop').addEventListener('click',()=>control('stop'));
for(const b of document.querySelectorAll('[data-filter]'))b.addEventListener('click',()=>{filter=b.dataset.filter;for(const other of document.querySelectorAll('[data-filter]'))other.classList.toggle('selected',other===b);renderActivity();});
$('expand').addEventListener('click',()=>{if(document.fullscreenElement)document.exitFullscreen();else $('world-panel').requestFullscreen().catch(()=>{});});
setInterval(renderStatus,1000);poll();setInterval(poll,1000);
