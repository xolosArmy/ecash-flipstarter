// PR-6a / P3-L3 (t117u; cuerpo de PR-3: «P3-L3: hardlink a campaigns.db»): una DB existente (store o
// grant) con nlink > 1 se rechaza fail-closed ANTES de abrir, crear o escribir nada. Orden en
// startServer: identidad de build (M5-V1 opción B, exit 78) -> validateAppConfig -> config de
// persistencia (aquí P3-L3) -> openPersistence. Control negativo: en la base 2b6d778 el hardlink se acepta.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CODEGEN_FLAG, PACKAGE_ROOT, baselineEnv, launch, makeTmp } from './helpers.mjs';

const DIST = path.join(PACKAGE_ROOT, 'dist');
const P = await import(pathToFileURL(path.join(DIST, 'persistence-config.js')).href);
const NLINK = /nlink > 1; P3-L3/;
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map((n) => [n, { sha: sha(path.join(dir, n)), nlink: statSync(path.join(dir, n)).nlink, mtimeMs: statSync(path.join(dir, n)).mtimeMs }]));

/** Directorio de datos con `legacy/campaigns.db` en otro directorio y `data/` para el proceso x402. */
function layout() {
  const root = makeTmp('x402-p3l3-').dir;
  const legacy = path.join(root, 'legacy'); const data = path.join(root, 'data');
  for (const d of [legacy, data]) mkdirSync(d);
  const legacyDb = path.join(legacy, 'campaigns.db');
  writeFileSync(legacyDb, 'SQLite format 3\0 contenido legacy ficticio');
  return { root, legacy, data, legacyDb };
}
const env = (data, extra = {}) => ({ TEYOLIA_X402_STORE_PATH: path.join(data, 'store.sqlite'), TEYOLIA_X402_GRANT_DB_PATH: path.join(data, 'grant.sqlite'), ...extra });

describe('P3-L3: readPersistenceConfig (unidad, dist/persistence-config.js)', () => {
  for (const which of ['store', 'grant']) {
    const variable = which === 'store' ? P.STORE_PATH_VAR : P.GRANT_DB_PATH_VAR;
    test(`${which}: hardlink a campaigns.db de otro directorio -> PersistenceConfigError (${variable}, nlink)`, () => {
      const { data, legacyDb } = layout();
      linkSync(legacyDb, path.join(data, `${which}.sqlite`));
      assert.throws(() => P.readPersistenceConfig(env(data)), (e) => e instanceof P.PersistenceConfigError && e.variable === variable && NLINK.test(e.reason));
    });
    test(`${which}: hardlink a un archivo cualquiera y symlink hacia un archivo con nlink 2 -> rechazo`, () => {
      const { root, data } = layout();
      const other = path.join(root, 'otro.sqlite'); writeFileSync(other, 'x');
      linkSync(other, path.join(data, `${which}.sqlite`));
      assert.throws(() => P.readPersistenceConfig(env(data)), (e) => e.variable === variable && NLINK.test(e.reason));
      const { data: d2 } = layout();
      symlinkSync(path.join(data, `${which}.sqlite`), path.join(d2, `${which}.sqlite`));
      assert.throws(() => P.readPersistenceConfig(env(d2)), (e) => e.variable === variable && NLINK.test(e.reason));
    });
  }
  test('control positivo: archivos inexistentes o existentes con nlink 1 -> aceptados', () => {
    const { data } = layout();
    assert.doesNotThrow(() => P.readPersistenceConfig(env(data)));
    writeFileSync(path.join(data, 'store.sqlite'), ''); writeFileSync(path.join(data, 'grant.sqlite'), '');
    assert.doesNotThrow(() => P.readPersistenceConfig(env(data)));
  });
  test('tras borrar el otro enlace (nlink vuelve a 1) se acepta: la regla mira nlink, no la historia', () => {
    const { root, data } = layout();
    const other = path.join(root, 'otro.sqlite'); writeFileSync(other, 'x');
    linkSync(other, path.join(data, 'store.sqlite'));
    assert.throws(() => P.readPersistenceConfig(env(data)));
    rmSync(other);
    assert.doesNotThrow(() => P.readPersistenceConfig(env(data)));
  });
});

