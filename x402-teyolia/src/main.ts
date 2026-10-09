// Punto de entrada en dos fases (plan v1.0 §4.2.2).
// Fase 1: solo node:* y ./env-guard.js. Fase 2 (si pasa): `await import('./server.js')`,
// que es el primer punto donde se carga Express.
// Limitación conocida (Auditor P4-L3): código precargado por NODE_OPTIONS/--import/--require
// se ejecuta ANTES de este archivo. Este guard lo detecta y rechaza el arranque, pero no lo
// previene; la barrera real es el lanzador (PR-6).

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
