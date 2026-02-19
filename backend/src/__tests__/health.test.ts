import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env.E_CASH_BACKEND = 'chronik';
  process.env.CHRONIK_BASE_URL = 'https://chronik.example';
  process.env.ALLOWED_ORIGIN = '*';
});

vi.mock('chronik-client', () => ({
  ChronikClient: vi.fn().mockImplementation(() => ({
    blockchainInfo: vi.fn().mockResolvedValue({ tipHeight: 123 }),
  })),
}));

describe('/api/health', () => {
  it('returns chronik health shape with tipHeight', async () => {
    const { healthHandler } = await import('../app');
    const res = createMockRes();
    await healthHandler({} as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      backendMode: 'chronik',
      chronikBaseUrl: 'https://chronik.example',
      tipHeight: 123,
    });
    expect(typeof res.body.timestamp).toBe('string');
  });
});

function createMockRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    header(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}


describe('/api/version', () => {
  it('returns build and runtime diagnostics', async () => {
    const { versionHandler } = await import('../app');
    const res = createMockRes();
    process.env.GIT_COMMIT_HASH = 'abc1234';
    process.env.name = 'pm2-process';
    versionHandler({} as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      gitCommit: 'abc1234',
      processName: 'pm2-process',
      chronikUrl: 'https://chronik.example',
    });
  });
});
