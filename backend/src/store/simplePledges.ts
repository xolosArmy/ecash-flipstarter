import { getDb } from './db';

export type SimplePledge = {
  pledgeId: string;
  txid: string | null;
  wcOfferId?: string | null;
  amount: number;
  contributorAddress: string;
  timestamp: string;
  message?: string;
};

export async function savePledge(campaignId: string, pledge: SimplePledge): Promise<void> {
  const db = await getDb();
  await db.exec('BEGIN TRANSACTION');
  try {
    await db.run(
      `INSERT INTO pledges (pledgeId, campaignId, txid, wcOfferId, amount, contributorAddress, timestamp, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pledge.pledgeId,
        campaignId,
        pledge.txid,
        pledge.wcOfferId ?? null,
        pledge.amount,
        pledge.contributorAddress,
        pledge.timestamp,
        pledge.message ?? null,
      ],
    );

    await db.run(
      'INSERT INTO audit_logs (campaignId, event, details) VALUES (?, ?, ?)',
      [
        campaignId,
        'PLEDGE_RECEIVED',
        JSON.stringify({
          pledgeId: pledge.pledgeId,
          wcOfferId: pledge.wcOfferId ?? null,
          amount: pledge.amount,
          contributorAddress: pledge.contributorAddress,
        }),
      ],
    );

    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

export async function getPledgesByCampaign(campaignId: string): Promise<SimplePledge[]> {
  const db = await getDb();
  const rows = await db.all<Array<SimplePledge & { campaignId: string }>>(
    `SELECT pledgeId, txid, wcOfferId, amount, contributorAddress, timestamp, message
     FROM pledges
     WHERE campaignId = ?
     ORDER BY timestamp ASC`,
    [campaignId],
  );
  return rows.map((row) => ({
    pledgeId: row.pledgeId,
    txid: row.txid,
    wcOfferId: row.wcOfferId ?? null,
    amount: Number(row.amount),
    contributorAddress: row.contributorAddress,
    timestamp: row.timestamp,
    message: row.message ?? undefined,
  }));
}

export async function updatePledgeTxid(pledgeId: string, txid: string): Promise<boolean> {
  const db = await getDb();
  await db.exec('BEGIN TRANSACTION');
  try {
    const pledge = await db.get<{ campaignId: string }>(
      'SELECT campaignId FROM pledges WHERE pledgeId = ?',
      [pledgeId],
    );

    const result = await db.run(
      'UPDATE pledges SET txid = ? WHERE pledgeId = ?',
      [txid, pledgeId],
    );
    const updated = (result.changes ?? 0) > 0;
    if (!updated) {
      await db.exec('COMMIT');
      return false;
    }

    await db.run(
      'INSERT INTO audit_logs (campaignId, event, details) VALUES (?, ?, ?)',
      [
        pledge?.campaignId ?? null,
        'PLEDGE_CONFIRMED',
        JSON.stringify({ pledgeId, txid }),
      ],
    );

    await db.exec('COMMIT');
    return true;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}
