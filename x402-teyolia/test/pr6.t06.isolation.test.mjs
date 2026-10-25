// PR-6 / T-06 (D-P6-1 y PM6-03/PM6-04; Fernando 2026-10-24 09:21 CDMX). El proceso x402 no alcanza
// finalize, código legacy ni variables de llave privada / refund-oracle. Sin cambios en src/.
//   T-06a: composición sobre el grafo REAL de dist/main.js (T-11a/b/c) + búsqueda en los archivos
//          propios de dist/ + inventario fijado de capacidades de red CARGADAS (PM6-04: la búsqueda
//          por strings es evadible; el poder discriminante viene de T-11 y de T-12d del arnés).
//   T-06b: con cada variable secreta del inventario 239f9dc el proceso real no arranca (regla A)
//          y ninguna está en la allowlist; par positivo. PM6-03: esta prueba es la capa DINÁMICA.
//   T-06c: lista de módulos efectivamente cargados en runtime (hook de carga + require.cache)
//          durante la cadena C3B completa; todo file: dentro del paquete; control negativo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES, MAIN, PACKAGE_ROOT, baselineEnv, launch, makeTmp, rejections } from './helpers.mjs';
import { buildGraph, checkT11a, checkT11b, checkT11c } from '../scripts/check-graph.mjs';
import { INVENTORY_FILE } from '../scripts/inventory.mjs';

const DIST = path.join(PACKAGE_ROOT, 'dist');
const INVENTORY = readFileSync(INVENTORY_FILE, 'utf8');
const rel = (f) => path.relative(PACKAGE_ROOT, f).split(path.sep).join('/');

// --- T-06a -------------------------------------------------------------------------------------
// Lista fijada (PM6-04) de capacidades de red CARGADAS por el grafo de dist/main.js. Si aparece una
// nueva (otro import de red o un fetch), la prueba falla y obliga a revisarla.
export const LOADED_NET_CAPABILITIES = Object.freeze([
  'node_modules/@x402-xec/express/dist/middleware.js globalThis.fetch (createX402XecMiddleware; cargado, NO invocado por dist/)',
  'node_modules/express/lib/application.js node:http',
  'node_modules/express/lib/request.js node:http',
  'node_modules/express/lib/request.js node:net',
  'node_modules/express/lib/response.js node:http',
  'node_modules/express/lib/utils.js node:http',
  'node_modules/router/index.js node:http',
  'node_modules/router/lib/route.js node:http',
]);
const NET_BUILTINS = /^(?:node:)?(?:net|http|https|http2|tls|dgram|dns|child_process|worker_threads|cluster)$/;
export function loadedNetCapabilities(graph) {
  const out = [];
  for (const n of graph.nodes.values()) {
    for (const b of [...(n.builtins ?? [])].filter((x) => NET_BUILTINS.test(x))) out.push(`${rel(n.file)} ${b.startsWith('node:') ? b : `node:${b}`}`);
    const src = readFileSync(n.file, 'utf8');
    if (/globalThis\.fetch|(?<![\w$.])fetch\s*\(/.test(src)) {
      out.push(rel(n.file) === 'node_modules/@x402-xec/express/dist/middleware.js'
        ? LOADED_NET_CAPABILITIES[0] : `${rel(n.file)} fetch`);
    }
  }
  return [...new Set(out)].sort();
}
// Búsqueda (evadible; solo complementaria) en los archivos PROPIOS del grafo.
export const OWN_STRING_RULES = [
  { id: 'puerto-legacy', re: /3011/g, allowed: ['dist/env-guard.js'] }, // env-guard RECHAZA 3011
  { id: 'backend', re: /backend\//g, allowed: [] },
  { id: 'finalize', re: /finali[sz]e/gi, allowed: [] },
  { id: 'llave-refund-oracle', re: /REFUND_ORACLE|PRIVKEY|_SEED\b/g, allowed: ['dist/allowlist.js', 'dist/env-guard.js'] },
];
export function ownStringHits(graph) {
  const hits = [];
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'own') continue;
    const src = readFileSync(n.file, 'utf8');
    for (const r of OWN_STRING_RULES) if (src.match(r.re) && !r.allowed.includes(rel(n.file))) hits.push(`${r.id}:${rel(n.file)}`);
  }
  return hits.sort();
}

