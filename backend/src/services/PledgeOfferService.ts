import { randomBytes, randomUUID } from 'crypto';
import { PledgeService } from './PledgeService';
import { serializeBuiltTx } from '../routes/serialize';
import { walletConnectOfferStore } from './WalletConnectOfferStore';
import { savePledge } from '../store/simplePledges';

const pledgeService = new PledgeService();

export async function createWalletConnectPledgeOffer(
  campaignId: string,
  contributorAddress: string,
  amount: bigint,
  options?: {
    campaignAddress?: string;
    message?: string;
  },
) {
  const tx = await pledgeService.createPledgeTx(campaignId, contributorAddress, amount);
  const built = serializeBuiltTx(tx);
  const campaignAddress = String(options?.campaignAddress ?? '').trim();
  if (!campaignAddress) {
    throw new Error('campaign-address-required');
  }

  const outputs = [{ address: campaignAddress, valueSats: Number(amount) }];
  const userPrompt = options?.message
    ? `Donate ${amount.toString()} sats. Memo: ${options.message}`
    : `Donate ${amount.toString()} sats`;

  const offer = walletConnectOfferStore.createOffer({
    campaignId,
    mode: 'intent',
    outputs,
    userPrompt,
    amount: amount.toString(),
    contributorAddress,
  });
  console.log(
    `[pledge.build] wc offer created offerId=${offer.offerId} campaign=${offer.campaignId} amount=${offer.amount}`,
  );

  const pledgeId = createPledgeId();
  await savePledge(campaignId, {
    pledgeId,
    txid: null,
    wcOfferId: offer.offerId,
    amount: Number(amount),
    contributorAddress,
    timestamp: new Date().toISOString(),
    message: options?.message,
  });

  return {
    ...built,
    mode: 'intent' as const,
    outputs,
    userPrompt,
    wcOfferId: offer.offerId,
    fee: typeof (built as { fee?: string }).fee === 'string' ? (built as { fee?: string }).fee : '0',
    pledgeId,
    amount: offer.amount,
    contributorAddress: offer.contributorAddress,
    campaignId: offer.campaignId,
    expiresAt: offer.expiresAt,
  };
}

function createPledgeId(): string {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  return randomBytes(16).toString('hex');
}
