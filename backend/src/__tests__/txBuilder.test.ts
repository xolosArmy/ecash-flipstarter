import { describe, expect, it } from 'vitest';
import { buildPayoutTx, buildPledgeTx } from '../blockchain/txBuilder';
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

describe('buildPayoutTx', () => {
  it('splits payout as 99% creator and 1% treasury', async () => {
    const creatorAddress = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
    const treasuryAddress = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';
    const totalRaised = 100000n;

    const built = await buildPayoutTx({
      campaignUtxos: [
        {
          txid: '55'.repeat(32),
          vout: 1,
          value: totalRaised + 500n,
          scriptPubKey: '51',
        },
      ],
      totalRaised,
      beneficiaryAddress: creatorAddress,
      treasuryAddress,
      fixedFee: 500n,
    });

    expect(built.treasuryCut).toBe(1000n);
    expect(built.beneficiaryAmount).toBe(99000n);
    expect(built.beneficiaryAmount + built.treasuryCut).toBe(totalRaised);
    expect(built.unsignedTx.outputs[0]?.value).toBe(99000n);
    expect(built.unsignedTx.outputs[1]?.value).toBe(1000n);
  });

  it('uses floor rounding for treasury cut and keeps exact total conservation', async () => {
    const creatorAddress = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
    const treasuryAddress = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';
    const totalRaised = 101n;

    const built = await buildPayoutTx({
      campaignUtxos: [
        {
          txid: '66'.repeat(32),
          vout: 0,
          value: totalRaised + 500n,
          scriptPubKey: '51',
        },
      ],
      totalRaised,
      beneficiaryAddress: creatorAddress,
      treasuryAddress,
      fixedFee: 500n,
    });

    expect(built.treasuryCut).toBe(1n);
    expect(built.beneficiaryAmount).toBe(100n);
    expect(built.beneficiaryAmount + built.treasuryCut).toBe(totalRaised);
  });
});
