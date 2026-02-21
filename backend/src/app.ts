import { execSync } from 'node:child_process';
import express from 'express';
import cors from 'cors';
import campaignsRouter from './routes/campaigns.routes';
import pledgeRouter from './routes/pledge.routes';
import pledgeBuildRouter from './routes/pledge.build';
import finalizeRouter from './routes/finalize.routes';
import refundRouter from './routes/refund.routes';
import broadcastRouter from './routes/broadcast.routes';
import walletConnectRouter from './routes/walletconnect.routes';
import { ECASH_BACKEND } from './config/ecash';
import { getEffectiveChronikBaseUrl, getTipHeight } from './blockchain/ecashClient';

export const healthHandler = async (_req: any, res: any) => {
  const tipHeight = await getTipHeight();
  return res.json({
    status: 'ok',
    ok: true,
    backendMode: ECASH_BACKEND,
    chronikBaseUrl: getEffectiveChronikBaseUrl(),
    tipHeight,
    timestamp: new Date().toISOString(),
  });
};

export const versionHandler = (_req: any, res: any) => {
  const gitCommit = process.env.GIT_COMMIT_HASH
    || (() => {
      try {
        return execSync('git rev-parse --short HEAD').toString().trim();
      } catch (_err) {
        return 'unknown';
      }
    })();

  return res.json({
    version: process.env.npm_package_version || 'unknown',
    gitCommit,
    processName: process.env.name || process.title,
    chronikUrl: getEffectiveChronikBaseUrl(),
  });
};

export function createApp() {
  const app = express();

  app.use(cors({ origin: true, credentials: true }));
  app.options('*', cors());

  app.use(express.json());

  app.get('/health', healthHandler);
  app.get('/version', versionHandler);

  app.use('/api', campaignsRouter);
  app.use('/api', pledgeRouter);
  app.use('/api', pledgeBuildRouter);
  app.use('/api', finalizeRouter);
  app.use('/api', refundRouter);
  app.use('/api', broadcastRouter);
  app.use('/api', walletConnectRouter);

  return app;
}

const app = createApp();
export default app;
