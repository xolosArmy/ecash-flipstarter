// PR-4: vectores de INF-042 §11 sobre la app real (createApp) con el middleware vendorizado,
// store SQLite durable, allocator xpub de prueba y Chronik por fixtures (DEC-AX-09 (a)).
// Sin red (solo loopback), sin llaves, sin fondos; kill switch ON solo aquí (DEC-AX-08 (a)).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HDKey } from '@scure/bip32';
import ecashaddr from 'ecashaddrjs';
import { computeInvoiceHash, computeResourceHash } from '@x402-xec/core';
import { decodePaymentOfferHeader } from '@x402-xec/express';
import { AMOUNT, FixtureTxProvider, TEST_XPUB, nextTxid, payingTx, proofHeader } from './fixtures/x402/chronik-fixtures.mjs';
import { ON_ENV, issue, server, startApp } from './pr4-harness.mjs';

const VECTOR = '7975d9022ee66b131c0ca3fae24ce5b7ddde46f56ac2e3a78e73720649770854';
const BLOCK = (ts) => ({ height: 900_000, hash: 'ab'.repeat(32), timestamp: ts });

async function paidFlow(h, opts = {}) {
  const { invoice, invoiceHash } = await issue(h, opts.route);
  const txid = h.provider.set(nextTxid(), payingTx({ txid: '', payTo: invoice.payTo, timeFirstSeen: h.clock.t, ...opts.tx }));
  h.provider.set(txid, { ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t, ...opts.tx }), txid });
  return { invoice, invoiceHash, txid, proof: proofHeader(invoiceHash, txid) };
}

describe('§11.1 Aceptación', () => {
  test('A-01: factura emitida + tx final con output exacto -> 200 UNLOCKED, GRANTED, delivery_count = 0 (D-4: solo reentregas)', async () => {
    const h = await startApp();
    const { proof, invoiceHash } = await paidFlow(h);
    const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'GRANTED');
    assert.equal(r.json.deliveryCount, 0);
    assert.equal((await h.store.getByInvoiceHash(invoiceHash)).state, 'PAID');
    assert.equal(h.grants.countGrants(), 1);
    await h.close();
  });
  test('A-02: sin bloque con isFinal; o con bloque sin isFinal -> 200', async () => {
    const h = await startApp();
    for (const tx of [{ isFinal: true }, { isFinal: false, block: BLOCK(h.clock.t) }]) {
      const { proof } = await paidFlow(h, { tx });
      assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof })).status, 200);
    }
    await h.close();
  });
  test('A-03: primer intento no final (402 sin PAID), reintento final -> 200', async () => {
    const h = await startApp();
    const { invoice, invoiceHash } = await issue(h);
    let final = false;
    const txid = h.provider.set(nextTxid(), () => ({ ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t, isFinal: final }), txid }));
    const p = proofHeader(invoiceHash, txid);
    const r1 = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': p });
    assert.equal(r1.status, 402); assert.equal(r1.json.error, 'TRANSACTION_NOT_FINAL');
    assert.equal((await h.store.getByInvoiceHash(invoiceHash)).state, 'ISSUED');
    final = true;
    assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': p })).status, 200);
    await h.close();
  });
  test('A-04: GET sin prueba -> 402, payment-required, oferta decodificable, accepts = 1, invoiceId = hash', async () => {
    const h = await startApp();
    const { res } = await issue(h);
    assert.equal(res.status, 402);
    assert.equal(res.headers['payment-required'], 'true');
    const offer = decodePaymentOfferHeader(res.headers['x-x402-payment-offer']);
    assert.equal(offer.accepts.length, 1);
    assert.equal(offer.invoiceId, computeInvoiceHash(offer.invoice));
    assert.equal(offer.invoice.amountSats, AMOUNT);
    assert.equal(offer.invoice.expiresAt - offer.invoice.issuedAt, 300, 'expirySeconds = 300 (RQ-10)');
    await h.close();
  });
  test('A-05: HEAD sin prueba -> 402 con la oferta en la cabecera', async () => {
    const h = await startApp();
    const r = await h.req('HEAD', server.DEMO_ROUTE);
    assert.equal(r.status, 402);
    assert.ok(decodePaymentOfferHeader(r.headers['x-x402-payment-offer']).invoiceId);
    assert.equal(r.body, '');
    await h.close();
  });
});

