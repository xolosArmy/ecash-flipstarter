import {
  CampaignDefinition,
  ensureCampaignCovenant,
  hasValidCampaignCovenant,
} from '../covenants/campaignDefinition';
import { CovenantIndex, type CovenantRef } from '../blockchain/covenantIndex';
import {
  loadCampaignsFromDisk,
  saveCampaignToDisk,
  type StoredCampaign,
} from '../store/campaignPersistence';
import { getCampaignById, listCampaigns as listCampaignsFromSqlite } from '../db/SQLiteStore';
import { getDb } from '../store/db';
import { ACTIVATION_FEE_SATS, ACTIVATION_FEE_XEC } from '../config/constants';
import { deriveCampaignSlug, resolveCampaignIdFromSnapshots } from './campaignIdResolver';

// In-memory cache used by CovenantIndex and pledge services.
const campaigns = new Map<string, CampaignDefinition>();
const campaignSnapshots = new Map<string, StoredCampaign>();
const covenantIndex = new CovenantIndex();

type AuditLogRow = {
  event: string;
  details: string | null;
  timestamp: string;
};

type ActivationOfferOutput = { address: string; valueSats: number };
type ActivationVerificationState = 'none' | 'pending_verification' | 'verified' | 'invalid';

function toBigIntGoal(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function toExpirationTime(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return BigInt(Math.floor(numeric));
    }
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) {
      return BigInt(parsedDate);
    }
  }
  return 0n;
}

function toIsoFromExpiration(expirationTime: bigint): string {
  const asNumber = Number(expirationTime);
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    return new Date(0).toISOString();
  }
  return new Date(asNumber).toISOString();
}

function toCampaignDefinition(snapshot: StoredCampaign): CampaignDefinition {
  return {
    id: snapshot.id,
    name: snapshot.name,
    description: snapshot.description ?? '',
    goal: toBigIntGoal(snapshot.goal),
    expirationTime: toExpirationTime(snapshot.expiresAt),
    beneficiaryPubKey: snapshot.beneficiaryPubKey ?? '',
    beneficiaryAddress: snapshot.beneficiaryAddress ?? undefined,
    campaignAddress: snapshot.campaignAddress ?? undefined,
    covenantAddress: snapshot.covenantAddress ?? undefined,
    status: snapshot.status ?? undefined,
  };
}

function toActivationFeeRequired(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return ACTIVATION_FEE_XEC;
}

function normalizeSnapshot(snapshot: StoredCampaign): StoredCampaign {
  const activationFeeRequired = toActivationFeeRequired(snapshot.activationFeeRequired);
  const status = typeof snapshot.status === 'string' ? snapshot.status.toLowerCase() : '';
  const activationFeePaid = snapshot.activationFeePaid === true
    || snapshot.activationFeeVerificationStatus === 'verified'
    || status === 'active'
    || status === 'funded'
    || status === 'expired'
    || status === 'paid_out';
  const activationFeeTxid = snapshot.activationFeeTxid ?? snapshot.activation?.feeTxid ?? null;
  const activationFeePaidAt = snapshot.activationFeePaidAt ?? snapshot.activation?.feePaidAt ?? null;
  const activationFeeVerificationStatus: ActivationVerificationState =
    snapshot.activationFeeVerificationStatus === 'pending_verification'
    || snapshot.activationFeeVerificationStatus === 'verified'
    || snapshot.activationFeeVerificationStatus === 'invalid'
      ? snapshot.activationFeeVerificationStatus
      : 'none';
  const activationFeeVerifiedAt = snapshot.activationFeeVerifiedAt ?? null;

  const activation = {
    feeSats: snapshot.activation?.feeSats ?? String(activationFeeRequired * 100),
    feeTxid: activationFeeTxid,
    feePaidAt: activationFeePaidAt,
    payerAddress: snapshot.activation?.payerAddress ?? null,
    wcOfferId: snapshot.activation?.wcOfferId ?? null,
  };

  return {
    ...snapshot,
    slug: deriveCampaignSlug(snapshot),
    activation,
    activationFeeRequired,
    activationFeePaid,
    activationFeeTxid,
    activationFeePaidAt,
    activationFeeVerificationStatus,
    activationFeeVerifiedAt,
    activationOfferMode: snapshot.activationOfferMode ?? null,
    activationOfferOutputs: snapshot.activationOfferOutputs ?? null,
    activationTreasuryAddressUsed: snapshot.activationTreasuryAddressUsed ?? null,
    treasuryAddressUsed: snapshot.treasuryAddressUsed ?? null,
  };
}

function normalizeActivationStatus(
  rawStatus: unknown,
  activationFeePaid: boolean,
): CampaignDefinition['status'] {
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';

  if (status === 'paid_out') return 'paid_out';
  if (status === 'funded') return 'funded';
  if (status === 'expired') return 'expired';

  if (!activationFeePaid) {
    if (status === 'draft') {
      return 'draft';
    }
    if (status === 'pending_verification') {
      return 'pending_verification';
    }
    if (status === 'fee_invalid') {
      return 'fee_invalid';
    }
    return 'pending_fee';
  }

  return 'active';
}

