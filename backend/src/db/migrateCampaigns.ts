import fs from 'fs';
import path from 'path';
import { openDatabase, initializeDatabase, upsertCampaign, type StoredCampaign } from './SQLiteStore';

export const CAMPAIGNS_JSON_PATH = path.resolve(__dirname, '../../data/campaigns.json');

export function readCampaignsFromJson(filePath = CAMPAIGNS_JSON_PATH): StoredCampaign[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as StoredCampaign[];
  return Array.isArray(parsed) ? parsed : [];
}

export async function migrateJsonCampaignsToSqlite(
  filePath = CAMPAIGNS_JSON_PATH,
): Promise<{ jsonCount: number; sqliteCount: number; migrated: number }> {
  const db = await openDatabase();
  await initializeDatabase(db);

  const campaigns = readCampaignsFromJson(filePath);
  for (const campaign of campaigns) {
    if (campaign && typeof campaign.id === 'string' && campaign.id.trim()) {
      await upsertCampaign(campaign, db);
    }
  }
  const row = await db.get<{ total: number }>('SELECT COUNT(*) as total FROM campaigns');
  const sqliteCount = row?.total ?? 0;
  return {
    jsonCount: campaigns.length,
    sqliteCount,
    migrated: campaigns.length,
  };
}
