import path from 'node:path';
import {loadJson,saveJson,acquireLock} from '../src/durable.mjs';
import {FeedbackQueue} from '../src/feedback.mjs';
import {FeedbackDispatcher} from '../src/dispatch.mjs';
const filename=path.resolve(process.argv[2]),base=path.dirname(filename),config=loadJson(filename,null);
const state=path.resolve(base,config.stateDirectory??'state');
const queue=new FeedbackQueue(path.join(state,'findings'),{characterId:config.characterId,world:config.world,realm:config.realm,nativeSession:config.nativeSession});
let unlock;
try {
  unlock=acquireLock(path.join(state,'feedback-dispatch.lock'));
  if(!config.feedback?.enabled)throw Error('Feedback dispatch not configured');
  const dispatcher=new FeedbackDispatcher(config.feedback);
  const events=await dispatcher.tick(queue,state);
  saveJson(path.join(state,'feedback-status.json'),{at:new Date().toISOString(),workerModel:config.feedback.workerModel,events,
    counts:Object.fromEntries([...new Set(queue.list().map(f=>f.status))].map(status=>[status,queue.list().filter(f=>f.status===status).length])),
    releaseAutomation:'Repairs produce candidates; promotion requires independent source, native/client and release validation. A job success never closes a finding.'});
}catch(error){saveJson(path.join(state,'feedback-status.json'),{at:new Date().toISOString(),error:error.message});process.exitCode=1;}
finally{unlock?.();}