function toStoredCampaign(definition: CampaignDefinition, prior?: StoredCampaign): StoredCampaign {
  const priorNormalized = prior ? normalizeSnapshot(prior) : undefined;
  const activationFeeRequired = priorNormalized?.activationFeeRequired ?? ACTIVATION_FEE_XEC;

  return {
    id: definition.id,
    slug: priorNormalized?.slug ?? deriveCampaignSlug({ id: definition.id, createdAt: priorNormalized?.createdAt ?? new Date().toISOString() }),
    name: definition.name,
    description: definition.description,
    goal: definition.goal.toString(),
    expiresAt: priorNormalized?.expiresAt ?? toIsoFromExpiration(definition.expirationTime),
    createdAt: priorNormalized?.createdAt ?? new Date().toISOString(),
    status: definition.status,
    recipientAddress: priorNormalized?.recipientAddress ?? definition.campaignAddress,
    beneficiaryAddress: definition.beneficiaryAddress,
    campaignAddress: definition.campaignAddress,
    covenantAddress: definition.covenantAddress,
    beneficiaryPubKey: definition.beneficiaryPubKey,
    location: priorNormalized?.location,
    activation: priorNormalized?.activation ?? {
      feeSats: String(activationFeeRequired * 100),
      feeTxid: null,
      feePaidAt: null,
      payerAddress: null,
      wcOfferId: null,
    },
    activationFeeRequired,
    activationFeePaid: priorNormalized?.activationFeePaid ?? false,
    activationFeeTxid: priorNormalized?.activationFeeTxid ?? null,
    activationFeePaidAt: priorNormalized?.activationFeePaidAt ?? null,
    activationFeeVerificationStatus: priorNormalized?.activationFeeVerificationStatus ?? 'none',
    activationFeeVerifiedAt: priorNormalized?.activationFeeVerifiedAt ?? null,
    activationOfferMode: priorNormalized?.activationOfferMode ?? null,
    activationOfferOutputs: priorNormalized?.activationOfferOutputs ?? null,
    activationTreasuryAddressUsed: priorNormalized?.activationTreasuryAddressUsed ?? null,
    payout: priorNormalized?.payout ?? {
      wcOfferId: null,
      txid: null,
      paidAt: null,
    },
    treasuryAddressUsed: priorNormalized?.treasuryAddressUsed ?? null,
  };
}

function safeParseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function syncCampaignStoreFromDiskCampaigns(diskCampaigns: StoredCampaign[]): void {
  campaigns.clear();
  campaignSnapshots.clear();

  for (const diskSnapshot of diskCampaigns) {
    const snapshot = normalizeSnapshot(diskSnapshot);
    snapshot.status = normalizeActivationStatus(snapshot.status, snapshot.activationFeePaid === true);

    const campaign = toCampaignDefinition(snapshot);
    const ensured = ensureCampaignCovenant({
      campaignId: campaign.id,
      campaign,
      existing: {
        scriptPubKey: undefined,
        scriptHash: undefined,
        campaignAddress: snapshot.campaignAddress ?? snapshot.covenantAddress,
      },
    });
    campaign.campaignAddress = ensured.campaignAddress;
    campaign.covenantAddress = ensured.campaignAddress;
    snapshot.campaignAddress = ensured.campaignAddress;
    snapshot.covenantAddress = ensured.campaignAddress;
    campaigns.set(campaign.id, campaign);
    campaignSnapshots.set(campaign.id, snapshot);

    covenantIndex.setCovenantRef({
      campaignId: campaign.id,
      txid: '',
      vout: 0,
      scriptHash: ensured.scriptHash,
      scriptPubKey: ensured.scriptPubKey,
      value: 0n,
    });
  }
}

export class CampaignService {
  /**
   * Registra un evento de auditoria en SQLite.
   */
  private async logEvent(campaignId: string, event: string, details: Record<string, unknown>) {
    const db = await getDb();
    await db.run(
      'INSERT INTO audit_logs (campaignId, event, details) VALUES (?, ?, ?)',
      [campaignId, event, JSON.stringify(details)],
    );
  }

  private async hasAuditEventForTxid(campaignId: string, event: string, txid: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.get<{ found: number }>(
      `SELECT 1 as found
       FROM audit_logs
       WHERE campaignId = ?
         AND event = ?
         AND json_extract(details, '$.txid') = ?
       LIMIT 1`,
      [campaignId, event, txid],
    );
    return row?.found === 1;
  }

  private async logEventOnceByTxid(
    campaignId: string,
    event: string,
    txid: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (await this.hasAuditEventForTxid(campaignId, event, txid)) {
      return;
    }
    await this.logEvent(campaignId, event, details);
  }

  private buildEnsuredCovenant(campaign: CampaignDefinition, existing?: CovenantRef): CovenantRef {
    const ensured = ensureCampaignCovenant({
      campaignId: campaign.id,
      campaign,
      existing: {
        txid: existing?.txid ?? '',
        vout: existing?.vout ?? 0,
        value: existing?.value ?? 0n,
      },
    });

    return {
      campaignId: campaign.id,
      txid: ensured.txid ?? '',
      vout: ensured.vout ?? 0,
      scriptHash: ensured.scriptHash,
      scriptPubKey: ensured.scriptPubKey,
      value:
        typeof ensured.value === 'bigint'
          ? ensured.value
          : typeof ensured.value === 'number'
            ? BigInt(Math.floor(ensured.value))
            : typeof ensured.value === 'string' && ensured.value.trim()
              ? BigInt(ensured.value)
              : 0n,
    };
  }