describe('§11.2 Rechazo (sin grant)', () => {
  const cases = [
    ['R-01 txid inexistente', 402, 'TX_NOT_FOUND', (h, inv) => ({ txid: nextTxid() })],
    ['R-02 output a otro destino', 402, 'PAY_TO_MISMATCH', (h, inv) => ({ tx: { payTo: ecashaddr.encodeCashAddress('ecash', 'p2pkh', '11'.repeat(20)) } })],
    ['R-03 monto menor', 402, 'AMOUNT_MISMATCH', () => ({ tx: { sats: BigInt(AMOUNT) - 1n } })],
    ['R-03 monto mayor (exact)', 402, 'AMOUNT_MISMATCH', () => ({ tx: { sats: BigInt(AMOUNT) + 1n } })],
    ['R-07 Chronik caída', 502, 'CHRONIK_UNAVAILABLE', () => ({ raw: 'UNAVAILABLE' })],
    ['R-08 Chronik malformada', 502, 'MALFORMED_CHRONIK_TX', () => ({ raw: { txid: 'x', outputs: 'no' } })],
    ['R-09 ni bloque ni final', 402, 'TRANSACTION_NOT_FINAL', () => ({ tx: { isFinal: false } })],
  ];
  for (const [name, status, code, mk] of cases) {
    test(`${name} -> ${status} ${code}`, async () => {
      const h = await startApp();
      const { invoice, invoiceHash } = await issue(h);
      const o = mk(h, invoice);
      let txid = o.txid ?? nextTxid();
      if (!o.txid) h.provider.set(txid, o.raw ?? { ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t, ...(o.tx ?? {}) }), txid });
      const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(invoiceHash, txid) });
      assert.equal(r.status, status); assert.equal(r.json.error, code);
      assert.equal((await h.store.getByInvoiceHash(invoiceHash)).state, 'ISSUED');
      assert.equal(h.grants.countGrants(), 0);
      await h.close();
    });
  }
  test('R-04 / R-05: invoiceHash no emitido por este servidor (o factura fabricada) -> 402 INVOICE_NOT_FOUND', async () => {
    const h = await startApp();
    const txid = h.provider.set(nextTxid(), 'UNAVAILABLE');
    const fake = computeInvoiceHash({ x402Version: 1, scheme: 'exact', network: 'xec:mainnet', resourceHash: VECTOR, amountSats: AMOUNT,
      payTo: 'ecash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', nonce: 'A'.repeat(32), issuedAt: h.clock.t, expiresAt: h.clock.t + 300 });
    for (const ih of ['0'.repeat(64), fake]) {
      const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(ih, txid) });
      assert.equal(r.status, 402); assert.equal(r.json.error, 'INVOICE_NOT_FOUND');
    }
    assert.equal(h.provider.calls, 0, 'no consulta Chronik');
    assert.equal(h.grants.countGrants(), 0);
    await h.close();
  });
  test('R-06 factura vencida sin pago previo -> 402 INVOICE_EXPIRED', async () => {
    const h = await startApp();
    const { proof } = await paidFlow(h);
    h.clock.t += 300;
    const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    assert.equal(r.status, 402); assert.equal(r.json.error, 'INVOICE_EXPIRED');
    assert.equal(h.grants.countGrants(), 0);
    await h.close();
  });
  test('R-10 / R-11 / R-12: campo extra, dos alias, versión 2 o red distinta -> 400 MALFORMED_PROOF', async () => {
    const h = await startApp();
    const { invoiceHash, txid, proof } = await paidFlow(h);
    const bad = [
      { 'payment-proof': proofHeader(invoiceHash, txid, { vout: 0 }) },
      { 'payment-proof': proofHeader(invoiceHash, txid, { signature: 'x' }) },
      { 'payment-proof': proof, 'settlement-proof': proof },
      { 'payment-proof': proofHeader(invoiceHash, txid, { x402Version: 2 }) },
      { 'payment-proof': proofHeader(invoiceHash, txid, { network: 'xec:testnet' }) },
      { 'payment-proof': 'no-es-base64url!' },
    ];
    for (const hd of bad) {
      const r = await h.req('GET', server.DEMO_ROUTE, hd);
      assert.equal(r.status, 400, JSON.stringify(hd)); assert.equal(r.json.error, 'MALFORMED_PROOF');
    }
    assert.equal(h.grants.countGrants(), 0);
    await h.close();
  });
  test('R-13: prueba válida presentada en otra ruta protegida -> 400 RESOURCE_MISMATCH', async () => {
    const h = await startApp();
    const { proof } = await paidFlow(h);
    const r = await h.req('GET', server.DEMO_ALT_ROUTE, { 'payment-proof': proof });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'RESOURCE_MISMATCH');
    await h.close();
  });
  test('R-14: kill switch OFF (aun con adaptadores) -> 503 TEYOLIA_X402_DISABLED; sin factura ni fila', async () => {
    for (const v of [undefined, 'false', '1', 'yes', 'TRUE']) {
      const env = v === undefined ? {} : { TEYOLIA_X402_ENABLED: v };
      const h = await startApp({ env });
      for (const m of ['GET', 'HEAD', 'POST']) {
        const r = await h.req(m, server.DEMO_ROUTE);
        assert.equal(r.status, 503, `${v} ${m}`);
        if (m !== 'HEAD') assert.equal(r.json.error, 'TEYOLIA_X402_DISABLED');
      }
      assert.equal(h.store.countActiveIssued(0), 0);
      assert.equal(h.provider.calls, 0);
      await h.close();
    }
  });
  test('R-15: middleware con store no durable o sin allocator (fuera de test) -> lanza al construir', async () => {
    const { createX402SettlementMiddleware } = await import('@x402-xec/express');
    const { InMemoryAuthoritativeInvoiceStore } = await import('@x402-xec/core');
    const base = { publicOrigin: 'https://api.teyolia.cash', routes: { 'GET /x': { amountSats: '1' } }, txProvider: new FixtureTxProvider() };
    assert.throws(() => createX402SettlementMiddleware({ ...base, store: new InMemoryAuthoritativeInvoiceStore(), payTo: 'ecash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' }), /durable/);
    const h = await startApp({ withAdapters: false });
    assert.throws(() => createX402SettlementMiddleware({ ...base, store: h.store }), /payToAllocator/);
    await h.close();
  });
});

