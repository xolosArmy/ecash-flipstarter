// D-4 (reentregas, T-14), D-5 (409 RECONCILIATION_REQUIRED con revisión humana) y M1/L-01
// (LATE_PAYMENT_REVIEW) sobre la DB del grant. Decisiones de Fernando 12:03, puntos 4 y 5.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, makeTmp } from './helpers.mjs';

const dist = (f) => pathToFileURL(path.join(PACKAGE_ROOT, 'dist', f)).href;
const { GrantDb, DEFAULT_REDELIVERY_MAX, DEFAULT_REDELIVERY_WINDOW_SECONDS } = await import(dist('grant-db.js'));
const { X402InvoiceStore } = await import(dist('invoice-store.js'));
const { ReadOnlyStoreReader } = await import(dist('store-reader.js'));

const hex = (c, n = 64) => c.repeat(n).slice(0, n);
let seq = 0;
function paid(txChar) {
  const t = String(++seq).padStart(4, '0');
  return { ok: true, invoice: { invoiceHash: hex(`a${t}`), nonce: hex(`b${t}`, 32), resourceHash: hex(`c${t}`), amountSats: 546n,
    payTo: `ecash:qsynthd4${t}`, network: 'xec:mainnet', scheme: 'exact', issuedAt: 1_000, expiresAt: 1_300, state: 'PAID', settledTxid: hex(txChar + t) } };
}
const fresh = (opts) => new GrantDb(path.join(makeTmp('x402-d4-').dir, 'grant.sqlite'), opts);

describe('D-4 / T-14: delivery_count cuenta solo reentregas (máx. 10 en 24 h)', () => {
  test('valores por defecto de Q-09: 10 y 86400', () => {
    assert.equal(DEFAULT_REDELIVERY_MAX, 10);
    assert.equal(DEFAULT_REDELIVERY_WINDOW_SECONDS, 86_400);
  });
  test('N=10: la primera entrega cuenta 0 y la 10.ª reentrega se acepta (delivery_count = 10)', () => {
    let now = 5_000;
    const g = fresh({ now: () => now });
    const s = paid('e');
    const first = g.recordGrant(s);
    assert.equal(first.status, 'GRANTED'); assert.equal(first.deliveryCount, 0);
    for (let i = 1; i <= 10; i++) {
      now += 1;
      const r = g.recordGrant(s);
      assert.equal(r.ok && r.status, 'EFFECT_REPLAYED', `reentrega ${i}`);
      assert.equal(r.deliveryCount, i); assert.equal(r.grantId, first.grantId);
    }
    assert.equal(g.deliveryCount(first.grantId), 10);
  });
  test('N=11: la 11.ª reentrega -> 410 TEYOLIA_X402_REDELIVERY_EXHAUSTED, sin efecto', () => {
    const g = fresh({ now: () => 5_000 });
    const s = paid('f');
    const first = g.recordGrant(s);
    for (let i = 1; i <= 10; i++) g.recordGrant(s);
    assert.deepEqual(g.recordGrant(s), { ok: false, httpStatus: 410, code: 'TEYOLIA_X402_REDELIVERY_EXHAUSTED' });
    assert.deepEqual(g.recordGrant(s).code, 'TEYOLIA_X402_REDELIVERY_EXHAUSTED', 'sigue agotado');
    assert.equal(g.deliveryCount(first.grantId), 10, 'el 410 no cambia la fila');
    assert.equal(g.countGrants(), 1);
  });
  for (const [label, dt, ok] of [['86399 s', 86_399, true], ['86400 s (límite exclusivo)', 86_400, false], ['86401 s', 86_401, false]]) {
    test(`ventana: reentrega a ${label} del primer acceso -> ${ok ? 'aceptada' : '410'}`, () => {
      let now = 7_000;
      const g = fresh({ now: () => now });
      const s = paid('9');
      const first = g.recordGrant(s);
      now = 7_000 + dt;
      const r = g.recordGrant(s);
      if (ok) assert.equal(r.status, 'EFFECT_REPLAYED');
      else assert.equal(r.code, 'TEYOLIA_X402_REDELIVERY_EXHAUSTED');
      assert.equal(g.deliveryCount(first.grantId), ok ? 1 : 0);
    });
  }
  test('negativo: configuración inválida de reentregas -> RangeError', () => {
    for (const o of [{ redeliveryMax: -1 }, { redeliveryMax: 1.5 }, { redeliveryWindowSeconds: 0 }]) assert.throws(() => fresh(o), RangeError);
  });
  test('un conflicto (txid distinto) no consume reentregas', () => {
    const g = fresh({ now: () => 5_000 });
    const s = paid('8');
    const first = g.recordGrant(s);
    assert.equal(g.recordGrant({ invoice: { ...s.invoice, settledTxid: hex('7') } }).code, 'EFFECT_BINDING_CONFLICT');
    assert.equal(g.deliveryCount(first.grantId), 0);
  });
});