  private applyEnsuredCovenant(campaign: CampaignDefinition, snapshot: StoredCampaign, covenant: CovenantRef): boolean {
    const existingAddress = campaign.campaignAddress ?? snapshot.campaignAddress ?? snapshot.covenantAddress;
    const existingCandidate = {
      campaignId: campaign.id,
      campaignAddress: existingAddress,
      scriptHash: covenant.scriptHash,
      scriptPubKey: covenant.scriptPubKey,
    };
    const needsAddressUpdate = !hasValidCampaignCovenant(existingCandidate);

    const ensured = ensureCampaignCovenant({
      campaignId: campaign.id,
      campaign,
      existing: {
        txid: covenant.txid,
        vout: covenant.vout,
        value: covenant.value,
      },
    });

    const nextAddress = ensured.campaignAddress;
    const changed =
      needsAddressUpdate
      || campaign.campaignAddress !== nextAddress
      || campaign.covenantAddress !== nextAddress
      || snapshot.campaignAddress !== nextAddress
      || snapshot.covenantAddress !== nextAddress;

    campaign.campaignAddress = nextAddress;
    campaign.covenantAddress = nextAddress;
    snapshot.campaignAddress = nextAddress;
    snapshot.covenantAddress = nextAddress;
    covenant.scriptHash = ensured.scriptHash;
    covenant.scriptPubKey = ensured.scriptPubKey;
    return changed;
  }

  async ensureCampaignCovenant(campaignId: string): Promise<CovenantRef> {
    const campaign = campaigns.get(campaignId);
    if (!campaign) {
      throw new Error('campaign-not-found');
    }
    const snapshotRaw = campaignSnapshots.get(campaignId);
    const snapshot = normalizeSnapshot(toStoredCampaign(campaign, snapshotRaw));
    const existing = covenantIndex.getCovenantRef(campaignId);
    const covenant = this.buildEnsuredCovenant(campaign, existing);
    const changed = this.applyEnsuredCovenant(campaign, snapshot, covenant);

    campaigns.set(campaignId, campaign);
    campaignSnapshots.set(campaignId, snapshot);
    covenantIndex.setCovenantRef(covenant);

    if (changed) {
      await saveCampaignToDisk(snapshot);
    }
    return covenant;
  }

