import fs from 'fs';
import path from 'path';
const { DatabaseSync } = require('node:sqlite');

export type CampaignStatus = 'draft' | 'pending_fee' | 'active' | 'expired' | 'funded' | 'paid_out';

export type CampaignRecord = {
  id: string;
  name: string;
  description?: string;
  recipientAddress: string;
  beneficiaryAddress: string;
  campaignAddress?: string;
  covenantAddress?: string;
  address?: string;
  recipient?: string;
  goal: number;
  expiresAt: string;
  createdAt: string;
  status: CampaignStatus;
  activation: {
    feeSats: string;
    feeTxid: string | null;
    feePaidAt: string | null;
    payerAddress: string | null;
    wcOfferId: string | null;
  };
  payout: {
    wcOfferId: string | null;
    txid: string | null;
    paidAt: string | null;
  };
  location?: string | {
    latitude: number;
    longitude: number;
  };
};

type CampaignRow = {
  payload_json: string;
};

const DATA_DIR = path.resolve(__dirname, '../../data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'campaigns.db');

export class SQLiteStore {
  private db: any = null;

  constructor(private readonly dbPath = DEFAULT_DB_PATH) {}

  openDatabase(): any {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    return this.db;
  }

  async initializeDatabase(): Promise<void> {
    const db = this.openDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        recipient_address TEXT NOT NULL,
        beneficiary_address TEXT NOT NULL,
        campaign_address TEXT,
        covenant_address TEXT,
        address TEXT,
        recipient TEXT,
        goal TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        location_text TEXT,
        location_lat TEXT,
        location_lng TEXT,
        activation_fee_sats TEXT,
        activation_fee_txid TEXT,
        activation_fee_paid_at TEXT,
        activation_payer_address TEXT,
        activation_wc_offer_id TEXT,
        payout_wc_offer_id TEXT,
        payout_txid TEXT,
        payout_paid_at TEXT,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async upsertCampaign(campaign: CampaignRecord): Promise<void> {
    const db = this.openDatabase();
    const normalized = this.normalizeCampaign(campaign);
    const locationObject = typeof normalized.location === 'object' ? normalized.location : null;

    db.prepare(`INSERT OR REPLACE INTO campaigns (
      id, name, description, recipient_address, beneficiary_address, campaign_address,
      covenant_address, address, recipient, goal, expires_at, created_at, status,
      location_text, location_lat, location_lng,
      activation_fee_sats, activation_fee_txid, activation_fee_paid_at, activation_payer_address,
      activation_wc_offer_id, payout_wc_offer_id, payout_txid, payout_paid_at, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      normalized.id,
      normalized.name,
      normalized.description ?? null,
      normalized.recipientAddress,
      normalized.beneficiaryAddress,
      normalized.campaignAddress ?? null,
      normalized.covenantAddress ?? null,
      normalized.address ?? null,
      normalized.recipient ?? null,
      String(normalized.goal),
      normalized.expiresAt,
      normalized.createdAt,
      normalized.status,
      typeof normalized.location === 'string' ? normalized.location : null,
      locationObject ? String(locationObject.latitude) : null,
      locationObject ? String(locationObject.longitude) : null,
      normalized.activation.feeSats,
      normalized.activation.feeTxid,
      normalized.activation.feePaidAt,
      normalized.activation.payerAddress,
      normalized.activation.wcOfferId,
      normalized.payout.wcOfferId,
      normalized.payout.txid,
      normalized.payout.paidAt,
      JSON.stringify(normalized),
    );
  }

  async getCampaignById(id: string): Promise<CampaignRecord | null> {
    const db = this.openDatabase();
    const row = db.prepare('SELECT payload_json FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
    if (!row) return null;
    return this.rowToCampaign(row);
  }

  async listCampaigns(): Promise<CampaignRecord[]> {
    const db = this.openDatabase();
    const rows = db.prepare('SELECT payload_json FROM campaigns ORDER BY created_at ASC').all() as CampaignRow[];
    return rows.map((row) => this.rowToCampaign(row));
  }

  async countCampaigns(): Promise<number> {
    const db = this.openDatabase();
    const row = db.prepare('SELECT COUNT(*) as count FROM campaigns').get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  async deleteCampaign(id: string): Promise<void> {
    const db = this.openDatabase();
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  private rowToCampaign(row: CampaignRow): CampaignRecord {
    try {
      const payload = JSON.parse(row.payload_json) as CampaignRecord;
      return this.normalizeCampaign(payload);
    } catch (err) {
      throw new Error(`[sqlite] campaña inválida en payload_json: ${(err as Error).message}`);
    }
  }

  private normalizeCampaign(campaign: CampaignRecord): CampaignRecord {
    return {
      ...campaign,
      goal: Number(campaign.goal),
      status: this.toStatus(campaign.status),
      activation: {
        feeSats: String(campaign.activation?.feeSats ?? '0'),
        feeTxid: campaign.activation?.feeTxid ?? null,
        feePaidAt: campaign.activation?.feePaidAt ?? null,
        payerAddress: campaign.activation?.payerAddress ?? null,
        wcOfferId: campaign.activation?.wcOfferId ?? null,
      },
      payout: {
        wcOfferId: campaign.payout?.wcOfferId ?? null,
        txid: campaign.payout?.txid ?? null,
        paidAt: campaign.payout?.paidAt ?? null,
      },
    };
  }

  private toStatus(value: unknown): CampaignStatus {
    if (
      value === 'draft'
      || value === 'pending_fee'
      || value === 'active'
      || value === 'expired'
      || value === 'funded'
      || value === 'paid_out'
    ) {
      return value;
    }
    return 'active';
  }
}

export const sqliteStore = new SQLiteStore();
