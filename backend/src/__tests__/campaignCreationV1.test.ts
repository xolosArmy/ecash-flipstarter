import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { CampaignService } from '../services/CampaignService';
import { getCampaignById } from '../db/SQLiteStore';
import { makeTestDbPath } from './helpers/testDbPath';
import { TEYOLIA_COVENANT_V1 } from '../covenants/scriptCompiler';

const BENEFICIARY_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';
const REFUND_ORACLE_PUBKEY = `03${'22'.repeat(32)}`;
const BENEFICIARY_PRIVKEY = '12'.repeat(32);
const BENEFICIARY_PUBKEY_FROM_PRIVKEY = Buffer.from(
  secp256k1.getPublicKey(Buffer.from(BENEFICIARY_PRIVKEY, 'hex'), true),
).toString('hex');

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

beforeAll(() => {
  process.env.TEYOLIA_SQLITE_PATH = makeTestDbPath();
});

afterAll(() => {
  delete process.env.TEYOLIA_SQLITE_PATH;
  delete process.env.TEYOLIA_REFUND_ORACLE_PUBKEY;
  delete process.env.REFUND_ORACLE_PUBKEY;
  delete process.env.TEYOLIA_BENEFICIARY_PUBKEY;
  delete process.env.BENEFICIARY_PUBKEY;
  delete process.env.TEYOLIA_BENEFICIARY_SEED;
  delete process.env.BENEFICIARY_SEED;
  delete process.env.TEYOLIA_BENEFICIARY_PRIVKEY;
  delete process.env.BENEFICIARY_PRIVKEY;
});

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.TEYOLIA_BENEFICIARY_PUBKEY;
  delete process.env.BENEFICIARY_PUBKEY;
  delete process.env.TEYOLIA_BENEFICIARY_SEED;
  delete process.env.BENEFICIARY_SEED;
  delete process.env.TEYOLIA_BENEFICIARY_PRIVKEY;
  delete process.env.BENEFICIARY_PRIVKEY;
  process.env.TEYOLIA_REFUND_ORACLE_PUBKEY = REFUND_ORACLE_PUBKEY;
});

describe('CampaignService V1 creation', () => {
  it('persists real V1 covenant fields in SQLite when beneficiaryPubKey is provided in payload', async () => {
    const service = new CampaignService();
    const campaignId = uniqueId('v1-payload-pubkey');

    await service.createCampaign({
      id: campaignId,
      name: 'Payload pubkey campaign',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: BENEFICIARY_ADDRESS,
      beneficiaryPubKey: BENEFICIARY_PUBKEY_FROM_PRIVKEY.toUpperCase(),
      contractVersion: TEYOLIA_COVENANT_V1,
    });

    const stored = await getCampaignById(campaignId);
    expect(stored).not.toBeNull();
    expect(stored?.contractVersion).toBe(TEYOLIA_COVENANT_V1);
    expect(stored?.beneficiaryPubKey).toBe(BENEFICIARY_PUBKEY_FROM_PRIVKEY);
    expect(stored?.redeemScriptHex).toMatch(/^[0-9a-f]+$/);
    expect(stored?.scriptHash).toMatch(/^[0-9a-f]{40}$/);
    expect(stored?.scriptPubKey).toMatch(/^a914[0-9a-f]{40}87$/);
    expect(stored?.constructorArgs?.beneficiaryPubKey).toBe(BENEFICIARY_PUBKEY_FROM_PRIVKEY);
  });

  it('derives beneficiaryPubKey from env private key for V1 campaigns', async () => {
    process.env.TEYOLIA_BENEFICIARY_PRIVKEY = BENEFICIARY_PRIVKEY;
    const service = new CampaignService();
    const campaignId = uniqueId('v1-env-privkey');

    await service.createCampaign({
      id: campaignId,
      name: 'Env privkey campaign',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: BENEFICIARY_ADDRESS,
      contractVersion: TEYOLIA_COVENANT_V1,
    });

    const stored = await getCampaignById(campaignId);
    expect(stored?.contractVersion).toBe(TEYOLIA_COVENANT_V1);
    expect(stored?.beneficiaryPubKey).toBe(BENEFICIARY_PUBKEY_FROM_PRIVKEY);
    expect(stored?.constructorArgs?.beneficiaryPubKey).toBe(BENEFICIARY_PUBKEY_FROM_PRIVKEY);
  });

  it('fails clearly instead of silently falling back to legacy when V1 lacks a real beneficiary pubkey', async () => {
    const service = new CampaignService();

    await expect(service.createCampaign({
      id: uniqueId('v1-missing-pubkey'),
      name: 'Missing pubkey campaign',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: BENEFICIARY_ADDRESS,
      contractVersion: TEYOLIA_COVENANT_V1,
    })).rejects.toThrow('missing-beneficiary-pubkey-for-v1');
  });
});
