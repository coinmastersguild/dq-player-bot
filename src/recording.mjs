import fs from 'node:fs';
import path from 'node:path';
const sensitive = /^(cookie|set-cookie|authorization|ticket|token|signature|private[_-]?key|mnemonic|seedPhrase|raw)$/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive.test(key)).map(([key, item]) => [key, redact(item)]));
}

export function createRecorder(root, manifest, maxBytes = 64 * 1024 * 1024) {
  const directory = path.join(root, `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(redact(manifest), null, 2) + '\n', {flag: 'wx', mode: 0o600});
  const fd = fs.openSync(path.join(directory, 'events.jsonl'), 'wx', 0o600);
  let bytes = 0, closed = false;
  return {directory,
    write(kind, data) {
      if (closed) throw Error('Recorder closed');
      const line = JSON.stringify({at: Date.now(), kind, data: redact(data)}) + '\n';
      if (bytes + Buffer.byteLength(line) > maxBytes) throw Error('Recording limit reached');
      fs.writeSync(fd, line); bytes += Buffer.byteLength(line);
    },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } }
  };
}