describe('T-06a — sin alcance a finalize / legacy / llaves en el grafo real de dist/main.js', () => {
  const graph = buildGraph(MAIN);
  test('T-11a/b/c sin problemas (base del poder discriminante de T-06a)', () => {
    assert.deepEqual(checkT11a(graph), []);
    assert.deepEqual(checkT11b(graph), []);
    assert.deepEqual(checkT11c(graph, INVENTORY), []);
  });
  test('ningún archivo del grafo está bajo backend/ ni fuera del paquete', () => {
    for (const n of graph.nodes.values()) {
      assert.ok(n.file.startsWith(PACKAGE_ROOT + path.sep), n.file);
      assert.ok(!/[\\/]backend[\\/]/.test(rel(n.file)), n.file);
    }
  });
  test('búsqueda en archivos propios: sin 3011 (salvo el rechazo de env-guard), backend/, finalize ni nombres de llave fuera de la lista negativa', () => {
    assert.deepEqual(ownStringHits(graph), []);
  });
  test('PM6-04: capacidades de red cargadas = lista fijada (incluye la cargada no invocada)', () => {
    assert.deepEqual(loadedNetCapabilities(graph), [...LOADED_NET_CAPABILITIES].sort());
    for (const f of readdirSync(DIST).filter((x) => x.endsWith('.js'))) {
      assert.ok(!readFileSync(path.join(DIST, f), 'utf8').includes('createX402XecMiddleware'), `${f} no invoca createX402XecMiddleware`);
    }
  });
  test('control negativo: un dist/ mutado que importa backend/ y hace fetch es detectado', () => {
    const { dir } = makeTmp('x402-t06a-');
    const main = path.join(dir, 'main.js');
    const legacy = path.join(dir, 'backend', 'finalize.js');
    mkdirSync(path.dirname(legacy), { recursive: true });
    copyFileSync(path.join(FIXTURES, 'pr6', 'outside-module.mjs'), legacy);
    writeFileSync(main, "import './backend/finalize.js';\nimport 'node:net';\nawait fetch('http://127.0.0.1:3011/');\n");
    const g = buildGraph(main, { ownRoot: dir, exceptions: [] });
    assert.ok(ownStringHits(g).some((h) => h.startsWith('puerto-legacy:')), 'detecta 3011');
    assert.ok(ownStringHits(g).some((h) => h.startsWith('backend:') || h.startsWith('finalize:')) || [...g.nodes.values()].some((n) => /backend/.test(n.file)), 'detecta backend/finalize');
    assert.ok(loadedNetCapabilities(g).length > 0, 'detecta capacidad de red');
  });
});
// --- T-06b -------------------------------------------------------------------------------------
const SECRETS = [...INVENTORY.matchAll(/^ENV ([A-Z0-9_]+) \| secreto[^|]*\|/gm)].map((m) => m[1]).sort();
const KEY_IDENTIFIERS = [...INVENTORY.matchAll(/^ENV ([A-Z0-9_]*(?:REFUND_ORACLE|BENEFICIARY|GAS_WALLET)[A-Z0-9_]*) \|/gm)].map((m) => m[1]).sort();

