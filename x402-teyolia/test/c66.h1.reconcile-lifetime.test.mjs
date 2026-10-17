// Codex #66 r4299872954 (grant-db.ts:200): el umbral de conciliación se calcula POR FACTURA con su
// vida persistida (expires_at - issued_at) + margen, mínimo 600 s inclusivo (PR4-H), y no con el
// TEYOLIA_X402_EXPIRY_SECONDS vigente. Dato ausente o inválido -> fail-closed (ReconcileDataError,
// la pasada no marca nada). Los tests pasan además `{ expirySeconds }` vigente como lo hacía el
// llamador de 3285806: el head lo ignora; en 3285806 decide el umbral y el test falla (control).
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ON_ENV, issue, startApp } from './pr4-harness.mjs';
import { PACKAGE_ROOT, makeTmp } from './helpers.mjs';

const dist = (f) => pathToFileURL(path.join(PACKAGE_ROOT, 'dist', f)).href;
const { GrantDb } = await import(dist('grant-db.js'));
const { X402InvoiceStore } = await import(dist('invoice-store.js'));
const { ReadOnlyStoreReader } = await import(dist('store-reader.js'));
const reconcileMod = await import(dist('reconcile.js'));
const { reconcileMinAgeSeconds, RECONCILE_RETRY_MARGIN_SECONDS } = reconcileMod;

const hex = (c, n = 64) => c.repeat(n).slice(0, n);
let seq = 0;
function synth(issuedAt, lifetime) {
  const t = String(++seq).padStart(4, '0');
  return { invoiceHash: hex(`a${t}`), nonce: hex(`b${t}`, 32), resourceHash: hex(`c${t}`), amountSats: 546n, payTo: `ecash:qsynthc66h1${t}`,
    network: 'xec:mainnet', scheme: 'exact', issuedAt, expiresAt: issuedAt + lifetime, state: 'ISSUED' };
}

/** Factura emitida con `lifetime`, liquidada en `settledAt` y sin grant (fallo entre commitPaid y grant). */
async function paidWithoutGrant(lifetime, { issuedAt = 1_000, settledAt = 1_200 } = {}) {
  const dir = makeTmp('x402-c66h1-').dir;
  const sp = path.join(dir, 'store.sqlite');
  const store = new X402InvoiceStore(sp);
  const rec = synth(issuedAt, lifetime);
  await store.issue(rec);
  assert.equal((await store.commitPaid(rec.invoiceHash, hex('7'), settledAt)).ok, true);
  store.shutdown();
  return { dir, sp, rec, settledAt };
}

function reconcileAt({ dir, sp }, now, configuredExpiry) {
  const g = new GrantDb(path.join(dir, `grant-${now}.sqlite`), { now: () => now });
  const reader = new ReadOnlyStoreReader(sp);
  try {
    return { marked: g.reconcile(reader, { expirySeconds: configuredExpiry }), g };
  } finally {
    reader.close();
  }
}

describe('Codex #66 H1: umbral por factura = vida persistida + margen (mínimo 600 s inclusivo)', () => {
  test('la exportación ReconcileDataError existe (fail-closed tipado)', () => {
    assert.equal(typeof reconcileMod.ReconcileDataError, 'function');
    assert.equal(reconcileMod.RECONCILE_MIN_AGE_SECONDS, 600);
  });

  test('valor exacto del umbral: max(600, vida + 300); vida inválida -> RangeError', () => {
    assert.equal(RECONCILE_RETRY_MARGIN_SECONDS, 300);
    assert.equal(reconcileMinAgeSeconds(300), 600);
    assert.equal(reconcileMinAgeSeconds(3600), 3900);
    assert.equal(reconcileMinAgeSeconds(1), 600, 'mínimo 600 s');
    assert.equal(reconcileMinAgeSeconds(60), 600, 'mínimo 600 s');
    assert.equal(reconcileMinAgeSeconds(301), 601);
    for (const v of [0, -1, 1.5, 3601, NaN, undefined, '300']) assert.throws(() => reconcileMinAgeSeconds(v), RangeError);
  });

  test('listPaid() entrega issuedAt y expiresAt persistidos', async () => {
    const f = await paidWithoutGrant(3600);
    const reader = new ReadOnlyStoreReader(f.sp);
    assert.deepEqual([...reader.listPaid()], [{ invoiceHash: f.rec.invoiceHash, settledTxid: hex('7'), settledAt: 1_200, issuedAt: 1_000, expiresAt: 4_600 }]);
    reader.close();
  });

  // Factura de 3600 s y proceso reiniciado con 300 s: umbral 3900 s, no 600 s.
  for (const [age, expect] of [[599, false], [600, false], [601, false], [3_899, false], [3_900, true], [3_901, true]]) {
    test(`vida 3600 s, configuración vigente 300 s: edad ${age} s -> ${expect ? 'marca' : 'no marca'}`, async () => {
      const f = await paidWithoutGrant(3600);
      const { marked, g } = reconcileAt(f, f.settledAt + age, 300);
      assert.deepEqual(marked, expect ? [f.rec.invoiceHash] : []);
      assert.equal(g.reconciliationState(f.rec.invoiceHash), expect ? 'RECONCILIATION_REQUIRED' : null);
      g.shutdown();
    });
  }

  // Al revés: factura de 300 s con la configuración subida a 3600 s -> sigue en 600 s.
  for (const [age, expect] of [[599, false], [600, true], [601, true]]) {
    test(`vida 300 s, configuración vigente 3600 s: edad ${age} s -> ${expect ? 'marca' : 'no marca'} (PR4-H)`, async () => {
      const f = await paidWithoutGrant(300);
      const { marked, g } = reconcileAt(f, f.settledAt + age, 3600);
      assert.deepEqual(marked, expect ? [f.rec.invoiceHash] : []);
      g.shutdown();
    });
  }

  // Vida corta (60 s): el mínimo absoluto de 600 s manda.
  for (const [age, expect] of [[599, false], [600, true]]) {
    test(`vida 60 s, configuración vigente 60 s: edad ${age} s -> ${expect ? 'marca' : 'no marca'} (mínimo 600 s)`, async () => {
      const f = await paidWithoutGrant(60, { issuedAt: 1_000, settledAt: 1_030 });
      const { marked, g } = reconcileAt(f, f.settledAt + age, 60);
      assert.deepEqual(marked, expect ? [f.rec.invoiceHash] : []);
      g.shutdown();
    });
  }

  test('extremo a extremo: emitida por la app con TEYOLIA_X402_EXPIRY_SECONDS=3600, reinicio con 300 -> no marca a 600 s, marca a 3900 s', async () => {
    const h1 = await startApp({ env: { ...ON_ENV, TEYOLIA_X402_EXPIRY_SECONDS: '3600' } });
    const { invoice, invoiceHash } = await issue(h1);
    assert.equal(invoice.expiresAt - invoice.issuedAt, 3600);
    const settledAt = h1.clock.t + 10;
    assert.equal((await h1.store.commitPaid(invoiceHash, hex('8'), settledAt)).ok, true, 'fallo inyectado: commitPaid sin grant');
    await h1.close();
    const h2 = await startApp({ env: { ...ON_ENV, TEYOLIA_X402_EXPIRY_SECONDS: '300' }, dir: h1.dir });
    const reader = new ReadOnlyStoreReader(path.join(h1.dir, 'store.sqlite'));
    h2.clock.t = settledAt + 600;
    assert.deepEqual(h2.grants.reconcile(reader, { expirySeconds: 300 }), [], '600 s: todavía dentro de la vida de la factura');
    h2.clock.t = settledAt + 3_899;
    assert.deepEqual(h2.grants.reconcile(reader, { expirySeconds: 300 }), []);
    h2.clock.t = settledAt + 3_900;
    assert.deepEqual(h2.grants.reconcile(reader, { expirySeconds: 300 }), [invoiceHash]);
    reader.close();
    await h2.close();
  });
});

