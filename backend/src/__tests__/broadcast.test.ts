import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

// P7A-07: la ruta está apagada por defecto (ENABLE_PUBLIC_BROADCAST, solo 'true' exacto); este test
// cubre la ruta habilitada y restaura el valor previo.
const previousPublicBroadcast = process.env.ENABLE_PUBLIC_BROADCAST;

afterEach(() => {
  if (previousPublicBroadcast === undefined) delete process.env.ENABLE_PUBLIC_BROADCAST;
  else process.env.ENABLE_PUBLIC_BROADCAST = previousPublicBroadcast;
});

beforeEach(() => {
  vi.resetModules();
  process.env.ENABLE_PUBLIC_BROADCAST = 'true';
  process.env.E_CASH_BACKEND = 'chronik';
  process.env.CHRONIK_BASE_URL = 'https://chronik.example';
  process.env.ALLOWED_ORIGIN = '*';
});

vi.mock('../blockchain/ecashClient', () => ({
  broadcastTx: vi.fn().mockResolvedValue({ txid: 'mock-txid' }),
}));

describe('/api/tx/broadcast', () => {
  it('broadcasts a signed tx hex', async () => {
    const { handleBroadcast } = await import('../routes/broadcast.routes');
    const res = createMockRes();
    await handleBroadcast({ body: { rawTxHex: '00'.repeat(10) } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      txid: 'mock-txid',
      backendMode: 'chronik',
      message: 'broadcasted',
    });
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
