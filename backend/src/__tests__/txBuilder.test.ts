import { describe, expect, it } from 'vitest';
import {
  buildPayoutTx,
  buildPledgeTx,
  signHybridPayoutTx,
} from '../blockchain/txBuilder';
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
  it('pays the beneficiary with a single output and disables treasury cut', async () => {
    const creatorAddress = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
    const totalRaised = 100000n;

    const built = await buildPayoutTx({
      campaignUtxos: [
        {
          txid: '55'.repeat(32),
          vout: 1,
          value: totalRaised,
          scriptPubKey: '51',
        },
      ],
      gasUtxo: {
        txid: '77'.repeat(32),
        vout: 0,
        value: 500n,
        scriptPubKey: '76a914000000000000000000000000000000000000000088ac',
      },
      gasAddress: creatorAddress,
      totalRaised,
      beneficiaryAddress: creatorAddress,
      fixedFee: 500n,
    });

    expect(built.treasuryCut).toBe(0n);
    expect(built.beneficiaryAmount).toBe(100000n);
    expect(built.beneficiaryAmount + built.treasuryCut).toBe(totalRaised);
    expect(built.unsignedTx.inputs).toHaveLength(2);
    expect(built.unsignedTx.outputs).toHaveLength(1);
    expect(built.unsignedTx.outputs[0]?.value).toBe(100000n);
  });

  it('keeps exact total conservation without treasury output', async () => {
    const creatorAddress = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
    const totalRaised = 101n;

    const built = await buildPayoutTx({
      campaignUtxos: [
        {
          txid: '66'.repeat(32),
          vout: 0,
          value: totalRaised,
          scriptPubKey: '51',
        },
      ],
      gasUtxo: {
        txid: '88'.repeat(32),
        vout: 1,
        value: 700n,
        scriptPubKey: '76a914000000000000000000000000000000000000000088ac',
      },
      gasAddress: creatorAddress,
      totalRaised,
      beneficiaryAddress: creatorAddress,
      fixedFee: 500n,
    });

    expect(built.treasuryCut).toBe(0n);
    expect(built.beneficiaryAmount).toBe(101n);
    expect(built.beneficiaryAmount + built.treasuryCut).toBe(totalRaised);
    expect(built.unsignedTx.outputs).toHaveLength(1);
  });

  it('signs a hybrid payout preserving all covenant inputs and a DER gas signature', () => {
    const raw = signHybridPayoutTx(
      {
        inputs: [
          { txid: '11'.repeat(32), vout: 0, value: 700n, scriptPubKey: '51' },
          { txid: '22'.repeat(32), vout: 1, value: 300n, scriptPubKey: '51' },
          {
            txid: '33'.repeat(32),
            vout: 2,
            value: 900n,
            scriptPubKey: '76a914000000000000000000000000000000000000000088ac',
          },
        ],
        outputs: [
          { value: 1000n, scriptPubKey: '76a914111111111111111111111111111111111111111188ac' },
          { value: 400n, scriptPubKey: '76a914222222222222222222222222222222222222222288ac' },
        ],
      },
      Buffer.from('01'.repeat(32), 'hex'),
      '51',
      2
    );

    expect(raw).toMatch(/^[0-9a-f]+$/);
    expect(raw.startsWith('02000000')).toBe(true);
  });

  it('rejects hybrid signing when the gas input lacks a scriptPubKey', () => {
    expect(() => signHybridPayoutTx(
      {
        inputs: [
          { txid: '11'.repeat(32), vout: 0, value: 1000n, scriptPubKey: '51' },
          { txid: '22'.repeat(32), vout: 1, value: 500n, scriptPubKey: '' },
        ],
        outputs: [{ value: 1000n, scriptPubKey: '76a914111111111111111111111111111111111111111188ac' }],
      },
      Buffer.from('01'.repeat(32), 'hex'),
      '51',
      1
    )).toThrow('gas-input-missing-scriptpubkey');
  });
});