describe('§11.3 Replay', () => {
  test('P-R1: misma (invoiceHash, txid) repetida, también tras expiresAt -> 200, mismo grant_id, delivery_count +1', async () => {
    const h = await startApp();
    const { proof } = await paidFlow(h);
    const a = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    h.clock.t += 301;
    const b = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    assert.equal(b.status, 200); assert.equal(b.json.status, 'EFFECT_REPLAYED');
    assert.equal(b.json.grantId, a.json.grantId); assert.equal(b.json.deliveryCount, 1);
    assert.equal(h.grants.countGrants(), 1);
    await h.close();
  });
  test('P-R2: misma factura con un segundo txid -> 409 TXID_CONFLICT; grant original intacto', async () => {
    const h = await startApp();
    const { invoice, invoiceHash, proof } = await paidFlow(h);
    const a = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    const t2 = h.provider.set(nextTxid(), null);
    h.provider.set(t2, { ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t }), txid: t2 });
    const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(invoiceHash, t2) });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'TXID_CONFLICT');
    assert.equal(h.grants.deliveryCount(a.json.grantId), 0);
    await h.close();
  });
  test('P-R3: mismo txid para otra factura -> 409 TXID_REUSED; sin segundo grant', async () => {
    const h = await startApp();
    const one = await issue(h);
    const two = await issue(h);
    const { cashAddressToOutputScriptHex } = await import('@x402-xec/core');
    const txid = h.provider.set(nextTxid(), null);
    h.provider.set(txid, { ...payingTx({ payTo: one.invoice.payTo, timeFirstSeen: h.clock.t,
      extraOutputs: [{ sats: BigInt(AMOUNT), outputScript: cashAddressToOutputScriptHex(two.invoice.payTo) }] }), txid });
    assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(one.invoiceHash, txid) })).status, 200);
    const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(two.invoiceHash, txid) });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'TXID_REUSED');
    assert.equal(h.grants.countGrants(), 1);
    await h.close();
  });
  test('P-R4: pruebas concurrentes para la misma factura -> exactamente un GRANTED y un grant', async () => {
    const h = await startApp();
    const { proof } = await paidFlow(h);
    const rs = await Promise.all(Array.from({ length: 6 }, () => h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(rs.filter((r) => r.json.status === 'GRANTED').length, 1);
    assert.equal(new Set(rs.map((r) => r.json.grantId)).size, 1);
    assert.equal(h.grants.countGrants(), 1);
    await h.close();
  });
  test('P-R5: reutilizar un nonce al emitir -> el store lanza NONCE_ALREADY_USED', async () => {
    const h = await startApp();
    const { invoice } = await issue(h);
    await assert.rejects(h.store.issue({ ...invoice, invoiceHash: '1'.repeat(64), amountSats: 1n, payTo: 'ecash:qother', state: 'ISSUED', derivationIndex: 999 }), (e) => e.code === 'NONCE_ALREADY_USED');
    await h.close();
  });
  test('P-R6: reinicio entre P-R1 y su repetición -> mismo grant_id (store y grant durables)', async () => {
    const provider = new FixtureTxProvider();
    const h = await startApp({ provider });
    const { proof } = await paidFlow(h);
    const a = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    const t = h.clock.t;
    await h.close();
    const h2 = await startApp({ provider, dir: h.dir, start: t + 5 });
    const b = await h2.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    assert.equal(b.status, 200); assert.equal(b.json.grantId, a.json.grantId); assert.equal(b.json.status, 'EFFECT_REPLAYED');
    await h2.close();
  });
});

