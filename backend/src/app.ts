import express from 'express';
import cors from 'cors';
import campaignsRouter, { loadCampaignsFromDisk } from './routes/campaigns.routes';
import pledgeRouter from './routes/pledge.routes';
import pledgeBuildRouter from './routes/pledge.build';
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

  const isProduction = process.env.NODE_ENV === 'production';
  const allowDevLocalhost = !isProduction;
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const devLocalhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      const isAllowed =
        allowedOrigins.includes(origin) || (allowDevLocalhost && devLocalhostRegex.test(origin));
      if (!isProduction) {
        console.log(`[cors] origin ${isAllowed ? 'allowed' : 'blocked'}: ${origin}`);
      }
      callback(null, isAllowed);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  app.use(express.json());

  loadCampaignsFromDisk();

  // Healthchecks
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/health', healthHandler);

  // Rutas de la API
  app.use('/api', campaignsRouter);
  app.use('/api', pledgeRouter);
  app.use('/api', pledgeBuildRouter);
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
