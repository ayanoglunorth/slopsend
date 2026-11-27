// slopsend: LocalSend protocol v2 sender. One file on purpose; see README for scope.
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generate } from 'selfsigned';

const PROTOCOL = '2.2';
const DEFAULT_PORT = 53317;
const APK_MIME = 'application/vnd.android.package-archive';

export class Fail extends Error {}

const home = () => process.env.SLOPSEND_HOME || path.join(os.homedir(), '.slopsend');

// --- identity and config ---------------------------------------------------

const fingerprintOf = (certPem) =>
  new crypto.X509Certificate(certPem).fingerprint256.replaceAll(':', '').toUpperCase();

export async function loadIdentity() {
  const dir = home();
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const notAfterDate = new Date();
    notAfterDate.setFullYear(notAfterDate.getFullYear() + 20);
    const pems = await generate([{ name: 'commonName', value: 'slopsend' }], {
      algorithm: 'sha256',
      notAfterDate,
    });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  }
  const cert = fs.readFileSync(certFile, 'utf8');
  return { cert, key: fs.readFileSync(keyFile, 'utf8'), fingerprint: fingerprintOf(cert) };
}

const configFile = () => path.join(home(), 'config.json');
export const loadConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return null;
  }
};
const saveConfig = (c) => {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
};

const selfInfo = (id) => ({
  alias: `slopsend-${os.hostname()}`.slice(0, 32),
  version: PROTOCOL,
  deviceModel: 'slopsend',
  deviceType: 'headless',
  fingerprint: id.fingerprint,
  port: DEFAULT_PORT,
  protocol: 'https',
  download: false,
});

// --- HTTP -----------------------------------------------------------------

// Peer certs are self-signed. With `pin` (the phone's PEM from pairing) the TLS chain check
// accepts only that exact certificate; without it (pairing, scanning) we only report what we saw.
const CERT_ERRORS = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']);
const toPem = (der) =>
  `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

function call(id, { ip, port, method = 'POST', path: p, body, stream, size, pin, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (data) Object.assign(headers, { 'content-type': 'application/json', 'content-length': data.length });
    if (stream) Object.assign(headers, { 'content-type': 'application/octet-stream', 'content-length': size });
    const req = https.request(
      {
        host: ip, port, method, path: p, headers, cert: id.cert, key: id.key,
        ...(pin ? { ca: [pin], rejectUnauthorized: true, checkServerIdentity: () => undefined } : { rejectUnauthorized: false }),
      },
      (res) => {
        const c = res.socket.getPeerCertificate(true);
        const seen = c?.raw && { fingerprint: c.fingerprint256.replaceAll(':', '').toUpperCase(), pem: toPem(c.raw) };
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try { json = JSON.parse(text); } catch { /* empty or non-JSON body is fine */ }
          resolve({ status: res.statusCode, json, peer: seen });
        });
      },
    );
    // Two clocks: a short one to connect (a dead address must fail fast so we can rescan),
    // a long one once connected (the phone may wait for the user to tap accept).
    const connectTimer = setTimeout(() => req.destroy(Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' })), 5000);
    req.on('socket', (s) => (s.getProtocol?.() ? clearTimeout(connectTimer) : s.once('secureConnect', () => clearTimeout(connectTimer))));
    req.on('close', () => clearTimeout(connectTimer));
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(CERT_ERRORS.has(e.code) ? new Fail('phone certificate changed. Run: slopsend pair') : e));
    if (stream) stream.pipe(req);
    else req.end(data);
  });
}

// --- discovery ------------------------------------------------------------

function localSubnets() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address))
        out.add(a.address.split('.').slice(0, 3).join('.'));
  return [...out];
}

async function probe(id, ip, port = DEFAULT_PORT, timeout = 1500) {
  try {
    const r = await call(id, { ip, port, path: '/api/localsend/v2/register', body: selfInfo(id), timeout });
    if (r.status !== 200 || !r.peer) return null;
    return { ip, port, alias: r.json?.alias ?? ip, fingerprint: r.peer.fingerprint, pem: r.peer.pem };
  } catch {
    return null;
  }
}

export async function scan(id, port = DEFAULT_PORT) {
  const ips = localSubnets().flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`));
  const hits = await Promise.all(ips.map((ip) => probe(id, ip, port)));
  return hits.filter(Boolean);
}

// --- pair -----------------------------------------------------------------

