import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadJson, saveJson} from './durable.mjs';

export class FeedbackQueue {
  constructor(directory, identity) { this.directory = directory; this.identity = identity; fs.mkdirSync(directory, {recursive: true, mode: 0o700}); }
  report({category, title, detail, suspected = true, target = null, evidence = {}, model = null}) {
    const key = JSON.stringify([this.identity.nativeSession.catalogSha256, this.identity.world, category, title, target]);
    const id = createHash('sha256').update(key).digest('hex').slice(0, 24), filename = path.join(this.directory, id + '.json');
    const prior = loadJson(filename, null), at = new Date().toISOString();
    const entry = prior ?? {id, category, title, target, firstSeenAt: at, status: 'new', occurrences: 0,
      identity: this.identity, suspected, model, remediation: null, retest: null};
    entry.lastSeenAt = at; entry.occurrences++; entry.detail = detail; entry.evidence = evidence;
    if (prior?.status === 'closed') entry.status = 'reopened';
    saveJson(filename, entry); return entry;
  }
  list() { return fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{24}\.json$/.test(n)).map(n => loadJson(path.join(this.directory, n), null)).filter(Boolean); }
  update(id, change) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw Error('Invalid finding ID');
    const filename = path.join(this.directory, id + '.json'), finding = loadJson(filename, null);
    if (!finding) throw Error('Finding not found');
    // A patch/job success cannot close a player defect; actual retest evidence is mandatory.
    if (change.status === 'closed' && (!change.retest?.passed || !change.retest?.runId || !change.retest?.release)) throw Error('Closing requires a passed release-bound playtest');
    saveJson(filename, {...finding, ...change});
  }
}
