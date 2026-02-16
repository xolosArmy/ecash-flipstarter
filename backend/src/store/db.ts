import { Database } from 'sqlite';
import { initializeDatabase, openDatabase } from '../db/SQLiteStore';

let db: Database | null = null;

async function ensurePledgesColumns(database: Database): Promise<void> {
  const columns = await database.all<Array<{ name: string }>>('PRAGMA table_info(pledges)');
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has('wcOfferId')) {
    await database.exec('ALTER TABLE pledges ADD COLUMN wcOfferId TEXT');
  }
}

export async function getDb(): Promise<Database> {
  if (db) return db;

  db = await openDatabase();
  await initializeDatabase(db);

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

  return db;
}
