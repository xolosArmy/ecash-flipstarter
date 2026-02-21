import { getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPledgeTx, type BuiltTx } from '../blockchain/txBuilder';
import type { Utxo } from '../blockchain/types';
import { campaignStore, covenantIndexInstance } from './CampaignService';
import { resolveEscrowAddress } from './escrowAddress';
import { getDb } from '../store/db';

const MIN_PLEDGE_FEE_SATS = 500n;

export class PledgeService {
  async createPledgeTx(campaignId: string, contributorAddress: string, amount: bigint): Promise<BuiltTx & { nextCovenantValue: bigint }> {
    const covenant = covenantIndexInstance.getCovenantRef(campaignId);
    if (!covenant) throw new Error('campaign-not-found');
    const campaign = campaignStore.get(campaignId);
    if (!campaign) throw new Error('campaign-not-found');
    const escrowAddress = resolveEscrowAddress(campaign as any);
    const contributorUtxos = await getUtxosForAddress(contributorAddress);
    const nonTokenUtxos = contributorUtxos.filter((utxo: Utxo) => !this.hasToken(utxo));
    
    const built = await this.buildWithSelectedUtxos({ utxos: nonTokenUtxos, amount, contributorAddress, covenant, beneficiaryAddress: escrowAddress });
    return { ...built, nextCovenantValue: covenant.value + amount };
  }

  async listAllPledges() {
    const db = await getDb();
    return db.all('SELECT * FROM pledges');
  }

  async listPledges(campaignId: string) {
    const db = await getDb();
    return db.all('SELECT * FROM pledges WHERE campaignId = ?', campaignId);
  }

  async getCampaignSummary(campaignId: string) {
    const db = await getDb();
    const row = await db.get('SELECT COUNT(*) as count, SUM(amount) as total FROM pledges WHERE campaignId = ?', campaignId) as any;
    return { campaignId, pledgeCount: row?.count || 0, totalPledgedSats: (row?.total || 0).toString(), status: 'active' };
  }

  private hasToken(utxo: Utxo): boolean {
    return Boolean(utxo.token || utxo.slpToken || utxo.tokenStatus || utxo.plugins?.token);
  }

  private async buildWithSelectedUtxos(args: any): Promise<BuiltTx> {
    const feeTarget = args.amount + MIN_PLEDGE_FEE_SATS;
    let total = 0n;
    const selected: Utxo[] = [];
    for (const utxo of args.utxos) {
      selected.push(utxo);
      total += utxo.value;
      if (total < feeTarget) continue;
      try {
        return await buildPledgeTx({ contributorUtxos: selected, covenantUtxo: { txid: args.covenant.txid, vout: args.covenant.vout, value: args.covenant.value, scriptPubKey: args.covenant.scriptPubKey }, amount: args.amount, covenantScriptHash: args.covenant.scriptHash, contributorAddress: args.contributorAddress, beneficiaryAddress: args.beneficiaryAddress });
      } catch (err) { continue; }
    }
    throw new Error('insufficient-funds');
  }
}
