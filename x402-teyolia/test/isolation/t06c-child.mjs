// PR-6 T-06c: hijo que ejecuta la app REAL de dist/ (createApp con adaptadores, arnés PR-4) y la
// cadena C3B completa en proceso (402 -> pago sintético -> 200 -> re-entrega 200), y luego emite la
// lista de módulos efectivamente cargados: ESM (hook de carga) + CJS (require.cache).
// X402_T06C_EXTRA (solo control negativo): ruta de un módulo FUERA del paquete que se importa.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startApp } from '../pr4-harness.mjs';
import { ORIGIN } from '../fixtures/x402/chronik-fixtures.mjs';
import { SyntheticC3BClient, SyntheticWallet } from '../fixtures/x402/c3b-client.mjs';

if (process.env.X402_T06C_EXTRA) await import(pathToFileURL(process.env.X402_T06C_EXTRA).href);
const h = await startApp();
const wallet = new SyntheticWallet(h.provider, { now: () => h.clock.t });
const client = new SyntheticC3BClient({ send: h.req, wallet, publicOrigin: ORIGIN, now: () => h.clock.t });
const a = await client.access('/x402/v1/access/demo');
const r2 = await client.redeliver('/x402/v1/access/demo', a.proofHeader);
const r1 = a.second;
await h.close();
const esm = readFileSync(process.env.X402_T06C_LOG, 'utf8').split('\n').filter(Boolean);
const cjs = Object.keys(createRequire(import.meta.url).cache).map((f) => pathToFileURL(f).href);
process.stdout.write(`T06C ${JSON.stringify({ statuses: [r1.status, r2.status], modules: [...new Set([...esm, ...cjs])].sort() })}\n`);
