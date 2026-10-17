// Codex #66 r4299872959 (grant-db.ts:244): la revisión de pago tardío (LATE_PAYMENT_REVIEW) y
// recordGrant() se serializan en BEGIN IMMEDIATE sobre la misma DB del grant:
//   - con revisión ya marcada, recordGrant() -> 409 RECONCILIATION_REQUIRED sin conceder;
//   - con grant ya concedido, el escaneo no marca revisión (ni, por tanto, reembolso manual);
//   - una factura nunca queda en ambos estados.
// La carrera es determinista: el txProvider de fixtures retiene la liquidación (barrera
// inyectada) DESPUÉS del chequeo de expiración del verificador y ANTES de commitPaid/grant.
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { nextTxid, payingTx, proofHeader } from './fixtures/x402/chronik-fixtures.mjs';
import { issue, server, startApp } from './pr4-harness.mjs';
import { PACKAGE_ROOT, makeTmp } from './helpers.mjs';

const dist = (f) => pathToFileURL(path.join(PACKAGE_ROOT, 'dist', f)).href;
const { GrantDb } = await import(dist('grant-db.js'));
const { ReadOnlyStoreReader } = await import(dist('store-reader.js'));

const hex = (c, n = 64) => c.repeat(n).slice(0, n);
const RECON = Object.freeze({ ok: false, httpStatus: 409, code: 'RECONCILIATION_REQUIRED' });

function barrier() {
  let release; let entered;
  const gate = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { entered = r; });
  return { gate, reached, release: () => release(), enter: () => entered() };
}

/** Facturas con grant Y revisión de pago tardío a la vez (debe ser 0). */
function bothStates(grantPath) {
  const db = new DatabaseSync(grantPath, { readOnly: true });
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM x402_access_grant g JOIN x402_late_payment_review l ON l.invoice_hash = g.invoice_hash').get().n);
  } finally { db.close(); }
}

function settlement(tag) {
  return { ok: true, invoice: { invoiceHash: hex(`a${tag}`), nonce: hex(`b${tag}`, 32), resourceHash: hex('c'), amountSats: 546n, payTo: `ecash:qsynthc66h2${tag}`,
    network: 'xec:mainnet', scheme: 'exact', issuedAt: 1_000, expiresAt: 1_300, state: 'PAID', settledTxid: hex(`d${tag}`) } };
}

describe('Codex #66 H2: unidad (GrantDb)', () => {
  test('revisión marcada -> recordGrant 409 RECONCILIATION_REQUIRED, sin grant, también repetido', async () => {
    const p = path.join(makeTmp('x402-c66h2-').dir, 'grant.sqlite');
    const g = new GrantDb(p, { now: () => 2_000 });
    const s = settlement('1');
    assert.deepEqual(await g.reviewLatePayments([{ invoiceHash: s.invoice.invoiceHash, payTo: s.invoice.payTo, expiresAt: 1_300 }], { hasFunds: () => true }), [s.invoice.invoiceHash]);
    for (let i = 0; i < 3; i++) assert.deepEqual(g.recordGrant(s), RECON);
    assert.equal(g.countGrants(), 0);
    assert.equal(g.latePaymentState(s.invoice.invoiceHash), 'LATE_PAYMENT_REVIEW');
    assert.equal(bothStates(p), 0);
    g.shutdown();
  });
  test('negativo: grant previo -> el escaneo no marca revisión; las reentregas siguen', async () => {
    const p = path.join(makeTmp('x402-c66h2-').dir, 'grant.sqlite');
    const g = new GrantDb(p, { now: () => 2_000 });
    const s = settlement('2');
    assert.equal(g.recordGrant(s).status, 'GRANTED');
    assert.deepEqual(await g.reviewLatePayments([{ invoiceHash: s.invoice.invoiceHash, payTo: s.invoice.payTo, expiresAt: 1_300 }], { hasFunds: () => true }), []);
    assert.equal(g.latePaymentState(s.invoice.invoiceHash), null);
    assert.equal(g.recordGrant(s).status, 'EFFECT_REPLAYED');
    assert.equal(bothStates(p), 0);
    g.shutdown();
  });
  test('negativo: la revisión de otra factura no afecta a esta', async () => {
    const g = new GrantDb(path.join(makeTmp('x402-c66h2-').dir, 'grant.sqlite'), { now: () => 2_000 });
    const a = settlement('3'); const b = settlement('4');
    await g.reviewLatePayments([{ invoiceHash: a.invoice.invoiceHash, payTo: a.invoice.payTo, expiresAt: 1_300 }], { hasFunds: () => true });
    assert.equal(g.recordGrant(b).status, 'GRANTED');
    g.shutdown();
  });
});

