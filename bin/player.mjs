#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {PlayerSession} from '../src/session.mjs';
import {validateConfig} from '../src/world.mjs';
import {checkPlayer, connectPlayer} from '../src/transport.mjs';
import {PlayerMcp} from '../src/mcp.mjs';
import {createRecorder} from '../src/recording.mjs';

async function main() {
  const [command, flag, configPath] = process.argv.slice(2);
  if (!['check', 'mcp'].includes(command) || flag !== '--config' || !configPath) {
    process.stderr.write('Usage: node bin/player.mjs check|mcp --config /absolute/path/player.config.json\n');
    process.exitCode = command === '--help' ? 0 : 1; return;
  }
  const filename = path.resolve(configPath), base = path.dirname(filename);
  const config = validateConfig(JSON.parse(fs.readFileSync(filename, 'utf8')));
  for (const key of ['cookieFile', 'tokenFile']) if (config[key]) config[key] = path.resolve(base, config[key]);
  const session = new PlayerSession(config);
  if (command === 'check') { process.stdout.write(JSON.stringify(await checkPlayer(session, config), null, 2) + '\n'); return; }
  const lock = (config.tokenFile ?? config.cookieFile) + '.player-lock';
  // No stale-lock deletion: a crashed player's state needs explicit reconciliation.
  const lockFd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(lockFd, String(process.pid));
  let bridge, recorder, cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    bridge?.stop(); recorder?.close(); fs.closeSync(lockFd); fs.unlinkSync(lock);
  };
  try {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const codeFiles = ['package.json', 'package-lock.json', 'bin/player.mjs',
      ...fs.readdirSync(path.join(packageRoot, 'src')).filter(name => name.endsWith('.mjs')).sort().map(name => 'src/' + name)];
    const source = codeFiles.map(name => ({path: name, sha256: createHash('sha256').update(fs.readFileSync(path.join(packageRoot, name))).digest('hex')}));
    recorder = createRecorder(path.join(base, 'runs'), {version: '0.1.0', characterId: config.characterId,
      source, realm: config.realm, origin: session.origin, world: config.world, nativeSession: config.nativeSession, runSeconds: config.runSeconds});
    bridge = await connectPlayer(session, config, {record: (kind, data) => recorder.write(kind, data)});
    const docs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
    const mcp = new PlayerMcp(bridge, docs);
    const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
    const end = () => { cleanup(); lines.close(); process.stdin.pause(); };
    process.once('SIGINT', end); process.once('SIGTERM', end); lines.once('close', cleanup);
    let queue = Promise.resolve(), pending = 0;
    lines.on('line', line => {
      if (line.length > 65536 || pending >= 16) return end();
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || message.id === undefined) return;
      pending++;
      queue = queue.then(async () => {
        try { const result = await mcp.handle(message); process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\n'); }
        catch { process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Unsupported request'}}) + '\n'); }
      }).finally(() => { pending--; });
    });
  } catch (e) { cleanup(); throw e; }
}
main().catch(error => {
  const reason = error instanceof SyntaxError ? 'Invalid configuration JSON' : error.message;
  process.stderr.write(`Player adapter failed: ${reason}. No command was automatically replayed.\n`);
  process.exitCode = 1;
});
