import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';
import { ACTIVATION_FEE_XEC } from '../config/constants';

export type CampaignStatus =
  | 'draft'
  | 'created'
  | 'pending_fee'
  | 'pending_verification'
  | 'fee_invalid'
  | 'active'
  | 'expired'
  | 'funded'
  | 'paid_out';

export type ActivationFeeVerificationStatus = 'none' | 'pending_verification' | 'verified' | 'invalid';

export type StoredCampaign = {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  goal: string | number | bigint;
  expiresAt: string;
  createdAt: string;
  status?: CampaignStatus;
  recipientAddress?: string;
  beneficiaryAddress?: string;
  campaignAddress?: string;
  covenantAddress?: string;
  escrowAddress?: string;
  beneficiaryPubKey?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
  activation?: {
    feeSats: string;
    feeTxid?: string | null;
    feePaidAt?: string | null;
    payerAddress?: string | null;
    wcOfferId?: string | null;
  };
  activationFeeRequired?: number;
  activationFeePaid?: boolean;
  activationFeeTxid?: string | null;
  activationFeePaidAt?: string | null;
  activationFeeVerificationStatus?: ActivationFeeVerificationStatus;
  activationFeeVerifiedAt?: string | null;
  activationOfferMode?: 'tx' | 'intent' | null;
  activationOfferOutputs?: Array<{ address: string; valueSats: number }> | null;
  activationTreasuryAddressUsed?: string | null;
  payout?: {
    wcOfferId?: string | null;
    txid?: string | null;
    paidAt?: string | null;
  };
  treasuryAddressUsed?: string | null;
};

const DEFAULT_DB_FILENAME = 'campaigns.db';

let dbPromise: Promise<Database<sqlite3.Database, sqlite3.Statement>> | null = null;
let dbPromisePath: string | null = null;

