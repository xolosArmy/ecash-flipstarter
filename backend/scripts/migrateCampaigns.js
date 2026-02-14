const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.resolve(__dirname, '../data');
const jsonPath = path.join(dataDir, 'campaigns.json');
const dbPath = path.join(dataDir, 'campaigns.db');

function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      recipient_address TEXT NOT NULL,
      beneficiary_address TEXT NOT NULL,
      campaign_address TEXT,
      covenant_address TEXT,
      address TEXT,
      recipient TEXT,
      goal TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      location_text TEXT,
      location_lat TEXT,
      location_lng TEXT,
      activation_fee_sats TEXT,
      activation_fee_txid TEXT,
      activation_fee_paid_at TEXT,
      activation_payer_address TEXT,
      activation_wc_offer_id TEXT,
      payout_wc_offer_id TEXT,
      payout_txid TEXT,
      payout_paid_at TEXT,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function upsertCampaign(db, campaign) {
  const locationObject = typeof campaign.location === 'object' ? campaign.location : null;
  db.prepare(`INSERT OR REPLACE INTO campaigns (
    id, name, description, recipient_address, beneficiary_address, campaign_address,
    covenant_address, address, recipient, goal, expires_at, created_at, status,
    location_text, location_lat, location_lng,
    activation_fee_sats, activation_fee_txid, activation_fee_paid_at, activation_payer_address,
    activation_wc_offer_id, payout_wc_offer_id, payout_txid, payout_paid_at, payload_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
    campaign.id,
    campaign.name,
    campaign.description ?? null,
    campaign.recipientAddress,
    campaign.beneficiaryAddress,
    campaign.campaignAddress ?? null,
    campaign.covenantAddress ?? null,
    campaign.address ?? null,
    campaign.recipient ?? null,
    String(campaign.goal),
    campaign.expiresAt,
    campaign.createdAt,
    campaign.status,
    typeof campaign.location === 'string' ? campaign.location : null,
    locationObject ? String(locationObject.latitude) : null,
    locationObject ? String(locationObject.longitude) : null,
    String(campaign.activation?.feeSats ?? '0'),
    campaign.activation?.feeTxid ?? null,
    campaign.activation?.feePaidAt ?? null,
    campaign.activation?.payerAddress ?? null,
    campaign.activation?.wcOfferId ?? null,
    campaign.payout?.wcOfferId ?? null,
    campaign.payout?.txid ?? null,
    campaign.payout?.paidAt ?? null,
    JSON.stringify(campaign),
  );
}

(function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  const campaigns = fs.existsSync(jsonPath)
    ? JSON.parse(fs.readFileSync(jsonPath, 'utf8') || '[]')
    : [];

  const db = new DatabaseSync(dbPath);
  initializeDatabase(db);

  for (const campaign of campaigns) {
    if (campaign?.id) {
      upsertCampaign(db, campaign);
    }
  }

  const row = db.prepare('SELECT COUNT(*) as count FROM campaigns').get();
  const sqliteCount = Number(row?.count ?? 0);
  console.log(`[migrateCampaigns] json=${campaigns.length} sqlite=${sqliteCount} migrated=${campaigns.length}`);

  if (campaigns.length !== sqliteCount) {
    throw new Error(`Conteo inconsistente: json=${campaigns.length} sqlite=${sqliteCount}`);
  }

  db.close();
})();
