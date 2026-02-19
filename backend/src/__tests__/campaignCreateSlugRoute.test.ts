import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { makeTestDbPath } from './helpers/testDbPath';

vi.mock('chronik-client', () => ({
  ChronikClient: vi.fn().mockImplementation(() => ({
    blockchainInfo: vi.fn().mockResolvedValue({ tipHeight: 123 }),
  })),
}));

describe('campaign create + public slug lookup', () => {
  let dbPath = '';

  beforeEach(async () => {
    vi.resetModules();
    dbPath = makeTestDbPath();
    process.env.TEYOLIA_SQLITE_PATH = dbPath;
    process.env.CAMPAIGNS_DUAL_WRITE_JSON = '0';
    process.env.MIGRATE_ON_START = '0';
  });

  afterEach(() => {
    delete process.env.TEYOLIA_SQLITE_PATH;
    delete process.env.CAMPAIGNS_DUAL_WRITE_JSON;
    delete process.env.MIGRATE_ON_START;
    if (dbPath && fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it('returns 201 and allows fetching campaign by slug route id', async () => {
    const { default: app } = await import('../app');

    const createRes = await request(app)
      .post('/api/campaigns')
      .send({
        id: 'client-temp-id',
        name: 'Campaign from API',
        goal: 1200,
        expiresAt: '2027-01-01T00:00:00.000Z',
        beneficiaryAddress: 'ecash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqu08dsy2',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBeTypeOf('string');
    expect(createRes.body.id).not.toBe('client-temp-id');
    expect(createRes.body.slug).toBeTypeOf('string');

    const getBySlugRes = await request(app).get(`/api/campaigns/${createRes.body.slug}`);
    expect(getBySlugRes.status).toBe(200);
    expect(getBySlugRes.body).toMatchObject({
      id: createRes.body.id,
      canonicalId: createRes.body.id,
      slug: createRes.body.slug,
    });
  });
});
