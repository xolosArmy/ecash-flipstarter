import fs from 'fs';
import path from 'path';
import { SQLiteStore, type CampaignRecord } from './SQLiteStore';

export const CAMPAIGNS_JSON_PATH = path.resolve(__dirname, '../../data/campaigns.json');

export function readCampaignsFromJson(filePath = CAMPAIGNS_JSON_PATH): CampaignRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as CampaignRecord[];
  return Array.isArray(parsed) ? parsed : [];
}

export async function migrateJsonCampaignsToSqlite(
  store: SQLiteStore,
  filePath = CAMPAIGNS_JSON_PATH,
): Promise<{ jsonCount: number; sqliteCount: number; migrated: number }> {
  const campaigns = readCampaignsFromJson(filePath);
  for (const campaign of campaigns) {
    if (campaign && typeof campaign.id === 'string' && campaign.id.trim()) {
      await store.upsertCampaign(campaign);
    }
  }
  const sqliteCount = await store.countCampaigns();
  return {
    jsonCount: campaigns.length,
    sqliteCount,
    migrated: campaigns.length,
  };
}
