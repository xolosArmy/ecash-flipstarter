// Harness en proceso de PR-4: createApp(env, adaptadores) con fixtures sintéticos (DEC-AX-09 (a)),
// en 127.0.0.1:0. Store y grant en archivos temporales propios (durables, sin modo inseguro).
import { request } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { XpubPayToAllocator } from '@x402-xec/core';
import { AMOUNT, FixtureTxProvider, ORIGIN, TEST_XPUB } from './fixtures/x402/chronik-fixtures.mjs';
import { PACKAGE_ROOT, makeTmp } from './helpers.mjs';

const dist = (f) => pathToFileURL(path.join(PACKAGE_ROOT, 'dist', f)).href;
export const server = await import(dist('server.js'));
const { X402InvoiceStore } = await import(dist('invoice-store.js'));
const { GrantDb } = await import(dist('grant-db.js'));

export const ON_ENV = Object.freeze({ TEYOLIA_X402_ENABLED: 'true', NODE_ENV: 'test' });

export async function startApp({ env = ON_ENV, withAdapters = true, start = 1_791_400_000, provider = new FixtureTxProvider(), grantOpts = {}, dir } = {}) {
  const d = dir ?? makeTmp('x402-pr4-').dir;
  const clock = { t: start };
  const now = () => clock.t;
  const store = new X402InvoiceStore(path.join(d, 'store.sqlite'));
  const grants = new GrantDb(path.join(d, 'grant.sqlite'), { now, ...grantOpts });
  const adapters = withAdapters
    ? { store, grants, txProvider: provider, payToAllocator: new XpubPayToAllocator(TEST_XPUB), amountSats: AMOUNT, publicOrigin: ORIGIN, now }
    : undefined;
  const app = server.createApp(env, adapters);
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = srv.address().port;
  const req = (method, urlPath, headers = {}) => new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
  const close = () => new Promise((res) => {
    srv.closeAllConnections?.();
    srv.close(() => { try { grants.shutdown(); } catch {} try { store.shutdown(); } catch {} res(); });
  });
  return { dir: d, port, store, grants, provider, clock, req, close };
}

/** GET sin prueba -> factura emitida (402). Devuelve { invoice, invoiceHash, res }. */
export async function issue(h, route = server.DEMO_ROUTE, method = 'GET') {
  const res = await h.req(method, route);
  return { res, invoice: res.json?.invoice, invoiceHash: res.json?.invoiceId };
}