export async function pair({ ip, port } = {}) {
  const id = await loadIdentity();
  const found = ip ? [await probe(id, ip, port ?? DEFAULT_PORT, 5000)].filter(Boolean) : await scan(id);
  if (!found.length) throw new Fail('no LocalSend device found. Open LocalSend on the phone (same Wi-Fi) and retry, or use: slopsend pair --ip <phone-ip>');
  if (found.length > 1)
    throw new Fail(`several devices found, pick one with --ip: ${found.map((d) => `${d.alias}=${d.ip}`).join(', ')}`);
  const d = found[0];
  saveConfig({ ip: d.ip, port: d.port, fingerprint: d.fingerprint, pem: d.pem, alias: d.alias });
  return d;
}

// --- find the APK ----------------------------------------------------------
// slopsend never builds. The agent (or the user) builds the debug APK with the project's own
// tooling; we only pick up the newest one it left behind.

export function findApk(root) {
  let best;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', '.git', '.gradle'].includes(e.name)) walk(full);
      } else if (e.name.endsWith('.apk') && /build[\\/](outputs[\\/]apk[\\/]debug|app[\\/]outputs[\\/]flutter-apk)/.test(full)) {
        const t = fs.statSync(full).mtimeMs;
        if (!best || t > best.t) best = { full, t };
      }
    }
  };
  walk(root);
  if (!best) throw new Fail('no debug APK found. Build one first (for example "gradlew assembleDebug" or "flutter build apk --debug"), then run again. Or pass the APK path: slopsend send app.apk');
  return best.full;
}

// --- send -----------------------------------------------------------------

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

const NET_ERRORS = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);

export async function send(file, { timeout = 120000 } = {}) {
  const cfg = loadConfig();
  if (!cfg) throw new Fail('not paired. Open LocalSend on the phone, then run: slopsend pair');
  if (!fs.existsSync(file)) throw new Fail(`file not found: ${file}`);
  const id = await loadIdentity();
  const size = fs.statSync(file).size;
  const name = path.basename(file);
  const fileId = crypto.randomUUID();
  const meta = { id: fileId, fileName: name, size, fileType: APK_MIME, sha256: await sha256File(file) };
  const prepare = (target) =>
    call(id, {
      ip: target.ip, port: target.port, pin: cfg.pem, timeout,
      path: '/api/localsend/v2/prepare-upload',
      body: { info: selfInfo(id), files: { [fileId]: meta } },
    });

  let target = cfg;
  let res;
  try {
    res = await prepare(target);
  } catch (e) {
    if (e.code === 'ETIMEDOUT') throw new Fail('phone did not answer in time. Look at the phone: accept the transfer, or finish the one-time Favorites setup, then retry');
    if (e instanceof Fail || !NET_ERRORS.has(e.code)) throw e instanceof Fail ? e : new Fail(`send failed: ${e.message}`);
    // IP probably changed: look for the paired phone by certificate fingerprint.
    const found = (await scan(id, cfg.port)).find((d) => d.fingerprint === cfg.fingerprint);
    if (!found) throw new Fail('phone not reachable. Open LocalSend on the phone (same Wi-Fi) and retry');
    target = { ...cfg, ip: found.ip, port: found.port };
    saveConfig(target);
    res = await prepare(target);
  }

  const explain = {
    403: 'phone rejected the transfer. One-time phone setup is missing: run "slopsend favorite", then on the phone Send tab > info icon on this PC > Favorite > Add; then Settings > Quick Save for "Favorites"',
    409: 'phone is busy with another transfer. Finish or cancel it and retry',
    401: 'phone asks for a PIN. Turn the PIN off in LocalSend settings',
    429: 'phone says too many requests. Wait a moment and retry',
  };
  if (res.status !== 200) throw new Fail(explain[res.status] ?? `phone answered HTTP ${res.status}`);
  const token = res.json?.files?.[fileId];
  if (!res.json?.sessionId || !token) throw new Fail('unexpected reply from phone (protocol mismatch?)');

  const up = await call(id, {
    ip: target.ip, port: target.port, pin: cfg.pem, timeout,
    path: `/api/localsend/v2/upload?sessionId=${encodeURIComponent(res.json.sessionId)}&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`,
    stream: fs.createReadStream(file), size,
  });
  if (up.status !== 200) throw new Fail(up.status === 422 ? 'checksum mismatch on the phone, retry' : `upload failed: HTTP ${up.status}`);
  return { name, size, alias: cfg.alias };
}

