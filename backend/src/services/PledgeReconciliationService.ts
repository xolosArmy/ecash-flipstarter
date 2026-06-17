import {
  getPledgesByCampaign,
  updatePledgeVerification,
  type PledgeStatus,
  type SimplePledge,
} from '../store/simplePledges';
import { PledgeVerificationService, type PledgeVerificationOutcome } from './PledgeVerificationService';

const RECONCILE_STATUSES = new Set<PledgeStatus>([
  'broadcasted',
  'pending_verification',
  'seen_mempool',
  'invalid',
]);

type ReconciliationDependencies = {
  getPledgesByCampaign: typeof getPledgesByCampaign;
  updatePledgeVerification: typeof updatePledgeVerification;
  pledgeVerificationService: Pick<PledgeVerificationService, 'verifyPledgeTx'>;
  now: () => Date;
};

const defaultDependencies: ReconciliationDependencies = {
  getPledgesByCampaign,
  updatePledgeVerification,
  pledgeVerificationService: new PledgeVerificationService(),
  now: () => new Date(),
};

export type PledgeReconciliationResult = {
  inspected: number;
  updated: number;
  confirmed: number;
  invalid: number;
};

function isLegacyRecoverableInvalid(pledge: SimplePledge): boolean {
  return pledge.status === 'invalid' && pledge.statusReason === 'txid-not-found';
}

function shouldInspectPledge(pledge: SimplePledge): boolean {
  if (!pledge.txid) return false;
  if (!RECONCILE_STATUSES.has(pledge.status)) return false;
  return pledge.status !== 'invalid' || isLegacyRecoverableInvalid(pledge);
}

function shouldWritePledge(
  pledge: SimplePledge,
  next: {
    txid: string | null;
    status: Extract<PledgeStatus, 'broadcasted' | 'pending_verification' | 'seen_mempool' | 'confirmed' | 'invalid'>;
    statusReason: string | null;
    confirmedAt: string | null;
  },
): boolean {
  return pledge.txid !== next.txid
    || pledge.status !== next.status
    || (pledge.statusReason ?? null) !== next.statusReason
    || (pledge.confirmedAt ?? null) !== next.confirmedAt;
}

function nextVerificationState(
  pledge: SimplePledge,
  verification: PledgeVerificationOutcome,
  confirmedAt: string,
): {
  txid: string | null;
  status: Extract<PledgeStatus, 'broadcasted' | 'pending_verification' | 'seen_mempool' | 'confirmed' | 'invalid'>;
  statusReason: string | null;
  confirmedAt: string | null;
} {
  if (verification.status === 'confirmed') {
    return {
      txid: verification.txid,
      status: 'confirmed',
      statusReason: null,
      confirmedAt,
    };
  }

  if (verification.status === 'seen_mempool') {
    return {
      txid: verification.txid,
      status: 'seen_mempool',
      statusReason: null,
      confirmedAt: null,
    };
  }

  if (verification.status === 'broadcasted') {
    if (pledge.status === 'seen_mempool') {
      return {
        txid: verification.txid,
        status: 'seen_mempool',
        statusReason: pledge.statusReason ?? null,
        confirmedAt: null,
      };
    }

    return {
      txid: verification.txid,
      status: isLegacyRecoverableInvalid(pledge) ? 'broadcasted' : pledge.status === 'pending_verification' ? 'pending_verification' : 'broadcasted',
      statusReason: verification.reason,
      confirmedAt: null,
    };
  }

  return {
    txid: verification.reason === 'txid-already-used' ? null : verification.txid,
    status: 'invalid',
    statusReason: verification.reason,
    confirmedAt: null,
  };
}

export class PledgeReconciliationService {
  constructor(private readonly deps: ReconciliationDependencies = defaultDependencies) {}

  async reconcilePendingPledgesForCampaign(campaignId: string): Promise<PledgeReconciliationResult> {
    const pledges = await this.deps.getPledgesByCampaign(campaignId);
    const result: PledgeReconciliationResult = {
      inspected: 0,
      updated: 0,
      confirmed: 0,
      invalid: 0,
    };

    for (const pledge of pledges) {
      if (!shouldInspectPledge(pledge)) continue;
      result.inspected += 1;

      const txid = pledge.txid;
      if (!txid) continue;

      const verification = await this.deps.pledgeVerificationService.verifyPledgeTx({
        campaignId,
        pledgeId: pledge.pledgeId,
        txid,
        expectedAmountSats: BigInt(pledge.amount),
      });
      const next = nextVerificationState(pledge, verification, this.deps.now().toISOString());
      if (!shouldWritePledge(pledge, next)) continue;

      await this.deps.updatePledgeVerification({
        pledgeId: pledge.pledgeId,
        txid: next.txid,
        status: next.status,
        statusReason: next.statusReason,
        confirmedAt: next.confirmedAt,
      });
      result.updated += 1;
      if (next.status === 'confirmed') result.confirmed += 1;
      if (next.status === 'invalid') result.invalid += 1;
    }

    return result;
  }
}

export const pledgeReconciliationService = new PledgeReconciliationService();

export async function reconcilePendingPledgesForCampaign(campaignId: string): Promise<PledgeReconciliationResult> {
  return pledgeReconciliationService.reconcilePendingPledgesForCampaign(campaignId);
}
