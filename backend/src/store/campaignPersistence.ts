import fs from 'fs';
import path from 'path';
import {
  countCampaigns,
  initializeDatabase,
  listCampaigns as listCampaignsFromSqlite,
  openDatabase,
  type StoredCampaign,
  upsertCampaign,
} from '../db/SQLiteStore';
export type { StoredCampaign } from '../db/SQLiteStore';

const CAMPAIGNS_JSON_FILE = 'campaigns.json';

function getDataDir(): string {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function getCampaignsJsonPath(): string {
  return path.join(getDataDir(), CAMPAIGNS_JSON_FILE);
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function shouldDualWriteJson(): boolean {
  return parseBooleanEnv(process.env.CAMPAIGNS_DUAL_WRITE_JSON, true);
}

export function shouldMigrateOnStart(): boolean {
  return parseBooleanEnv(process.env.MIGRATE_ON_START, true);
}

export function readCampaignsJson(): StoredCampaign[] {
  const filePath = getCampaignsJsonPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as StoredCampaign[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[campaignPersistence] failed to read campaigns.json: ${message}`);
    return [];
  }
}

export function writeCampaignsJson(campaigns: StoredCampaign[]): void {
  const filePath = getCampaignsJsonPath();
  const payload = JSON.stringify(campaigns, null, 2);
  fs.writeFileSync(filePath, `${payload}\n`, 'utf8');
}

export async function migrateJsonCampaignsToSqlite(): Promise<{
  jsonCount: number;
  sqliteCount: number;
  migrated: number;
}> {
  const db = await openDatabase();
  await initializeDatabase(db);

  const jsonCampaigns = readCampaignsJson();
  let migrated = 0;

  for (const campaign of jsonCampaigns) {
    await upsertCampaign(campaign, db);
    migrated += 1;
  }

  const sqliteCount = await countCampaigns(db);
  return {
    jsonCount: jsonCampaigns.length,
    sqliteCount,
    migrated,
  };
}

export async function loadCampaignsFromDisk(options?: { migrateOnStart?: boolean }): Promise<StoredCampaign[]> {
  const db = await openDatabase();
  await initializeDatabase(db);

  try {
    const sqliteCampaigns = await listCampaignsFromSqlite(db);
    if (sqliteCampaigns.length > 0) {
      return sqliteCampaigns;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[campaignPersistence] failed to list SQLite campaigns: ${message}`);
  }

  const jsonCampaigns = readCampaignsJson();
  const migrateOnStart = options?.migrateOnStart ?? shouldMigrateOnStart();
  if (jsonCampaigns.length > 0 && migrateOnStart) {
    try {
      for (const campaign of jsonCampaigns) {
        await upsertCampaign(campaign, db);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[campaignPersistence] failed to migrate JSON campaigns to SQLite: ${message}`);
    }
  }

  return jsonCampaigns;
}

export async function saveCampaignsToDisk(campaigns: StoredCampaign[]): Promise<void> {
  const db = await openDatabase();
  await initializeDatabase(db);

  for (const campaign of campaigns) {
    await upsertCampaign(campaign, db);
  }

  if (shouldDualWriteJson()) {
    writeCampaignsJson(campaigns);
  }
}

export async function saveCampaignToDisk(campaign: StoredCampaign): Promise<void> {
  const db = await openDatabase();
  await initializeDatabase(db);
  await upsertCampaign(campaign, db);

  if (!shouldDualWriteJson()) {
    return;
  }

  const existing = readCampaignsJson();
  const idx = existing.findIndex((entry) => entry.id === campaign.id);
  if (idx >= 0) {
    existing[idx] = campaign;
  } else {
    existing.push(campaign);
  }
  writeCampaignsJson(existing);
}
