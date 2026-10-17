// DB del grant x402 (PR-3; INF-042 §8.2; INF-045 §5.3 RQ-04; nota E-6).
// Archivo propio, distinto del store de facturas. Tabla `x402_access_grant` con UNIQUE en
// invoice_hash, settled_txid y nonce; inserción `ON CONFLICT DO NOTHING` genérica y lectura por
// cada clave en UNA transacción local (BEGIN IMMEDIATE). Cualquier divergencia o error de
// restricción no absorbido -> 409 EFFECT_BINDING_CONFLICT, nunca 500 (T-04, T-08).
// Sin efectos fuera de la transacción: no hay contadores, ledger ni notificaciones (§8.2 paso 4).
// Este módulo no monta middleware ni ruta (eso es PR-4): recibe el contexto de liquidación ya
// verificado (`request.x402Settlement`) como dato inyectado.

import { DatabaseSync } from 'node:sqlite';
import { ReconcileDataError, reconcileMinAgeSeconds } from './reconcile.js';
import { enableWal } from './sqlite-wal.js';

export { WAL_RETRY_ATTEMPTS, WAL_RETRY_BUDGET_MS, WAL_RETRY_DELAY_MS } from './sqlite-wal.js';

/** Subconjunto de `request.x402Settlement` (SettlementVerificationSuccess) que usa el grant. */
export interface SettlementContext {
  readonly ok?: true;
  readonly invoice: {
    readonly invoiceHash: string;
    readonly nonce: string;
    readonly resourceHash: string;
    readonly amountSats: bigint;
    readonly payTo: string;
    readonly state: string;
    readonly settledTxid?: string | undefined;
  };
}

/** Factura PAID tal como está persistida (Codex #66: incluye issued_at/expires_at para su vida). */
export interface PaidInvoice {
  readonly invoiceHash: string;
  readonly settledTxid: string;
  readonly settledAt: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Fuente de facturas PAID para la conciliación (T-03). D-2 (a): ReadOnlyStoreReader (store-reader.ts). */
export interface PaidInvoiceSource {
  listPaid(): Iterable<PaidInvoice>;
}

export type GrantOutcome =
  | { readonly ok: true; readonly status: 'GRANTED' | 'EFFECT_REPLAYED'; readonly grantId: string; readonly deliveryCount: number }
  | { readonly ok: false; readonly httpStatus: 409 | 410 | 500; readonly code: 'EFFECT_BINDING_CONFLICT' | 'RECONCILIATION_REQUIRED' | 'X402_CONTEXT_MISSING' | 'TEYOLIA_X402_REDELIVERY_EXHAUSTED' };

/**
 * D-4 / RQ-11 / T-14 (INF-044 §10.1 M2; Q-09): `delivery_count` cuenta SOLO reentregas (la primera
 * entrega no cuenta). Se aceptan hasta REDELIVERY_MAX (10) reentregas mientras
 * `now - first_delivery_at < REDELIVERY_WINDOW_SECONDS` (86400, límite exclusivo como expiresAt).
 * La 11.ª, o cualquiera fuera de la ventana -> 410 TEYOLIA_X402_REDELIVERY_EXHAUSTED, sin efecto
 * (no cambia la fila). Valores de TEYOLIA_X402_REDELIVERY_MAX / _WINDOW_SECONDS.
 */
export const DEFAULT_REDELIVERY_MAX = 10;
export const DEFAULT_REDELIVERY_WINDOW_SECONDS = 86_400;

/** Sonda inyectada para M1/L-01: ¿llegaron fondos al payTo de una factura ISSUED vencida? */
export interface LatePaymentProbe {
  hasFunds(payTo: string, expiresAt: number): boolean | Promise<boolean>;
}

interface GrantRow {
  grant_id: string;
  invoice_hash: string;
  settled_txid: string;
  nonce: string;
  resource_hash: string;
  amount_sats: string;
  pay_to: string;
  first_delivery_at: number;
  delivery_count: number;
}

export interface GrantDbOptions {
  /** Reloj inyectado (segundos Unix). */
  readonly now?: () => number;
  /** Generador de grant_id inyectado (por defecto crypto.randomUUID). */
  readonly newId?: () => string;
  /** Reentregas máximas (D-4). Por defecto 10. */
  readonly redeliveryMax?: number;
  /** Ventana de reentrega en segundos desde la primera entrega (D-4). Por defecto 86400. */
  readonly redeliveryWindowSeconds?: number;
}

const EXHAUSTED = Object.freeze({ ok: false, httpStatus: 410, code: 'TEYOLIA_X402_REDELIVERY_EXHAUSTED' } as const);

const CONFLICT = Object.freeze({ ok: false, httpStatus: 409, code: 'EFFECT_BINDING_CONFLICT' } as const);

export class GrantDb {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #redeliveryMax: number;
  readonly #redeliveryWindow: number;
  #closed = false;

