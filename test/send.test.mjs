import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generate } from 'selfsigned';

process.env.SLOPSEND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'slopsend-test-'));
const { pair, send, loadConfig, loadIdentity } = await import('../src/slopsend.mjs');

// Fake phone: a LocalSend v2 receiver. `mode` switches its behaviour per test.
let server, port, mode, received, senderFp;
const phoneCert = await generate([{ name: 'commonName', value: 'fake-phone' }], { algorithm: 'sha256' });

before(async () => {
  server = https.createServer(
    { cert: phoneCert.cert, key: phoneCert.private, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      const peer = req.socket.getPeerCertificate();
      senderFp = peer?.fingerprint256?.replaceAll(':', '');
      const url = new URL(req.url, 'http://x');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (url.pathname === '/api/localsend/v2/register') return json(200, { alias: 'Fake Phone' });
        if (url.pathname === '/api/localsend/v2/prepare-upload') {
          if (mode === 'reject') return json(403, {});
          if (mode === 'hang') return;
          const files = JSON.parse(body).files;
          const id = Object.keys(files)[0];
          received = { meta: files[id] };
          return json(200, { sessionId: 's1', files: { [id]: 'tok' } });
        }
        if (url.pathname === '/api/localsend/v2/upload') {
          if (url.searchParams.get('token') !== 'tok') return json(403, {});
          received.data = body;
          return json(200, {});
        }
        json(404, {});
      });
    },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server.closeAllConnections(); server.close(); });

const apk = path.join(process.env.SLOPSEND_HOME, 'app-debug.apk');
fs.writeFileSync(apk, crypto.randomBytes(100_000));

test('send before pair explains what to do', async () => {
  await assert.rejects(send(apk), /not paired/);
});

test('pair stores the phone fingerprint', async () => {
  const d = await pair({ ip: '127.0.0.1', port });
  assert.equal(d.alias, 'Fake Phone');
  const expected = new crypto.X509Certificate(phoneCert.cert).fingerprint256.replaceAll(':', '');
  assert.equal(loadConfig().fingerprint, expected);
});

test('send uploads the APK and identifies us by certificate', async () => {
  mode = 'accept';
  const r = await send(apk);
  assert.equal(r.name, 'app-debug.apk');
  assert.deepEqual(received.data, fs.readFileSync(apk));
  assert.equal(received.meta.sha256, crypto.createHash('sha256').update(received.data).digest('hex'));
  assert.equal(senderFp, (await loadIdentity()).fingerprint);
});

test('403 from the phone gives the favorites hint', async () => {
  mode = 'reject';
  await assert.rejects(send(apk), /Favorite.*Quick Save/);
});

test('changed phone certificate is refused', async () => {
  mode = 'accept';
  const cfg = loadConfig();
  fs.writeFileSync(path.join(process.env.SLOPSEND_HOME, 'config.json'), JSON.stringify({ ...cfg, pem: (await generate([{ name: 'commonName', value: 'other' }], { algorithm: 'sha256' })).cert }));
  await assert.rejects(send(apk), /certificate changed/);
});

test('favorite listener answers the phone register check and then stops', async () => {
  const { listenForFavorite } = await import('../src/slopsend.mjs');
  const waiting = listenForFavorite({ port: 54399, timeout: 10000, quiet: 200 });
  await new Promise((r) => setTimeout(r, 300));
  const reply = await new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: 54399, method: 'POST', path: '/api/localsend/v2/register', rejectUnauthorized: false }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(reply.fingerprint, (await loadIdentity()).fingerprint);
  assert.equal(reply.token, reply.fingerprint);
  assert.equal(await waiting, '127.0.0.1 (POST /api/localsend/v2/register)');
});

test('phone that never answers prepare-upload gives a hint instead of a rescan', async () => {
  await pair({ ip: '127.0.0.1', port });
  mode = 'hang';
  await assert.rejects(send(apk, { timeout: 400 }), /did not answer in time/);
});

test('findApk picks the newest debug APK and never builds', async () => {
  const { findApk } = await import('../src/slopsend.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slopsend-proj-'));
  assert.throws(() => findApk(root), /no debug APK found/);
  const dir = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.apk'), 'x');
  fs.utimesSync(path.join(dir, 'old.apk'), new Date(2020, 1, 1), new Date(2020, 1, 1));
  fs.writeFileSync(path.join(dir, 'app-debug.apk'), 'y');
  fs.mkdirSync(path.join(root, 'node_modules', 'x', 'build', 'outputs', 'apk', 'debug'), { recursive: true });
  assert.equal(findApk(root), path.join(dir, 'app-debug.apk'));
});
