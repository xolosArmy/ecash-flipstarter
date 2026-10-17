// Fase 2: Express 5, sin body parser. Solo se carga si el guard de entorno pasó.
// Rutas (Auditor P4-L4):
//   - x402: `/x402/v1/access/demo` (y `/x402/v1/access/demo-alt`, para R-13) y todo `/x402/**`.
//     OFF -> 503 TEYOLIA_X402_DISABLED, evaluado ANTES de cualquier middleware (R-14).
//     ON sin adaptadores inyectados -> 503 TEYOLIA_X402_NOT_IMPLEMENTED (el proceso real no tiene
//     txProvider: Chronik solo por fixtures, DEC-AX-09 (a); decisión abierta PR4-A).
//     ON con adaptadores (solo tests) -> rate limit de emisión (M3) -> createX402SettlementMiddleware
//     (0f409de, store durable y allocator xpub; sin allowInsecureDevelopmentMode) -> grant.
//   - health propio: `/teyolia-x402/health`; anuncio propio: `/teyolia-x402/capabilities` (RQ-03,
//     opción preferida: el proceso x402 publica su anuncio; mismo predicado que la ruta, T-17).
//   - nada bajo `/proposed/v0.1/` (404).

import process from 'node:process';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ChronikQueryTarget, InvoicePayToAllocator } from '@x402-xec/core';
import { createX402SettlementMiddleware } from '@x402-xec/express';
import {
  X402_DISABLED_CODE,
  X402_NOT_IMPLEMENTED_CODE,
  ZERO_LIMITS,
  killSwitchState,
  readRateLimits,
} from './policy.js';
import { DEFAULT_REDELIVERY_MAX, DEFAULT_REDELIVERY_WINDOW_SECONDS, GrantDb } from './grant-db.js';
import { X402InvoiceStore } from './invoice-store.js';
import { createIssuanceLimiter } from './issuance-limit.js';
import { PersistenceConfigError, readPersistenceConfig } from './persistence-config.js';
import { ExpiryConfigError, readExpirySeconds } from './reconcile.js';
import { TrustProxyConfigError, readTrustProxy } from './trust-proxy.js';

export const DEMO_ROUTE = '/x402/v1/access/demo';
export const DEMO_ALT_ROUTE = '/x402/v1/access/demo-alt';
export const X402_PREFIX = '/x402';
export const HEALTH_ROUTE = '/teyolia-x402/health';
export const CAPABILITIES_ROUTE = '/teyolia-x402/capabilities';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Adaptadores inyectados (DEC-AX-09 (a)). Solo los construyen los tests con fixtures sintéticos:
 * txProvider por fixtures (sin red), allocator con xpub de vector de prueba (sin llaves), importe
 * sintético. El proceso real (`startServer`) nunca los pasa.
 */
export interface X402Adapters {
  readonly store: X402InvoiceStore;
  readonly grants: GrantDb;
  readonly txProvider: ChronikQueryTarget;
  readonly payToAllocator: InvoicePayToAllocator;
  readonly amountSats: string;
  readonly publicOrigin: string;
  readonly now?: () => number;
}

function limitsAreZero(): boolean {
  return (
    ZERO_LIMITS.maxAmountPerOperationSats === 0n &&
    ZERO_LIMITS.maxAggregateSats === 0n &&
    ZERO_LIMITS.agentBudgetSats === 0n
  );
}

/** Predicado ÚNICO de la ruta y del anuncio (INF-042 §7.1 punto 2; C-03; T-17). */
export function x402RouteActive(env: Env, adapters: X402Adapters | undefined): boolean {
  return killSwitchState(env) === 'ON' && adapters !== undefined;
}

