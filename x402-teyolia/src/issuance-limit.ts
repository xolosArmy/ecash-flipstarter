// M3 / RQ-12 / T-15 (INF-044 §10.1; Q-09): rate limit de EMISIÓN antes del middleware x402.
// Solo se limitan las peticiones SIN prueba (I-5 adoptada): las que traen una cabecera de prueba
// no consumen cupo ni emiten factura. Ventana fija de 60 s (reloj inyectado): 10/min por IP,
// 120/min global y tope de 200 facturas ISSUED vigentes. Al superar cualquiera -> 429
// TEYOLIA_X402_ISSUANCE_LIMITED antes del middleware: no se escribe fila ni se consume índice.
// La IP es `req.ip`, que solo usa X-Forwarded-For si el proxy es de confianza (trust-proxy.ts, T-19).

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const ISSUANCE_LIMITED_CODE = 'TEYOLIA_X402_ISSUANCE_LIMITED';
const PROOF_HEADERS = ['payment-proof', 'settlement-proof', 'x402-settlement-proof'] as const;
const WINDOW_SECONDS = 60;

export interface IssuanceLimiterConfig {
  readonly perIpPerMinute: number;
  readonly globalPerMinute: number;
  readonly maxIssued: number;
  readonly now: () => number;
  readonly countActiveIssued: (now: number) => number;
}

export function hasProofHeader(req: Request): boolean {
  return PROOF_HEADERS.some((h) => req.headers[h] !== undefined);
}

export function createIssuanceLimiter(cfg: IssuanceLimiterConfig): RequestHandler {
  let window = -1;
  let global = 0;
  const perIp = new Map<string, number>();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasProofHeader(req)) {
      next();
      return;
    }
    const now = cfg.now();
    const w = Math.floor(now / WINDOW_SECONDS);
    if (w !== window) {
      window = w;
      global = 0;
      perIp.clear();
    }
    const ip = req.ip ?? 'unknown';
    const used = perIp.get(ip) ?? 0;
    if (used >= cfg.perIpPerMinute || global >= cfg.globalPerMinute || cfg.countActiveIssued(now) >= cfg.maxIssued) {
      res.status(429).set('Cache-Control', 'no-store').json({ error: ISSUANCE_LIMITED_CODE });
      return;
    }
    perIp.set(ip, used + 1);
    global += 1;
    next();
  };
}
