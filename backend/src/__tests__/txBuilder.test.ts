import { describe, expect, it } from 'vitest';
import { buildPledgeTx } from '../blockchain/txBuilder';

describe('buildPledgeTx', () => {
  it('builds a genesis pledge without a covenant input', async () => {
    const built = await buildPledgeTx({
      contributorUtxos: [
        {
          txid: '11'.repeat(32),
          vout: 0,
          value: 1000n,
          scriptPubKey: '76a914000000000000000000000000000000000000000088ac',
        },
      ],
      covenantUtxo: {
        txid: '',
        vout: 0,
        value: 0n,
        scriptPubKey: '51',
      },
      amount: 1000n,
      covenantScriptHash: '',
      contributorAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    });

    expect(built.unsignedTx.inputs).toHaveLength(1);
    expect(built.unsignedTx.outputs[0].scriptPubKey).toMatch(/^76a914[0-9a-f]+88ac$/);
  });
});
