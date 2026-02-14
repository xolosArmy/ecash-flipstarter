import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVATION_FEE_XEC,
} from '../config/constants';
import {
  countCampaigns,
  deleteCampaign,
  getCampaignById,
  initializeDatabase,
  listCampaigns,
  openDatabase,
  upsertCampaign,
  type StoredCampaign,
} from '../db/SQLiteStore';

let tmpDir = '';
let dbPath = '';

const SAMPLE_CAMPAIGN: StoredCampaign = {
  id: 'campaign-test-1',
  name: 'SQLite test campaign',
  description: 'Campaign persisted in sqlite',
  goal: '12345',
  expiresAt: '2026-12-31T00:00:00.000Z',
  createdAt: '2026-02-14T00:00:00.000Z',
  status: 'pending_fee',
  recipientAddress: 'ecash:qptestrecipientaddress0000000000000000000',
  beneficiaryAddress: 'ecash:qpbeneficiaryaddress000000000000000000',
  campaignAddress: 'ecash:qpcampaignaddress0000000000000000000000',
  covenantAddress: 'ecash:qpcovenantaddress000000000000000000000',
  location: {
    latitude: 32.5149,
    longitude: -117.0382,
  },
  activation: {
    feeSats: '80000000',
    feeTxid: null,
    feePaidAt: null,
    payerAddress: null,
    wcOfferId: null,
  },
  activationFeeRequired: 800000,
  activationFeePaid: false,
  activationFeeTxid: null,
  activationFeePaidAt: null,
  payout: {
    wcOfferId: null,
    txid: null,
    paidAt: null,
  },
  treasuryAddressUsed: null,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-store-test-'));
  dbPath = path.join(tmpDir, 'test-campaigns.db');
});

afterEach(async () => {
  try {
    const db = await openDatabase(dbPath);
    await db.close();
  } catch {
    // no-op
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SQLiteStore', () => {
  it('creates campaigns table on initializeDatabase', async () => {
    const db = await openDatabase(dbPath);
    await initializeDatabase(db);

    const tableInfo = await db.all<Array<{ name: string }>>('PRAGMA table_info(campaigns)');
    const columnNames = tableInfo.map((entry) => entry.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('expiresAt');
    expect(columnNames).toContain('activation_feeSats');
    expect(columnNames).toContain('activationFeeRequired');
    expect(columnNames).toContain('activationFeePaid');
    expect(columnNames).toContain('treasuryAddressUsed');
    expect(columnNames).toContain('payout_txid');
  });

  it('upserts and lists campaigns with activation defaults', async () => {
    const db = await openDatabase(dbPath);
    await initializeDatabase(db);

    await upsertCampaign(SAMPLE_CAMPAIGN, db);

    const list = await listCampaigns(db);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(SAMPLE_CAMPAIGN.id);
    expect(list[0].goal).toBe('12345');
    expect(list[0].activation?.feeSats).toBe('80000000');
    expect(list[0].activationFeeRequired).toBe(800000);
    expect(list[0].activationFeePaid).toBe(false);
  });

  it('gets campaign by id and updates existing records via upsert', async () => {
    const db = await openDatabase(dbPath);
    await initializeDatabase(db);

    await upsertCampaign(SAMPLE_CAMPAIGN, db);
    await upsertCampaign(
      {
        ...SAMPLE_CAMPAIGN,
        name: 'Updated name',
        status: 'active',
        activation: {
          feeSats: SAMPLE_CAMPAIGN.activation?.feeSats ?? '80000000',
          feeTxid: 'a'.repeat(64),
          feePaidAt: '2026-02-14T01:00:00.000Z',
        },
        activationFeePaid: true,
        activationFeeTxid: 'a'.repeat(64),
        activationFeePaidAt: '2026-02-14T01:00:00.000Z',
      },
      db,
    );

    const campaign = await getCampaignById(SAMPLE_CAMPAIGN.id, db);
    expect(campaign).not.toBeNull();
    expect(campaign?.name).toBe('Updated name');
    expect(campaign?.activation?.feeTxid).toBe('a'.repeat(64));
    expect(campaign?.activationFeePaid).toBe(true);
    expect(await countCampaigns(db)).toBe(1);
  });

  it('fills activation defaults for legacy rows during initializeDatabase', async () => {
    const db = await openDatabase(dbPath);
    await db.exec(`
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        goal TEXT,
        expiresAt TEXT,
        createdAt TEXT,
        status TEXT
      )
    `);
    await db.run(
      'INSERT INTO campaigns (id, name, description, goal, expiresAt, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['legacy-1', 'Legacy', '', '100', '2026-12-31T00:00:00.000Z', '2026-02-14T00:00:00.000Z', 'active'],
    );

    await initializeDatabase(db);

    const migrated = await getCampaignById('legacy-1', db);
    expect(migrated?.activationFeeRequired).toBe(ACTIVATION_FEE_XEC);
    expect(migrated?.activationFeePaid).toBe(false);
  });

  it('deletes campaign by id', async () => {
    const db = await openDatabase(dbPath);
    await initializeDatabase(db);

    await upsertCampaign(SAMPLE_CAMPAIGN, db);
    const deleted = await deleteCampaign(SAMPLE_CAMPAIGN.id, db);

    expect(deleted).toBe(true);
    expect(await getCampaignById(SAMPLE_CAMPAIGN.id, db)).toBeNull();
  });
});
