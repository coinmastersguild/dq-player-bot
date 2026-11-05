// Adapted from dq-arena-bot's same-origin session/cookie transport; see provenance.json.
import fs from 'node:fs';

export function readPrivateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw Error('Session must be an owner-only regular file (mode 0600)');
  }
  return fs.readFileSync(file, 'utf8');
}

export function cookieHeader(text, origin, now = Date.now()) {
  const url = new URL(origin);
  return text.split('\n').filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map(line => line.replace(/^#HttpOnly_/, '').trimEnd().split('\t'))
    .filter(row => {
      if (row.length !== 7) return false;
      const [domain, subdomains, path, secure, expires, name, value] = row;
      const host = domain.replace(/^\./, '');
      return (url.hostname === host || (subdomains === 'TRUE' && url.hostname.endsWith('.' + host))) &&
        path === '/' && (secure !== 'TRUE' || url.protocol === 'https:') &&
        (expires === '0' || Number(expires) * 1000 > now) &&
        /^[!#$%&'*+.^_`|~\w-]+$/.test(name) && !/[\r\n;]/.test(value);
    }).map(row => `${row[5]}=${row[6]}`).join('; ');
}

export function validateOrigin(origin) {
  const url = new URL(origin);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Expected HTTPS origin, or explicit loopback HTTP origin');
  }
  return url.origin;
}

export class PlayerSession {
  constructor({origin, cookieFile, tokenFile, fetchImpl = fetch}) {
    this.origin = validateOrigin(origin);
    if (!!cookieFile === !!tokenFile) throw Error('Configure exactly one cookieFile or tokenFile');
    Object.assign(this, {cookieFile, tokenFile, fetch: fetchImpl});
  }
  headers() {
    const headers = {Origin: this.origin, 'Content-Type': 'application/json', 'User-Agent': 'dq-player-bot/0.1.0'};
    if (this.tokenFile) {
      const token = readPrivateFile(this.tokenFile).trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Expected existing native session token');
      headers.Authorization = `Bearer ${token}`;
    } else {
      headers.Cookie = cookieHeader(readPrivateFile(this.cookieFile), this.origin);
      if (!headers.Cookie) throw Error('No unexpired cookie for the selected origin');
    }
    return headers;
  }
  async request(path, body) {
    const reads = ['/api/account', '/api/characters', '/api/world/status'];
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.hash || (body === undefined ? !reads.includes(url.pathname) : url.pathname !== '/api/zone/enter') ||
        (body !== undefined && [...url.searchParams].some(([key, value]) => key !== 'release' || !/^[a-f0-9]{64}$/.test(value)))) {
      throw Error('Unsupported player API route');
    }
    if (body !== undefined && (Object.keys(body).sort().join(',') !== 'characterId,world' ||
        !Number.isSafeInteger(body.characterId) || body.characterId < 1 || typeof body.world !== 'string')) {
      throw Error('Entry requires only characterId and world');
    }
    const headers = this.headers();
    let response;
    try {
      response = await this.fetch(url.href, {method: body === undefined ? 'GET' : 'POST',
        headers, redirect: 'error', signal: AbortSignal.timeout(20000),
        ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      throw Error(`Player HTTP request failed${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ' (' + code + ')' : ''}; no automatic replay`);
    }
    if (!response.ok) throw Object.assign(Error(`Player API HTTP ${response.status}`), {status: response.status});
    return response.json();
  }
}