describe('Codex #66 H2: carrera determinista settlement vs. escaneo (app real, barrera en el txProvider)', () => {
  test('escaneo marca mientras la liquidación está retenida -> la liquidación termina en 409, sin grant; nunca ambos estados', async () => {
    const h = await startApp();
    const { invoice, invoiceHash } = await issue(h);
    const b = barrier();
    const txid = nextTxid();
    const tx = { ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t }), txid };
    h.provider.set(txid, async () => { b.enter(); await b.gate; return tx; });
    const pending = h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(invoiceHash, txid) });
    await b.reached; // el verificador ya pasó el chequeo de expiración y espera a Chronik
    h.clock.t = invoice.expiresAt + 1; // la factura vence durante la espera
    const reader = new ReadOnlyStoreReader(path.join(h.dir, 'store.sqlite'));
    const expired = reader.listExpiredIssued(h.clock.t);
    assert.deepEqual(expired.map((e) => e.invoiceHash), [invoiceHash], 'el escaneo la ve ISSUED y vencida');
    assert.deepEqual(await h.grants.reviewLatePayments(expired, { hasFunds: (p) => p === invoice.payTo }), [invoiceHash]);
    b.release();
    const r = await pending;
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'RECONCILIATION_REQUIRED');
    assert.equal(h.grants.countGrants(), 0, 'sin grant');
    assert.equal(h.grants.latePaymentState(invoiceHash), 'LATE_PAYMENT_REVIEW');
    assert.equal((await h.store.getByInvoiceHash(invoiceHash)).state, 'PAID', 'upstream sí confirmó el pago');
    const again = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(invoiceHash, txid) });
    assert.equal(again.status, 409, 'el reintento idempotente tampoco concede');
    assert.equal(bothStates(path.join(h.dir, 'grant.sqlite')), 0);
    reader.close();
    await h.close();
  });

  test('orden inverso: el grant gana mientras la sonda está retenida -> el escaneo no marca; nunca ambos estados', async () => {
    const h = await startApp();
    const { invoice, invoiceHash } = await issue(h);
    const settle = barrier();
    const txid = nextTxid();
    const tx = { ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t }), txid };
    h.provider.set(txid, async () => { settle.enter(); await settle.gate; return tx; });
    const pending = h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(invoiceHash, txid) });
    await settle.reached;
    h.clock.t = invoice.expiresAt + 1;
    const reader = new ReadOnlyStoreReader(path.join(h.dir, 'store.sqlite'));
    const expired = reader.listExpiredIssued(h.clock.t);
    const probeGate = barrier();
    const scan = h.grants.reviewLatePayments(expired, { hasFunds: async (p) => { probeGate.enter(); await probeGate.gate; return p === invoice.payTo; } });
    await probeGate.reached; // el escaneo ya leyó la lista y espera a la sonda
    settle.release();
    const r = await pending;
    assert.equal(r.status, 200); assert.equal(r.json.status, 'GRANTED');
    probeGate.release();
    assert.deepEqual(await scan, [], 'con grant no se marca revisión ni reembolso');
    assert.equal(h.grants.latePaymentState(invoiceHash), null);
    assert.equal(bothStates(path.join(h.dir, 'grant.sqlite')), 0);
    reader.close();
    await h.close();
  });
});