describe('§11.4 T-09 y G-01 en la app', () => {
  test('T-09: excepción del store inyectada en el middleware -> 500 controlado; el proceso sigue vivo', async () => {
    const h = await startApp();
    const orig = h.store.issueWithAllocation.bind(h.store);
    h.store.issueWithAllocation = async () => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; };
    const r = await h.req('GET', server.DEMO_ROUTE);
    assert.equal(r.status, 500); assert.equal(r.json.error, 'internal_error');
    h.store.issueWithAllocation = async () => { const { InvoiceStoreError } = await import('@x402-xec/core'); throw new InvoiceStoreError('NONCE_ALREADY_USED', 'x'); };
    assert.equal((await h.req('GET', server.DEMO_ROUTE)).status, 500);
    h.store.issueWithAllocation = orig;
    assert.equal((await h.req('GET', server.DEMO_ROUTE)).status, 402, 'sigue atendiendo');
    await h.close();
  });
});

describe('§11.5 canonicalización en la app real', () => {
  test('GET sin cuerpo en /x402/v1/access/demo con origen https://api.teyolia.cash -> resourceHash = vector', async () => {
    const h = await startApp();
    const { invoice, res } = await issue(h);
    assert.equal(invoice.resourceHash, VECTOR);
    assert.equal(computeResourceHash(res.json.resource), VECTOR);
    await h.close();
  });
});

