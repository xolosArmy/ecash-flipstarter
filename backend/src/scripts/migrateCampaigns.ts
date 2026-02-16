import { countCampaigns, initializeDatabase, openDatabase } from '../db/SQLiteStore';
import { migrateJsonCampaignsToSqlite } from '../store/campaignPersistence';

async function main() {
  const db = await openDatabase();
  await initializeDatabase(db);

  const before = await countCampaigns(db);
  const result = await migrateJsonCampaignsToSqlite();
  const after = await countCampaigns(db);

  console.log(`[migrate] sqlite campaigns before=${before}`);
  console.log(`[migrate] json campaigns=${result.jsonCount}`);
  console.log(`[migrate] migrated rows=${result.migrated}`);
  console.log(`[migrate] sqlite campaigns after=${after}`);

  if (result.jsonCount !== after && result.jsonCount > 0) {
    console.error(`[migrate] validation failed: jsonCount=${result.jsonCount} sqliteCount=${after}`);
    process.exitCode = 1;
    return;
  }

  console.log('[migrate] validation ok');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[migrate] failed: ${message}`);
  process.exitCode = 1;
});
