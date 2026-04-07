import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  buildFinalizeTx,
  buildPayoutTx,
  buildPledgeTx,
  buildFinalizeUnlockingScriptV1,
  buildRefundTx,
  buildPledgeUnlockingScriptV1,
  buildRefundUnlockingScriptV1,
  computeEcashSigHash,
  signHybridPayoutTx,
  signRefundInputV1,
} from '../blockchain/txBuilder';
import { addressToScriptPubKey } from '../blockchain/ecashClient';
import { TEYOLIA_COVENANT_V1, compileCampaignCovenantV1 } from '../covenants/scriptCompiler';

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

  it('builds the V1 covenant pledge unlocking script with selector 0x03 and redeemScript', async () => {
    const contributorAddress = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
    const contributorScript = await addressToScriptPubKey(contributorAddress);
    const redeemScriptHex = '51';

    const built = await buildPledgeTx({
      contributorUtxos: [
        {
          txid: '11'.repeat(32),
          vout: 0,
          value: 5000n,
          scriptPubKey: contributorScript,
        },
      ],
      covenantUtxo: {
        txid: '22'.repeat(32),
        vout: 1,
        value: 3000n,
        scriptPubKey: 'a914' + 'ab'.repeat(20) + '87',
      },
      amount: 1000n,
      covenantScriptHash: '',
      contributorAddress,
      campaignScriptPubKey: 'a914' + 'ab'.repeat(20) + '87',
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex,
    });

    expect(built.unsignedTx.inputs[0]?.scriptSig).toBe(buildPledgeUnlockingScriptV1(redeemScriptHex));
    expect(built.unsignedTx.outputs[0]).toEqual({
      value: 4000n,
      scriptPubKey: 'a914' + 'ab'.repeat(20) + '87',
    });
  });
});