describe('§11.6 Frontera de capacidades y T-17', () => {
  test('C-03 / T-17: matriz kill switch x adaptadores -> el anuncio coincide siempre con la ruta; sin llamadas fuera', async () => {
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (...a) => { fetches += 1; return realFetch(...a); };
    try {
      for (const env of [{}, ON_ENV]) {
        for (const withAdapters of [false, true]) {
          const h = await startApp({ env, withAdapters });
          const cap = await h.req('GET', server.CAPABILITIES_ROUTE);
          const route = await h.req('GET', server.DEMO_ROUTE);
          assert.equal(cap.json.capabilities.x402Access, route.status === 402, JSON.stringify({ env, withAdapters }));
          assert.equal(cap.json.capabilities.x402Access, env === ON_ENV && withAdapters);
          assert.equal('monetary' in cap.json.capabilities, false, 'x402 no anuncia ni enciende lo monetario legacy');
          await h.close();
        }
      }
    } finally { globalThis.fetch = realFetch; }
    assert.equal(fetches, 0, 'el proceso x402 no llama al legacy');
  });
  test('C-01 / C-02: TEYOLIA_MONETARY_FLOWS_ENABLED no existe para el proceso x402 (el guard lo rechaza, regla A)', async () => {
    const { evaluateStartup } = await import('../dist/env-guard.js');
    for (const v of ['true', 'false']) {
      const r = evaluateStartup({ env: { TEYOLIA_MONETARY_FLOWS_ENABLED: v, TEYOLIA_X402_LISTEN: '0', NODE_ENV: 'test' }, execArgv: [], cwd: '/', listCwd: () => [] });
      assert.equal(r.ok, false);
      assert.deepEqual(r.rejections.find((x) => x.name === 'TEYOLIA_MONETARY_FLOWS_ENABLED'), { name: 'TEYOLIA_MONETARY_FLOWS_ENABLED', rule: 'A' });
    }
  });
  test('C-05: Chronik que discrepa en isFinal entre consultas -> nunca 200 sin finalidad', async () => {
    const h = await startApp();
    const { invoice, invoiceHash } = await issue(h);
    const txid = h.provider.set(nextTxid(), (call) => ({ ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t, isFinal: call % 2 === 0 }), txid }));
    for (let i = 0; i < 4; i++) {
      const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(invoiceHash, txid) });
      if (r.status === 200) assert.equal(h.provider.calls % 2, 0, '200 solo en la consulta final');
      else { assert.equal(r.status, 402); assert.equal(r.json.error, 'TRANSACTION_NOT_FINAL'); }
    }
    await h.close();
  });
});