// --- favorite helper --------------------------------------------------------

// LocalSend checks a new favorite by calling /register on it, so for a moment this computer
// has to answer like a LocalSend device. Resolves with the phone's IP once it has called.
export async function listenForFavorite({ port = DEFAULT_PORT, timeout = 300000, quiet = 20000, onHit = () => {} } = {}) {
  const id = await loadIdentity();
  let first, calm, calmTimer;
  const called = new Promise((r) => (first = r));
  const idle = new Promise((r) => (calm = r));
  const server = https.createServer({ cert: id.cert, key: id.key }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // v2 calls the identity `fingerprint`, newer clients read it as `token`; send both.
    res.end(JSON.stringify({ ...selfInfo(id), token: id.fingerprint }));
    req.resume();
    if (/\/(register|info)$/.test(req.url.split('?')[0])) {
      const who = `${req.socket.remoteAddress.replace('::ffff:', '')} (${req.method} ${req.url})`;
      onHit(who);
      first(who);
      clearTimeout(calmTimer);
      calmTimer = setTimeout(calm, quiet); // done once the phone has been quiet for a while
    }
  });
  await new Promise((ok, fail) => {
    server.once('error', (e) => fail(e.code === 'EADDRINUSE' ? new Fail(`port ${port} is in use. Close the LocalSend desktop app and retry`) : e));
    server.listen(port, '0.0.0.0', ok);
  });
  let timer;
  const expired = new Promise((_, fail) => (timer = setTimeout(() => fail(new Fail('the phone never contacted this computer. Check that Windows Firewall allows Node.js on private networks, that the phone is on the same Wi-Fi, and that you tapped Add while this command was running')), timeout)));
  try {
    const ip = await Promise.race([called, expired]);
    await idle;
    return ip;
  } finally {
    clearTimeout(timer);
    clearTimeout(calmTimer);
    server.closeAllConnections();
    server.close();
  }
}

// --- CLI ------------------------------------------------------------------

const setupSteps = (alias) =>
  [
    'One-time setup so the phone stops asking (about a minute), in this order:',
    '  1. On the computer run "slopsend favorite" and leave it running.',
    '  2. On the phone open LocalSend and go to the Send tab.',
    `  3. Tap the info icon on "${alias}" (not listed? run "slopsend pair" and look again).`,
    '  4. Switch on Favorite, then tap Add. "slopsend favorite" prints "phone contacted this computer".',
    '  5. Go to the Settings tab and switch on Quick Save for "Favorites" (not the plain "Quick Save").',
  ].join('\n');

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  try {
    if (cmd === 'pair') {
      const d = await pair({ ip: flag('--ip'), port: flag('--port') ? Number(flag('--port')) : undefined });
      console.log(`paired with "${d.alias}" (${d.ip}). ${setupSteps(selfInfo(await loadIdentity()).alias)}`);
    } else if (cmd === 'favorite') {
      console.log('listening for the phone (up to 5 min). Now on the phone: LocalSend > Send tab > info icon on this computer > Favorite > Add. Keep this running until a "phone contacted" line appears.');
      await listenForFavorite({ onHit: (who) => console.log(`phone contacted this computer: ${who}`) });
      console.log(`Done listening. Now on the phone: Settings > turn on Quick Save for "Favorites". Then run: slopsend send`);
    } else if (cmd === 'send') {
      const positional = rest.filter((a) => !a.startsWith('--'));
      const file = path.resolve(positional[0] ?? findApk(process.cwd())); // fail before touching the network
      // First run pairs on its own, so there is no separate setup step.
      const firstRun = !loadConfig();
      if (firstRun) await pair({ ip: flag('--ip') });
      const r = await send(file);
      const mins = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000);
      console.log(`sent ${r.name} (${mb(r.size)}, built ${mins < 1 ? 'just now' : `${mins} min ago`}) to "${r.alias}". On the phone, open the LocalSend notification or Downloads and tap Install.`);
      if (firstRun) console.log(setupSteps(selfInfo(await loadIdentity()).alias));
    } else {
      console.log('usage: slopsend send [apk-path] | slopsend pair [--ip <phone-ip>] | slopsend favorite');
      process.exitCode = cmd ? 2 : 0;
    }
  } catch (e) {
    console.error(`slopsend: ${e instanceof Fail ? e.message : e.stack}`);
    process.exitCode = 1;
  }
}
