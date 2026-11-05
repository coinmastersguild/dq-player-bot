export const PLAYTEST_ROLES={
 'combat-loot':'Test level-appropriate combat, facing, line of sight, retreat, kill credit and authorized loot. Vary encounters instead of farming one trivial spawn indefinitely.',
 'quests-navigation':'Test acquiring one accessible ordinary quest, its directions and route, objective progress and return. Briefly visit eligible observed NPCs within the bounded discovery budget; never invent a destination or quest.',
 'progression-recovery':'Test useful XP and loot progression, safe exploration, retreat, death recovery and persistence across ordinary reconnects. Avoid repeating an unproductive action loop.'
};
export function playtestPolicy(config,observation,memory,now){
 const role=config?.role;if(!role)return null;if(!Object.hasOwn(PLAYTEST_ROLES,role))throw Error('Unknown playtest role');
 const self=observation.self,activeQuest=self.qlog?.some(q=>!['ready','done','completed'].includes(q.state));
 const visited=memory?.visited??[],recent=visited.filter(v=>v.at>now-15*60*1000);
 const npcEligible=e=>e.k==='npc'&&e.kg!==1&&Number.isFinite(e.x)&&Math.hypot(e.x-self.x,e.z-self.z)<=80&&
  (self.qoffers?.some(q=>q.npcId===e.id)||role==='quests-navigation'&&!activeQuest&&new Set(recent.map(v=>v.id)).size<3&&!recent.some(v=>v.id===e.id));
 return{role,mission:PLAYTEST_ROLES[role],minHuntLevel:activeQuest?1:Math.max(1,(self.lv??1)-2),npcEligible};
}
