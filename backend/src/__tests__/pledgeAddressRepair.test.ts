import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDbPath } from './helpers/testDbPath';

const CONTRIBUTOR_ADDRESS = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
const BENEFICIARY_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

vi.mock('../blockchain/ecashClient', async () => {
  const actual = await vi.importActual<typeof import('../blockchain/ecashClient')>('../blockchain/ecashClient');
  return {
    ...actual,
    getUtxosForAddress: vi.fn(async () => [
      {
        txid: 'a'.repeat(64),
        vout: 0,
        value: 2_000_000n,
        scriptPubKey: '76a9148f56f7f9f0e5f5f2dc94f8ea4636e2bdb75a1a8a88ac',
      },
    ]),
    addressToScriptPubKey: vi.fn(async (address: string) => {
      if (address.startsWith('ecash:qq')) {
        return '76a9149f56f7f9f0e5f5f2dc94f8ea4636e2bdb75a1a8a88ac';
      }
      return '76a9148f56f7f9f0e5f5f2dc94f8ea4636e2bdb75a1a8a88ac';
    }),
  };
});

beforeAll(() => {
  process.env.TEYOLIA_SQLITE_PATH = makeTestDbPath();
});

afterAll(() => {
  delete process.env.TEYOLIA_SQLITE_PATH;
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('pledge covenant auto-repair', () => {
  it('repairs missing campaign address for active campaign before building pledge', async () => {
    const { CampaignService } = await import('../services/CampaignService');
    const { openDatabase, initializeDatabase } = await import('../db/SQLiteStore');
    const campaignId = uniqueId('pledge-repair');
    const service = new CampaignService();

    await service.createCampaign({
      id: campaignId,
      name: 'Legacy active campaign',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 3 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: BENEFICIARY_ADDRESS,
    });
    await service.markActivationFeePaid(campaignId, 'f'.repeat(64));

    const db = await openDatabase();
    await initializeDatabase(db);
    await db.run(
      'UPDATE campaigns SET campaignAddress = NULL, covenantAddress = NULL WHERE id = ?',
      [campaignId],
    );

    vi.resetModules();
    const pledgeRoutes = (await import('../routes/pledge.routes')) as typeof import('../routes/pledge.routes');
    const createPledgeHandler = pledgeRoutes.createPledgeHandler;

    const pledgeRes = createMockRes();
    await createPledgeHandler(
      {
        params: { id: campaignId },
        body: {
          contributorAddress: CONTRIBUTOR_ADDRESS,
          amount: '1000',
        },
      } as any,
      pledgeRes as any,
    );

    expect(pledgeRes.statusCode).toBe(200);
    expect(pledgeRes.body.error).toBeUndefined();
    expect(pledgeRes.body.wcOfferId).toBeTruthy();

    const { CampaignService: RefreshedCampaignService } = await import('../services/CampaignService');
    const refreshedService = new RefreshedCampaignService();
    const repaired = await refreshedService.getCampaign(campaignId);
    expect(repaired?.status).toBe('active');
    expect(repaired?.covenant?.campaignAddress).toMatch(/^ecash:/i);
    expect(repaired?.covenant?.scriptHash).toMatch(/^[0-9a-f]{40}$/i);
    expect(repaired?.covenant?.scriptPubKey).toMatch(/^a914[0-9a-f]{40}87$/i);
    expect(repaired?.covenant?.scriptHash).not.toBe('hash-placeholder');
    expect(repaired?.covenant?.scriptPubKey).not.toBe('51');
  });
});

function createMockRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
}