export function createApp(env: Env, adapters?: X402Adapters): express.Express {
  const state = killSwitchState(env);
  const limits = readRateLimits(env);
  const trustProxy = readTrustProxy(env);
  const expirySeconds = readExpirySeconds(env);
  const active = x402RouteActive(env, adapters);

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', trustProxy);

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
  app.get(CAPABILITIES_ROUTE, (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json({ component: 'x402-teyolia', capabilities: { x402Access: active } });
  });

  if (active && adapters) {
    const now = adapters.now ?? (() => Math.floor(Date.now() / 1000));
    const limiter = createIssuanceLimiter({
      ...limits,
      now,
      countActiveIssued: (t) => adapters.store.countActiveIssued(t),
    });
    const settlement = createX402SettlementMiddleware({
      publicOrigin: adapters.publicOrigin,
      payToAllocator: adapters.payToAllocator,
      routes: {
        [`GET ${DEMO_ROUTE}`]: { amountSats: adapters.amountSats },
        [`GET ${DEMO_ALT_ROUTE}`]: { amountSats: adapters.amountSats },
      },
      store: adapters.store,
      txProvider: adapters.txProvider,
      expirySeconds,
      now,
    });
    const grant = (req: Request, res: Response): void => {
      const out = adapters.grants.recordGrant(req.x402Settlement);
      res.set('Cache-Control', 'no-store');
      if (!out.ok) {
        res.status(out.httpStatus).json({ error: out.code });
        return;
      }
      res.status(200).json({ status: out.status, grantId: out.grantId, deliveryCount: out.deliveryCount, resource: req.path });
    };
    for (const route of [DEMO_ROUTE, DEMO_ALT_ROUTE]) {
      app.get(route, limiter, settlement, grant);
      app.all(route, x402Unavailable);
    }
  } else {
    app.all(DEMO_ROUTE, x402Unavailable);
  }
  app.use(X402_PREFIX, x402Unavailable);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });
  // T-09: una excepción del store o del middleware (SQLITE_BUSY, NONCE_ALREADY_USED…) llega aquí
  // (Express 5 reenvía los rechazos async) -> 500 controlado; el proceso sigue vivo.
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).set('Cache-Control', 'no-store').json({ error: 'internal_error' });
  });
  return app;
}

/** Opciones de la DB del grant desde la allowlist (D-4). Inválido -> error de configuración. */
export function readRedeliveryOptions(env: Env): { redeliveryMax: number; redeliveryWindowSeconds: number } {
  const num = (name: string, fallback: number, min: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min) throw new PersistenceConfigError(name, 'valor no válido');
    return Number(raw);
  };
  return {
    redeliveryMax: num('TEYOLIA_X402_REDELIVERY_MAX', DEFAULT_REDELIVERY_MAX, 0),
    redeliveryWindowSeconds: num('TEYOLIA_X402_REDELIVERY_WINDOW_SECONDS', DEFAULT_REDELIVERY_WINDOW_SECONDS, 1),
  };
}

/** Recursos persistentes del proceso (PR-3). Solo existen con el kill switch ON. */
export interface Persistence {
  readonly store: X402InvoiceStore;
  readonly grants: GrantDb;
}

/**
 * Abre store y grant (archivos propios y distintos) solo con el kill switch ON: con OFF no se
 * crea ni se escribe ningún archivo (R-14). Configuración inválida -> null y exitCode 78.
 */
export function openPersistence(env: Env): Persistence | null | 'invalid' {
  if (killSwitchState(env) !== 'ON') return null;
  try {
    const cfg = readPersistenceConfig(env);
    const store = new X402InvoiceStore(cfg.storePath);
    try {
      return { store, grants: new GrantDb(cfg.grantDbPath, readRedeliveryOptions(env)) };
    } catch (err) {
      store.shutdown();
      throw err;
    }
  } catch (err) {
    const why = err instanceof PersistenceConfigError ? `${err.variable} (${err.reason})` : 'error al abrir la persistencia';
    process.stderr.write(`x402-teyolia: persistencia rechazada: ${why}\n`);
    return 'invalid';
  }
}

export function startServer(env: Env): void {
  const persistence = openPersistence(env);
  if (persistence === 'invalid') {
    process.stderr.write('x402-teyolia: arranque abortado por la configuración de persistencia\n');
    process.exitCode = 78;
    return;
  }
  let app: express.Express;
  try {
    app = createApp(env);
  } catch (err) {
    const why = err instanceof TrustProxyConfigError || err instanceof ExpiryConfigError ? err.message : 'configuración no válida';
    process.stderr.write(`x402-teyolia: configuración rechazada: ${why}\n`);
    persistence?.grants.shutdown();
    persistence?.store.shutdown();
    process.exitCode = 78;
    return;
  }
  const port = Number(env['TEYOLIA_X402_LISTEN']);
  const server = app.listen(port, '127.0.0.1', (error?: Error) => {
    if (error) {
      process.stderr.write('x402-teyolia: no se pudo abrir el puerto\n');
      persistence?.grants.shutdown();
      persistence?.store.shutdown();
      process.exitCode = 1;
      return;
    }
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    process.stdout.write(
      `x402-teyolia: escuchando en 127.0.0.1:${bound} (kill switch ${killSwitchState(env)})\n`,
    );
  });
  // TR-01 (T-07): cierre ordenado en SIGTERM/SIGINT. Deja de aceptar conexiones, cierra las
  // inactivas y, al cerrar el servidor, hace checkpoint WAL y cierra grant y store.
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      let ok = true;
      for (const close of [() => persistence?.grants.shutdown(), () => persistence?.store.shutdown()]) {
        try { close(); } catch { ok = false; }
      }
      if (!ok) process.stderr.write('x402-teyolia: error en el cierre ordenado de la persistencia\n');
      process.exitCode = ok ? 0 : 1;
    });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
