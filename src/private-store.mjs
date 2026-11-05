import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
// Unlike telemetry's redacted saveJson, this owner-only store must preserve
// signing material and exact pending transaction bytes for recovery.
export function savePrivateJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);
  const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
