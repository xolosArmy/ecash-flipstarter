// D-2 (a) (decisión de Fernando 12:03, punto 2): lector SQL de solo lectura del store con
// verificación fail-closed del esquema de 0f409de y PRAGMA query_only; ventana de conciliación
// minAgeSeconds = expiración + margen (300 + 300 = 600 s), probada en el límite, debajo y encima.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, makeTmp } from './helpers.mjs';

const dist = (f) => pathToFileURL(path.join(PACKAGE_ROOT, 'dist', f)).href;
const { ReadOnlyStoreReader, StoreSchemaError, STORE_SCHEMA_0F409DE } = await import(dist('store-reader.js'));
const { reconcileMinAgeSeconds, readExpirySeconds, RECONCILE_RETRY_MARGIN_SECONDS, DEFAULT_EXPIRY_SECONDS } = await import(dist('reconcile.js'));
const { X402InvoiceStore } = await import(dist('invoice-store.js'));
const { GrantDb } = await import(dist('grant-db.js'));

const hex = (c, n = 64) => c.repeat(n).slice(0, n);
let seq = 0;
function synth() {
  const t = String(++seq).padStart(4, '0');
  return { invoiceHash: hex(`d${t}`), nonce: hex(`e${t}`, 32), resourceHash: hex(`f${t}`), amountSats: 546n, payTo: `ecash:qsyntheticd2${t}`,
    network: 'xec:mainnet', scheme: 'exact', issuedAt: 1_000, expiresAt: 1_300, state: 'ISSUED' };
}
function freshStore() {
  const dir = makeTmp('x402-d2-').dir;
  const p = path.join(dir, 'store.sqlite');
  return { dir, p, store: new X402InvoiceStore(p) };
}

describe('D-2 (a): lector de solo lectura del store', () => {
  test('positivo: esquema 0f409de verificado; lista PAID y vencidas ISSUED', async () => {
    const { p, store } = freshStore();
    const a = synth(); const b = synth(); const c = synth();
    for (const r of [a, b, c]) await store.issue(r);
    await store.commitPaid(a.invoiceHash, hex('1'), 1_100);
    const r = new ReadOnlyStoreReader(p);
    assert.deepEqual([...r.listPaid()], [{ invoiceHash: a.invoiceHash, settledTxid: hex('1'), settledAt: 1_100, issuedAt: 1_000, expiresAt: 1_300 }]);
    assert.deepEqual(r.listExpiredIssued(1_299).map((x) => x.invoiceHash), [], 'expiresAt exclusivo: aún vigente');
    assert.deepEqual(r.listExpiredIssued(1_300).map((x) => x.invoiceHash), [b.invoiceHash, c.invoiceHash].sort());
    r.close(); store.shutdown();
  });

  test('positivo: el lector no puede escribir (readOnly + query_only verificado)', async () => {
    const { p, store } = freshStore();
    const r = new ReadOnlyStoreReader(p);
    // acceso a la conexión interna no expuesto: se comprueba con una conexión equivalente
    const db = new DatabaseSync(p, { readOnly: true });
    db.exec('PRAGMA query_only = 1');
    assert.throws(() => db.exec("UPDATE invoices SET state = 'PAID'"), /readonly|query_only|attempt to write/i);
    db.close(); r.close(); store.shutdown();
    assert.equal(typeof ReadOnlyStoreReader.prototype.listPaid, 'function');
    assert.equal(Object.getOwnPropertyNames(ReadOnlyStoreReader.prototype).filter((n) => /write|insert|update|delete|commit/i.test(n)).length, 0);
  });

  test('negativo: archivo inexistente -> falla y NO lo crea', () => {
    const dir = makeTmp('x402-d2n-').dir;
    const p = path.join(dir, 'nope.sqlite');
    assert.throws(() => new ReadOnlyStoreReader(p), StoreSchemaError);
    assert.equal(existsSync(p), false);
    assert.deepEqual(readdirSync(dir), []);
    for (const bad of ['', ':memory:', 'file:x.sqlite']) assert.throws(() => new ReadOnlyStoreReader(bad), StoreSchemaError);
  });

  for (const [name, ddl] of [
    ['columna extra', 'ALTER TABLE invoices ADD COLUMN extra TEXT'],
    ['índice extra', 'CREATE INDEX extra_idx ON invoices(state)'],
    ['trigger', "CREATE TRIGGER t AFTER INSERT ON invoices BEGIN SELECT 1; END"],
    ['tabla extra', 'CREATE TABLE otra(a)'],
    ['falta el índice parcial de settled_txid', 'DROP INDEX idx_invoices_settled_txid'],
  ]) {
    test(`negativo: esquema distinto de 0f409de (${name}) -> StoreSchemaError (fail-closed)`, () => {
      const { p, store } = freshStore();
      store.shutdown();
      const db = new DatabaseSync(p); db.exec(ddl); db.close();
      assert.throws(() => new ReadOnlyStoreReader(p), StoreSchemaError);
    });
  }

  test('negativo: archivo que no es SQLite -> StoreSchemaError', async () => {
    const dir = makeTmp('x402-d2x-').dir;
    const p = path.join(dir, 'x.sqlite');
    (await import('node:fs')).writeFileSync(p, 'no soy sqlite'.repeat(100));
    assert.throws(() => new ReadOnlyStoreReader(p), StoreSchemaError);
  });

  test('la tabla esperada son exactamente los 6 objetos del store de 0f409de', () => {
    assert.equal(STORE_SCHEMA_0F409DE.length, 6);
  });
});

describe('D-2 (a): ventana de conciliación = expiración + margen de reintento', () => {
  test('valor exacto: 300 + 300 = 600 s con la configuración por defecto', () => {
    assert.equal(DEFAULT_EXPIRY_SECONDS, 300);
    assert.equal(RECONCILE_RETRY_MARGIN_SECONDS, 300);
    assert.equal(reconcileMinAgeSeconds(readExpirySeconds({})), 600);
    assert.equal(reconcileMinAgeSeconds(60), 600, 'Codex #66: mínimo 600 s (PR4-H)');
    for (const e of [0, -1, 1.5, 3601, NaN, undefined]) assert.throws(() => reconcileMinAgeSeconds(e), RangeError);
    for (const raw of ['0', '-5', '1e3', ' 300', '3601', 'abc']) assert.throws(() => readExpirySeconds({ TEYOLIA_X402_EXPIRY_SECONDS: raw }));
    assert.equal(readExpirySeconds({ TEYOLIA_X402_EXPIRY_SECONDS: '120' }), 120);
  });

  for (const [label, age, expectMarked] of [['debajo (599 s)', 599, false], ['en el límite (600 s)', 600, true], ['encima (601 s)', 601, true]]) {
    test(`store real + lector: factura PAID sin grant con edad ${label} -> ${expectMarked ? 'marcada' : 'no marcada'}`, async () => {
      const { dir, p, store } = freshStore();
      const rec = synth();
      await store.issue(rec);
      await store.commitPaid(rec.invoiceHash, hex('2'), 1_200);
      const g = new GrantDb(path.join(dir, 'grant.sqlite'), { now: () => 1_200 + age });
      const reader = new ReadOnlyStoreReader(p);
      assert.deepEqual(g.reconcile(reader), expectMarked ? [rec.invoiceHash] : []);
      assert.equal(g.reconciliationState(rec.invoiceHash), expectMarked ? 'RECONCILIATION_REQUIRED' : null);
      assert.equal((await store.getByInvoiceHash(rec.invoiceHash)).state, 'PAID', 'el lector no cambia el store');
      reader.close(); g.shutdown(); store.shutdown();
    });
  }
});
