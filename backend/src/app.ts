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

export function createApp() {
  const app = express();
  
  // Acepta CUALQUIER origen (Soluciona el bloqueo CORS de Vercel)
  app.use(cors({ origin: true, credentials: true }));
  app.options('*', cors());
  
  app.use(express.json());

  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  
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
