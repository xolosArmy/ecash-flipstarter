import { getDb } from './db';

export type PledgeStatus =
  | 'intent'
  | 'broadcasted'
  | 'seen_mempool'
  | 'confirmed'
  | 'finalized'
  | 'expired'
  | 'refunded'
  | 'invalid';

export type SimplePledge = {
  pledgeId: string;
  txid: string | null;
  wcOfferId?: string | null;
  amount: number;
  contributorAddress: string;
  timestamp: string;
  message?: string;
  status: PledgeStatus;
  statusReason?: string | null;
  confirmedAt?: string | null;
  refundTxid?: string | null;
  refundedAt?: string | null;
};

export const CONFIRMED_PLEDGE_STATUSES: readonly PledgeStatus[] = ['confirmed', 'finalized'];
export const PENDING_PLEDGE_STATUSES: readonly PledgeStatus[] = ['intent', 'broadcasted', 'seen_mempool'];

function isConfirmedStatus(status: PledgeStatus): boolean {
  return CONFIRMED_PLEDGE_STATUSES.includes(status);
}

function isPendingStatus(status: PledgeStatus): boolean {
  return PENDING_PLEDGE_STATUSES.includes(status);
}

function mapRow(row: SimplePledge & { campaignId: string }): SimplePledge {
  return {
    pledgeId: row.pledgeId,
    txid: row.txid,
    wcOfferId: row.wcOfferId ?? null,
    amount: Number(row.amount),
    contributorAddress: row.contributorAddress,
    timestamp: row.timestamp,
    message: row.message ?? undefined,
    status: row.status,
    statusReason: row.statusReason ?? null,
    confirmedAt: row.confirmedAt ?? null,
    refundTxid: row.refundTxid ?? null,
    refundedAt: row.refundedAt ?? null,
  };
}

function mapVerificationEvent(status: PledgeStatus): string {
  switch (status) {
    case 'seen_mempool':
      return 'PLEDGE_SEEN_MEMPOOL';
    case 'confirmed':
      return 'PLEDGE_CONFIRMED';
    case 'finalized':
      return 'PLEDGE_FINALIZED';
    case 'invalid':
      return 'PLEDGE_INVALID';
    case 'broadcasted':
      return 'PLEDGE_BROADCASTED';
    case 'expired':
      return 'PLEDGE_EXPIRED';
    case 'refunded':
      return 'PLEDGE_REFUNDED';
    case 'intent':
    default:
      return 'PLEDGE_INTENT_CREATED';
  }
}

