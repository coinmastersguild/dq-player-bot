// qlog and qview have deliberately different identifiers on the real wire.
// Never alias display names or strip a world namespace to connect them.
export function readyQuestForNpc(self,npc){
  if(npc?.k!=='npc'||typeof npc.tid!=='string'||!Array.isArray(self?.qlog)||!Array.isArray(self?.qview))return null;
  return self.qview.find(view=>typeof view.id==='string'&&view.state==='ready'&&
    self.qlog.some(progress=>progress.questId===view.id&&progress.state==='ready')&&
    (view.turnInNpcId===npc.tid||Array.isArray(view.turnInNpcIds)&&view.turnInNpcIds.includes(npc.tid)))??null;
}
