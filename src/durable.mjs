import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {redact} from './recording.mjs';
export function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(redact(value), null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  if (fs.existsSync(file)) {
    const prior = loadJson(file, null);
    if (!Number.isSafeInteger(prior?.pid) || prior.pid < 2) throw Error('Invalid service lock');
    try { process.kill(prior.pid, 0); throw Error('Player service already running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({pid: process.pid, startedAt: Date.now()})); fs.fsyncSync(fd); fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}
