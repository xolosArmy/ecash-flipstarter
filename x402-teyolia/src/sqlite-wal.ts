// Activación de WAL compartida por la DB del grant y el store de facturas (Codex #65; P65Δ-M1).
// `PRAGMA journal_mode = WAL` necesita un lock exclusivo y SQLite puede devolver SQLITE_BUSY sin
// pasar por el busy handler, así que busy_timeout no cubre un arranque en frío concurrente.
// Contrato: el llamador fija `PRAGMA busy_timeout = 5000` ANTES de llamar aquí y antes de cualquier
// DDL. Límites fijos: hasta WAL_RETRY_ATTEMPTS intentos, WAL_RETRY_DELAY_MS entre ellos y un
// presupuesto total de WAL_RETRY_BUDGET_MS. Al agotarse falla cerrado: cierra la conexión y lanza.
// Solo se reintenta SQLITE_BUSY/SQLITE_LOCKED (o un modo distinto de `wal`); cualquier otro error
// se propaga de inmediato.

import type { DatabaseSync } from 'node:sqlite';

export const WAL_RETRY_ATTEMPTS = 50;
export const WAL_RETRY_DELAY_MS = 100;
export const WAL_RETRY_BUDGET_MS = 5000;
export const BUSY_TIMEOUT_MS = 5000;

function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null;
  const code = typeof e?.errcode === 'number' ? e.errcode & 0xff : -1;
  return code === 5 || code === 6 || /database (table )?is locked|database is busy/i.test(String(e?.message ?? ''));
}

export function enableWal(db: DatabaseSync, label = 'SQLite'): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const start = Date.now();
  let last: unknown = null;
  for (let i = 1; i <= WAL_RETRY_ATTEMPTS; i++) {
    try {
      const row = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
      if (String(row?.journal_mode).toLowerCase() === 'wal') return;
      last = new Error(`journal_mode quedó en ${String(row?.journal_mode)}`);
    } catch (err) {
      if (!isBusy(err)) { try { db.close(); } catch { /* ya cerrada */ } throw err; }
      last = err;
    }
    if (i === WAL_RETRY_ATTEMPTS || Date.now() - start + WAL_RETRY_DELAY_MS > WAL_RETRY_BUDGET_MS) break;
    Atomics.wait(sleeper, 0, 0, WAL_RETRY_DELAY_MS);
  }
  try { db.close(); } catch { /* ya cerrada */ }
  throw new Error(`${label}: no se pudo activar WAL tras el reintento acotado (${WAL_RETRY_ATTEMPTS} intentos / ${WAL_RETRY_BUDGET_MS} ms): ${String((last as Error | null)?.message ?? last)}`);
}
