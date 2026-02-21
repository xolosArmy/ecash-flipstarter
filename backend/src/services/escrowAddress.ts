import cashaddr from 'ecashaddrjs';
import type { StoredCampaign } from '../db/SQLiteStore';
import { ensureCampaignCovenant } from '../covenants/campaignDefinition';
import { getTransactionOutputs } from '../blockchain/ecashClient';
import { validateAddress } from '../utils/validation';

export type EscrowAddressFields = {
  id?: string;
  escrowAddress?: string;
  covenantAddress?: string;
  campaignAddress?: string;
  recipientAddress?: string;
  beneficiaryAddress?: string;
  beneficiaryPubKey?: string;
  goal?: string | bigint | number;
  expirationTime?: string | bigint | number;
  expiresAt?: string;
  activationFeeTxid?: string | null;
  activation?: {
    feeTxid?: string | null;
  };
  covenant?: {
    scriptPubKey?: string;
  };
};

export function resolveEscrowAddress(campaign: EscrowAddressFields): string {
  const direct = pickAddress(campaign.escrowAddress, 'escrowAddress');
  if (direct) return direct;

  const covenantAddress = pickAddress(campaign.covenantAddress, 'covenantAddress');
  if (covenantAddress) {
    campaign.escrowAddress = covenantAddress;
    return covenantAddress;
  }

  const derived = deriveEscrowAddress(campaign);
  if (derived) return derived;

  const legacy = pickAddress(campaign.campaignAddress ?? campaign.recipientAddress, 'campaignAddress');
  if (legacy) {
    console.warn('[escrow] using legacy campaign/recipient address fallback', {
      campaignId: campaign.id,
      campaignAddress: campaign.campaignAddress,
      recipientAddress: campaign.recipientAddress,
    });
    return legacy;
  }

  throw new Error('campaign-address-required');
}

export function buildEscrowMismatchDetails(campaign: EscrowAddressFields, expectedEscrow: string) {
  return {
    campaignId: campaign.id,
    canonicalEscrow: expectedEscrow,
    campaignAddress: campaign.campaignAddress ?? null,
    recipientAddress: campaign.recipientAddress ?? null,
    covenantAddress: campaign.covenantAddress ?? null,
    escrowAddressStored: campaign.escrowAddress ?? null,
  };
}

export function validateEscrowConsistency(campaign: EscrowAddressFields): { ok: true; escrowAddress: string }
| { ok: false; error: string; details: ReturnType<typeof buildEscrowMismatchDetails> } {
  const expectedEscrow = resolveEscrowAddress(campaign);
  const candidates = [
    campaign.escrowAddress,
    campaign.covenantAddress,
    campaign.campaignAddress,
    campaign.recipientAddress,
  ]
    .map((entry) => pickAddress(entry, 'escrowAddress'))
    .filter((entry): entry is string => Boolean(entry));

  for (const candidate of candidates) {
    if (candidate !== expectedEscrow) {
      return {
        ok: false,
        error: 'escrow-address-mismatch',
        details: buildEscrowMismatchDetails(campaign, expectedEscrow),
      };
    }
  }

  return { ok: true, escrowAddress: expectedEscrow };
}

function deriveEscrowAddress(campaign: EscrowAddressFields): string | null {
  if (campaign.covenant?.scriptPubKey) {
    try {
      return validateAddress(cashaddr.encodeOutputScript(campaign.covenant.scriptPubKey, 'ecash'), 'campaignAddress');
    } catch {
      // ignore and continue to definition derivation
    }
  }

  try {
    if (!campaign.id || !campaign.beneficiaryPubKey || campaign.goal == null) {
      return null;
    }
    const expirationTime = campaign.expirationTime
      ?? (campaign.expiresAt ? BigInt(Date.parse(campaign.expiresAt)) : undefined);
    if (expirationTime == null) {
      return null;
    }
    const ensured = ensureCampaignCovenant({
      campaignId: campaign.id,
      campaign: {
        id: campaign.id,
        name: 'derived',
        description: '',
        beneficiaryPubKey: campaign.beneficiaryPubKey,
        beneficiaryAddress: campaign.beneficiaryAddress,
        goal: BigInt(campaign.goal),
        expirationTime: BigInt(expirationTime),
      },
    });
    return validateAddress(ensured.campaignAddress, 'campaignAddress');
  } catch {
    return null;
  }
}

function pickAddress(raw: unknown, field: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return validateAddress(raw.trim(), field);
  } catch {
    return null;
  }
}

export async function repairEscrowAddressFromChain(campaign: EscrowAddressFields): Promise<string | null> {
  return tryResolveEscrowFromActivationTx(campaign);
}

export async function repairCampaignEscrowAddress(
  campaign: StoredCampaign,
): Promise<{ escrowAddress: string; source: string; txidUsed: string | null }> {
  const fromChain = await repairEscrowAddressFromChain(campaign);
  const escrowAddress = fromChain ?? resolveEscrowAddress(campaign);
  // Canonical escrow for pledges; keep recipient/beneficiary untouched for payout.
  campaign.escrowAddress = escrowAddress;
  campaign.covenantAddress = escrowAddress;
  campaign.campaignAddress = escrowAddress;
  const txidUsed = String(campaign.activationFeeTxid ?? campaign.activation?.feeTxid ?? '').trim() || null;
  return { escrowAddress, source: fromChain ? 'activation-tx' : 'resolved', txidUsed };
}

async function tryResolveEscrowFromActivationTx(campaign: EscrowAddressFields): Promise<string | null> {
  const txid = String(campaign.activationFeeTxid ?? campaign.activation?.feeTxid ?? '').trim();
  if (!/^[0-9a-f]{64}$/i.test(txid) || /^f{64}$/i.test(txid)) {
    return null;
  }

  const expectedScript = campaign.covenant?.scriptPubKey
    ?? deriveExpectedScript(campaign);
  if (!expectedScript) return null;

  try {
    const outputs = await getTransactionOutputs(txid);
    const match = outputs.find((output) => output.scriptPubKey.toLowerCase() === expectedScript.toLowerCase());
    if (!match) return null;
    return validateAddress(cashaddr.encodeOutputScript(match.scriptPubKey, 'ecash'), 'escrowAddress');
  } catch (err) {
    console.warn('[escrow-repair] activation tx lookup failed', {
      campaignId: campaign.id,
      txid,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function deriveExpectedScript(campaign: EscrowAddressFields): string | null {
  try {
    if (!campaign.id || !campaign.beneficiaryPubKey || campaign.goal == null) {
      return null;
    }
    const expirationTime = campaign.expirationTime
      ?? (campaign.expiresAt ? BigInt(Date.parse(campaign.expiresAt)) : undefined);
    if (expirationTime == null) {
      return null;
    }
    return ensureCampaignCovenant({
      campaignId: campaign.id,
      campaign: {
        id: campaign.id,
        name: 'derived',
        description: '',
        beneficiaryPubKey: campaign.beneficiaryPubKey,
        beneficiaryAddress: campaign.beneficiaryAddress,
        goal: BigInt(campaign.goal),
        expirationTime: BigInt(expirationTime),
      },
    }).scriptPubKey;
  } catch {
    return null;
  }
}