  constructor(databasePath: string, opts: GrantDbOptions = {}) {
    if (typeof databasePath !== 'string' || databasePath === '' || databasePath === ':memory:' || /^file:/i.test(databasePath)) {
      throw new TypeError('GrantDb requiere una ruta de archivo persistente');
    }
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
    this.#redeliveryMax = opts.redeliveryMax ?? DEFAULT_REDELIVERY_MAX;
    this.#redeliveryWindow = opts.redeliveryWindowSeconds ?? DEFAULT_REDELIVERY_WINDOW_SECONDS;
    if (!Number.isSafeInteger(this.#redeliveryMax) || this.#redeliveryMax < 0) throw new RangeError('redeliveryMax debe ser un entero >= 0');
    if (!Number.isSafeInteger(this.#redeliveryWindow) || this.#redeliveryWindow < 1) throw new RangeError('redeliveryWindowSeconds debe ser un entero >= 1');
    this.#db = new DatabaseSync(databasePath);
    // Codex #65: busy_timeout ANTES del cambio de journal mode y de cualquier DDL.
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    enableWal(this.#db, 'GrantDb');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS x402_access_grant (
        grant_id TEXT PRIMARY KEY,
        invoice_hash TEXT NOT NULL UNIQUE,
        settled_txid TEXT NOT NULL UNIQUE,
        nonce TEXT NOT NULL UNIQUE,
        resource_hash TEXT NOT NULL,
        amount_sats TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'GRANTED'),
        created_at INTEGER NOT NULL,
        first_delivery_at INTEGER NOT NULL,
        delivery_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS x402_reconciliation (
        invoice_hash TEXT PRIMARY KEY,
        settled_txid TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'RECONCILIATION_REQUIRED'),
        marked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS x402_late_payment_review (
        invoice_hash TEXT PRIMARY KEY,
        pay_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state = 'LATE_PAYMENT_REVIEW'),
        marked_at INTEGER NOT NULL
      );
    `);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Algoritmo de INF-042 §8.2 (pasos 1–3) en una transacción local. */
  recordGrant(s: SettlementContext | null | undefined): GrantOutcome {
    const inv = s?.invoice;
    if (!inv || inv.state !== 'PAID' || typeof inv.settledTxid !== 'string' || inv.settledTxid === '') {
      return { ok: false, httpStatus: 500, code: 'X402_CONTEXT_MISSING' };
    }
    const db = this.#db;
    db.exec('BEGIN IMMEDIATE');
    try {
      // D-5 y Codex #66 r4299872959: una factura marcada para revisión humana (conciliación o pago
      // tardío) nunca recibe grant. Se comprueba dentro de esta misma BEGIN IMMEDIATE, que
      // serializa con la de reviewLatePayments(): una factura nunca queda con grant y revisión.
      if (
        db.prepare('SELECT 1 FROM x402_reconciliation WHERE invoice_hash = ?').get(inv.invoiceHash) ||
        db.prepare('SELECT 1 FROM x402_late_payment_review WHERE invoice_hash = ?').get(inv.invoiceHash)
      ) {
        db.exec('COMMIT');
        return { ok: false, httpStatus: 409, code: 'RECONCILIATION_REQUIRED' };
      }
      const t = this.#now();
      const ins = db
        .prepare(
          `INSERT INTO x402_access_grant (grant_id, invoice_hash, settled_txid, nonce, resource_hash, amount_sats, pay_to, state, created_at, first_delivery_at, delivery_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'GRANTED', ?, ?, 0) ON CONFLICT DO NOTHING`,
        )
        .run(this.#newId(), inv.invoiceHash, inv.settledTxid, inv.nonce, inv.resourceHash, inv.amountSats.toString(10), inv.payTo, t, t);
      const by = (col: 'invoice_hash' | 'settled_txid' | 'nonce', v: string): GrantRow | undefined =>
        db.prepare(`SELECT grant_id, invoice_hash, settled_txid, nonce, resource_hash, amount_sats, pay_to, first_delivery_at, delivery_count FROM x402_access_grant WHERE ${col} = ?`).get(v) as GrantRow | undefined;
      const a = by('invoice_hash', inv.invoiceHash);
      const b = by('settled_txid', inv.settledTxid);
      const c = by('nonce', inv.nonce);
      if (
        !a || !b || !c || a.grant_id !== b.grant_id || a.grant_id !== c.grant_id ||
        a.settled_txid !== inv.settledTxid ||
        a.nonce !== inv.nonce ||
        a.resource_hash !== inv.resourceHash ||
        a.amount_sats !== inv.amountSats.toString(10) ||
        a.pay_to !== inv.payTo
      ) {
        db.exec('ROLLBACK');
        return CONFLICT;
      }
      if (Number(ins.changes) === 1) {
        db.exec('COMMIT');
        return { ok: true, status: 'GRANTED', grantId: a.grant_id, deliveryCount: 0 };
      }
      // Reentrega (D-4): solo cuenta si cabe en el máximo y en la ventana; si no, 410 sin efecto.
      if (a.delivery_count >= this.#redeliveryMax || t - a.first_delivery_at >= this.#redeliveryWindow) {
        db.exec('ROLLBACK');
        return EXHAUSTED;
      }
      db.prepare('UPDATE x402_access_grant SET delivery_count = delivery_count + 1 WHERE grant_id = ?').run(a.grant_id);
      db.exec('COMMIT');
      return { ok: true, status: 'EFFECT_REPLAYED', grantId: a.grant_id, deliveryCount: a.delivery_count + 1 };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* sin transacción abierta */ }
      if (err instanceof Error && /constraint/i.test(err.message)) return CONFLICT;
      throw err;
    }
  }

  /**
   * Conciliación (INF-042 §8.2 «Fallos entre commit y efecto»; T-03; D-2 (a); Codex #66
   * r4299872954): toda factura PAID sin grant cuya liquidación tenga al menos
   * `reconcileMinAgeSeconds(expiresAt - issuedAt)` segundos (vida PERSISTIDA de esa factura +
   * margen, mínimo 600 s; ver reconcile.ts) queda marcada RECONCILIATION_REQUIRED para revisión
   * humana (D-5). No depende de la expiración configurada ahora. No reembolsa ni mueve fondos.
   * Fail-closed: si una factura trae settled_at, issued_at o expires_at ausentes o inválidos, lanza
   * ReconcileDataError y revierte: esa pasada no marca NADA. Devuelve los invoiceHash marcados.
   */
  reconcile(source: PaidInvoiceSource): string[] {
    const db = this.#db;
    const now = this.#now();
    const marked: string[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const has = db.prepare('SELECT 1 FROM x402_access_grant WHERE invoice_hash = ?');
      const mark = db.prepare(
        `INSERT INTO x402_reconciliation (invoice_hash, settled_txid, state, marked_at) VALUES (?, ?, 'RECONCILIATION_REQUIRED', ?) ON CONFLICT DO NOTHING`,
      );
      for (const p of source.listPaid()) {
        const id = typeof p?.invoiceHash === 'string' ? p.invoiceHash : '<sin invoiceHash>';
        if (typeof p?.invoiceHash !== 'string' || p.invoiceHash === '') throw new ReconcileDataError(id, 'invoiceHash');
        if (typeof p.settledTxid !== 'string' || p.settledTxid === '') throw new ReconcileDataError(id, 'settled_txid');
        for (const k of ['settledAt', 'issuedAt', 'expiresAt'] as const) {
          if (!Number.isSafeInteger(p[k])) throw new ReconcileDataError(id, k);
        }
        let minAgeSeconds: number;
        try {
          minAgeSeconds = reconcileMinAgeSeconds(p.expiresAt - p.issuedAt);
        } catch {
          throw new ReconcileDataError(id, 'vida (expires_at - issued_at) fuera de [1, 3600]');
        }
        if (now - p.settledAt < minAgeSeconds || has.get(p.invoiceHash)) continue;
        if (Number(mark.run(p.invoiceHash, p.settledTxid, now).changes) === 1) marked.push(p.invoiceHash);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* sin transacción abierta */ }
      throw err;
    }
    return marked;
  }

  /**
   * M1 / L-01 (INF-042 §10.1 LATE_PAYMENT_REVIEW): facturas ISSUED ya vencidas cuyo payTo recibió
   * fondos según la sonda inyectada quedan marcadas LATE_PAYMENT_REVIEW para revisión humana.
   * Sin grant y sin movimiento de fondos (devolución manual vía Wallet, fuera de Teyolia).
   * La sonda corre fuera de la transacción; el «¿ya tiene grant?» y la marca van en una sola
   * BEGIN IMMEDIATE, serializada con la de recordGrant() (Codex #66 r4299872959): si el grant
   * ganó, no se marca; si la marca ganó, recordGrant() responde 409 RECONCILIATION_REQUIRED.
   */
  async reviewLatePayments(expired: Iterable<{ readonly invoiceHash: string; readonly payTo: string; readonly expiresAt: number }>, probe: LatePaymentProbe): Promise<string[]> {
    const now = this.#now();
    const funded: { invoiceHash: string; payTo: string; expiresAt: number }[] = [];
    for (const e of expired) {
      if (e.expiresAt > now) continue;
      if ((await probe.hasFunds(e.payTo, e.expiresAt)) === true) funded.push({ invoiceHash: e.invoiceHash, payTo: e.payTo, expiresAt: e.expiresAt });
    }
    const db = this.#db;
    const marked: string[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const has = db.prepare('SELECT 1 FROM x402_access_grant WHERE invoice_hash = ?');
      const mark = db.prepare(
        `INSERT INTO x402_late_payment_review (invoice_hash, pay_to, expires_at, state, marked_at) VALUES (?, ?, ?, 'LATE_PAYMENT_REVIEW', ?) ON CONFLICT DO NOTHING`,
      );
      for (const f of funded) {
        if (has.get(f.invoiceHash)) continue;
        if (Number(mark.run(f.invoiceHash, f.payTo, f.expiresAt, now).changes) === 1) marked.push(f.invoiceHash);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* sin transacción abierta */ }
      throw err;
    }
    return marked;
  }

  latePaymentState(invoiceHash: string): string | null {
    const r = this.#db.prepare('SELECT state FROM x402_late_payment_review WHERE invoice_hash = ?').get(invoiceHash) as { state: string } | undefined;
    return r?.state ?? null;
  }

  deliveryCount(grantId: string): number | null {
    const r = this.#db.prepare('SELECT delivery_count FROM x402_access_grant WHERE grant_id = ?').get(grantId) as { delivery_count: number } | undefined;
    return r === undefined ? null : Number(r.delivery_count);
  }

  countGrants(): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM x402_access_grant').get() as { n: number }).n);
  }

  reconciliationState(invoiceHash: string): string | null {
    const r = this.#db.prepare('SELECT state FROM x402_reconciliation WHERE invoice_hash = ?').get(invoiceHash) as { state: string } | undefined;
    return r?.state ?? null;
  }

  /** Cierre ordenado (TR-01): checkpoint WAL TRUNCATE y close; idempotente. */
  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.#db.close();
    }
  }
}
