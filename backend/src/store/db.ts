import { Database } from 'sqlite';
import { initializeDatabase, openDatabase } from '../db/SQLiteStore';

let db: Database | null = null;

async function ensurePledgesColumns(database: Database): Promise<void> {
  const columns = await database.all<Array<{ name: string }>>('PRAGMA table_info(pledges)');
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has('wcOfferId')) {
    await database.exec('ALTER TABLE pledges ADD COLUMN wcOfferId TEXT');
  }
  if (!existing.has('status')) {
    await database.exec("ALTER TABLE pledges ADD COLUMN status TEXT NOT NULL DEFAULT 'intent'");
  }
  if (!existing.has('statusReason')) {
    await database.exec('ALTER TABLE pledges ADD COLUMN statusReason TEXT');
  }
  if (!existing.has('confirmedAt')) {
    await database.exec('ALTER TABLE pledges ADD COLUMN confirmedAt TEXT');
  }
  if (!existing.has('refundTxid')) {
    await database.exec('ALTER TABLE pledges ADD COLUMN refundTxid TEXT');
  }
  if (!existing.has('refundedAt')) {
    await database.exec('ALTER TABLE pledges ADD COLUMN refundedAt TEXT');
  }
}

async function ensurePledgesIndexes(database: Database): Promise<void> {
  await database.exec(`
    CREATE INDEX IF NOT EXISTS idx_pledges_campaign_id ON pledges(campaignId);
    CREATE INDEX IF NOT EXISTS idx_pledges_status ON pledges(status);
    CREATE INDEX IF NOT EXISTS idx_pledges_contributor_address ON pledges(contributorAddress);
    CREATE INDEX IF NOT EXISTS idx_pledges_txid ON pledges(txid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pledges_txid_unique_non_null
      ON pledges(txid)
      WHERE txid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_audit_logs_campaign_id ON audit_logs(campaignId);
  `);
}

async function migrateLegacyPledgeStatuses(database: Database): Promise<void> {
  await database.run(`
    UPDATE pledges
    SET status = CASE
      WHEN refundTxid IS NOT NULL OR refundedAt IS NOT NULL THEN 'refunded'
      WHEN txid IS NOT NULL AND TRIM(txid) <> '' THEN 'confirmed'
      ELSE 'intent'
    END
    WHERE status IS NULL
      OR TRIM(status) = ''
      OR (
        status = 'intent'
        AND (
          refundTxid IS NOT NULL
          OR refundedAt IS NOT NULL
          OR (txid IS NOT NULL AND TRIM(txid) <> '')
        )
      )
  `);
}

export async function getDb(): Promise<Database> {
  if (db) return db;

  db = await openDatabase();
  await initializeDatabase(db);
  await db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS pledges (
      pledgeId TEXT PRIMARY KEY,
      campaignId TEXT NOT NULL,
      txid TEXT,
      wcOfferId TEXT,
      amount REAL NOT NULL,
      contributorAddress TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'intent',
      statusReason TEXT,
      confirmedAt TEXT,
      refundTxid TEXT,
      refundedAt TEXT,
      FOREIGN KEY(campaignId) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaignId TEXT,
      event TEXT NOT NULL,
      details TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(campaignId) REFERENCES campaigns(id)
    );
  `);

  await ensurePledgesColumns(db);
  await migrateLegacyPledgeStatuses(db);
  await ensurePledgesIndexes(db);

  return db;
}
