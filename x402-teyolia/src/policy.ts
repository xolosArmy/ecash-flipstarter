// Kill switch y límites (DEC-AX-08 (a), fila 13:24; lectura vinculante 5/6).

export type KillSwitchState = 'OFF' | 'ON';

/** Solo el literal exacto 'true' enciende el kill switch (INF-042 R-14, C-04). */
export function killSwitchState(env: Readonly<Record<string, string | undefined>>): KillSwitchState {
  return env['TEYOLIA_X402_ENABLED'] === 'true' ? 'ON' : 'OFF';
}

/**
 * Límites congelados en cero. Ninguna variable de entorno los cambia: no están
 * en la allowlist y este módulo no lee el entorno para ellos.
 * «Límites cero» = importe y presupuesto (lectura 5/6), no los límites de tasa de M3.
 */
export const ZERO_LIMITS = Object.freeze({
  maxAmountPerOperationSats: 0n,
  maxAggregateSats: 0n,
  agentBudgetSats: 0n,
});

/**
 * Límites de tasa de M3 (Q-09): se leen de la allowlist pero NO se aplican en PR-1
 * (se aplican en PR-4). Valores por defecto de INF-045 §5.1.
 */
export interface RateLimitConfig {
  readonly perIpPerMinute: number;
  readonly globalPerMinute: number;
  readonly maxIssued: number;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) return fallback;
  return Number(raw);
}

export function readRateLimits(env: Readonly<Record<string, string | undefined>>): RateLimitConfig {
  return Object.freeze({
    perIpPerMinute: readPositiveInt(env['TEYOLIA_X402_RATE_PER_IP'], 10),
    globalPerMinute: readPositiveInt(env['TEYOLIA_X402_RATE_GLOBAL'], 120),
    maxIssued: readPositiveInt(env['TEYOLIA_X402_MAX_ISSUED'], 200),
  });
}

/** Códigos de error de la ruta x402 en PR-1 (no hay middleware hasta PR-4). */
export const X402_DISABLED_CODE = 'TEYOLIA_X402_DISABLED';
export const X402_NOT_IMPLEMENTED_CODE = 'TEYOLIA_X402_NOT_IMPLEMENTED';
