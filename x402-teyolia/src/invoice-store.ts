// Store de facturas x402 (PR-3): SqliteAuthoritativeInvoiceStore del subpath `./sqlite` de
// @x402-xec/core 0f409de, en su archivo propio. Añade el cierre ordenado de TR-01: checkpoint
// WAL (TRUNCATE) y cierre, idempotente, para que no quede `-wal`/`-shm` residual (T-07).
//
// P65Δ-M1 (PR-4, sin modificar vendor): el `initDatabase()` de upstream ejecuta
// `PRAGMA journal_mode = WAL` antes de `PRAGMA busy_timeout = 5000`. Se sobrescribe el método
// protegido para fijar busy_timeout primero, activar WAL con el reintento acotado y fail-closed de
// `sqlite-wal.ts` y solo después delegar en el `initDatabase()` de upstream (su DDL y pragmas
// quedan intactos; su `journal_mode = WAL` es ya un no-op sobre una DB en WAL).

import { SqliteAuthoritativeInvoiceStore } from '@x402-xec/core/sqlite';
import { BUSY_TIMEOUT_MS, enableWal } from './sqlite-wal.js';

export class X402InvoiceStore extends SqliteAuthoritativeInvoiceStore {
  /** busy_timeout observado justo antes de activar WAL (evidencia de P65Δ-M1). */
  declare readonly busyTimeoutAtWal: number;
  #closed = false;

  protected override initDatabase(): void {
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    const bt = (this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout;
    Object.defineProperty(this, 'busyTimeoutAtWal', { value: Number(bt), enumerable: false });
    enableWal(this.db, 'X402InvoiceStore');
    super.initDatabase();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Facturas ISSUED aún vigentes (`expires_at > now`): tope M3 de 200 (T-15/W-02). Solo lectura. */
  countActiveIssued(now: number): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE state = 'ISSUED' AND expires_at > ?").get(now) as { n: number };
    return Number(r.n);
  }

  /** Checkpoint WAL (TRUNCATE) y cierre. Llamadas repetidas no hacen nada. */
  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.close();
    }
  }
}
