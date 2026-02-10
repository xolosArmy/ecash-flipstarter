import { PledgeService } from './PledgeService';
import { serializeBuiltTx } from '../routes/serialize';
import { walletConnectOfferStore } from './WalletConnectOfferStore';

const pledgeService = new PledgeService();

export async function createWalletConnectPledgeOffer(
  campaignId: string,
  contributorAddress: string,
  amount: bigint,
) {
  const tx = await pledgeService.createPledgeTx(campaignId, contributorAddress, amount);
  const built = serializeBuiltTx(tx);
  const unsignedTxHex = built.unsignedTxHex || built.rawHex;
  const offer = walletConnectOfferStore.createOffer({
    campaignId,
    unsignedTxHex,
    amount: amount.toString(),
    contributorAddress,
  });
  console.log(
    `[pledge.build] wc offer created offerId=${offer.offerId} campaign=${offer.campaignId} amount=${offer.amount}`,
  );

  return {
    ...built,
    wcOfferId: offer.offerId,
    fee: typeof (built as { fee?: string }).fee === 'string' ? (built as { fee?: string }).fee : '0',
    amount: offer.amount,
    contributorAddress: offer.contributorAddress,
    campaignId: offer.campaignId,
    expiresAt: offer.expiresAt,
  };
}
