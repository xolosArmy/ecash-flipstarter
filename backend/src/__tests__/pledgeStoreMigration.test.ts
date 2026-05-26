import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir = '';
let dbPath = '';

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-store-migration-test-'));
  dbPath = path.join(tmpDir, 'pledges.db');
  process.env.TEYOLIA_SQLITE_PATH = dbPath;
});

afterEach(() => {
  delete process.env.TEYOLIA_SQLITE_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pledge store migration', () => {
  it('migrates legacy pledged tx rows into confirmed status', async () => {
    const { openDatabase, initializeDatabase } = await import('../db/SQLiteStore');
    const db = await openDatabase(dbPath);
    await initializeDatabase(db);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS pledges (
        pledgeId TEXT PRIMARY KEY,
        campaignId TEXT NOT NULL,
        txid TEXT,
        amount REAL NOT NULL,
        contributorAddress TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        message TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaignId TEXT,
        event TEXT NOT NULL,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.run(
      'INSERT INTO campaigns (id, name, description, goal, expiresAt, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['camp-legacy', 'Legacy', '', '1000', '2026-12-31T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'active'],
    );
    await db.run(
      'INSERT INTO pledges (pledgeId, campaignId, txid, amount, contributorAddress, timestamp, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['pledge-legacy-confirmed', 'camp-legacy', 'a'.repeat(64), 1200, 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035', new Date().toISOString(), 'legacy'],
    );

    const storeDb = await import('../store/db');
    const pledgedStore = await import('../store/simplePledges');
    const migratedDb = await storeDb.getDb();
    const pledge = await pledgedStore.getPledgeById('pledge-legacy-confirmed');

    expect(pledge?.status).toBe('confirmed');
    expect(await pledgedStore.getConfirmedTotalByCampaign('camp-legacy')).toBe(1200);
    await migratedDb.close();
  });

  it('allows multiple intent pledges with null txid while enforcing uniqueness once txid is set', async () => {
    const { openDatabase, initializeDatabase } = await import('../db/SQLiteStore');
    const db = await openDatabase(dbPath);
    await initializeDatabase(db);
    await db.run(
      'INSERT INTO campaigns (id, name, description, goal, expiresAt, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['camp-null-txid', 'Null txid campaign', '', '1000', '2026-12-31T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'active'],
    );

    const { savePledge, updatePledgeVerification } = await import('../store/simplePledges');

    await savePledge('camp-null-txid', {
      pledgeId: 'pledge-null-1',
      txid: null,
      amount: 500,
      contributorAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035',
      timestamp: new Date().toISOString(),
      status: 'intent',
    });
    await savePledge('camp-null-txid', {
      pledgeId: 'pledge-null-2',
      txid: null,
      amount: 600,
      contributorAddress: 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      timestamp: new Date().toISOString(),
      status: 'intent',
    });

    await updatePledgeVerification({
      pledgeId: 'pledge-null-1',
      txid: 'b'.repeat(64),
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    });

    await expect(updatePledgeVerification({
      pledgeId: 'pledge-null-2',
      txid: 'b'.repeat(64),
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    })).rejects.toThrow('txid-already-used');
  });
});