describe('T-06b — variables de llave privada / refund-oracle: el proceso real no arranca', async () => {
  const { NORMATIVE_ALLOWLIST, SYSTEM_ALLOWLIST } = await import(pathToFileURL(path.join(DIST, 'allowlist.js')).href);
  test('el inventario 239f9dc declara los 12 secretos esperados', () => {
    assert.equal(SECRETS.length, 12, SECRETS.join(','));
    assert.ok(SECRETS.includes('TEYOLIA_REFUND_ORACLE_PRIVKEY') && SECRETS.includes('REFUND_ORACLE_SEED'));
  });
  test('ninguna variable de llave/identificador de llave está en las allowlists (capa estática)', () => {
    for (const n of KEY_IDENTIFIERS) {
      assert.ok(!NORMATIVE_ALLOWLIST.includes(n) && !SYSTEM_ALLOWLIST.includes(n), n);
    }
  });
  test('par positivo: con el entorno base el proceso real arranca (OFF, 503)', async () => {
    const { dir } = makeTmp('x402-t06b-');
    const r = await launch({ env: baselineEnv(dir), cwd: dir });
    assert.equal(r.started, true, r.stderr);
    await r.stop();
  });
  for (const name of [...new Set([...SECRETS, ...KEY_IDENTIFIERS])].sort()) {
    // Secretos: regla A obligatoria. Identificadores no secretos de la misma familia: A o B.
    const rules = SECRETS.includes(name) ? ['A'] : ['A', 'B'];
    test(`capa dinámica (PM6-03): ${name} presente -> no arranca, exit 78, regla ${rules.join('/')}`, async () => {
      const { dir } = makeTmp('x402-t06b-');
      const r = await launch({ env: { ...baselineEnv(dir), [name]: 'valor-ficticio-no-es-llave' }, cwd: dir });
      if (r.started) { await r.stop(); assert.fail(`${name}: el proceso arrancó (falla cerrado sin dejar el hijo vivo)`); }
      assert.equal(r.code, 78);
      assert.ok(rejections(r.stderr).some((x) => x.name === name && rules.includes(x.rule)), r.stderr);
      assert.ok(!r.stderr.includes('valor-ficticio-no-es-llave'), 'el valor no se imprime');
    });
  }
});

// --- T-06c -------------------------------------------------------------------------------------
const CHILD = path.join(PACKAGE_ROOT, 'test', 'isolation', 't06c-child.mjs');
const REGISTER = path.join(PACKAGE_ROOT, 'test', 'isolation', 't06c-register.mjs');
function runtimeModules(extra) {
  const { dir } = makeTmp('x402-t06c-');
  const log = path.join(dir, 'modules.log');
  const env = { PATH: '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', NODE_ENV: 'test', NODE_NO_WARNINGS: '1', X402_T06C_LOG: log, TMPDIR: dir };
  if (extra) env.X402_T06C_EXTRA = extra;
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(REGISTER).href, CHILD], { env, cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('T06C '));
  return JSON.parse(line.slice(5));
}
export function outsidePackage(modules) {
  return modules.filter((u) => u.startsWith('file:')).map((u) => fileURLToPath(u))
    .filter((f) => !f.startsWith(PACKAGE_ROOT + path.sep) || /[\\/]backend[\\/]/.test(path.relative(PACKAGE_ROOT, f)));
}
describe('T-06c — módulos cargados en runtime (cadena C3B completa)', () => {
  test('cadena 200/200 y todo módulo file: cargado está dentro del paquete; ninguno bajo backend/', () => {
    const r = runtimeModules();
    assert.deepEqual(r.statuses, [200, 200]);
    assert.ok(r.modules.some((u) => u.endsWith('/dist/server.js')) && r.modules.some((u) => u.includes('/node_modules/express/')), 'el hook vio dist/ y express (CJS)');
    assert.deepEqual(outsidePackage(r.modules), []);
    assert.ok(!r.modules.some((u) => /finali[sz]e/i.test(u)));
  });
  test('control negativo (PM6-04): un módulo cargado desde fuera del paquete es detectado', () => {
    const { dir } = makeTmp('x402-t06c-out-');
    const outside = path.join(dir, 'outside-module.mjs');
    copyFileSync(path.join(FIXTURES, 'pr6', 'outside-module.mjs'), outside);
    const r = runtimeModules(outside);
    assert.deepEqual(outsidePackage(r.modules), [outside]);
  });
});
