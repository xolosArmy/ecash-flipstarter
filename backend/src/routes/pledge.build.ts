import { Router } from 'express';
import { ChronikClient } from 'chronik-client';
import { TxBuilder, Script, P2PKHSignatory, ALL_BIP143, Ecc } from '@ecash/lib';
import { decodeBase58 } from 'b58-ts';
import { campaignStore } from '../services/CampaignService';
import { validateAddress } from '../utils/validation';
import { CHRONIK_BASE_URL } from '../config/ecash';

const router = Router();
const chronik = new ChronikClient([CHRONIK_BASE_URL]);
const FIXED_FEE = 500n;
const DUST_LIMIT = 546n;

router.post('/campaigns/:id/pledge/build', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = campaignStore.get(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    if (!campaign.beneficiaryAddress) {
      throw new Error('beneficiary-address-required');
    }

    const contributorAddressRaw = req.body.contributorAddress as string;
    const wif = req.body.wif as string;
    const amountRaw = req.body.amount;

    if (typeof contributorAddressRaw !== 'string' || !contributorAddressRaw.trim()) {
      return res.status(400).json({ error: 'missing-address' });
    }
    const contributorAddress = validateAddress(contributorAddressRaw, 'contributorAddress');
    if (typeof wif !== 'string' || !wif.trim()) {
      return res.status(400).json({ error: 'wif-required' });
    }
    const amountNum = Number(amountRaw);
    if (!Number.isFinite(amountNum) || !Number.isInteger(amountNum) || amountNum < 1000) {
      return res.status(400).json({
        error: 'El monto debe ser un número entero mayor o igual a 1000 satoshis.',
      });
    }
    const amountSat = BigInt(amountNum);

    const addressNoPrefix = contributorAddress.toLowerCase().startsWith('ecash:')
      ? contributorAddress.slice('ecash:'.length)
      : contributorAddress;
    const utxosResult = await chronik.address(addressNoPrefix).utxos();
    const utxos = utxosResult.utxos.map((utxo) => ({
      txid: utxo.outpoint.txid,
      vout: utxo.outpoint.outIdx,
      value: BigInt(utxo.sats),
    }));

    let totalInput = 0n;
    const selectedUtxos: typeof utxos = [];
    for (const utxo of utxos) {
      selectedUtxos.push(utxo);
      totalInput += utxo.value;
      if (totalInput >= amountSat + FIXED_FEE) break;
    }
    if (totalInput < amountSat + FIXED_FEE) {
      throw new Error('insufficient-funds');
    }

    let changeAmount = totalInput - amountSat - FIXED_FEE;
    let feePaid = FIXED_FEE;
    if (changeAmount > 0n && changeAmount < DUST_LIMIT) {
      feePaid += changeAmount;
      changeAmount = 0n;
    }

    let privKeyBytes: Uint8Array;
    try {
      const decoded = decodeBase58(wif.trim());
      const buffer = Buffer.from(decoded);
      if (buffer.length !== 37 && buffer.length !== 38) {
        throw new Error('wif-invalid');
      }
      const versionByte = buffer[0];
      if (versionByte !== 0x80 && versionByte !== 0xef) {
        throw new Error('wif-invalid');
      }
      privKeyBytes = buffer.subarray(1, 33);
    } catch (_err) {
      return res.status(400).json({ error: 'wif-invalid' });
    }

    const ecc = new Ecc();
    const pubKeyBytes = ecc.derivePubkey(privKeyBytes);

    const contributorScript = Script.fromAddress(contributorAddress);
    const beneficiaryScript = Script.fromAddress(campaign.beneficiaryAddress);
    const signatory = P2PKHSignatory(privKeyBytes, pubKeyBytes, ALL_BIP143);
    const builderInputs = selectedUtxos.map((utxo) => ({
      input: {
        prevOut: { txid: utxo.txid, outIdx: utxo.vout },
        signData: { value: utxo.value, outputScript: contributorScript },
      },
      signatory,
    }));
    const builderOutputs = [
      { value: amountSat, script: beneficiaryScript },
      ...(changeAmount > 0n ? [{ value: changeAmount, script: contributorScript }] : []),
    ];

    const txBuilder = new TxBuilder({ inputs: builderInputs, outputs: builderOutputs });
    const signedTx = txBuilder.sign(new Ecc());
    const txHex = Buffer.from(signedTx.ser()).toString('hex');

    return res.json({
      txHex,
      usedUtxos: selectedUtxos.length,
      totalInput: totalInput.toString(),
      change: changeAmount.toString(),
      fee: feePaid.toString(),
    });
  } catch (err) {
    console.error('[pledge.build] Error:', err);
    const message = (err as Error).message || String(err);
    if (
      message === 'insufficient-funds' ||
      message === 'beneficiary-address-required' ||
      message === 'contributorAddress-invalid' ||
      message === 'contributorAddress-required' ||
      message === 'wif-invalid'
    ) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'internal-error' });
  }
});

export default router;
