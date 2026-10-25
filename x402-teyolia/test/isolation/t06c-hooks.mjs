// PR-6 T-06c: hook de carga (module.register) SOLO para la prueba; registra cada URL que el
// cargador ESM carga realmente (no un análisis estático). Escribe en X402_T06C_LOG (una URL por línea).
import { appendFileSync } from 'node:fs';
const LOG = process.env.X402_T06C_LOG;
export async function load(url, context, nextLoad) {
  if (LOG) appendFileSync(LOG, `${url}\n`);
  return nextLoad(url, context);
}