  /**
   * Crea una campaña y la persiste en SQLite (con dual-write JSON opcional).
   */
  async createCampaign(payload: Partial<CampaignDefinition> & Record<string, unknown>) {
    const id = typeof payload.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : `campaign-${Date.now()}`;

    const expiresAtCandidate = typeof payload.expiresAt === 'string'
      ? payload.expiresAt
      : toIsoFromExpiration(toExpirationTime(payload.expirationTime));

    const activationFeeRequired = toActivationFeeRequired(payload.activationFeeRequired);
    const activationFeePaid = false;

    const requestedStatus = typeof payload.status === 'string' ? payload.status : undefined;
    const initialStatus = activationFeePaid
      ? (requestedStatus || 'active')
      : 'pending_fee';

    const campaign: CampaignDefinition = {
      id,
      name: payload.name || 'Unnamed',
      description: payload.description || '',
      goal: payload.goal !== undefined ? BigInt(payload.goal) : 0n,
      expirationTime: toExpirationTime(payload.expirationTime ?? expiresAtCandidate),
      beneficiaryPubKey: payload.beneficiaryPubKey || '',
      beneficiaryAddress: payload.beneficiaryAddress,
      campaignAddress:
        typeof payload.campaignAddress === 'string'
          ? payload.campaignAddress
          : typeof payload.recipientAddress === 'string'
            ? payload.recipientAddress
            : undefined,
      covenantAddress: payload.covenantAddress,
      status: initialStatus,
    };
    const ensuredInitialCovenant = ensureCampaignCovenant({
      campaignId: id,
      campaign,
      existing: {
        txid: '',
        vout: 0,
        value: 0n,
      },
    });
    campaign.campaignAddress = ensuredInitialCovenant.campaignAddress;
    campaign.covenantAddress = ensuredInitialCovenant.campaignAddress;

    const snapshot: StoredCampaign = normalizeSnapshot({
      id,
      slug: typeof payload.slug === 'string' && payload.slug.trim()
        ? payload.slug.trim()
        : deriveCampaignSlug({
          id,
          createdAt: typeof payload.createdAt === 'string' && payload.createdAt.trim()
            ? payload.createdAt
            : new Date().toISOString(),
        }),
      name: campaign.name,
      description: campaign.description,
      goal: campaign.goal.toString(),
      expiresAt: expiresAtCandidate,
      createdAt: typeof payload.createdAt === 'string' && payload.createdAt.trim()
        ? payload.createdAt
        : new Date().toISOString(),
      status: campaign.status,
      recipientAddress: typeof payload.recipientAddress === 'string'
        ? payload.recipientAddress
        : campaign.campaignAddress,
      beneficiaryAddress: campaign.beneficiaryAddress,
      campaignAddress: campaign.campaignAddress,
      covenantAddress: campaign.covenantAddress,
      beneficiaryPubKey: campaign.beneficiaryPubKey,
      activation: {
        feeSats:
          typeof payload.activation === 'object' && payload.activation && 'feeSats' in payload.activation
            ? String((payload.activation as { feeSats?: unknown }).feeSats ?? ACTIVATION_FEE_SATS.toString())
            : String(activationFeeRequired * 100),
        feeTxid: null,
        feePaidAt: null,
        payerAddress:
          typeof payload.activation === 'object' && payload.activation && 'payerAddress' in payload.activation
            ? ((payload.activation as { payerAddress?: string | null }).payerAddress ?? null)
            : null,
        wcOfferId:
          typeof payload.activation === 'object' && payload.activation && 'wcOfferId' in payload.activation
            ? ((payload.activation as { wcOfferId?: string | null }).wcOfferId ?? null)
            : null,
      },
      activationFeeRequired,
      activationFeePaid,
      activationFeeTxid: null,
      activationFeePaidAt: null,
      activationFeeVerificationStatus: 'none',
      activationFeeVerifiedAt: null,
      activationOfferMode: null,
      activationOfferOutputs: null,
      activationTreasuryAddressUsed: null,
      payout: {
        wcOfferId:
          typeof payload.payout === 'object' && payload.payout && 'wcOfferId' in payload.payout
            ? ((payload.payout as { wcOfferId?: string | null }).wcOfferId ?? null)
            : null,
        txid:
          typeof payload.payout === 'object' && payload.payout && 'txid' in payload.payout
            ? ((payload.payout as { txid?: string | null }).txid ?? null)
            : null,
        paidAt:
          typeof payload.payout === 'object' && payload.payout && 'paidAt' in payload.payout
            ? ((payload.payout as { paidAt?: string | null }).paidAt ?? null)
            : null,
      },
      treasuryAddressUsed: null,
    });

    if (typeof payload.location === 'object' && payload.location !== null) {
      const locationObj = payload.location as { latitude?: unknown; longitude?: unknown };
      if (typeof locationObj.latitude === 'number' && typeof locationObj.longitude === 'number') {
        snapshot.location = { latitude: locationObj.latitude, longitude: locationObj.longitude };
      }
    }

    await saveCampaignToDisk(snapshot);

    campaigns.set(id, campaign);
    campaignSnapshots.set(id, snapshot);

    const covenantRef: CovenantRef = {
      campaignId: id,
      txid: '',
      vout: 0,
      scriptHash: ensuredInitialCovenant.scriptHash,
      scriptPubKey: ensuredInitialCovenant.scriptPubKey,
      value: 0n,
    };
    covenantIndex.setCovenantRef(covenantRef);

    await this.logEvent(id, 'CREATED', {
      name: campaign.name,
      goal: campaign.goal.toString(),
      expiresAt: snapshot.expiresAt,
      activationFeeRequired: snapshot.activationFeeRequired,
    });

    return this.serializeCampaign(campaign, snapshot, covenantRef, 0);
  }


  async resolveCampaignId(input: string): Promise<string | null> {
    const candidate = String(input ?? '').trim();
    if (!candidate) {
      return null;
    }

    if (campaigns.has(candidate)) {
      return candidate;
    }

    const records = await listCampaignsFromSqlite();
    const resolved = resolveCampaignIdFromSnapshots(candidate, records);
    if (resolved) {
      return resolved;
    }

    const fromCacheSnapshots = Array.from(campaignSnapshots.values());
    return resolveCampaignIdFromSnapshots(candidate, fromCacheSnapshots);
  }

  async getCanonicalCampaign(input: string) {
    const canonicalId = await this.resolveCampaignId(input);
    if (!canonicalId) {
      return null;
    }
    const campaign = await this.getCampaign(canonicalId);
    if (!campaign) {
      return null;
    }
    return { canonicalId, campaign };
  }

  async getCampaign(id: string) {
    const fromCache = campaigns.get(id);
    if (fromCache) {
      const snapshotRaw = campaignSnapshots.get(id);
      const snapshot = snapshotRaw ? normalizeSnapshot(snapshotRaw) : normalizeSnapshot(toStoredCampaign(fromCache));
      const existing = covenantIndex.getCovenantRef(id);
      const covenant = existing ?? this.buildEnsuredCovenant(fromCache);
      const changed = this.applyEnsuredCovenant(fromCache, snapshot, covenant);
      campaignSnapshots.set(id, snapshot);
      campaigns.set(id, fromCache);
      covenantIndex.setCovenantRef(covenant);
      if (changed) {
        await saveCampaignToDisk(snapshot);
      }
      const progress = covenant && fromCache.goal > 0n ? Number((covenant.value * 100n) / fromCache.goal) : 0;
      return this.serializeCampaign(fromCache, snapshot, covenant, progress);
    }

    const snapshotRaw = await getCampaignById(id);
    if (!snapshotRaw) {
      return null;
    }

    const snapshot = normalizeSnapshot(snapshotRaw);
    snapshot.status = normalizeActivationStatus(snapshot.status, snapshot.activationFeePaid === true);

    const campaign = toCampaignDefinition(snapshot);
    campaigns.set(id, campaign);
    campaignSnapshots.set(id, snapshot);

    let covenant = covenantIndex.getCovenantRef(id);
    if (!covenant) {
      covenant = this.buildEnsuredCovenant(campaign);
    }
    const changed = this.applyEnsuredCovenant(campaign, snapshot, covenant);
    covenantIndex.setCovenantRef(covenant);
    campaignSnapshots.set(id, snapshot);
    campaigns.set(id, campaign);
    if (changed) {
      await saveCampaignToDisk(snapshot);
    }

    const progress = covenant && campaign.goal > 0n ? Number((covenant.value * 100n) / campaign.goal) : 0;
    return this.serializeCampaign(campaign, snapshot, covenant, progress);
  }

