import { describe, expect, it } from 'vitest';
import { CampaignService } from '../services/CampaignService';

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe('activation fee rules', () => {
  it('does not allow ACTIVE status before activation fee is paid', async () => {
    const service = new CampaignService();
    const campaignId = uniqueId('activation-unpaid');

    await service.createCampaign({
      id: campaignId,
      name: 'Needs fee',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    });

    await expect(service.updateCampaignStatus(campaignId, 'active')).rejects.toThrow('activation-fee-unpaid');

    const summary = await service.getCampaign(campaignId);
    expect(summary?.status).toBe('pending_fee');
    expect(summary?.activationFeePaid).toBe(false);
  });

  it('marks campaign active after activation fee confirmation', async () => {
    const service = new CampaignService();
    const campaignId = uniqueId('activation-paid');

    await service.createCampaign({
      id: campaignId,
      name: 'Fee paid campaign',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    });

    await service.markActivationFeePaid(campaignId, 'a'.repeat(64), {
      paidAt: new Date().toISOString(),
      payerAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    });

    const summary = await service.getCampaign(campaignId);
    expect(summary?.status).toBe('active');
    expect(summary?.activationFeePaid).toBe(true);
    expect(summary?.activationFeeTxid).toBe('a'.repeat(64));
  });
});
