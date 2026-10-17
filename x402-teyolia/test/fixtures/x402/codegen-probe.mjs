// Sonda de D-1 / P2b-L3 (solo test/). Antes de cargar NADA de fase 2 sustituye `Function` y `eval`
// globales por envoltorios que cuentan intentos y construcciones EXITOSAS de código desde cadenas.
// Luego ejecuta un flujo x402 completo con la app real (402 + pago por fixtures + 200), toca la
// superficie conocida (zod allowsEval/Doc.compile, get-intrinsic %eval% y getEvalledConstructor) e
// imprime `CODEGEN {…}`. Se lanza con y sin --disallow-code-generation-from-strings.
const counts = { attempts: 0, successes: 0, evalErrors: 0 };
const RealFunction = globalThis.Function;
const realEval = globalThis.eval;
const track = (fn) => {
  counts.attempts += 1;
  try { const r = fn(); counts.successes += 1; return r; } catch (e) { if (e instanceof EvalError) counts.evalErrors += 1; throw e; }
};
globalThis.Function = new Proxy(RealFunction, {
  construct: (t, args, nt) => track(() => Reflect.construct(t, args, nt === globalThis.Function ? t : nt)),
  apply: (t, self, args) => track(() => Reflect.apply(t, self, args)),
});
globalThis.eval = function evalProbe(src) { return track(() => realEval(src)); };

const { startApp, issue, server } = await import('../../pr4-harness.mjs');
const { nextTxid, payingTx, proofHeader } = await import('./chronik-fixtures.mjs');
const h = await startApp();
const { invoice, invoiceHash } = await issue(h);
const txid = h.provider.set(nextTxid(), null);
h.provider.set(txid, { ...payingTx({ payTo: invoice.payTo, timeFirstSeen: h.clock.t }), txid });
const ok = await h.req('GET', server.DEMO_ROUTE, { 'payment-proof': proofHeader(invoiceHash, txid) });
const { createRequire } = await import('node:module');
const req = createRequire(import.meta.url);
const GetIntrinsic = req('get-intrinsic');
let intrinsicEval = 'n/a';
try { intrinsicEval = String(GetIntrinsic('%eval%')('1 + 1')); } catch (e) { intrinsicEval = e?.constructor?.name ?? 'error'; }
let asyncFn = 'n/a';
try { asyncFn = typeof GetIntrinsic('%AsyncFunction%'); } catch (e) { asyncFn = e?.constructor?.name ?? 'error'; }
const { util } = await import('zod/v4/core');
await h.close();
process.stdout.write(`CODEGEN ${JSON.stringify({ ...counts, status402: invoiceHash ? 402 : 0, status200: ok.status, intrinsicEval, asyncFn, zodAllowsEval: util.allowsEval.value })}\n`);
