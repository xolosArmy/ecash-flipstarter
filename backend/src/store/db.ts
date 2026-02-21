import { Database } from 'sqlite';
import { initializeDatabase, openDatabase } from '../db/SQLiteStore';

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  
  dbInstance = await openDatabase();
  await initializeDatabase(dbInstance);
  
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS pledges (
      pledgeId TEXT PRIMARY KEY,
      campaignId TEXT NOT NULL,
      txid TEXT,
      wcOfferId TEXT,
      amount REAL NOT NULL,
      contributorAddress TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      message TEXT
    );
  `);
  
  return dbInstance;
}