function getDataDir(): string {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function getDefaultDbPath(): string {
  return path.join(getDataDir(), DEFAULT_DB_FILENAME);
}

function getEffectiveDbPath(dbPath?: string): string {
  const envPath = process.env.TEYOLIA_SQLITE_PATH?.trim();
  return dbPath ?? (envPath && envPath.length > 0 ? envPath : getDefaultDbPath());
}

export async function openDatabase(dbPath?: string): Promise<Database> {
  const effectivePath = getEffectiveDbPath(dbPath);
  if (!dbPromise || dbPromisePath !== effectivePath) {
    dbPromise = open({
      filename: effectivePath,
      driver: sqlite3.Database,
    });
    dbPromisePath = effectivePath;
  }
  return dbPromise;
}

export async function initializeDatabase(database?: Database): Promise<void> {
  const db = database ?? (await openDatabase());

  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      slug TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      status TEXT,
      recipientAddress TEXT,
      beneficiaryAddress TEXT,
      campaignAddress TEXT,
      covenantAddress TEXT,
      escrowAddress TEXT,
      beneficiaryPubKey TEXT,
      location_lat REAL,
      location_lng REAL,
      activation_feeSats TEXT,
      activation_feeTxid TEXT,
      activation_feePaidAt TEXT,
      activation_payerAddress TEXT,
      activation_wcOfferId TEXT,
      activationFeeRequired INTEGER,
      activationFeePaid INTEGER,
      activationFeeTxid TEXT,
      activationFeePaidAt TEXT,
      activationFeeVerificationStatus TEXT,
      activationFeeVerifiedAt TEXT,
      activationOfferMode TEXT,
      activationOfferOutputs TEXT,
      activationTreasuryAddressUsed TEXT,
      payout_wcOfferId TEXT,
      payout_txid TEXT,
      payout_paidAt TEXT,
      treasuryAddressUsed TEXT,
      expirationTime TEXT
    )
  `);

  await ensureCampaignColumns(db);

  await db.run(
    `UPDATE campaigns
     SET activationFeeRequired = ?
     WHERE activationFeeRequired IS NULL OR activationFeeRequired <= 0`,
    [ACTIVATION_FEE_XEC],
  );

  await db.run(
    `UPDATE campaigns
     SET activationFeePaid = 0
     WHERE activationFeePaid IS NULL`,
  );

  await db.run(
    `UPDATE campaigns
     SET activationFeeVerificationStatus = 'none'
     WHERE activationFeeVerificationStatus IS NULL OR TRIM(activationFeeVerificationStatus) = ''`,
  );

  await db.run(
    `UPDATE campaigns
     SET status = 'created'
     WHERE status IS NULL OR TRIM(status) = ''`,
  );

  await db.run(
    `UPDATE campaigns
     SET slug = 'campaign-' || CAST(strftime('%s', createdAt) AS INTEGER) || '000'
     WHERE (slug IS NULL OR TRIM(slug) = '')
       AND createdAt IS NOT NULL
       AND TRIM(createdAt) <> ''
       AND strftime('%s', createdAt) IS NOT NULL`,
  );
}


async function ensureCampaignColumns(db: Database): Promise<void> {
  const columns = await db.all<Array<{ name: string }>>('PRAGMA table_info(campaigns)');
  const existing = new Set(columns.map((column) => column.name));

  const requiredColumns: Array<{ name: string; sqlType: string; defaultSql?: string }> = [
    { name: 'name', sqlType: 'TEXT', defaultSql: "''" },
    { name: 'slug', sqlType: 'TEXT' },
    { name: 'description', sqlType: 'TEXT', defaultSql: "''" },
    { name: 'goal', sqlType: 'TEXT', defaultSql: "'0'" },
    { name: 'expiresAt', sqlType: 'TEXT', defaultSql: "''" },
    { name: 'createdAt', sqlType: 'TEXT', defaultSql: "''" },
    { name: 'status', sqlType: 'TEXT' },
    { name: 'recipientAddress', sqlType: 'TEXT' },
    { name: 'beneficiaryAddress', sqlType: 'TEXT' },
    { name: 'campaignAddress', sqlType: 'TEXT' },
    { name: 'covenantAddress', sqlType: 'TEXT' },
    { name: 'escrowAddress', sqlType: 'TEXT' },
    { name: 'beneficiaryPubKey', sqlType: 'TEXT' },
    { name: 'location_lat', sqlType: 'REAL' },
    { name: 'location_lng', sqlType: 'REAL' },
    { name: 'activation_feeSats', sqlType: 'TEXT' },
    { name: 'activation_feeTxid', sqlType: 'TEXT' },
    { name: 'activation_feePaidAt', sqlType: 'TEXT' },
    { name: 'activation_payerAddress', sqlType: 'TEXT' },
    { name: 'activation_wcOfferId', sqlType: 'TEXT' },
    { name: 'activationFeeRequired', sqlType: 'INTEGER', defaultSql: String(ACTIVATION_FEE_XEC) },
    { name: 'activationFeePaid', sqlType: 'INTEGER', defaultSql: '0' },
    { name: 'activationFeeTxid', sqlType: 'TEXT' },
    { name: 'activationFeePaidAt', sqlType: 'TEXT' },
    { name: 'activationFeeVerificationStatus', sqlType: 'TEXT', defaultSql: "'none'" },
    { name: 'activationFeeVerifiedAt', sqlType: 'TEXT' },
    { name: 'activationOfferMode', sqlType: 'TEXT' },
    { name: 'activationOfferOutputs', sqlType: 'TEXT' },
    { name: 'activationTreasuryAddressUsed', sqlType: 'TEXT' },
    { name: 'payout_wcOfferId', sqlType: 'TEXT' },
    { name: 'payout_txid', sqlType: 'TEXT' },
    { name: 'payout_paidAt', sqlType: 'TEXT' },
    { name: 'treasuryAddressUsed', sqlType: 'TEXT' },
    { name: 'expirationTime', sqlType: 'TEXT' },
  ];

  for (const column of requiredColumns) {
    if (existing.has(column.name)) {
      continue;
    }
    const defaultSql = column.defaultSql ? ` DEFAULT ${column.defaultSql}` : '';
    await db.exec(`ALTER TABLE campaigns ADD COLUMN ${column.name} ${column.sqlType}${defaultSql}`);
  }
}

type CampaignRow = {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  goal: string;
  expiresAt: string | null;
  createdAt: string | null;
  status: CampaignStatus | null;
  recipientAddress: string | null;
  beneficiaryAddress: string | null;
  campaignAddress: string | null;
  covenantAddress: string | null;
  escrowAddress: string | null;
  beneficiaryPubKey: string | null;
  location_lat: number | null;
  location_lng: number | null;
  activation_feeSats: string | null;
  activation_feeTxid: string | null;
  activation_feePaidAt: string | null;
  activation_payerAddress: string | null;
  activation_wcOfferId: string | null;
  activationFeeRequired: number | null;
  activationFeePaid: number | null;
  activationFeeTxid: string | null;
  activationFeePaidAt: string | null;
  activationFeeVerificationStatus: string | null;
  activationFeeVerifiedAt: string | null;
  activationOfferMode: string | null;
  activationOfferOutputs: string | null;
  activationTreasuryAddressUsed: string | null;
  payout_wcOfferId: string | null;
  payout_txid: string | null;
  payout_paidAt: string | null;
  treasuryAddressUsed: string | null;
  expirationTime: string | null;
};


function derivePersistedSlug(id: string, createdAt: string): string {
  const createdAtTs = Date.parse(createdAt);
  if (Number.isFinite(createdAtTs) && createdAtTs > 0) {
    return `campaign-${Math.floor(createdAtTs)}`;
  }
  const idMatch = id.match(/(\d{10,})/);
  if (idMatch) {
    return `campaign-${idMatch[1]}`;
  }
  return `campaign-${id}`;
}

function toIsoDate(input: unknown, fallback: string): string {
  if (typeof input === 'string' && input.trim()) {
    return input;
  }
  return fallback;
}

function toGoalString(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.trim()) return value;
  return '0';
}

function deriveExpirationTime(expiresAt: string, explicit?: string | null): string {
  if (explicit && explicit.trim()) {
    return explicit;
  }
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? String(parsed) : '0';
}

function mapRowToCampaign(row: CampaignRow): StoredCampaign {
  const expiresAt = row.expiresAt && row.expiresAt.trim() ? row.expiresAt : row.expirationTime ?? '';
  const canonicalEscrow = row.escrowAddress ?? row.covenantAddress ?? row.campaignAddress ?? row.recipientAddress;
  const recipientAddress = row.recipientAddress ?? row.beneficiaryAddress ?? undefined;
  const campaign: StoredCampaign = {
    id: row.id,
    slug: row.slug ?? undefined,
    name: row.name,
    description: row.description ?? '',
    goal: row.goal,
    expiresAt,
    createdAt: row.createdAt ?? new Date(0).toISOString(),
    status: row.status ?? undefined,
    recipientAddress,
    beneficiaryAddress: row.beneficiaryAddress ?? undefined,
    campaignAddress: canonicalEscrow ?? row.campaignAddress ?? undefined,
    covenantAddress: canonicalEscrow ?? row.covenantAddress ?? undefined,
    escrowAddress: canonicalEscrow ?? undefined,
    beneficiaryPubKey: row.beneficiaryPubKey ?? undefined,
    activation: {
      feeSats: row.activation_feeSats ?? String(ACTIVATION_FEE_XEC * 100),
      feeTxid: row.activation_feeTxid,
      feePaidAt: row.activation_feePaidAt,
      payerAddress: row.activation_payerAddress,
      wcOfferId: row.activation_wcOfferId,
    },
    activationFeeRequired: row.activationFeeRequired ?? ACTIVATION_FEE_XEC,
    activationFeePaid: row.activationFeePaid === 1,
    activationFeeTxid: row.activationFeeTxid ?? row.activation_feeTxid,
    activationFeePaidAt: row.activationFeePaidAt ?? row.activation_feePaidAt,
    activationFeeVerificationStatus:
      row.activationFeeVerificationStatus === 'pending_verification'
      || row.activationFeeVerificationStatus === 'verified'
      || row.activationFeeVerificationStatus === 'invalid'
        ? row.activationFeeVerificationStatus
        : 'none',
    activationFeeVerifiedAt: row.activationFeeVerifiedAt ?? null,
    activationOfferMode: row.activationOfferMode === 'intent' || row.activationOfferMode === 'tx'
      ? row.activationOfferMode
      : null,
    activationOfferOutputs: parseActivationOfferOutputs(row.activationOfferOutputs),
    activationTreasuryAddressUsed: row.activationTreasuryAddressUsed,
    payout: {
      wcOfferId: row.payout_wcOfferId,
      txid: row.payout_txid,
      paidAt: row.payout_paidAt,
    },
    treasuryAddressUsed: row.treasuryAddressUsed,
  };

  if (row.location_lat !== null && row.location_lng !== null) {
    campaign.location = {
      latitude: row.location_lat,
      longitude: row.location_lng,
    };
  }

  return campaign;
}

export async function upsertCampaign(campaign: StoredCampaign, database?: Database): Promise<void> {
  const db = database ?? (await openDatabase());
  const nowIso = new Date().toISOString();
  const expiresAt = toIsoDate(campaign.expiresAt, nowIso);
  const createdAt = toIsoDate(campaign.createdAt, nowIso);
  const goal = toGoalString(campaign.goal);
  const canonicalEscrow = campaign.escrowAddress ?? campaign.covenantAddress ?? campaign.campaignAddress ?? campaign.recipientAddress ?? null;

  const activationFeeRequired =
    typeof campaign.activationFeeRequired === 'number' && campaign.activationFeeRequired > 0
      ? Math.floor(campaign.activationFeeRequired)
      : ACTIVATION_FEE_XEC;
  const activationFeePaid = campaign.activationFeePaid ? 1 : 0;
  const activationFeeTxid = campaign.activationFeeTxid ?? campaign.activation?.feeTxid ?? null;
  const activationFeePaidAt = campaign.activationFeePaidAt ?? campaign.activation?.feePaidAt ?? null;
  const activationFeeVerificationStatus =
    campaign.activationFeeVerificationStatus === 'pending_verification'
    || campaign.activationFeeVerificationStatus === 'verified'
    || campaign.activationFeeVerificationStatus === 'invalid'
      ? campaign.activationFeeVerificationStatus
      : 'none';
  const activationFeeVerifiedAt = campaign.activationFeeVerifiedAt ?? null;
  const activationOfferMode =
    campaign.activationOfferMode === 'intent' || campaign.activationOfferMode === 'tx'
      ? campaign.activationOfferMode
      : null;
  const activationOfferOutputs = serializeActivationOfferOutputs(campaign.activationOfferOutputs);

  try {
    await db.run(
      `
      INSERT OR REPLACE INTO campaigns (
        id,
        slug,
        name,
        description,
        goal,
        expiresAt,
        createdAt,
        status,
        recipientAddress,
        beneficiaryAddress,
        campaignAddress,
        covenantAddress,
        escrowAddress,
        beneficiaryPubKey,
        location_lat,
        location_lng,
        activation_feeSats,
        activation_feeTxid,
        activation_feePaidAt,
        activation_payerAddress,
        activation_wcOfferId,
        activationFeeRequired,
        activationFeePaid,
        activationFeeTxid,
        activationFeePaidAt,
        activationFeeVerificationStatus,
        activationFeeVerifiedAt,
        activationOfferMode,
        activationOfferOutputs,
        activationTreasuryAddressUsed,
        payout_wcOfferId,
        payout_txid,
        payout_paidAt,
        treasuryAddressUsed,
        expirationTime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        campaign.id,
        (typeof campaign.slug === 'string' && campaign.slug.trim())
          ? campaign.slug.trim()
          : derivePersistedSlug(campaign.id, createdAt),
        campaign.name,
        campaign.description ?? '',
        goal,
        expiresAt,
        createdAt,
        campaign.status ?? null,
        canonicalEscrow ?? campaign.recipientAddress ?? null,
        campaign.beneficiaryAddress ?? null,
        canonicalEscrow ?? campaign.campaignAddress ?? null,
        canonicalEscrow ?? campaign.covenantAddress ?? null,
        canonicalEscrow,
        campaign.beneficiaryPubKey ?? null,
        campaign.location?.latitude ?? null,
        campaign.location?.longitude ?? null,
        campaign.activation?.feeSats ?? String(activationFeeRequired * 100),
        campaign.activation?.feeTxid ?? activationFeeTxid,
        campaign.activation?.feePaidAt ?? activationFeePaidAt,
        campaign.activation?.payerAddress ?? null,
        campaign.activation?.wcOfferId ?? null,
        activationFeeRequired,
        activationFeePaid,
        activationFeeTxid,
        activationFeePaidAt,
        activationFeeVerificationStatus,
        activationFeeVerifiedAt,
        activationOfferMode,
        activationOfferOutputs,
        campaign.activationTreasuryAddressUsed ?? null,
        campaign.payout?.wcOfferId ?? null,
        campaign.payout?.txid ?? null,
        campaign.payout?.paidAt ?? null,
        campaign.treasuryAddressUsed ?? null,
        deriveExpirationTime(expiresAt, null),
      ],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sqlite-upsert-campaign-failed:${campaign.id}:${message}`);
  }
}

function parseActivationOfferOutputs(raw: string | null): Array<{ address: string; valueSats: number }> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const outputs = parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const address = (entry as { address?: unknown }).address;
        const valueSats = (entry as { valueSats?: unknown }).valueSats;
        if (typeof address !== 'string') return null;
        const valueNumber = Number(valueSats);
        if (!Number.isFinite(valueNumber) || valueNumber <= 0) return null;
        return { address, valueSats: Math.floor(valueNumber) };
      })
      .filter((entry): entry is { address: string; valueSats: number } => entry !== null);
    return outputs.length > 0 ? outputs : null;
  } catch {
    return null;
  }
}

function serializeActivationOfferOutputs(
  outputs: StoredCampaign['activationOfferOutputs'],
): string | null {
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  return JSON.stringify(outputs);
}

export async function getCampaignById(id: string, database?: Database): Promise<StoredCampaign | null> {
  const db = database ?? (await openDatabase());
  try {
    const row = await db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id]);
    return row ? mapRowToCampaign(row) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sqlite-get-campaign-failed:${id}:${message}`);
  }
}

export async function listCampaigns(database?: Database): Promise<StoredCampaign[]> {
  const db = database ?? (await openDatabase());
  try {
    const rows = await db.all<CampaignRow[]>('SELECT * FROM campaigns ORDER BY createdAt DESC, id DESC');
    return rows.map((row) => mapRowToCampaign(row));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sqlite-list-campaigns-failed:${message}`);
  }
}

export async function deleteCampaign(id: string, database?: Database): Promise<boolean> {
  const db = database ?? (await openDatabase());
  try {
    const result = await db.run('DELETE FROM campaigns WHERE id = ?', [id]);
    return (result.changes ?? 0) > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sqlite-delete-campaign-failed:${id}:${message}`);
  }
}

export async function countCampaigns(database?: Database): Promise<number> {
  const db = database ?? (await openDatabase());
  const row = await db.get<{ total: number }>('SELECT COUNT(*) as total FROM campaigns');
  return row?.total ?? 0;
}
