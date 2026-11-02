// Punto de entrada en dos fases (plan v1.0 §4.2.2).
// Fase 1: solo node:* y ./env-guard.js. Fase 2 (si pasa): `await import('./server.js')`,
// que es el primer punto donde se carga Express.
// Limitación conocida (Auditor, revisión P-4 del diseño de PR-1: P-4/L3; no es P4-L3 (PR-4), del
// dictamen de PR-4): código precargado por NODE_OPTIONS/--import/--require
// se ejecuta ANTES de este archivo. Este guard lo detecta y rechaza el arranque, pero no lo
// previene. P6C-06: la barrera real NO la aporta PR-6 (PR-6 solo demuestra el aislamiento en CI con
// namespaces desechables); es el lanzador del host: unit con entorno propio, sin NODE_OPTIONS/NODE_*
// ni PassEnvironment (G3-01), y ExecStart fijo (G3-02), precondiciones del gate de TA-3
// (docs/pr6-aislamiento.md §4).

import process from 'node:process';
import { evaluateStartup, formatRejections } from './env-guard.js';

const result = evaluateStartup({
  env: process.env,
  execArgv: process.execArgv,
  cwd: process.cwd(),
});

if (!result.ok) {
  for (const line of formatRejections(result)) {
    process.stderr.write(`${line}\n`);
  }
  process.stderr.write('x402-teyolia: arranque abortado por el guard de entorno\n');
  process.exitCode = 78;
} else {
  const { startServer } = await import('./server.js');
  startServer(process.env);
}
