import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteStore, type CampaignRecord } from '../db/SQLiteStore';

const stores: SQLiteStore[] = [];
const tempFiles: string[] = [];

function buildCampaign(id: string): CampaignRecord {
  return {
    id,
    name: 'Campaña de prueba',
    description: 'Persistencia sqlite',
    recipientAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    beneficiaryAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    campaignAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    covenantAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    goal: 10000,
    expiresAt: '2027-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    activation: {
      feeSats: '80000000',
      feeTxid: null,
      feePaidAt: null,
      payerAddress: null,
      wcOfferId: null,
    },
    payout: {
      wcOfferId: null,
      txid: null,
      paidAt: null,
    },
    location: {
      latitude: 32.5149,
      longitude: -117.0382,
    },
  };
}

function createStore() {
  const dbPath = path.join(os.tmpdir(), `campaigns-test-${Date.now()}-${Math.random()}.db`);
  tempFiles.push(dbPath);
  const store = new SQLiteStore(dbPath);
  stores.push(store);
  return store;
}

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  tempFiles.splice(0).forEach((filePath) => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });
});

describe('SQLiteStore', () => {
  it('crea tabla y permite upsert/list/get', async () => {
    const store = createStore();
    await store.initializeDatabase();

    const campaignA = buildCampaign('campaign-a');
    const campaignB = buildCampaign('campaign-b');
    campaignB.name = 'Otra campaña';

    await store.upsertCampaign(campaignA);
    await store.upsertCampaign(campaignB);

    const list = await store.listCampaigns();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('campaign-a');

    const found = await store.getCampaignById('campaign-b');
    expect(found?.name).toBe('Otra campaña');

    campaignB.status = 'funded';
    await store.upsertCampaign(campaignB);
    const updated = await store.getCampaignById('campaign-b');
    expect(updated?.status).toBe('funded');
  });
});
