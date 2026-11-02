import { Router } from 'express';
import { broadcastTx } from '../blockchain/ecashClient';
import { ECASH_BACKEND } from '../config/ecash';
import { validateHex } from '../utils/validation';
import {
  isPublicBroadcastEnabled,
  MONETARY_ROUTE_DISABLED_STATUS,
  publicBroadcastDisabledBody,
} from '../security/monetaryRouteGates';

const router = Router();

export async function handleBroadcast(req: any, res: any) {
  if (!isPublicBroadcastEnabled()) {
    res.status(MONETARY_ROUTE_DISABLED_STATUS).json(publicBroadcastDisabledBody());
    return;
  }
  try {
    const rawTxHex = req.body.rawTxHex as string | undefined;
    if (typeof rawTxHex !== 'string') {
      res.status(400).json({ error: 'rawTxHex-required' });
      return;
    }
    const sanitized = validateHex(rawTxHex);
    const result = await broadcastTx(sanitized);
    res.json({ txid: result.txid, backendMode: ECASH_BACKEND, message: 'broadcasted' });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

router.post('/broadcast', handleBroadcast);
router.post('/tx/broadcast', handleBroadcast);

export default router;
