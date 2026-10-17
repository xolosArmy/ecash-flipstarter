// D-2 (a) (decisión de Fernando 12:03, punto 2): lector SQL de SOLO LECTURA, propiedad de Teyolia,
// sobre el archivo del store de facturas x402 (INF-042 §8.2 «Fallos entre commit y efecto», AX-L2:
// AuthoritativeInvoiceStore no enumera por estado). Fail-closed:
//   - abre con `readOnly: true` y además fija `PRAGMA query_only = 1` (y lo verifica);
//   - verifica que sqlite_master coincida EXACTAMENTE con el esquema de x402-XEC 0f409de
//     (mismos objetos, mismo SQL salvo espacios); cualquier diferencia -> StoreSchemaError;
//   - nunca crea el archivo: si no existe, falla.
// No escribe, no reembolsa y no mueve fondos.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { PaidInvoice, PaidInvoiceSource } from './grant-db.js';

/** sqlite_master del store de 0f409de (`BaseSqliteAuthoritativeInvoiceStore.initDatabase`). */
export const STORE_SCHEMA_0F409DE: readonly { type: string; name: string; tbl_name: string; sql: string | null }[] = Object.freeze([
  { type: 'index', name: 'idx_invoices_settled_txid', tbl_name: 'invoices', sql: 'CREATE UNIQUE INDEX idx_invoices_settled_txid ON invoices(settled_txid) WHERE settled_txid IS NOT NULL' },
  { type: 'index', name: 'sqlite_autoindex_invoices_1', tbl_name: 'invoices', sql: null },
  { type: 'index', name: 'sqlite_autoindex_invoices_2', tbl_name: 'invoices', sql: null },
  { type: 'index', name: 'sqlite_autoindex_invoices_3', tbl_name: 'invoices', sql: null },
  { type: 'index', name: 'sqlite_autoindex_invoices_4', tbl_name: 'invoices', sql: null },
  {
    type: 'table', name: 'invoices', tbl_name: 'invoices',
    sql: 'CREATE TABLE invoices ( invoice_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, resource_hash TEXT NOT NULL, amount_sats TEXT NOT NULL, pay_to TEXT NOT NULL UNIQUE, network TEXT NOT NULL, scheme TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, settled_txid TEXT, settled_at INTEGER, derivation_index INTEGER NOT NULL UNIQUE )',
  },
]);

export class StoreSchemaError extends Error {
  constructor(message: string) {
    super(`store-reader: ${message}`);
    this.name = 'StoreSchemaError';
  }
}

const norm = (sql: string | null): string | null => (sql === null ? null : sql.replace(/\s+/g, ' ').trim());

export interface ExpiredIssued {
  readonly invoiceHash: string;
  readonly payTo: string;
  readonly expiresAt: number;
}

export class ReadOnlyStoreReader implements PaidInvoiceSource {
  readonly #db: DatabaseSync;

  constructor(storePath: string) {
    if (typeof storePath !== 'string' || storePath === '' || /^file:|:memory:/i.test(storePath) || !existsSync(storePath)) {
      throw new StoreSchemaError('el archivo del store no existe o no es una ruta de archivo');
    }
    const db = new DatabaseSync(storePath, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = 1;');
      const q = (db.prepare('PRAGMA query_only').get() as { query_only?: number } | undefined)?.query_only;
      if (q !== 1) throw new StoreSchemaError('PRAGMA query_only no quedó activo');
      const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
      const got = JSON.stringify(rows.map((r) => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: norm(r.sql) })));
      const want = JSON.stringify(STORE_SCHEMA_0F409DE.map((r) => ({ ...r, sql: norm(r.sql) })));
      if (got !== want) throw new StoreSchemaError('el esquema no coincide con x402-XEC 0f409de');
    } catch (err) {
      try { db.close(); } catch { /* ya cerrada */ }
      throw err instanceof StoreSchemaError ? err : new StoreSchemaError(`no se pudo verificar el store: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#db = db;
  }

  /**
   * Facturas PAID (para la conciliación de T-03), con su vida persistida (Codex #66: issued_at y
   * expires_at). Un valor que no sea un entero de SQLite se entrega como NaN para que la
   * conciliación falle cerrada (ReconcileDataError); nunca se convierte desde texto.
   */
  *listPaid(): Iterable<PaidInvoice> {
    const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : Number.NaN);
    const rows = this.#db
      .prepare("SELECT invoice_hash, settled_txid, settled_at, issued_at, expires_at FROM invoices WHERE state = 'PAID' AND settled_txid IS NOT NULL AND settled_at IS NOT NULL ORDER BY invoice_hash")
      .all() as { invoice_hash: string; settled_txid: string; settled_at: unknown; issued_at: unknown; expires_at: unknown }[];
    for (const r of rows) {
      yield { invoiceHash: r.invoice_hash, settledTxid: r.settled_txid, settledAt: int(r.settled_at), issuedAt: int(r.issued_at), expiresAt: int(r.expires_at) };
    }
  }

  /** Facturas ISSUED ya vencidas (`expires_at <= now`; límite exclusivo de upstream), para M1/L-01. */
  listExpiredIssued(now: number): ExpiredIssued[] {
    const rows = this.#db
      .prepare("SELECT invoice_hash, pay_to, expires_at FROM invoices WHERE state = 'ISSUED' AND expires_at <= ? ORDER BY invoice_hash")
      .all(now) as { invoice_hash: string; pay_to: string; expires_at: number }[];
    return rows.map((r) => ({ invoiceHash: r.invoice_hash, payTo: r.pay_to, expiresAt: Number(r.expires_at) }));
  }

  close(): void {
    try { this.#db.close(); } catch { /* ya cerrada */ }
  }
}