describe('V1 covenant spends', () => {
  const beneficiaryAddress = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
  const refundAddress = 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035';
  const covenantScriptPubKey = 'a914' + 'cd'.repeat(20) + '87';
  const redeemScriptHex = '51';
  const beneficiaryPrivKey = Buffer.from('01'.repeat(32), 'hex');
  const oraclePrivKey = Buffer.from('02'.repeat(32), 'hex');

  it('builds a signed V1 finalize tx and preserves the expected spend shape', async () => {
    const covenant = compileCampaignCovenantV1({
      goal: 4000n,
      expirationTime: 123456n,
      beneficiaryPubKey:
        '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      refundOraclePubKey:
        '024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ea5d0a1c6b7b29f1974f2d4d9f12',
    });
    const built = await buildFinalizeTx({
      covenantUtxo: {
        txid: '33'.repeat(32),
        vout: 0,
        value: 5000n,
        scriptPubKey: covenantScriptPubKey,
      },
      beneficiaryAddress,
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex: covenant.redeemScriptHex,
      beneficiaryPrivKey,
      beneficiaryPubKey:
        '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      gasUtxos: [
        {
          txid: '88'.repeat(32),
          vout: 1,
          value: 2000n,
          scriptPubKey: '76a914' + '11'.repeat(20) + '88ac',
        },
      ],
      gasChangeAddress: beneficiaryAddress,
      gasPrivKey: Buffer.from('03'.repeat(32), 'hex'),
    });

    expect(built.rawHex).toMatch(/^[0-9a-f]+$/);
    expect(built.unsignedTx.inputs).toHaveLength(2);
    const scriptSig = built.unsignedTx.inputs[0]?.scriptSig ?? '';
    const { dataHex: flaggedSigHex, nextOffset: afterFlaggedSig } = readPushHex(scriptSig, 0);
    const { dataHex: rawSigHex, nextOffset: afterRawSig } = readPushHex(scriptSig, afterFlaggedSig);
    const { dataHex: preimageHex, nextOffset: afterPreimage } = readPushHex(scriptSig, afterRawSig);
    const { dataHex: preimageSha256Hex, nextOffset: afterPreimageSha256 } = readPushHex(scriptSig, afterPreimage);
    const { dataHex: output0Hex, nextOffset: afterOutput0 } = readPushHex(scriptSig, afterPreimageSha256);

    expect(scriptSig).toBe(
      buildFinalizeUnlockingScriptV1(
        flaggedSigHex,
        rawSigHex,
        preimageHex,
        preimageSha256Hex,
        output0Hex,
        covenant.redeemScriptHex,
      ),
    );
    expect(scriptSig.slice(afterOutput0, afterOutput0 + 2)).toBe('51');
    expect(flaggedSigHex).toHaveLength(130);
    expect(rawSigHex).toHaveLength(128);
    expect(Buffer.from(flaggedSigHex, 'hex')).toHaveLength(65);
    expect(Buffer.from(rawSigHex, 'hex')).toHaveLength(64);
    expect(flaggedSigHex.endsWith('c3')).toBe(true);
    expect(preimageSha256Hex).toBe(crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex'));
    expect(Buffer.from(output0Hex, 'hex')).toHaveLength(34);
    expect(output0Hex).toBe(`881300000000000019${await addressToScriptPubKey(beneficiaryAddress)}`);
    expect(built.unsignedTx.outputs[0]).toEqual({
      value: 5000n,
      scriptPubKey: await addressToScriptPubKey(beneficiaryAddress),
    });
    expect(built.fee).toBe(1000n);
  });

  it('refund scriptSig contains oracle signature, selector 0x02 and redeemScript', async () => {
    const built = await buildRefundTx({
      covenantUtxo: {
        txid: '44'.repeat(32),
        vout: 1,
        value: 6000n,
        scriptPubKey: covenantScriptPubKey,
      },
      refundAddress,
      refundAmount: 2000n,
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex,
      refundOraclePrivKey: oraclePrivKey,
      expirationTime: 123456n,
    });

    const signature = signRefundInputV1(
      {
        ...built.unsignedTx,
        inputs: built.unsignedTx.inputs.map((input, index) => (index === 0 ? { ...input, scriptSig: undefined } : input)),
      },
      oraclePrivKey,
      redeemScriptHex,
      0,
    );

    expect(built.unsignedTx.inputs[0]?.scriptSig).toBe(
      buildRefundUnlockingScriptV1(signature, redeemScriptHex),
    );
    expect(signature.endsWith('41')).toBe(true);
  });

  it('refund uses the requested locktime and a non-final sequence when CLTV applies', async () => {
    const built = await buildRefundTx({
      covenantUtxo: {
        txid: '55'.repeat(32),
        vout: 2,
        value: 6000n,
        scriptPubKey: covenantScriptPubKey,
      },
      refundAddress,
      refundAmount: 2000n,
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex,
      refundOraclePrivKey: oraclePrivKey,
      expirationTime: 987654n,
    });

    expect(built.unsignedTx.locktime).toBe(987654);
    expect(built.unsignedTx.inputs[0]?.sequence).toBe(0xfffffffe);
  });

  it('refund normalizes millisecond locktimes to seconds', async () => {
    const built = await buildRefundTx({
      covenantUtxo: {
        txid: '56'.repeat(32),
        vout: 2,
        value: 6000n,
        scriptPubKey: covenantScriptPubKey,
      },
      refundAddress,
      refundAmount: 2000n,
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex,
      refundOraclePrivKey: oraclePrivKey,
      expirationTime: 1_775_234_960_697n,
    });

    expect(built.unsignedTx.locktime).toBe(1_775_234_960);
    expect(built.unsignedTx.inputs[0]?.sequence).toBe(0xfffffffe);
  });

  it('computes a deterministic eCash sighash for V1 signing', () => {
    const tx = {
      inputs: [
        {
          txid: '66'.repeat(32),
          vout: 0,
          value: 5000n,
          scriptPubKey: covenantScriptPubKey,
          sequence: 0xfffffffe,
        },
      ],
      outputs: [
        { value: 2000n, scriptPubKey: '76a914' + '11'.repeat(20) + '88ac' },
        { value: 2500n, scriptPubKey: covenantScriptPubKey },
      ],
      locktime: 123456,
    };

    expect(computeEcashSigHash(tx, 0, redeemScriptHex)).toBe(computeEcashSigHash(tx, 0, redeemScriptHex));
  });

  it('refund signature changes when non-covered finalize-style assumptions no longer apply and outputs change', () => {
    const tx = {
      inputs: [
        {
          txid: '66'.repeat(32),
          vout: 0,
          value: 5000n,
          scriptPubKey: covenantScriptPubKey,
          sequence: 0xfffffffe,
        },
      ],
      outputs: [
        { value: 2000n, scriptPubKey: '76a914' + '11'.repeat(20) + '88ac' },
        { value: 2500n, scriptPubKey: covenantScriptPubKey },
      ],
      locktime: 123456,
    };
    const changedOutputsTx = {
      ...tx,
      outputs: [
        { value: 2001n, scriptPubKey: '76a914' + '11'.repeat(20) + '88ac' },
        { value: 2499n, scriptPubKey: covenantScriptPubKey },
      ],
    };

    expect(signRefundInputV1(tx, oraclePrivKey, redeemScriptHex)).not.toBe(
      signRefundInputV1(changedOutputsTx, oraclePrivKey, redeemScriptHex),
    );
  });

  it('legacy campaigns keep using the old finalize path', async () => {
    const built = await buildFinalizeTx({
      covenantUtxo: {
        txid: '77'.repeat(32),
        vout: 0,
        value: 5000n,
        scriptPubKey: '51',
      },
      beneficiaryAddress,
    });

    expect(built.unsignedTx.inputs[0]?.scriptSig).toBeUndefined();
    expect(built.unsignedTx.outputs).toHaveLength(1);
    expect(built.unsignedTx.outputs[0]?.value).toBe(5000n);
  });
});

function readPushHex(scriptHex: string, offset: number): { dataHex: string; nextOffset: number } {
  const opcode = parseInt(scriptHex.slice(offset, offset + 2), 16);
  if (Number.isNaN(opcode)) {
    throw new Error('invalid-script-offset');
  }

  let size = opcode;
  let cursor = offset + 2;
  if (opcode === 0x4c) {
    size = parseInt(scriptHex.slice(cursor, cursor + 2), 16);
    cursor += 2;
  } else if (opcode === 0x4d) {
    size = parseInt(scriptHex.slice(cursor + 2, cursor + 4) + scriptHex.slice(cursor, cursor + 2), 16);
    cursor += 4;
  }

  const dataHex = scriptHex.slice(cursor, cursor + size * 2);
  return {
    dataHex,
    nextOffset: cursor + size * 2,
  };
}

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
