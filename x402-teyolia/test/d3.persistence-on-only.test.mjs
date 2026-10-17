// D-3 (decisión de Fernando 12:03, punto 3): la persistencia solo funciona con el kill switch ON.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, makeTmp } from './helpers.mjs';

const { openPersistence } = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'server.js')).href);
const paths = (d) => ({ TEYOLIA_X402_STORE_PATH: path.join(d, 's.sqlite'), TEYOLIA_X402_GRANT_DB_PATH: path.join(d, 'g.sqlite') });

describe('D-3: persistencia solo con ON', () => {
  for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE', ' true']) {
    test(`negativo: TEYOLIA_X402_ENABLED=${JSON.stringify(v)} con rutas válidas -> null y ningún archivo`, () => {
      const d = makeTmp('x402-d3-').dir;
      const env = { ...paths(d), ...(v === undefined ? {} : { TEYOLIA_X402_ENABLED: v }) };
      assert.equal(openPersistence(env), null);
      assert.deepEqual(readdirSync(d), []);
    });
  }
  test('negativo: OFF con rutas inválidas -> null (ni siquiera se validan ni se tocan)', () => {
    assert.equal(openPersistence({ TEYOLIA_X402_STORE_PATH: ':memory:', TEYOLIA_X402_GRANT_DB_PATH: 'relativa.db' }), null);
  });
  test('positivo: ON -> store y grant abiertos en sus archivos; ON sin rutas -> invalid', () => {
    const d = makeTmp('x402-d3p-').dir;
    const p = openPersistence({ TEYOLIA_X402_ENABLED: 'true', ...paths(d) });
    assert.ok(p && p !== 'invalid');
    assert.ok(existsSync(path.join(d, 's.sqlite')) && existsSync(path.join(d, 'g.sqlite')));
    p.grants.shutdown(); p.store.shutdown();
    assert.equal(openPersistence({ TEYOLIA_X402_ENABLED: 'true' }), 'invalid');
  });
  test('negativo: ON con reentregas mal configuradas -> invalid (fail-closed, D-4)', () => {
    const d = makeTmp('x402-d3r-').dir;
    for (const [k, v] of [['TEYOLIA_X402_REDELIVERY_MAX', '-1'], ['TEYOLIA_X402_REDELIVERY_WINDOW_SECONDS', '0'], ['TEYOLIA_X402_REDELIVERY_MAX', 'diez']]) {
      assert.equal(openPersistence({ TEYOLIA_X402_ENABLED: 'true', ...paths(d), [k]: v }), 'invalid', `${k}=${v}`);
    }
  });
});
