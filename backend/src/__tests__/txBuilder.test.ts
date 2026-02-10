import { describe, expect, it } from 'vitest';
import { buildPledgeTx } from '../blockchain/txBuilder';
import { addressToScriptPubKey } from '../blockchain/ecashClient';

describe('buildPledgeTx', () => {
  it('routes campaign output first and contributor change last', async () => {
    const contributorAddress = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
    const contributorScript = await addressToScriptPubKey(contributorAddress);
    const built = await buildPledgeTx({
      contributorUtxos: [
        {
          txid: '11'.repeat(32),
          vout: 0,
          value: 10000n,
          scriptPubKey: contributorScript,
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
      contributorAddress,
      campaignScriptPubKey: '51',
    });

    expect(built.unsignedTx.inputs).toHaveLength(1);
    expect(built.unsignedTx.outputs[0]).toEqual({ value: 1000n, scriptPubKey: '51' });
    expect(built.unsignedTx.outputs.at(-1)?.scriptPubKey).toBe(contributorScript);
  });

  it('rejects token-bearing contributor utxos', async () => {
    await expect(
      buildPledgeTx({
        contributorUtxos: [
          {
            txid: '33'.repeat(32),
            vout: 0,
            value: 2000n,
            scriptPubKey: '76a914000000000000000000000000000000000000000088ac',
            token: { amount: '1' },
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
        campaignScriptPubKey: '51',
      }),
    ).rejects.toThrow('token-utxo-not-supported');
  });
});
