// Fase 2: Express 5, sin body parser. Solo se carga si el guard de entorno pasó.
// Rutas (Auditor P4-L4):
//   - x402: `/x402/v1/access/demo` y todo `/x402/**` -> 503 (OFF: TEYOLIA_X402_DISABLED;
//     ON: TEYOLIA_X402_NOT_IMPLEMENTED, no hay middleware hasta PR-4).
//   - health propio: `/teyolia-x402/health` (no choca con `/api/health` del legacy).
//   - nada bajo `/proposed/v0.1/` (404).

import process from 'node:process';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  X402_DISABLED_CODE,
  X402_NOT_IMPLEMENTED_CODE,
  ZERO_LIMITS,
  killSwitchState,
  readRateLimits,
} from './policy.js';

export const DEMO_ROUTE = '/x402/v1/access/demo';
export const X402_PREFIX = '/x402';
export const HEALTH_ROUTE = '/teyolia-x402/health';

type Env = Readonly<Record<string, string | undefined>>;

function limitsAreZero(): boolean {
  return (
    ZERO_LIMITS.maxAmountPerOperationSats === 0n &&
    ZERO_LIMITS.maxAggregateSats === 0n &&
    ZERO_LIMITS.agentBudgetSats === 0n
  );
}

export function createApp(env: Env): express.Express {
  const state = killSwitchState(env);
  readRateLimits(env);

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', false);

  const x402Unavailable = (_req: Request, res: Response): void => {
    res
      .status(503)
      .set('Cache-Control', 'no-store')
      .json({ error: state === 'ON' ? X402_NOT_IMPLEMENTED_CODE : X402_DISABLED_CODE });
  };

  app.get(HEALTH_ROUTE, (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json({
      status: 'ok',
      component: 'x402-teyolia',
      x402Enabled: state === 'ON',
      limitsZero: limitsAreZero(),
    });
  });
  app.all(DEMO_ROUTE, x402Unavailable);
  app.use(X402_PREFIX, x402Unavailable);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

export function startServer(env: Env): void {
  const app = createApp(env);
  const port = Number(env['TEYOLIA_X402_LISTEN']);
  const server = app.listen(port, '127.0.0.1', (error?: Error) => {
    if (error) {
      process.stderr.write('x402-teyolia: no se pudo abrir el puerto\n');
      process.exitCode = 1;
      return;
    }
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    process.stdout.write(
      `x402-teyolia: escuchando en 127.0.0.1:${bound} (kill switch ${killSwitchState(env)})\n`,
    );
  });
  const shutdown = (): void => {
    server.close(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
