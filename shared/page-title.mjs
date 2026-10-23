// The <title> of a shared page, for the "Send to Todos" share sheet. Only public hosts: every
// address the connection would use is checked inside the socket's own lookup, so a name that
// resolves to a private, loopback or link-local address (or changes its answer between two
// lookups) is never connected to. Nothing here throws: a page that cannot be read safely is ''.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const MAX_BYTES = 1536 * 1024; // YouTube puts its <title> after 1MB of inline script
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (entities[e]) return entities[e];
  if (e[0] !== '#') return m;
  try { return String.fromCodePoint(parseInt(/^#x/i.test(e) ? e.slice(2) : e.slice(1), /^#x/i.test(e) ? 16 : 10)); } catch { return m; }
});

/** True for addresses that must never be fetched (RFC 1918, loopback, link-local, CGNAT, ULA…). */
export function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) {
    const rest = v6.slice(7);
    if (net.isIPv4(rest)) return privateAddress(rest);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest); // ::ffff:7f00:1 is 127.0.0.1 too
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return privateAddress(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`); }
    return true;
  }
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('64:ff9b');
}

/** A lookup for the socket that refuses private answers, so the check and the connection agree. */
function guardedLookup(allowLocal) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options;
    dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return cb(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
      if (!list.length || (!allowLocal && list.some((a) => privateAddress(a.address)))) return cb(new Error('refused address'));
      cb(null, opts.all ? list : list[0].address, opts.all ? undefined : list[0].family);
    });
  };
}

/** One GET; resolves to { status, location, type, html } with at most MAX_BYTES of the body. */
function get(target, { timeout, allowLocal }) {
  return new Promise((resolve) => {
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, { method: 'GET', lookup: guardedLookup(allowLocal), timeout, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; Todos/1.0)' } }, (res) => {
      let html = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        html += chunk;
        if (html.length >= MAX_BYTES || /<\/title>/i.test(html)) { res.destroy(); finish(); }
      });
      res.on('end', finish);
      res.on('error', finish);
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode, location: res.headers.location, type: res.headers['content-type'] || '', html });
      }
    });
    // `timeout` on the request is idle time only; a slow drip must not hold the server longer either.
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeout);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}

/** The page's title, or '' when it cannot be read safely. `allowLocal` is for tests only. */
export async function pageTitle(url, { timeout = 6000, allowLocal = false } = {}) {
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      const target = new URL(current);
      if (!/^https?:$/.test(target.protocol)) return '';
      const host = target.hostname.replace(/^\[|\]$/g, '');
      if (!allowLocal && net.isIP(host) && privateAddress(host)) return '';
      const res = await get(target, { timeout, allowLocal });
      if (!res) return '';
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (!res.location) return '';
        current = new URL(res.location, target).href; // checked again on the next hop
        continue;
      }
      if (res.status !== 200 || !/text\/html/.test(res.type)) return '';
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(res.html);
      return m ? decode(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    }
  } catch {
    /* a bad URL, a refused address, anything odd: no title */
  }
  return '';
}
