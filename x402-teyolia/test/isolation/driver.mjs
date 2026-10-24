// PR-6 — driver del arnés de aislamiento T-12 / T-12e / T-13 / T-06 (D-P6-1 (a), Fernando 2026-10-24 09:21).
// Corre como root DENTRO de namespaces desechables (unshare --mount --net --pid, tmpfs propio; ver
// harness.sh). Dos usuarios de SO reales, distintos y sin entrada en /etc/passwd (EN-2):
//   LEGACY_UID (teyolia-api sintético) y X402_UID (proceso x402). Control de egreso del SO por uid con
//   nftables (egress.nft), cargado solo en este netns. Ningún mock en proceso.
// Salida TAP; exit 1 ante cualquier fallo (fail-closed). Sin red real: solo loopback y una ruta
// por defecto hacia lo (192.0.2.0/24, TEST-NET-1) que nunca sale del netns.
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.ISO_ROOT;
const NODE = process.env.ISO_NODE;
const NFT = process.env.ISO_NFT;
if (!ROOT || !NODE || !NFT) { console.error('driver: faltan ISO_ROOT/ISO_NODE/ISO_NFT'); process.exit(1); }
const PKG = path.join(ROOT, 'pkg');
const HERE = path.join(PKG, 'test', 'isolation');

// --- Identidades (mutaciones MT12-3 / MT13-2 editan estas constantes) ---
const LEGACY_UID = 2001;
const X402_UID = 2002;
const PROBE_UID = X402_UID;          // uid con el que corren las sondas «x402»
const PROBE_GROUPS = [];             // grupos suplementarios de las sondas «x402»

// --- Chronik configurada (DM-1: endpoint fijo, una sola variable) ---
const CHRONIK_URL = 'http://127.0.0.1:47100';
const CH = new URL(CHRONIK_URL);
const CH_HOST = CH.hostname;
const CH_PORT = Number(CH.port);
const OTHER_PORT = 47199;

// --- Layout legacy sintético (OB-01). Modos y dueños que exige la separación de usuarios. ---
const P = {
  release: path.join(ROOT, 'srv/teyolia-api/release'),
  env: path.join(ROOT, 'srv/teyolia-api/release/.env'),
  unitDir: path.join(ROOT, 'etc/systemd/system'),
  unit: path.join(ROOT, 'etc/systemd/system/teyolia-api.service'),
  state: path.join(ROOT, 'var/lib/teyolia/state-metadata-0defa0b'),
  db: path.join(ROOT, 'var/lib/teyolia/state-metadata-0defa0b/campaigns.db'),
  run: path.join(ROOT, 'run/teyolia-api'),
  sock: path.join(ROOT, 'run/teyolia-api/legacy.sock'),
  x402Dir: path.join(ROOT, 'var/lib/teyolia-x402'),
  x402Home: path.join(ROOT, 'home/teyolia-x402'),
  legacyHome: path.join(ROOT, 'home/teyolia-api'),
};
const LAYOUT = [
  // [ruta, tipo, modo, uid, gid]
  [P.release, 'dir', 0o750, LEGACY_UID, LEGACY_UID],
  [P.env, 'file', 0o600, LEGACY_UID, LEGACY_UID],
  [P.unitDir, 'dir', 0o755, 0, 0],
  [P.unit, 'file', 0o640, 0, LEGACY_UID],
  [P.state, 'dir', 0o700, LEGACY_UID, LEGACY_UID],
  [P.db, 'sqlite', 0o600, LEGACY_UID, LEGACY_UID],
  [P.run, 'dir', 0o750, LEGACY_UID, LEGACY_UID],
  [P.x402Dir, 'dir', 0o700, X402_UID, X402_UID],
  [P.x402Home, 'dir', 0o700, X402_UID, X402_UID],
  [P.legacyHome, 'dir', 0o700, LEGACY_UID, LEGACY_UID],
];
const SOCK_MODE = 0o660;