  async listCampaigns() {
    const records = await listCampaignsFromSqlite();
    if (records.length === 0 && campaigns.size > 0) {
      return Array.from(campaigns.values()).map((campaign) => {
        const snapshotRaw = campaignSnapshots.get(campaign.id);
        const snapshot = snapshotRaw ? normalizeSnapshot(snapshotRaw) : undefined;
        const covenant = covenantIndex.getCovenantRef(campaign.id);
        const progress = covenant && campaign.goal > 0n ? Number((covenant.value * 100n) / campaign.goal) : 0;
        return this.serializeCampaign(campaign, snapshot, covenant, progress);
      });
    }

    syncCampaignStoreFromDiskCampaigns(records);
    return records.map((rawSnapshot) => {
      const snapshot = normalizeSnapshot(rawSnapshot);
      const campaign = toCampaignDefinition(snapshot);
      const covenant = covenantIndex.getCovenantRef(campaign.id);
      const progress = covenant && campaign.goal > 0n ? Number((covenant.value * 100n) / campaign.goal) : 0;
      return this.serializeCampaign(campaign, snapshot, covenant, progress);
    });
  }

  async getGlobalStats() {
    const db = await getDb();
    const stats = await db.get<{
      totalCampaigns: number;
      totalGoalSats: number;
      totalRaisedSats: number;
      totalPledges: number;
    }>(`
      SELECT
        COUNT(DISTINCT c.id) AS totalCampaigns,
        COALESCE(SUM(CAST(c.goal AS INTEGER)), 0) AS totalGoalSats,
        COALESCE((SELECT SUM(amount) FROM pledges), 0) AS totalRaisedSats,
        COALESCE((SELECT COUNT(*) FROM pledges), 0) AS totalPledges
      FROM campaigns c
    `);

    return {
      totalCampaigns: stats?.totalCampaigns ?? 0,
      totalGoalSats: (stats?.totalGoalSats ?? 0).toString(),
      totalRaisedSats: stats?.totalRaisedSats ?? 0,
      totalPledges: stats?.totalPledges ?? 0,
    };
  }

  async getCampaignHistory(id: string) {
    const db = await getDb();
    const rows = await db.all<AuditLogRow[]>(
      'SELECT event, details, timestamp FROM audit_logs WHERE campaignId = ? ORDER BY timestamp DESC, id DESC',
      [id],
    );

    return rows.map((row) => ({
      event: row.event,
      timestamp: row.timestamp,
      details: safeParseJson(row.details),
    }));
  }