describe('Codex #66 H1: dato persistido ausente o inválido -> fail-closed (no marca nada)', () => {
  const base = { invoiceHash: hex('e'), settledTxid: hex('f'), settledAt: 1_000, issuedAt: 900, expiresAt: 1_200 };
  const good = { invoiceHash: hex('d'), settledTxid: hex('c'), settledAt: 1_000, issuedAt: 900, expiresAt: 1_200 };
  const bad = [
    ['issuedAt ausente', { issuedAt: undefined }],
    ['expiresAt ausente', { expiresAt: undefined }],
    ['issuedAt NaN', { issuedAt: NaN }],
    ['expiresAt texto', { expiresAt: '1200' }],
    ['vida 0 (expiresAt = issuedAt)', { expiresAt: 900 }],
    ['vida negativa', { expiresAt: 800 }],
    ['vida 3601', { expiresAt: 900 + 3_601 }],
    ['issuedAt fraccionario', { issuedAt: 900.5 }],
    ['settledAt NaN', { settledAt: NaN }],
  ];
  for (const [label, patch] of bad) {
    test(`${label} -> ReconcileDataError; la otra factura vencida tampoco se marca (rollback)`, () => {
      const g = new GrantDb(path.join(makeTmp('x402-c66h1n-').dir, 'grant.sqlite'), { now: () => 100_000 });
      const src = { listPaid: () => [good, { ...base, ...patch }] };
      assert.throws(() => g.reconcile(src, { expirySeconds: 300 }), (e) => e?.name === 'ReconcileDataError');
      assert.equal(g.reconciliationState(good.invoiceHash), null);
      assert.equal(g.reconciliationState(base.invoiceHash), null);
      g.shutdown();
    });
  }
  test('vida 3600 inclusiva es válida (límite superior)', () => {
    const g = new GrantDb(path.join(makeTmp('x402-c66h1n-').dir, 'grant.sqlite'), { now: () => 1_000 + 3_900 });
    assert.deepEqual(g.reconcile({ listPaid: () => [{ ...base, issuedAt: 900, expiresAt: 4_500 }] }, { expirySeconds: 300 }), [base.invoiceHash]);
    g.shutdown();
  });
  test('store real con expires_at corrupto (texto) -> el lector entrega NaN y la conciliación falla cerrada', async () => {
    const f = await paidWithoutGrant(300);
    const w = new DatabaseSync(f.sp);
    w.prepare('UPDATE invoices SET expires_at = ? WHERE invoice_hash = ?').run('no-es-entero', f.rec.invoiceHash);
    w.close();
    const reader = new ReadOnlyStoreReader(f.sp);
    assert.equal(Number.isNaN([...reader.listPaid()][0].expiresAt), true);
    const g = new GrantDb(path.join(f.dir, 'grant.sqlite'), { now: () => f.settledAt + 100_000 });
    assert.throws(() => g.reconcile(reader, { expirySeconds: 300 }), (e) => e?.name === 'ReconcileDataError');
    assert.equal(g.reconciliationState(f.rec.invoiceHash), null);
    reader.close(); g.shutdown();
  });
});