describe('D-5: 409 RECONCILIATION_REQUIRED con revisión humana', () => {
  test('marcada -> todo grant posterior da 409, también repetido; la clase no expone forma de desmarcar', () => {
    let now = 2_000;
    const g = fresh({ now: () => now });
    const s = paid('6');
    now = 1_100 + 600;
    assert.deepEqual(g.reconcile({ listPaid: () => [{ invoiceHash: s.invoice.invoiceHash, settledTxid: s.invoice.settledTxid, settledAt: 1_100, issuedAt: 1_000, expiresAt: 1_300 }] }), [s.invoice.invoiceHash]);
    for (let i = 0; i < 3; i++) assert.deepEqual(g.recordGrant(s), { ok: false, httpStatus: 409, code: 'RECONCILIATION_REQUIRED' });
    assert.equal(g.countGrants(), 0);
    const methods = Object.getOwnPropertyNames(GrantDb.prototype);
    assert.equal(methods.filter((m) => /unmark|clear|resolve|approve|delete/i.test(m)).length, 0, 'la resolución es humana, fuera del proceso');
  });
  test('negativo: con grant previo la conciliación no marca y las reentregas siguen', () => {
    const g = fresh({ now: () => 9_999 });
    const s = paid('5');
    g.recordGrant(s);
    assert.deepEqual(g.reconcile({ listPaid: () => [{ invoiceHash: s.invoice.invoiceHash, settledTxid: s.invoice.settledTxid, settledAt: 1, issuedAt: 1_000, expiresAt: 1_300 }] }), []);
    assert.equal(g.recordGrant(s).status, 'EFFECT_REPLAYED');
  });
});

describe('M1 / L-01: LATE_PAYMENT_REVIEW sobre facturas ISSUED vencidas (lector de solo lectura + sonda inyectada)', () => {
  test('fondos tardíos en el payTo -> LATE_PAYMENT_REVIEW; sin fondos o aún vigente -> nada; sin grant', async () => {
    const dir = makeTmp('x402-l01-').dir;
    const store = new X402InvoiceStore(path.join(dir, 'store.sqlite'));
    const mk = (i, exp) => ({ invoiceHash: hex(`9${i}`), nonce: hex(`8${i}`, 32), resourceHash: hex('7'), amountSats: 546n, payTo: `ecash:qsynthl01${i}`,
      network: 'xec:mainnet', scheme: 'exact', issuedAt: 1_000, expiresAt: exp, state: 'ISSUED' });
    const funded = mk(1, 1_300); const empty = mk(2, 1_300); const live = mk(3, 5_000);
    for (const r of [funded, empty, live]) await store.issue(r);
    const g = new GrantDb(path.join(dir, 'grant.sqlite'), { now: () => 2_000 });
    const reader = new ReadOnlyStoreReader(path.join(dir, 'store.sqlite'));
    const probe = { hasFunds: (payTo) => payTo === funded.payTo || payTo === live.payTo };
    assert.deepEqual(await g.reviewLatePayments(reader.listExpiredIssued(2_000), probe), [funded.invoiceHash]);
    assert.equal(g.latePaymentState(funded.invoiceHash), 'LATE_PAYMENT_REVIEW');
    assert.equal(g.latePaymentState(empty.invoiceHash), null);
    assert.equal(g.latePaymentState(live.invoiceHash), null, 'vigente: no es pago tardío');
    assert.deepEqual(await g.reviewLatePayments(reader.listExpiredIssued(2_000), probe), [], 'idempotente');
    assert.equal(g.countGrants(), 0);
    assert.equal((await store.getByInvoiceHash(funded.invoiceHash)).state, 'ISSUED', 'el store no cambia');
    reader.close(); g.shutdown(); store.shutdown();
  });
});
