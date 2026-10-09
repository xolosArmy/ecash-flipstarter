// Allowlist normativa del proceso x402 (INF-045 §5.1, TA2-M1; comentario 4/6 TA2.1-L1).
// Cualquier ampliación exige decisión registrada y re-auditoría del inventario (INF-045 l.233).

/** Las 16 variables de la allowlist normativa de INF-045 §5.1. */
export const NORMATIVE_ALLOWLIST: readonly string[] = Object.freeze([
  'NODE_ENV',
  'TEYOLIA_X402_ENABLED',
  'TEYOLIA_X402_LISTEN',
  'TEYOLIA_X402_PUBLIC_ORIGIN',
  'TEYOLIA_X402_STORE_PATH',
  'TEYOLIA_X402_GRANT_DB_PATH',
  'TEYOLIA_X402_XPUB',
  'TEYOLIA_X402_CHRONIK_URL',
  'TEYOLIA_X402_EXPIRY_SECONDS',
  'TEYOLIA_X402_RATE_PER_IP',
  'TEYOLIA_X402_RATE_GLOBAL',
  'TEYOLIA_X402_MAX_ISSUED',
  'TEYOLIA_X402_REDELIVERY_MAX',
  'TEYOLIA_X402_REDELIVERY_WINDOW_SECONDS',
  'TEYOLIA_X402_TRUST_PROXY',
  'TEYOLIA_X402_ANNOUNCE_PATH',
]);

/**
 * Conjunto de sistema ENUMERADO (plan v1.0 §4.2.3 regla B; TA2.1-L1).
 * Ninguna otra NODE_*: NODE_OPTIONS, NODE_PATH, NODE_TLS_REJECT_UNAUTHORIZED,
 * NODE_EXTRA_CA_CERTS, NODE_DEBUG y cualquier otra se rechazan por regla B.
 */
export const SYSTEM_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TZ',
  'TMPDIR',
]);

/**
 * Regla A, nombres exactos: lista mínima de OB-02 (INF-044 §3.4) y columna
 * «Falta» de INF-045 §4.2.
 */
export const NEGATIVE_EXACT: readonly string[] = Object.freeze([
  'GAS_WALLET_SEED',
  'GAS_WALLET_PRIVKEY',
  'TEYOLIA_REFUND_ORACLE_PRIVKEY',
  'TEYOLIA_REFUND_ORACLE_SEED',
  'REFUND_ORACLE_PRIVKEY',
  'REFUND_ORACLE_SEED',
  'ECASH_RPC_USER',
  'ECASH_RPC_PASS',
  'E_CASH_RPC_USER',
  'E_CASH_RPC_PASS',
  'FORCE_RESCUE_CAMPAIGN_ID',
  'ECASH_RPC_URL',
  'E_CASH_RPC_URL',
  'TEYOLIA_SQLITE_PATH',
  'ENABLE_PUBLIC_REFUNDS',
  'TEYOLIA_MONETARY_FLOWS_ENABLED',
  'CHRONIK_URL',
  'CHRONIK_BASE_URL',
  'TEYOLIA_REFUND_ORACLE_PUBKEY',
]);

/** Regla A, prefijos de OB-02: TEYOLIA_BENEFICIARY_*, BENEFICIARY_*, TEYOLIA_GAS_WALLET_*. */
export const NEGATIVE_PREFIXES: readonly string[] = Object.freeze([
  'TEYOLIA_BENEFICIARY_',
  'BENEFICIARY_',
  'TEYOLIA_GAS_WALLET_',
]);

/** Regla A, subcadenas (INF-045 §5.1). */
export const NEGATIVE_SUBSTRINGS: readonly string[] = Object.freeze([
  'PRIVKEY',
  'PRIVATE_KEY',
  'SEED',
  'MNEMONIC',
  'WIF',
  'XPRV',
  'TPRV',
  'PASS',
  'PASSWORD',
  'SECRET',
  'TOKEN',
  'RPC_USER',
  'KEY',
  'AUTH',
  'CREDENTIAL',
]);
