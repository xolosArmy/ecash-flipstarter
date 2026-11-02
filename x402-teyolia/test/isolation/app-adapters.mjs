// PR-6 (T-12d, fase «ON con adaptadores»): levanta la app real de dist/ (createApp, arnés PR-4) con
// fixtures EN PROCESO, con el uid de x402 que fija el driver. El cliente C3B corre FUERA (root), así
// que cualquier conexión nueva de este uid sería egreso. El «pago» sintético llega por stdin
// («settle <payTo> <amountSats>»), nunca por red; sin llaves, firma ni broadcast.
import { createInterface } from 'node:readline';
import { startApp } from '../pr4-harness.mjs';
import { payingTx } from '../fixtures/x402/chronik-fixtures.mjs';

const h = await startApp();
process.stdout.write(`PORT ${h.port}\n`);
let n = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, payTo, amount] = line.trim().split(/\s+/);
  if (cmd === 'settle') {
    const txid = `150${(++n).toString(16)}`.padStart(64, '0');
    h.provider.set(txid, { ...payingTx({ payTo, sats: BigInt(amount), timeFirstSeen: h.clock.t }), txid });
    process.stdout.write(`TXID ${txid}\n`);
  } else if (cmd === 'stats') {
    process.stdout.write(`STATS ${JSON.stringify({ chronikCalls: h.provider.calls, grants: h.grants.countGrants() })}\n`);
  } else if (cmd === 'exit') {
    h.close().then(() => process.exit(0));
  }
});