  async setActivationOffer(
    id: string,
    wcOfferId: string,
    payerAddress: string,
    options?: {
      mode?: 'tx' | 'intent';
      outputs?: ActivationOfferOutput[];
      treasuryAddressUsed?: string | null;
      logAuditEvent?: boolean;
    },
  ) {
    const campaign = campaigns.get(id);
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const previousSnapshot = campaignSnapshots.get(id);
    const nextSnapshot = normalizeSnapshot(toStoredCampaign(campaign, previousSnapshot));
    nextSnapshot.activation = {
      feeSats: nextSnapshot.activation?.feeSats ?? String(nextSnapshot.activationFeeRequired! * 100),
      feeTxid: nextSnapshot.activationFeeTxid ?? null,
      feePaidAt: nextSnapshot.activationFeePaidAt ?? null,
      payerAddress,
      wcOfferId,
    };
    nextSnapshot.activationOfferMode = options?.mode ?? 'tx';
    nextSnapshot.activationOfferOutputs = options?.outputs ?? null;
    nextSnapshot.activationTreasuryAddressUsed = options?.treasuryAddressUsed ?? null;

    await saveCampaignToDisk(nextSnapshot);
    campaignSnapshots.set(id, nextSnapshot);

    if (options?.logAuditEvent !== false) {
      await this.logEvent(id, 'ACTIVATION_FEE_OFFER_CREATED', {
        wcOfferId,
        payerAddress,
        mode: nextSnapshot.activationOfferMode,
        outputs: nextSnapshot.activationOfferOutputs,
        treasuryAddressUsed: nextSnapshot.activationTreasuryAddressUsed,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async recordActivationFeeBroadcast(
    id: string,
    txid: string,
    options?: {
      paidAt?: string;
      payerAddress?: string | null;
      treasuryAddressUsed?: string | null;
    },
  ) {
    const campaign = campaigns.get(id);
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const previousSnapshot = campaignSnapshots.get(id);
    const nextSnapshot = normalizeSnapshot(toStoredCampaign(campaign, previousSnapshot));
    const normalizedTxid = txid.trim().toLowerCase();
    const reusePaidAt =
      nextSnapshot.activationFeeTxid?.toLowerCase() === normalizedTxid
        ? nextSnapshot.activationFeePaidAt
        : null;
    const paidAt = reusePaidAt ?? options?.paidAt ?? new Date().toISOString();

    nextSnapshot.activationFeeTxid = normalizedTxid;
    nextSnapshot.activationFeePaidAt = paidAt;
    nextSnapshot.activationFeePaid = false;
    nextSnapshot.activationFeeVerificationStatus = 'pending_verification';
    nextSnapshot.activationFeeVerifiedAt = null;
    nextSnapshot.status = 'pending_verification';
    nextSnapshot.treasuryAddressUsed = options?.treasuryAddressUsed ?? nextSnapshot.treasuryAddressUsed ?? null;
    nextSnapshot.activation = {
      feeSats: nextSnapshot.activation?.feeSats ?? String(nextSnapshot.activationFeeRequired! * 100),
      feeTxid: normalizedTxid,
      feePaidAt: paidAt,
      payerAddress: options?.payerAddress ?? nextSnapshot.activation?.payerAddress ?? null,
      wcOfferId: nextSnapshot.activation?.wcOfferId ?? null,
    };

    campaign.status = 'pending_verification';
    campaigns.set(id, campaign);
    await saveCampaignToDisk(nextSnapshot);
    campaignSnapshots.set(id, nextSnapshot);
  }

  async finalizeActivationFeeVerification(
    id: string,
    txid: string,
    outcome: 'verified' | 'invalid' | 'pending_verification',
    options?: {
      payerAddress?: string | null;
      treasuryAddressUsed?: string | null;
      reason?: string | null;
      paidAt?: string;
      verifiedAt?: string;
    },
  ) {
    const campaign = campaigns.get(id);
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const previousSnapshot = campaignSnapshots.get(id);
    const nextSnapshot = normalizeSnapshot(toStoredCampaign(campaign, previousSnapshot));
    const normalizedTxid = txid.trim().toLowerCase();
    const paidAt = options?.paidAt ?? nextSnapshot.activationFeePaidAt ?? new Date().toISOString();
    const verifiedAt = options?.verifiedAt ?? new Date().toISOString();

    nextSnapshot.activationFeeTxid = normalizedTxid;
    nextSnapshot.activationFeePaidAt = paidAt;
    nextSnapshot.treasuryAddressUsed = options?.treasuryAddressUsed ?? nextSnapshot.treasuryAddressUsed ?? null;
    nextSnapshot.activation = {
      feeSats: nextSnapshot.activation?.feeSats ?? String(nextSnapshot.activationFeeRequired! * 100),
      feeTxid: normalizedTxid,
      feePaidAt: paidAt,
      payerAddress: options?.payerAddress ?? nextSnapshot.activation?.payerAddress ?? null,
      wcOfferId: nextSnapshot.activation?.wcOfferId ?? null,
    };

    if (outcome === 'verified') {
      nextSnapshot.activationFeePaid = true;
      nextSnapshot.activationFeeVerificationStatus = 'verified';
      nextSnapshot.activationFeeVerifiedAt = verifiedAt;
      nextSnapshot.status = 'active';
      campaign.status = 'active';
      const existing = covenantIndex.getCovenantRef(id);
      const covenant = existing ?? this.buildEnsuredCovenant(campaign);
      this.applyEnsuredCovenant(campaign, nextSnapshot, covenant);
      campaigns.set(id, campaign);
      covenantIndex.setCovenantRef(covenant);
      await saveCampaignToDisk(nextSnapshot);
      campaignSnapshots.set(id, nextSnapshot);

      await this.logEventOnceByTxid(id, 'ACTIVATION_FEE_VERIFIED', normalizedTxid, {
        txid: normalizedTxid,
        verifiedAt,
        paidAt,
        payerAddress: nextSnapshot.activation?.payerAddress ?? null,
        activationFeeRequired: nextSnapshot.activationFeeRequired,
        activationTreasuryAddressUsed: nextSnapshot.activationTreasuryAddressUsed ?? null,
      });
      return;
    }

    if (outcome === 'invalid') {
      nextSnapshot.activationFeePaid = false;
      nextSnapshot.activationFeeVerificationStatus = 'invalid';
      nextSnapshot.activationFeeVerifiedAt = null;
      nextSnapshot.status = 'pending_fee';
      campaign.status = 'pending_fee';
      campaigns.set(id, campaign);
      await saveCampaignToDisk(nextSnapshot);
      campaignSnapshots.set(id, nextSnapshot);

      await this.logEventOnceByTxid(id, 'ACTIVATION_FEE_INVALID', normalizedTxid, {
        txid: normalizedTxid,
        invalidAt: verifiedAt,
        reason: options?.reason ?? null,
        activationFeeRequired: nextSnapshot.activationFeeRequired,
        activationTreasuryAddressUsed: nextSnapshot.activationTreasuryAddressUsed ?? null,
      });
      return;
    }

    nextSnapshot.activationFeePaid = false;
    nextSnapshot.activationFeeVerificationStatus = 'pending_verification';
    nextSnapshot.activationFeeVerifiedAt = null;
    nextSnapshot.status = 'pending_verification';
    campaign.status = 'pending_verification';
    campaigns.set(id, campaign);
    await saveCampaignToDisk(nextSnapshot);
    campaignSnapshots.set(id, nextSnapshot);
  }

  async markActivationFeePaid(
    id: string,
    txid: string,
    options?: {
      paidAt?: string;
      payerAddress?: string | null;
      treasuryAddressUsed?: string | null;
    },
  ) {
    const campaign = campaigns.get(id);
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const previousSnapshot = campaignSnapshots.get(id);
    const nextSnapshot = normalizeSnapshot(toStoredCampaign(campaign, previousSnapshot));
    const normalizedTxid = txid.trim().toLowerCase();
    const previousTxid = (nextSnapshot.activationFeeTxid ?? '').toLowerCase();
    const existingPaid = nextSnapshot.activationFeePaid === true;

    if (existingPaid && previousTxid) {
      if (previousTxid !== normalizedTxid) {
        throw new Error('activation-fee-already-confirmed');
      }

      const previousStatus = nextSnapshot.status;
      nextSnapshot.status = normalizeActivationStatus(nextSnapshot.status, true);
      nextSnapshot.activationFeeVerificationStatus = 'verified';
      nextSnapshot.activationFeeVerifiedAt = nextSnapshot.activationFeeVerifiedAt ?? new Date().toISOString();
      if (options?.payerAddress) {
        nextSnapshot.activation = {
          feeSats: nextSnapshot.activation?.feeSats ?? String(nextSnapshot.activationFeeRequired! * 100),
          feeTxid: nextSnapshot.activationFeeTxid ?? null,
          feePaidAt: nextSnapshot.activationFeePaidAt ?? null,
          payerAddress: options.payerAddress,
          wcOfferId: nextSnapshot.activation?.wcOfferId ?? null,
        };
      }
      let covenantChanged = false;
      if (nextSnapshot.status === 'active') {
        const existing = covenantIndex.getCovenantRef(id);
        const covenant = existing ?? this.buildEnsuredCovenant(campaign);
        covenantChanged = this.applyEnsuredCovenant(campaign, nextSnapshot, covenant);
        covenantIndex.setCovenantRef(covenant);
      }

      const needsPersist =
        previousStatus !== nextSnapshot.status
        || nextSnapshot.activation?.payerAddress !== (previousSnapshot?.activation?.payerAddress ?? null)
        || covenantChanged;
      if (needsPersist) {
        campaign.status = nextSnapshot.status;
        campaigns.set(id, campaign);
        await saveCampaignToDisk(nextSnapshot);
        campaignSnapshots.set(id, nextSnapshot);
      }
      return;
    }

    const paidAt = options?.paidAt ?? new Date().toISOString();

    nextSnapshot.activationFeePaid = true;
    nextSnapshot.activationFeeTxid = normalizedTxid;
    nextSnapshot.activationFeePaidAt = paidAt;
    nextSnapshot.activationFeeVerificationStatus = 'verified';
    nextSnapshot.activationFeeVerifiedAt = new Date().toISOString();
    nextSnapshot.status = normalizeActivationStatus(nextSnapshot.status, true);
    nextSnapshot.treasuryAddressUsed = options?.treasuryAddressUsed ?? nextSnapshot.treasuryAddressUsed ?? null;

    nextSnapshot.activation = {
      feeSats: nextSnapshot.activation?.feeSats ?? String(nextSnapshot.activationFeeRequired! * 100),
      feeTxid: normalizedTxid,
      feePaidAt: paidAt,
      payerAddress: options?.payerAddress ?? nextSnapshot.activation?.payerAddress ?? null,
      wcOfferId: nextSnapshot.activation?.wcOfferId ?? null,
    };

    if (nextSnapshot.status === 'active') {
      const existing = covenantIndex.getCovenantRef(id);
      const covenant = existing ?? this.buildEnsuredCovenant(campaign);
      this.applyEnsuredCovenant(campaign, nextSnapshot, covenant);
      covenantIndex.setCovenantRef(covenant);
    }

    campaign.status = nextSnapshot.status;
    campaigns.set(id, campaign);
    await saveCampaignToDisk(nextSnapshot);
    campaignSnapshots.set(id, nextSnapshot);

    await this.logEventOnceByTxid(id, 'ACTIVATION_FEE_PAID', normalizedTxid, {
      txid: normalizedTxid,
      paidAt,
      payerAddress: nextSnapshot.activation?.payerAddress ?? null,
      activationFeeRequired: nextSnapshot.activationFeeRequired,
      activationTreasuryAddressUsed: nextSnapshot.activationTreasuryAddressUsed ?? null,
    });
  }

  async setPayoutOffer(id: string, wcOfferId: string) {
    const campaign = campaigns.get(id);
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const previousSnapshot = campaignSnapshots.get(id);
    const nextSnapshot = normalizeSnapshot(toStoredCampaign(campaign, previousSnapshot));
    nextSnapshot.payout = {
      wcOfferId,
      txid: nextSnapshot.payout?.txid ?? null,
      paidAt: nextSnapshot.payout?.paidAt ?? null,
    };

    await saveCampaignToDisk(nextSnapshot);
    campaignSnapshots.set(id, nextSnapshot);

    await this.logEvent(id, 'PAYOUT_OFFER_CREATED', {
      wcOfferId,
      createdAt: new Date().toISOString(),
    });
  }

  async markPayoutComplete(
    id: string,
    txid: string,
    treasuryAddressUsed: string,
  ) {
    const campaign = campaigns.get(id);
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const previousSnapshot = campaignSnapshots.get(id);
    const nextSnapshot = normalizeSnapshot(toStoredCampaign(campaign, previousSnapshot));
    const paidAt = new Date().toISOString();

    nextSnapshot.status = 'paid_out';
    nextSnapshot.payout = {
      wcOfferId: nextSnapshot.payout?.wcOfferId ?? null,
      txid,
      paidAt,
    };
    nextSnapshot.treasuryAddressUsed = treasuryAddressUsed;

    campaign.status = 'paid_out';
    campaigns.set(id, campaign);
    await saveCampaignToDisk(nextSnapshot);
    campaignSnapshots.set(id, nextSnapshot);

    await this.logEvent(id, 'PAYOUT_CONFIRMED', {
      txid,
      paidAt,
      treasuryAddressUsed,
    });
  }

  /**
   * Actualiza el estado de una campana y sincroniza el cache en memoria.
   */
  async updateCampaignStatus(id: string, status: CampaignDefinition['status']) {
    const campaign = campaigns.get(id);
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const previousSnapshot = campaignSnapshots.get(id);
    const nextSnapshot = normalizeSnapshot(toStoredCampaign(campaign, previousSnapshot));

    if (status === 'active' && !nextSnapshot.activationFeePaid) {
      throw new Error('activation-fee-unpaid');
    }

    campaign.status = status;
    campaigns.set(id, campaign);

    nextSnapshot.status = status;
    if (status === 'active') {
      const existing = covenantIndex.getCovenantRef(id);
      const covenant = existing ?? this.buildEnsuredCovenant(campaign);
      this.applyEnsuredCovenant(campaign, nextSnapshot, covenant);
      covenantIndex.setCovenantRef(covenant);
    }
    await saveCampaignToDisk(nextSnapshot);
    campaignSnapshots.set(id, nextSnapshot);

    await this.logEvent(id, String(status).toUpperCase(), {
      status,
      changedAt: new Date().toISOString(),
    });
  }

  private serializeCampaign(
    campaign: CampaignDefinition,
    snapshotRaw?: StoredCampaign,
    covenant?: CovenantRef,
    progress?: number,
  ) {
    const snapshot = snapshotRaw ? normalizeSnapshot(snapshotRaw) : undefined;
    const expiresAt = snapshot?.expiresAt ?? toIsoFromExpiration(campaign.expirationTime);

    return {
      id: campaign.id,
      slug: snapshot?.slug ?? deriveCampaignSlug({ id: campaign.id, createdAt: snapshot?.createdAt ?? new Date().toISOString() }),
      name: campaign.name,
      description: campaign.description,
      goal: campaign.goal.toString(),
      expirationTime: campaign.expirationTime.toString(),
      expiresAt,
      createdAt: snapshot?.createdAt,
      status: campaign.status,
      recipientAddress: snapshot?.recipientAddress,
      beneficiaryAddress: campaign.beneficiaryAddress,
      campaignAddress: campaign.campaignAddress,
      covenantAddress: campaign.covenantAddress,
      beneficiaryPubKey: campaign.beneficiaryPubKey,
      location: snapshot?.location,
      activation: snapshot?.activation,
      activationFeeRequired: snapshot?.activationFeeRequired ?? ACTIVATION_FEE_XEC,
      activationFeePaid: snapshot?.activationFeePaid ?? false,
      activationFeeTxid: snapshot?.activationFeeTxid ?? null,
      activationFeePaidAt: snapshot?.activationFeePaidAt ?? null,
      activationFeeVerificationStatus: snapshot?.activationFeeVerificationStatus ?? 'none',
      activationFeeVerifiedAt: snapshot?.activationFeeVerifiedAt ?? null,
      activationOfferMode: snapshot?.activationOfferMode ?? null,
      activationOfferOutputs: snapshot?.activationOfferOutputs ?? null,
      activationTreasuryAddressUsed: snapshot?.activationTreasuryAddressUsed ?? null,
      payout: snapshot?.payout,
      treasuryAddressUsed: snapshot?.treasuryAddressUsed ?? null,
      covenant: covenant
        ? {
          ...covenant,
          value: covenant.value.toString(),
          campaignAddress: campaign.campaignAddress ?? snapshot?.campaignAddress ?? snapshot?.covenantAddress,
        }
        : undefined,
      progress,
    };
  }
}

/**
 * Carga campañas desde SQLite (o fallback JSON) a memoria al iniciar.
 */
export async function hydrateCampaignStore(): Promise<void> {
  const records = await loadCampaignsFromDisk();
  syncCampaignStoreFromDiskCampaigns(records);
}

export { campaigns as campaignStore, covenantIndex as covenantIndexInstance };