export async function savePledge(campaignId: string, pledge: Omit<SimplePledge, 'status'> & { status?: PledgeStatus }): Promise<void> {
  const db = await getDb();
  const status = pledge.status ?? 'intent';
  await db.exec('BEGIN TRANSACTION');
  try {
    await db.run(
      `INSERT INTO pledges (
         pledgeId,
         campaignId,
         txid,
         wcOfferId,
         amount,
         contributorAddress,
         timestamp,
         message,
         status,
         statusReason,
         confirmedAt,
         refundTxid,
         refundedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pledge.pledgeId,
        campaignId,
        pledge.txid,
        pledge.wcOfferId ?? null,
        pledge.amount,
        pledge.contributorAddress,
        pledge.timestamp,
        pledge.message ?? null,
        status,
        pledge.statusReason ?? null,
        pledge.confirmedAt ?? null,
        pledge.refundTxid ?? null,
        pledge.refundedAt ?? null,
      ],
    );

    await db.run(
      'INSERT INTO audit_logs (campaignId, event, details) VALUES (?, ?, ?)',
      [
        campaignId,
        mapVerificationEvent(status),
        JSON.stringify({
          pledgeId: pledge.pledgeId,
          wcOfferId: pledge.wcOfferId ?? null,
          amount: pledge.amount,
          contributorAddress: pledge.contributorAddress,
          status,
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
    `SELECT pledgeId, txid, wcOfferId, amount, contributorAddress, timestamp, message, status, statusReason, confirmedAt, refundTxid, refundedAt
     FROM pledges
     WHERE campaignId = ?
     ORDER BY timestamp ASC`,
    [campaignId],
  );
  return rows.map(mapRow);
}

export async function getPledgeById(pledgeId: string): Promise<(SimplePledge & { campaignId: string }) | null> {
  const db = await getDb();
  const row = await db.get<SimplePledge & { campaignId: string }>(
    `SELECT pledgeId, campaignId, txid, wcOfferId, amount, contributorAddress, timestamp, message, status, statusReason, confirmedAt, refundTxid, refundedAt
     FROM pledges
     WHERE pledgeId = ?`,
    [pledgeId],
  );
  return row ? { ...mapRow(row), campaignId: row.campaignId } : null;
}

export async function getPledgeByTxid(txid: string): Promise<(SimplePledge & { campaignId: string }) | null> {
  const db = await getDb();
  const row = await db.get<SimplePledge & { campaignId: string }>(
    `SELECT pledgeId, campaignId, txid, wcOfferId, amount, contributorAddress, timestamp, message, status, statusReason, confirmedAt, refundTxid, refundedAt
     FROM pledges
     WHERE txid = ?`,
    [txid],
  );
  return row ? { ...mapRow(row), campaignId: row.campaignId } : null;
}

export async function getConfirmedTotalByCampaign(campaignId: string): Promise<number> {
  const pledges = await getPledgesByCampaign(campaignId);
  return pledges
    .filter((pledge) => isConfirmedStatus(pledge.status))
    .reduce((total, pledge) => total + pledge.amount, 0);
}

export async function getPendingTotalByCampaign(campaignId: string): Promise<number> {
  const pledges = await getPledgesByCampaign(campaignId);
  return pledges
    .filter((pledge) => isPendingStatus(pledge.status))
    .reduce((total, pledge) => total + pledge.amount, 0);
}

export async function updatePledgeVerification(args: {
  pledgeId: string;
  txid: string | null;
  status: Extract<PledgeStatus, 'broadcasted' | 'seen_mempool' | 'confirmed' | 'invalid'>;
  statusReason?: string | null;
  confirmedAt?: string | null;
}): Promise<SimplePledge | null> {
  const db = await getDb();
  await db.exec('BEGIN TRANSACTION');
  try {
    const pledge = await db.get<{ campaignId: string }>(
      'SELECT campaignId FROM pledges WHERE pledgeId = ?',
      [args.pledgeId],
    );

    const result = await db.run(
      `UPDATE pledges
       SET txid = ?,
           status = ?,
           statusReason = ?,
           confirmedAt = ?
       WHERE pledgeId = ?`,
      [
        args.txid,
        args.status,
        args.statusReason ?? null,
        args.confirmedAt ?? null,
        args.pledgeId,
      ],
    );

    const updated = (result.changes ?? 0) > 0;
    if (!updated) {
      await db.exec('COMMIT');
      return null;
    }

    await db.run(
      'INSERT INTO audit_logs (campaignId, event, details) VALUES (?, ?, ?)',
      [
        pledge?.campaignId ?? null,
        mapVerificationEvent(args.status),
        JSON.stringify({
          pledgeId: args.pledgeId,
          txid: args.txid,
          status: args.status,
          statusReason: args.statusReason ?? null,
        }),
      ],
    );

    await db.exec('COMMIT');
    return getPledgeById(args.pledgeId);
  } catch (error) {
    await db.exec('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed: pledges.txid')) {
      throw new Error('txid-already-used');
    }
    throw error;
  }
}

export async function markPledgeRefunded(args: {
  pledgeId: string;
  refundTxid: string;
  refundedAt?: string;
}): Promise<SimplePledge | null> {
  const db = await getDb();
  await db.exec('BEGIN TRANSACTION');
  try {
    const pledge = await db.get<{ campaignId: string }>(
      'SELECT campaignId FROM pledges WHERE pledgeId = ?',
      [args.pledgeId],
    );

    const result = await db.run(
      `UPDATE pledges
       SET status = 'refunded',
           statusReason = NULL,
           refundTxid = ?,
           refundedAt = ?
       WHERE pledgeId = ?`,
      [args.refundTxid, args.refundedAt ?? new Date().toISOString(), args.pledgeId],
    );
    const updated = (result.changes ?? 0) > 0;
    if (!updated) {
      await db.exec('COMMIT');
      return null;
    }

    await db.run(
      'INSERT INTO audit_logs (campaignId, event, details) VALUES (?, ?, ?)',
      [
        pledge?.campaignId ?? null,
        'PLEDGE_REFUNDED',
        JSON.stringify({ pledgeId: args.pledgeId, refundTxid: args.refundTxid }),
      ],
    );

    await db.exec('COMMIT');
    return getPledgeById(args.pledgeId);
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}
