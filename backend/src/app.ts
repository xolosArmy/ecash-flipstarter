import express from 'express';
import campaignsRouter from './routes/campaigns.routes';
import pledgeRouter from './routes/pledge.routes';
import finalizeRouter from './routes/finalize.routes';
import refundRouter from './routes/refund.routes';
import broadcastRouter from './routes/broadcast.routes';
import { ECASH_BACKEND, USE_CHRONIK } from './config/ecash';
import {
  getBlockchainInfo,
  getEffectiveChronikBaseUrl,
  getTipHeight,
} from './blockchain/ecashClient';

export function createApp() {
  const app = express();

  const defaultOrigin = 'http://127.0.0.1:5173';
  const allowedOrigin = (process.env.ALLOWED_ORIGIN || defaultOrigin).trim();
  // Allow only the configured origin; no wildcard in production.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      if (req.method === 'OPTIONS') {
        return res.sendStatus(403);
      }
      return res.status(403).json({ error: 'cors-not-allowed' });
    }
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  app.use(express.json());

  // Healthchecks
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/health', healthHandler);

  // Rutas de la API
  app.use('/api', campaignsRouter);
  app.use('/api', pledgeRouter);
  app.use('/api', finalizeRouter);
  app.use('/api', refundRouter);
  app.use('/api', broadcastRouter);

  return app;
}

export async function healthHandler(_req: express.Request, res: express.Response) {
  const timestamp = new Date().toISOString();
  try {
    if (USE_CHRONIK) {
      try {
        const blockchainInfo = await getBlockchainInfo();
        const tipHeight =
          (blockchainInfo as { tipHeight?: number }).tipHeight ??
          (blockchainInfo as { tip_height?: number }).tip_height ??
          0;
        res.json({
          status: 'ok',
          network: 'XEC',
          backendMode: ECASH_BACKEND,
          chronikBaseUrl: getEffectiveChronikBaseUrl(),
          tipHeight,
          timestamp,
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.json({
          status: 'error',
          network: 'XEC',
          backendMode: 'chronik',
          chronikBaseUrl: getEffectiveChronikBaseUrl(),
          error: `Chronik protobuf client failed: ${message}`,
          timestamp,
        });
        return;
      }
    }
    const tipHeight = await getTipHeight();
    res.json({
      status: 'ok',
      network: 'XEC',
      backendMode: ECASH_BACKEND,
      tipHeight,
      timestamp,
    });
  } catch (err) {
    res.json({
      status: 'error',
      backendMode: ECASH_BACKEND,
      error: (err as Error).message,
      timestamp,
    });
  }
}

const app = createApp();
export default app;
