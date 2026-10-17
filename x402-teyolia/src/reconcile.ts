// Ventana de conciliación (D-2 (a), decisión de Fernando 12:03; Codex #66 r4299872954).
// El umbral se calcula POR FACTURA con su vida persistida en el store (issued_at/expires_at), no
// con el TEYOLIA_X402_EXPIRY_SECONDS vigente (un reinicio con otra expiración no debe adelantar la
// marca de facturas emitidas antes). Valor exacto:
//   lifetime      = expires_at - issued_at            (entero en [1, 3600]; si no -> fail-closed)
//   minAgeSeconds = max(RECONCILE_MIN_AGE_SECONDS, lifetime + RECONCILE_RETRY_MARGIN_SECONDS)
//   RECONCILE_RETRY_MARGIN_SECONDS = 300, RECONCILE_MIN_AGE_SECONDS = 600 (PR4-H, inclusivo)
//   -> 600 s para la vida por defecto (300 s); 3900 s para una factura de 3600 s.
// Justificación del margen: una factura solo pasa a PAID antes de `expiresAt`; el cliente cuyo
// grant falló tras `commitPaid` reintenta con la misma prueba (idempotente, T-02). El margen le
// da otra ventana completa de expiración (300 s) para ese reintento antes de que la conciliación
// marque RECONCILIATION_REQUIRED, que es definitivo para la factura (D-5: 409 + revisión humana).
// Medido desde `settled_at` (el hecho económico). Una factura con settled_at + minAge <= now se marca.

export const DEFAULT_EXPIRY_SECONDS = 300;
export const RECONCILE_RETRY_MARGIN_SECONDS = 300;
export const MAX_EXPIRY_SECONDS = 3600;
/** Mínimo absoluto del umbral (PR4-H): 600 s, inclusivo. */
export const RECONCILE_MIN_AGE_SECONDS = DEFAULT_EXPIRY_SECONDS + RECONCILE_RETRY_MARGIN_SECONDS;

export class ExpiryConfigError extends Error {}

/** Lee TEYOLIA_X402_EXPIRY_SECONDS: entero 1..3600; ausente -> 300; inválido -> error (fail-closed). */
export function readExpirySeconds(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['TEYOLIA_X402_EXPIRY_SECONDS'];
  if (raw === undefined || raw === '') return DEFAULT_EXPIRY_SECONDS;
  if (!/^[1-9][0-9]{0,3}$/.test(raw) || Number(raw) > MAX_EXPIRY_SECONDS) throw new ExpiryConfigError('TEYOLIA_X402_EXPIRY_SECONDS');
  return Number(raw);
}

/**
 * Umbral de conciliación para UNA factura a partir de su vida persistida (`expiresAt - issuedAt`).
 * La vida debe ser un entero en [1, MAX_EXPIRY_SECONDS]; si no, RangeError (fail-closed).
 */
export function reconcileMinAgeSeconds(lifetimeSeconds: number): number {
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > MAX_EXPIRY_SECONDS) {
    throw new RangeError('la vida de la factura debe ser un entero en [1, 3600]');
  }
  return Math.max(RECONCILE_MIN_AGE_SECONDS, lifetimeSeconds + RECONCILE_RETRY_MARGIN_SECONDS);
}

/** Dato persistido ausente o inválido en una factura PAID: la conciliación aborta sin marcar nada. */
export class ReconcileDataError extends Error {
  readonly invoiceHash: string;
  constructor(invoiceHash: string, reason: string) {
    super(`reconcile: dato persistido inválido en ${invoiceHash}: ${reason}`);
    this.name = 'ReconcileDataError';
    this.invoiceHash = invoiceHash;
  }
}
