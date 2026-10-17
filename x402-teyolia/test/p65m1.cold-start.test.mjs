// P65Δ-M1 (decisión de Fernando 12:03, punto 1): arranque en frío concurrente de openPersistence
// COMPLETO (store de facturas + DB del grant) contra archivos que no existen. Sin el parche del
// store (vendor fija WAL antes de busy_timeout) algún proceso falla con «database is locked» y
// openPersistence devuelve 'invalid'. Con el parche, todos abren y ambos archivos quedan en WAL.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, makeTmp } from './helpers.mjs';

const dist = (f) => pathToFileURL(path.join(PACKAGE_ROOT, 'dist', f)).href;
const K = 8;
const ROUNDS = 5;

function opener(dir, t0) {
  return new Promise((resolve) => {
    const code = `
      const { openPersistence } = await import(${JSON.stringify(dist('server.js'))});
      const env = { TEYOLIA_X402_ENABLED: 'true', TEYOLIA_X402_STORE_PATH: process.argv[1], TEYOLIA_X402_GRANT_DB_PATH: process.argv[2] };
      while (Date.now() < ${t0});
      const p = openPersistence(env);
      if (p === null || p === 'invalid') process.exit(3);
      p.grants.shutdown(); p.store.shutdown();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, path.join(dir, 'store.sqlite'), path.join(dir, 'grant.sqlite')], {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (c) => resolve({ code: c, err }));
  });
}

describe('P65Δ-M1: arranque en frío concurrente de openPersistence completo', () => {
  test(`${K} procesos x ${ROUNDS} rondas, store y grant nuevos -> todos abren; ambos en WAL con esquema`, async () => {
    for (let r = 0; r < ROUNDS; r++) {
      const dir = makeTmp('x402-p65m1-').dir;
      assert.equal(existsSync(path.join(dir, 'store.sqlite')), false);
      const t0 = Date.now() + 500;
      const res = await Promise.all(Array.from({ length: K }, () => opener(dir, t0)));
      const bad = res.filter((x) => x.code !== 0);
      assert.deepEqual(bad.map((x) => x.code), [], `ronda ${r}: ningún proceso falla (${bad[0]?.err.trim() ?? ''})`);
      for (const [f, table] of [['store.sqlite', 'invoices'], ['grant.sqlite', 'x402_access_grant']]) {
        const raw = new DatabaseSync(path.join(dir, f));
        assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal', f);
        assert.ok(raw.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table), `${f}: ${table}`);
        raw.close();
      }
    }
  });

  test('store: busy_timeout queda en 5000 antes de WAL y la constante de reintento es la compartida', async () => {
    const { X402InvoiceStore } = await import(dist('invoice-store.js'));
    const dir = makeTmp('x402-p65m1b-').dir;
    const s = new X402InvoiceStore(path.join(dir, 'store.sqlite'));
    assert.equal(s.busyTimeoutAtWal, 5000, 'busy_timeout leído justo antes de activar WAL');
    s.shutdown();
  });

  test('store: reintento agotado -> el constructor falla cerrado dentro del presupuesto y openPersistence da invalid', async () => {
    const { WAL_RETRY_BUDGET_MS } = await import(dist('sqlite-wal.js'));
    const dir = makeTmp('x402-p65m1c-').dir;
    const store = path.join(dir, 'store.sqlite');
    const holder = new DatabaseSync(store); // modo rollback; un lector con transacción abierta impide WAL
    holder.exec('CREATE TABLE h(a); INSERT INTO h VALUES (1); BEGIN;');
    holder.prepare('SELECT * FROM h').get();
    const t = Date.now();
    const res = await opener(dir, 0);
    const ms = Date.now() - t;
    holder.exec('COMMIT'); holder.close();
    assert.equal(res.code, 3, 'openPersistence -> invalid');
    assert.match(res.err, /persistencia rechazada/);
    assert.ok(ms >= WAL_RETRY_BUDGET_MS - 1000, `reintentó hasta agotar el presupuesto (${ms} ms)`);
    assert.ok(ms < WAL_RETRY_BUDGET_MS * 2 + 3000, `acotado (${ms} ms)`);
    assert.equal(existsSync(path.join(dir, 'grant.sqlite')), false, 'no se abre el grant si el store falla');
  });
});