describe('§11.7 W-01, W-02, L-01, B-01', () => {
  test('W-01: facturas hasta derivation_index > 100; se paga la 102.ª; payTo = xpub/i; gap 20–100 no la ve', async () => {
    const env = { ...ON_ENV, TEYOLIA_X402_RATE_PER_IP: '500', TEYOLIA_X402_RATE_GLOBAL: '500', TEYOLIA_X402_MAX_ISSUED: '500' };
    const h = await startApp({ env });
    let last;
    for (let i = 0; i <= 101; i++) last = await issue(h);
    const rec = await h.store.getByInvoiceHash(last.invoiceHash);
    assert.equal(rec.derivationIndex, 101);
    const child = HDKey.fromExtendedKey(TEST_XPUB).deriveChild(101);
    assert.equal(last.invoice.payTo, ecashaddr.encodeCashAddress('ecash', 'p2pkh', Buffer.from(child.identifier).toString('hex')));
    const scan = (gap) => Array.from({ length: gap }, (_, i) => ecashaddr.encodeCashAddress('ecash', 'p2pkh', Buffer.from(HDKey.fromExtendedKey(TEST_XPUB).deriveChild(i).identifier).toString('hex')));
    assert.equal(scan(20).includes(last.invoice.payTo), false);
    assert.equal(scan(100).includes(last.invoice.payTo), false, 'hueco de RMZWallet 424072e documentado');
    assert.equal(scan(102).includes(last.invoice.payTo), true, 'escaneo hasta el índice máximo del store');
    const txid = h.provider.set(nextTxid(), null);
    h.provider.set(txid, { ...payingTx({ payTo: last.invoice.payTo, timeFirstSeen: h.clock.t }), txid });
    assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(last.invoiceHash, txid) })).status, 200);
    await h.close();
  });
  test('W-02 / T-15: tope de ISSUED vigentes -> 429 sin fila ni índice consumido', async () => {
    const env = { ...ON_ENV, TEYOLIA_X402_MAX_ISSUED: '3', TEYOLIA_X402_RATE_PER_IP: '100', TEYOLIA_X402_RATE_GLOBAL: '100' };
    const h = await startApp({ env });
    for (let i = 0; i < 3; i++) assert.equal((await issue(h)).res.status, 402);
    const next = await h.store.getNextDerivationIndex();
    const r = await h.req('GET', server.DEMO_ROUTE);
    assert.equal(r.status, 429); assert.equal(r.json.error, 'TEYOLIA_X402_ISSUANCE_LIMITED');
    assert.equal(await h.store.getNextDerivationIndex(), next, 'índice no consumido');
    assert.equal(h.store.countActiveIssued(h.clock.t), 3);
    h.clock.t += 300;
    assert.equal((await issue(h)).res.status, 402, 'al vencer, el tope se libera');
    await h.close();
  });
  test('L-01: tx con output exacto que llega tras expiresAt -> 402 INVOICE_EXPIRED, sin grant; la revisión marca LATE_PAYMENT_REVIEW', async () => {
    const { ReadOnlyStoreReader } = await import('../dist/store-reader.js');
    const path = await import('node:path');
    const h = await startApp();
    const { invoice, invoiceHash } = await issue(h);
    h.clock.t += 400;
    const txid = h.provider.set(nextTxid(), null);
    h.provider.set(txid, { ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t }), txid });
    const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(invoiceHash, txid) });
    assert.equal(r.status, 402); assert.equal(r.json.error, 'INVOICE_EXPIRED');
    const reader = new ReadOnlyStoreReader(path.join(h.dir, 'store.sqlite'));
    const probe = { hasFunds: (payTo) => payTo === invoice.payTo };
    assert.deepEqual(await h.grants.reviewLatePayments(reader.listExpiredIssued(h.clock.t), probe), [invoiceHash]);
    assert.equal(h.grants.latePaymentState(invoiceHash), 'LATE_PAYMENT_REVIEW');
    assert.equal(h.grants.countGrants(), 0);
    reader.close();
    await h.close();
  });
  test('B-01 x T-14: la misma prueba desde un segundo cliente tras expiresAt -> 200 hasta 10 reentregas; la 11.ª -> 410', async () => {
    const h = await startApp();
    const { proof } = await paidFlow(h);
    assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof })).json.status, 'GRANTED');
    h.clock.t += 301;
    for (let i = 1; i <= 10; i++) {
      const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof, 'x-client': 'segundo' });
      assert.equal(r.status, 200); assert.equal(r.json.deliveryCount, i);
    }
    const r11 = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    assert.equal(r11.status, 410); assert.equal(r11.json.error, 'TEYOLIA_X402_REDELIVERY_EXHAUSTED');
    assert.equal(r11.body.includes(proof), false, 'la respuesta no repite la prueba');
    await h.close();
  });
  test('T-14: reentrega pasadas 24 h del primer acceso -> 410', async () => {
    const h = await startApp();
    const { proof } = await paidFlow(h);
    await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    h.clock.t += 86_400;
    const r = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proof });
    assert.equal(r.status, 410); assert.equal(r.json.error, 'TEYOLIA_X402_REDELIVERY_EXHAUSTED');
    await h.close();
  });
});