// ------------------------------------------------------------------------------------------
const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? 'ok' : 'not ok'} ${results.length} - ${id} ${detail}\n`);
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const nft = (...args) => sh(NFT, args);
const BASE_ENV = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };

function asUid(uid, groups = []) {
  const g = groups.length ? ['--groups', groups.join(',')] : ['--clear-groups'];
  return ['setpriv', ['--reuid', String(uid), '--regid', String(uid), ...g]];
}

function counters() {
  const j = JSON.parse(nft('-j', 'list', 'table', 'inet', 'x402iso'));
  const out = {};
  for (const item of j.nftables) {
    const r = item.rule;
    if (!r?.comment) continue;
    const c = r.expr.find((e) => e.counter);
    out[r.comment] = c ? c.counter.packets : 0;
  }
  return out;
}

// P6C-03: registro de hijos para matarlos ante cualquier error (antes el driver quedaba colgado si
// un paso fallaba con un hijo vivo) y vigía global que aborta con exit 1 (fail-closed).
const CHILDREN = new Set();
const track = (child) => { CHILDREN.add(child); child.once('exit', () => CHILDREN.delete(child)); return child; };
const killAll = () => { for (const c of CHILDREN) { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); } };
const WATCHDOG_MS = Number(process.env.ISO_WATCHDOG_MS ?? 300_000);
setTimeout(() => { console.error(`driver: ERROR vigía: ${WATCHDOG_MS} ms sin terminar`); killAll(); process.exit(1); }, WATCHDOG_MS).unref();

// Oyentes: anuncian cada accept en stdout.
const accepts = {};
function startListeners(uid, specs, env) {
  return new Promise((resolve, reject) => {
    const [cmd, pre] = uid === 0 ? [NODE, []] : asUid(uid);
    const args = uid === 0 ? [path.join(HERE, 'listener.mjs'), JSON.stringify(specs)] : [...pre, NODE, path.join(HERE, 'listener.mjs'), JSON.stringify(specs)];
    const child = track(spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'inherit'] }));
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const [k, name] = line.split(' ');
        if (k === 'LISTEN') accepts[name] ??= 0;
        if (k === 'ACCEPT') accepts[name] = (accepts[name] ?? 0) + 1;
        if (k === 'READY') resolve(child);
        if (k === 'ERROR') reject(new Error(line));
      }
    });
    child.on('exit', (code) => reject(new Error(`listener salió ${code}`)));
    setTimeout(() => reject(new Error('listener sin READY')), 5000);
  });
}

function probe(who, op, target, port) {
  const [cmd, pre] = who === 'legacy' ? asUid(LEGACY_UID) : asUid(PROBE_UID, PROBE_GROUPS);
  const args = [...pre, NODE, path.join(HERE, 'probe.mjs'), op, target, ...(port === undefined ? [] : [String(port)])];
  const out = sh(cmd, args, { env: { ...BASE_ENV, HOME: '/nonexistent', NODE_NO_WARNINGS: '1' }, timeout: 10_000 });
  return JSON.parse(out.trim().split('\n').pop()).result;
}

// Los «ACCEPT» de los oyentes llegan por stdout de forma asíncrona (las sondas son síncronas):
// se deja drenar el event loop antes de cada instantánea.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = async () => { await sleep(300); return { c: counters(), a: { ...accepts } }; };
const delta = (s0, s1) => {
  const d = {};
  for (const k of new Set([...Object.keys(s0.c), ...Object.keys(s1.c)])) d[`nft:${k}`] = (s1.c[k] ?? 0) - (s0.c[k] ?? 0);
  for (const k of new Set([...Object.keys(s0.a), ...Object.keys(s1.a)])) d[`accept:${k}`] = (s1.a[k] ?? 0) - (s0.a[k] ?? 0);
  return d;
};
const nonzero = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== 0));

function httpReq(port, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, headers: res.headers, body, json }); });
    });
    r.on('error', reject);
    r.end();
  });
}

function spawnAs(uid, args, { env, cwd, stdin = 'ignore' }) {
  const [cmd, pre] = asUid(uid);
  return track(spawn(cmd, [...pre, ...args], { env, cwd, stdio: [stdin, 'pipe', 'pipe'] }));
}

function waitLine(child, re, ms = 10_000) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = '';
    const t = setTimeout(() => reject(new Error(`timeout esperando ${re}; stdout=${out} stderr=${err}`)), ms);
    child.stdout.on('data', (d) => { out += d; const m = re.exec(out); if (m) { clearTimeout(t); resolve(m); } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`salió ${code}; stdout=${out} stderr=${err}`)); });
  });
}
const stop = (child) => new Promise((res) => { if (child.exitCode !== null || child.signalCode !== null) return res(); child.once('exit', () => res()); child.kill('SIGTERM'); });
const exitOf = (child, ms = 10_000) => new Promise((res) => { const t = setTimeout(() => { child.kill('SIGKILL'); res({ code: null, timeout: true }); }, ms); child.on('exit', (code, signal) => { clearTimeout(t); res({ code, signal }); }); });

const CODEGEN_FLAG = '--disallow-code-generation-from-strings';
const MAIN = path.join(PKG, 'dist', 'main.js');
const FAKE_XPUB = `xpub661MyMwAqRbcF${'A'.repeat(94)}`;
const offEnv = () => ({ ...BASE_ENV, HOME: P.x402Home, NODE_ENV: 'test', TEYOLIA_X402_LISTEN: '0', TEYOLIA_X402_CHRONIK_URL: CHRONIK_URL });
const onEnv = (dir) => ({
  ...offEnv(),
  TEYOLIA_X402_ENABLED: 'true',
  TEYOLIA_X402_PUBLIC_ORIGIN: 'http://127.0.0.1',
  TEYOLIA_X402_STORE_PATH: path.join(dir, 'store.sqlite'),
  TEYOLIA_X402_GRANT_DB_PATH: path.join(dir, 'grant.sqlite'),
  TEYOLIA_X402_XPUB: FAKE_XPUB,
});

// ------------------------------------------------------------------------------------------
async function main() {
  // 1. Red del netns: solo loopback.
  sh('ip', ['link', 'set', 'lo', 'up']);
  // Ruta por defecto hacia lo: un destino no local (192.0.2.1, TEST-NET-1) pasa por el hook output
  // de nftables y luego se descarta en la entrada (no hay forwarding): nunca sale del netns.
  sh('ip', ['route', 'add', 'default', 'dev', 'lo']);
  process.stdout.write(`# netns: ${sh('ip', ['-brief', 'addr']).trim().replace(/\n/g, ' | ')}; rutas: ${sh('ip', ['route']).trim().replace(/\n/g, ' | ')}\n`);

  // 2. Política de egreso por uid (solo en este netns).
  const policy = readFileSync(path.join(HERE, 'egress.nft'), 'utf8')
    .replaceAll('@X402_UID@', String(X402_UID)).replaceAll('@CHRONIK_HOST@', CH_HOST).replaceAll('@CHRONIK_PORT@', String(CH_PORT));
  writeFileSync(path.join(ROOT, 'egress.rendered.nft'), policy);
  nft('-f', path.join(ROOT, 'egress.rendered.nft'));
  const c0 = counters();
  check('SETUP-nft', ['x402-new', 'x402-chronik', 'x402-deny'].every((k) => k in c0), `política cargada en el netns: ${JSON.stringify(c0)}`);

  // 3. Layout legacy sintético.
  for (const [p, type, mode, uid, gid] of LAYOUT) {
    if (type === 'dir') mkdirSync(p, { recursive: true });
    else {
      mkdirSync(path.dirname(p), { recursive: true });
      if (type === 'sqlite') {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(p); db.exec("CREATE TABLE campaigns(id TEXT); INSERT INTO campaigns VALUES ('legacy-sintetico');"); db.close();
      } else if (p === P.env) writeFileSync(p, 'TEYOLIA_REFUND_ORACLE_PRIVKEY=no-es-una-llave-sintetico\n');
      else writeFileSync(p, '[Service]\nUser=teyolia-api\nEnvironmentFile=/srv/teyolia-api/release/.env\nExecStart=/usr/bin/node dist/server.js\n');
    }
    chownSync(p, uid, gid);
    chmodSync(p, mode);
  }
  for (const d of ['srv', 'srv/teyolia-api', 'etc', 'etc/systemd', 'var', 'var/lib', 'var/lib/teyolia', 'run', 'home']) chmodSync(path.join(ROOT, d), 0o755);
  chmodSync(ROOT, 0o755);

  // 4. Oyentes: Chronik de fixture (root) y legacy sintético (uid legacy; TCP como backend/src/server.ts,
  //    más un socket con ruta y uno abstracto como CONTROL de T-12e).
  const chronik = await startListeners(0, [{ name: 'chronik', tcp: { host: CH_HOST, port: CH_PORT } }], BASE_ENV);
  const legacy = await startListeners(LEGACY_UID, [
    { name: 'legacy-tcp', tcp: { host: '127.0.0.1', port: 3011 } },
    { name: 'legacy-tcp6', tcp: { host: '::1', port: 3011 } },
    { name: 'otro-tcp', tcp: { host: '127.0.0.1', port: OTHER_PORT } },
    { name: 'legacy-unix', path: P.sock, mode: SOCK_MODE },
    { name: 'legacy-abstract', abstract: 'teyolia-legacy-ipc' },
  ], { ...BASE_ENV, HOME: P.legacyHome, LEGACY_SECRET_SINTETICO: 'no-es-una-llave' });

  try {
    // ---------------- T-12 sondas ----------------
    let s0 = await snap(); let r = probe('x402', 'tcp', CH_HOST, CH_PORT); let d = delta(s0, await snap());
    check('T-12a', r === 'CONNECTED' && d['nft:x402-chronik'] === 1 && d['nft:x402-deny'] === 0, `uid x402 -> Chronik configurada ${CH_HOST}:${CH_PORT} = ${r}; ${JSON.stringify(nonzero(d))}`);

    s0 = await snap(); r = probe('x402', 'tcp', '127.0.0.1', 3011); d = delta(s0, await snap());
    const rl = probe('legacy', 'tcp', '127.0.0.1', 3011);
    check('T-12b', r !== 'CONNECTED' && d['nft:x402-deny'] === 1 && (d['accept:legacy-tcp'] ?? 0) === 0 && rl === 'CONNECTED',
      `uid x402 -> 127.0.0.1:3011 = ${r} (${JSON.stringify(nonzero(d))}); par positivo uid legacy = ${rl}`);

    const others = [['tcp', '127.0.0.1', OTHER_PORT, 'CONNECTED'], ['tcp', '::1', 3011, 'CONNECTED'], ['tcp', '192.0.2.1', 443, 'TIMEOUT'], ['udp', '192.0.2.1', 53, 'SENT'], ['udp', '127.0.0.1', 53, null]];
    for (const [op, host, port, legacyExpect] of others) {
      s0 = await snap(); r = probe('x402', op, host, port); d = delta(s0, await snap());
      const s1 = await snap(); const rl2 = legacyExpect === null ? null : probe('legacy', op, host, port); const dl = delta(s1, await snap());
      const okX = r !== 'CONNECTED' && d['nft:x402-deny'] >= 1;
      const okL = legacyExpect === null || (rl2 === legacyExpect && (dl['nft:x402-deny'] ?? 0) === 0);
      check('T-12c', okX && okL, `${op} ${host}:${port}: uid x402 = ${r} (${JSON.stringify(nonzero(d))}); uid legacy = ${rl2 ?? 'n/a'} (${JSON.stringify(nonzero(dl))})`);
    }

    // ---------------- T-12e (IPC) ----------------
    s0 = await snap(); r = probe('x402', 'unix', P.sock); d = delta(s0, await snap());
    const ru = probe('legacy', 'unix', P.sock);
    check('T-12e-ii', r === 'EACCES' && (d['accept:legacy-unix'] ?? 0) === 0 && ru === 'CONNECTED', `socket UNIX con ruta (DAC): uid x402 = ${r}; uid legacy = ${ru}`);
    s0 = await snap(); r = probe('x402', 'unix', '@teyolia-legacy-ipc'); d = delta(s0, await snap());
    check('T-12e-iii-control', r === 'CONNECTED' && d['accept:legacy-abstract'] === 1 && d['nft:x402-new'] === 0,
      `socket abstracto @teyolia-legacy-ipc: uid x402 = ${r} -> sin barrera en TA-2 (ni DAC ni nft; precondición del gate de TA-3) y el contador lo detecta: ${JSON.stringify(nonzero(d))}`);

    // ---------------- T-13 (DAC con uids reales) ----------------
    const pairs = [
      ['T-13a', 'read', P.env, '.env del release legacy'],
      ['T-13b', 'read', P.unit, 'unit teyolia-api.service'],
      ['T-13c', 'readdir', P.state, 'directorio de estado legacy'],
      ['T-13c', 'sqlite', P.db, 'campaigns.db (node:sqlite, que ignora --permission)'],
      ['T-13e', 'readdir', P.release, 'directorio de release legacy'],
    ];
    for (const [id, op, target, what] of pairs) {
      const rx = probe('x402', op, target); const rlg = probe('legacy', op, target);
      check(id, rx !== 'OK' && rlg === 'OK', `${what}: uid x402 = ${rx}; uid legacy = ${rlg}`);
    }
    const env = `/proc/${legacy.pid}/environ`;
    const rxe = probe('x402', 'read', env); const rle = probe('legacy', 'read', env);
    const leaked = readFileSync(env, 'utf8').includes('LEGACY_SECRET_SINTETICO');
    check('T-13f', rxe !== 'OK' && rle === 'OK' && leaked, `/proc/<pid legacy>/environ: uid x402 = ${rxe}; uid legacy = ${rle}`);

    // ---------------- T-12d / T-12e-iii / T-06c: procesos x402 reales ----------------
    const routes = async (port) => {
      const out = [];
      for (const [m, p, h] of [
        ['GET', '/teyolia-x402/health', {}], ['GET', '/teyolia-x402/capabilities', {}],
        ['GET', '/x402/v1/access/demo', {}], ['POST', '/x402/v1/access/demo', {}],
        ['GET', '/x402/v1/access/demo', { 'payment-proof': 'eyJ4NDAyVmVyc2lvbiI6MX0' }],
        ['GET', '/x402/v1/access/demo', { 'payment-signature': 'c2lnbmF0dXJh' }],
        ['GET', '/api/campaigns', {}], ['GET', '/no-existe', {}],
      ]) out.push(`${m} ${p}${Object.keys(h).length ? `+${Object.keys(h)[0]}` : ''}=${(await httpReq(port, m, p, h)).status}`);
      return out.join(' ');
    };
    // PM6-02: CERO conexiones salientes del proceso real (aceptadas o rechazadas: nft x402-new cuenta
    // toda conexión nueva del uid x402) y CERO accepts en cualquier oyente sintético, incluido el
    // socket abstracto @teyolia-legacy-ipc (T-12e-iii: el proceso real no intenta usarlo).
    const quiet = (d) => Object.values(d).every((v) => v === 0);
    const WATCH = `vigilados: nft[${Object.keys(counters()).join(',')}] + accept[${Object.keys(accepts).join(',')}]`;

    // OFF
    s0 = await snap();
    let child = spawnAs(X402_UID, [NODE, MAIN], { env: offEnv(), cwd: P.x402Home });
    let port = Number((await waitLine(child, /escuchando en 127\.0\.0\.1:(\d+)/))[1]);
    let seen = await routes(port);
    const health = await httpReq(port, 'GET', '/teyolia-x402/health');
    await stop(child); d = delta(s0, await snap());
    check('T-12d-off', quiet(d), `dist/main.js OFF (uid x402): ${seen}; ${WATCH}; distintos de 0: ${JSON.stringify(nonzero(d))}`);
    check('E-8-off', health.json?.x402Enabled === false && health.json?.limitsZero === true, `health OFF: x402Enabled=${health.json?.x402Enabled} limitsZero=${health.json?.limitsZero}`);

    // ON sin adaptadores (proceso real, 503)
    s0 = await snap();
    child = spawnAs(X402_UID, [NODE, CODEGEN_FLAG, MAIN], { env: onEnv(P.x402Dir), cwd: P.x402Home });
    port = Number((await waitLine(child, /escuchando en 127\.0\.0\.1:(\d+)/))[1]);
    seen = await routes(port);
    const demo = await httpReq(port, 'GET', '/x402/v1/access/demo');
    const h2 = await httpReq(port, 'GET', '/teyolia-x402/health');
    await stop(child); d = delta(s0, await snap());
    check('T-12d-on503', quiet(d), `dist/main.js ON sin adaptadores (uid x402): ${seen}; distintos de 0: ${JSON.stringify(nonzero(d))}`);
    check('E-8-on503', demo.status === 503 && h2.json?.limitsZero === true, `ruta x402 = ${demo.status} ${demo.json?.error ?? ''}; limitsZero=${h2.json?.limitsZero}`);

    // ON con adaptadores (createApp real de dist/ + fixtures en proceso), cadena C3B completa desde fuera.
    const { acceptOffer, encodeProof } = await import(pathToFileURL(path.join(PKG, 'test/fixtures/x402/c3b-client.mjs')).href);
    const { createSettlementProofFromReceipt } = await import(pathToFileURL(path.join(PKG, 'node_modules/@x402-xec/core/dist/index.js')).href);
    const tmp = path.join(P.x402Dir, 'adp'); mkdirSync(tmp); chownSync(tmp, X402_UID, X402_UID);
    s0 = await snap();
    child = spawnAs(X402_UID, [NODE, path.join(HERE, 'app-adapters.mjs')], { env: { ...BASE_ENV, HOME: P.x402Home, TMPDIR: tmp }, cwd: P.x402Home, stdin: 'pipe' });
    port = Number((await waitLine(child, /PORT (\d+)/))[1]);
    seen = await routes(port);
    const ORIGIN = 'https://api.teyolia.cash';
    const ROUTE = '/x402/v1/access/demo';
    const first = await httpReq(port, 'GET', ROUTE);
    const { offer, invoiceHash } = acceptOffer(first, { publicOrigin: ORIGIN, method: 'GET', path: ROUTE, now: first.json.invoice.issuedAt });
    child.stdin.write(`settle ${offer.invoice.payTo} ${offer.invoice.amountSats}\n`);
    const txid = (await waitLine(child, /TXID ([0-9a-f]{64})/))[1];
    const proof = encodeProof(createSettlementProofFromReceipt({ status: 'settled', network: 'xec:mainnet', txid }, invoiceHash));
    const second = await httpReq(port, 'GET', ROUTE, { 'payment-proof': proof });
    const third = await httpReq(port, 'GET', ROUTE, { 'payment-proof': proof });
    child.stdin.write('stats\n');
    const stats = JSON.parse((await waitLine(child, /STATS (\{.*\})/))[1]);
    child.stdin.write('exit\n'); await exitOf(child); d = delta(s0, await snap());
    check('T-12d-onadp', quiet(d) && second.status === 200 && third.status === 200,
      `createApp de dist/ con adaptadores (uid x402): ${seen}; cadena C3B 402->${second.status} ${second.json?.status ?? ''}->${third.status} ${third.json?.status ?? ''}; ${JSON.stringify(stats)}; distintos de 0: ${JSON.stringify(nonzero(d))}`);

    // T-13d: configuración que apunta al legacy -> no arranca y no crea nada; par positivo propio.
    const before = readdirSync(P.release).sort().join(',');
    child = spawnAs(X402_UID, [NODE, CODEGEN_FLAG, MAIN], { env: onEnv(P.release), cwd: P.x402Home });
    let ex = await exitOf(child);
    const after = readdirSync(P.release).sort().join(',');
    const ownDir = path.join(P.x402Dir, 'own'); mkdirSync(ownDir); chownSync(ownDir, X402_UID, X402_UID); chmodSync(ownDir, 0o700);
    child = spawnAs(X402_UID, [NODE, CODEGEN_FLAG, MAIN], { env: onEnv(ownDir), cwd: P.x402Home });
    await waitLine(child, /escuchando en 127\.0\.0\.1:(\d+)/); await stop(child);
    const own = readdirSync(ownDir).filter((f) => f.endsWith('.sqlite')).sort().join(',');
    check('T-13d', ex.code === 78 && before === after && own === 'grant.sqlite,store.sqlite',
      `STORE/GRANT en el release legacy: exit ${ex.code}, release antes=[${before}] después=[${after}]; par positivo en dir propio: [${own}]`);
  } finally {
    await stop(legacy); await stop(chronik);
  }

  const fail = results.filter((x) => !x.ok).length;
  process.stdout.write(`1..${results.length}\n# pass ${results.length - fail}\n# fail ${fail}\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(`driver: ERROR ${e.stack ?? e}`); killAll(); process.exit(1); });