// Copias de dist/ dentro del paquete (resuelven node_modules), como pr5.m5v1.no-start.
const base = mkdtempSync(path.join(PACKAGE_ROOT, '.p3l3-tmp-'));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const brokenIdentityDist = () => { const d = path.join(base, `d${n++}`, 'dist'); cpSync(DIST, d, { recursive: true }); writeFileSync(path.join(d, 'build-info.json'), '{'); return d; };

async function start(data, main) {
  const home = makeTmp('x402-p3l3-h-').dir;
  const e = { ...baselineEnv(home), TEYOLIA_X402_ENABLED: 'true', ...env(data) };
  return launch({ env: e, cwd: makeTmp('x402-cwd-').dir, execArgv: [CODEGEN_FLAG], ...(main ? { main } : {}) });
}

describe('P3-L3: proceso real (dist/main.js), fail-closed antes de persistir', () => {
  for (const which of ['store', 'grant']) {
    test(`ON con ${which}.sqlite = hardlink a campaigns.db -> exit 78; legacy intacto; sin -wal/-shm ni la otra DB`, async () => {
      const { data, legacy, legacyDb } = layout();
      linkSync(legacyDb, path.join(data, `${which}.sqlite`));
      const before = { legacy: snapshot(legacy), data: snapshot(data) };
      const r = await start(data);
      if (r.started) { await r.stop(); assert.fail('arrancó con un hardlink a campaigns.db'); }
      assert.equal(r.code, 78, r.stderr);
      const variable = which === 'store' ? 'TEYOLIA_X402_STORE_PATH' : 'TEYOLIA_X402_GRANT_DB_PATH';
      assert.match(r.stderr, new RegExp(`persistencia rechazada: ${variable} \\(archivo existente con más de un enlace duro \\(nlink > 1; P3-L3\\)\\)`));
      assert.match(r.stderr, /arranque abortado por la configuración de persistencia/);
      assert.deepEqual(snapshot(legacy), before.legacy, 'campaigns.db sin cambios (bytes, nlink, mtime)');
      assert.deepEqual(snapshot(data), before.data, 'directorio de datos sin archivos nuevos (-wal, -shm, la otra DB)');
    });
  }
  test('orden con M5-V1 opción B: identidad no válida + hardlink -> exit 78 por la identidad, sin llegar a la persistencia', async () => {
    const { data, legacy, legacyDb } = layout();
    linkSync(legacyDb, path.join(data, 'store.sqlite'));
    const before = { legacy: snapshot(legacy), data: snapshot(data) };
    const r = await start(data, path.join(brokenIdentityDist(), 'main.js'));
    if (r.started) { await r.stop(); assert.fail('arrancó'); }
    assert.equal(r.code, 78, r.stderr);
    assert.match(r.stderr, /identidad de build no válida \(.+\); arranque abortado/);
    assert.doesNotMatch(r.stderr, /persistencia rechazada/, 'la identidad se evalúa antes que la persistencia');
    assert.deepEqual(snapshot(legacy), before.legacy);
    assert.deepEqual(snapshot(data), before.data);
  });
  test('orden con validateAppConfig: configuración inválida + hardlink -> 78 por la configuración, antes que P3-L3', async () => {
    const { data, legacyDb } = layout();
    linkSync(legacyDb, path.join(data, 'store.sqlite'));
    const home = makeTmp('x402-p3l3-h-').dir;
    const e = { ...baselineEnv(home), TEYOLIA_X402_ENABLED: 'true', ...env(data), TEYOLIA_X402_EXPIRY_SECONDS: 'abc' };
    const r = await launch({ env: e, cwd: makeTmp('x402-cwd-').dir, execArgv: [CODEGEN_FLAG] });
    if (r.started) { await r.stop(); assert.fail('arrancó'); }
    assert.equal(r.code, 78, r.stderr);
    assert.match(r.stderr, /configuración rechazada/);
    assert.doesNotMatch(r.stderr, /persistencia rechazada/);
  });
  test('control positivo: misma disposición sin hardlink -> arranca y crea store y grant', async () => {
    const { data } = layout();
    const r = await start(data);
    assert.equal(r.started, true, r.stderr);
    await r.stop();
    const names = readdirSync(data);
    assert.ok(names.includes('store.sqlite') && names.includes('grant.sqlite'), names.join(','));
  });
});