describe('T-15 rate limit de emisión (solo peticiones sin prueba) y T-19 proxy de confianza', () => {
  test('T-15: 10/min por IP -> la 11.ª da 429 sin fila; con prueba no consume cupo; la ventana siguiente reabre', async () => {
    const h = await startApp();
    for (let i = 0; i < 10; i++) assert.equal((await issue(h)).res.status, 402);
    const idx = await h.store.getNextDerivationIndex();
    const r = await h.req('GET', server.DEMO_ROUTE);
    assert.equal(r.status, 429); assert.equal(r.json.error, 'TEYOLIA_X402_ISSUANCE_LIMITED');
    assert.equal(await h.store.getNextDerivationIndex(), idx);
    const withProof = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader('0'.repeat(64), '1'.repeat(64)) });
    assert.equal(withProof.status, 402, 'con prueba: no limitada (INVOICE_NOT_FOUND)'); assert.equal(withProof.json.error, 'INVOICE_NOT_FOUND');
    h.clock.t += 60;
    assert.equal((await issue(h)).res.status, 402);
    await h.close();
  });
  test('T-15: 120/min global con varias IPs (proxy de confianza loopback) -> la 121.ª da 429', async () => {
    const env = { ...ON_ENV, TEYOLIA_X402_TRUST_PROXY: 'loopback', TEYOLIA_X402_MAX_ISSUED: '1000' };
    const h = await startApp({ env });
    for (let i = 0; i < 120; i++) {
      const r = await h.req('GET', server.DEMO_ROUTE, { 'x-forwarded-for': `198.51.100.${i % 20}` });
      assert.equal(r.status, 402, `petición ${i}`);
    }
    const r = await h.req('GET', server.DEMO_ROUTE, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(r.status, 429);
    await h.close();
  });
  test('T-19: X-Forwarded-For falso desde origen no confiable -> el límite usa la IP real', async () => {
    for (const trust of [undefined, '10.0.0.1']) {
      const env = { ...ON_ENV, ...(trust ? { TEYOLIA_X402_TRUST_PROXY: trust } : {}) };
      const h = await startApp({ env });
      for (let i = 0; i < 10; i++) assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'x-forwarded-for': `198.51.100.${i}` })).status, 402);
      assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'x-forwarded-for': '198.51.100.250' })).status, 429, `trust=${trust}`);
      await h.close();
    }
  });
  test('T-19 (positivo): desde el proxy de confianza (loopback) la cabecera sí se usa por IP', async () => {
    const h = await startApp({ env: { ...ON_ENV, TEYOLIA_X402_TRUST_PROXY: 'loopback' } });
    for (let i = 0; i < 10; i++) await h.req('GET', server.DEMO_ROUTE, { 'x-forwarded-for': '198.51.100.1' });
    assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'x-forwarded-for': '198.51.100.1' })).status, 429);
    assert.equal((await h.req('GET', server.DEMO_ROUTE, { 'x-forwarded-for': '198.51.100.2' })).status, 402, 'otra IP real');
    await h.close();
  });
  test('T-19 (negativo): TEYOLIA_X402_TRUST_PROXY no válido -> createApp lanza (fail-closed)', async () => {
    const { TrustProxyConfigError } = await import('../dist/trust-proxy.js');
    for (const v of ['true', '1', '10.0.0.0/8', 'proxy.local', 'loopback,,']) {
      assert.throws(() => server.createApp({ TEYOLIA_X402_TRUST_PROXY: v }), TrustProxyConfigError, v);
    }
  });
});

describe('PR4-A: el proceso real sin adaptadores sigue en 503', () => {
  test('ON sin adaptadores inyectados -> 503 TEYOLIA_X402_NOT_IMPLEMENTED y anuncio x402Access = false', async () => {
    const h = await startApp({ withAdapters: false });
    const r = await h.req('GET', server.DEMO_ROUTE);
    assert.equal(r.status, 503); assert.equal(r.json.error, 'TEYOLIA_X402_NOT_IMPLEMENTED');
    assert.equal((await h.req('GET', server.CAPABILITIES_ROUTE)).json.capabilities.x402Access, false);
    await h.close();
  });
});

describe('trust-proxy: validación de IP literal', () => {
  test('acepta loopback, IPv4 e IPv6 literales; rechaza el resto', async () => {
    const { readTrustProxy } = await import('../dist/trust-proxy.js');
    assert.equal(readTrustProxy({}), false);
    assert.equal(readTrustProxy({ TEYOLIA_X402_TRUST_PROXY: '' }), false);
    assert.deepEqual(readTrustProxy({ TEYOLIA_X402_TRUST_PROXY: 'loopback, 10.0.0.1,::1,fe80::1' }), ['loopback', '10.0.0.1', '::1', 'fe80::1']);
    for (const v of ['256.0.0.1', '01.2.3.4', '1.2.3', '::g', ':', 'loopback;x', '*']) assert.throws(() => readTrustProxy({ TEYOLIA_X402_TRUST_PROXY: v }), v);
  });
});
