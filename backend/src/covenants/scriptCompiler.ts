import type { CampaignDefinition } from './campaignDefinition';
import { createHash } from 'crypto';

export function compileCampaignScript(_campaign: CampaignDefinition): {
  scriptHex: string;
  scriptHash: string;
} {
  const campaign = _campaign;
  const seed = [
    campaign.id,
    campaign.name ?? '',
    campaign.goal?.toString?.() ?? '',
    campaign.expirationTime?.toString?.() ?? '',
    campaign.beneficiaryPubKey ?? '',
    campaign.beneficiaryAddress ?? '',
  ].join('|');

  // Build a deterministic redeem script and derive a valid P2SH output script from it.
  const seedHash = createHash('sha256').update(seed).digest();
  const redeemScript = Buffer.concat([Buffer.from([0x51, 0x20]), seedHash]); // OP_1 PUSH32 <seedHash>
  const scriptHash = createHash('ripemd160').update(createHash('sha256').update(redeemScript).digest()).digest('hex');
  const scriptHex = `a914${scriptHash}87`;
  return { scriptHex, scriptHash };
}
