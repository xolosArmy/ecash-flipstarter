import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCampaignMock = vi.fn();
const setActivationOfferMock = vi.fn();
const recordActivationFeeBroadcastMock = vi.fn();
const finalizeActivationFeeVerificationMock = vi.fn();
const createOfferMock = vi.fn().mockReturnValue({
  offerId: 'offer-123',
});
const getPledgesByCampaignMock = vi.fn().mockResolvedValue([]);

vi.mock('../services/CampaignService', () => ({
  CampaignService: class {
    getCampaign = getCampaignMock;
    setActivationOffer = setActivationOfferMock;
    recordActivationFeeBroadcast = recordActivationFeeBroadcastMock;
    finalizeActivationFeeVerification = finalizeActivationFeeVerificationMock;
  },
}));

vi.mock('../blockchain/ecashClient', () => ({
  getUtxosForAddress: vi.fn(),
  addressToScriptPubKey: vi.fn(),
  getTransactionInfo: vi.fn(),
}));

vi.mock('../blockchain/txBuilder', () => ({
  buildPayoutTx: vi.fn(),
}));

vi.mock('../store/simplePledges', () => ({
  getPledgesByCampaign: getPledgesByCampaignMock,
}));

vi.mock('../services/WalletConnectOfferStore', () => ({
  walletConnectOfferStore: {
    createOffer: createOfferMock,
  },
}));

const BASE_CAMPAIGN = {
  id: 'camp-1',
  name: 'Campaign',
  goal: '1000',
  expirationTime: String(Date.now() + 86_400_000),
  beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
  activationFeeRequired: 800000,
  activationFeePaid: false,
  activationFeeVerificationStatus: 'none',
  status: 'pending_fee',
};

beforeEach(() => {
  vi.clearAllMocks();
  createOfferMock.mockReturnValue({ offerId: 'offer-123' });
  getPledgesByCampaignMock.mockResolvedValue([]);
  getCampaignMock.mockResolvedValue(BASE_CAMPAIGN);
});

describe('buildActivationHandler', () => {
  it('returns intent outputs and persists activation offer', async () => {
    const { buildActivationHandler } = (await import('../routes/campaigns.routes')) as {
      buildActivationHandler: (req: any, res: any) => Promise<void>;
    };
    const req = {
      params: { id: 'camp-1' },
      body: { payerAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk' },
    };
    const res = createMockRes();

    await buildActivationHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.mode).toBe('intent');
    expect(res.body.outputs).toEqual([
      {
        address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
        valueSats: 80000000,
      },
    ]);
    expect(setActivationOfferMock).toHaveBeenCalledWith(
      'camp-1',
      'offer-123',
      'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
      {
        mode: 'intent',
        outputs: [
          {
            address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
            valueSats: 80000000,
          },
        ],
        treasuryAddressUsed: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
        logAuditEvent: true,
      },
    );
  });

  it('reuses persisted activation intent without creating a new offer/audit spam', async () => {
    const { buildActivationHandler } = (await import('../routes/campaigns.routes')) as {
      buildActivationHandler: (req: any, res: any) => Promise<void>;
    };
    getCampaignMock.mockResolvedValue({
      ...BASE_CAMPAIGN,
      activationOfferMode: 'intent',
      activationOfferOutputs: [
        {
          address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
          valueSats: 80000000,
        },
      ],
      activation: {
        feeSats: '80000000',
        wcOfferId: 'persisted-offer',
      },
    });

    const req = {
      params: { id: 'camp-1' },
      body: { payerAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk' },
    };
    const res = createMockRes();

    await buildActivationHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.wcOfferId).toBe('persisted-offer');
    expect(createOfferMock).not.toHaveBeenCalled();
    expect(setActivationOfferMock).not.toHaveBeenCalled();
  });
});

describe('confirmActivationHandler', () => {
  it('activates campaign only when chronik confirms treasury output and confirmation', async () => {
    const { confirmActivationHandler } = (await import('../routes/campaigns.routes')) as {
      confirmActivationHandler: (req: any, res: any) => Promise<void>;
    };
    const ecashClient = await import('../blockchain/ecashClient');
    vi.mocked(ecashClient.addressToScriptPubKey).mockResolvedValue('76a914abcd');
    vi.mocked(ecashClient.getTransactionInfo).mockResolvedValue({
      txid: 'a'.repeat(64),
      confirmations: 2,
      height: 900000,
      outputs: [{ scriptPubKey: '76a914abcd', valueSats: 80000000n }],
    });
    getCampaignMock
      .mockResolvedValueOnce(BASE_CAMPAIGN)
      .mockResolvedValueOnce({
        ...BASE_CAMPAIGN,
        status: 'active',
        activationFeePaid: true,
        activationFeeVerificationStatus: 'verified',
        activationFeeTxid: 'a'.repeat(64),
      });

    const req = {
      params: { id: 'camp-1' },
      body: { txid: 'a'.repeat(64), payerAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk' },
    };
    const res = createMockRes();

    await confirmActivationHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.activationFeePaid).toBe(true);
    expect(res.body.verificationStatus).toBe('verified');
    expect(recordActivationFeeBroadcastMock).toHaveBeenCalledTimes(1);
    expect(finalizeActivationFeeVerificationMock).toHaveBeenCalledWith(
      'camp-1',
      'a'.repeat(64),
      'verified',
      expect.any(Object),
    );
  });

  it('keeps pending_verification when tx is still in mempool', async () => {
    const { confirmActivationHandler } = (await import('../routes/campaigns.routes')) as {
      confirmActivationHandler: (req: any, res: any) => Promise<void>;
    };
    const ecashClient = await import('../blockchain/ecashClient');
    vi.mocked(ecashClient.addressToScriptPubKey).mockResolvedValue('76a914abcd');
    vi.mocked(ecashClient.getTransactionInfo).mockResolvedValue({
      txid: 'b'.repeat(64),
      confirmations: 0,
      height: -1,
      outputs: [{ scriptPubKey: '76a914abcd', valueSats: 80000000n }],
    });
    getCampaignMock
      .mockResolvedValueOnce(BASE_CAMPAIGN)
      .mockResolvedValueOnce({
        ...BASE_CAMPAIGN,
        status: 'pending_verification',
        activationFeePaid: false,
        activationFeeVerificationStatus: 'pending_verification',
        activationFeeTxid: 'b'.repeat(64),
      });

    const req = {
      params: { id: 'camp-1' },
      body: { txid: 'b'.repeat(64) },
    };
    const res = createMockRes();

    await confirmActivationHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('pending_verification');
    expect(res.body.activationFeePaid).toBe(false);
    expect(res.body.verificationStatus).toBe('pending_verification');
    expect(finalizeActivationFeeVerificationMock).toHaveBeenCalledWith(
      'camp-1',
      'b'.repeat(64),
      'pending_verification',
      expect.any(Object),
    );
  });

  it('marks invalid and returns pending_fee when tx does not pay required treasury output', async () => {
    const { confirmActivationHandler } = (await import('../routes/campaigns.routes')) as {
      confirmActivationHandler: (req: any, res: any) => Promise<void>;
    };
    const ecashClient = await import('../blockchain/ecashClient');
    vi.mocked(ecashClient.addressToScriptPubKey).mockResolvedValue('76a914abcd');
    vi.mocked(ecashClient.getTransactionInfo).mockResolvedValue({
      txid: 'c'.repeat(64),
      confirmations: 1,
      height: 900000,
      outputs: [{ scriptPubKey: '76a914ffff', valueSats: 1000n }],
    });

    getCampaignMock
      .mockResolvedValueOnce(BASE_CAMPAIGN)
      .mockResolvedValueOnce({
        ...BASE_CAMPAIGN,
        status: 'pending_fee',
        activationFeePaid: false,
        activationFeeVerificationStatus: 'invalid',
        activationFeeTxid: 'c'.repeat(64),
      });

    const req = {
      params: { id: 'camp-1' },
      body: { txid: 'c'.repeat(64) },
    };
    const res = createMockRes();

    await confirmActivationHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('pending_fee');
    expect(res.body.verificationStatus).toBe('invalid');
    expect(res.body.txid).toBe('c'.repeat(64));
    expect(res.body.warning).toBe('activation-fee-output-mismatch');
    expect(finalizeActivationFeeVerificationMock).toHaveBeenCalledWith(
      'camp-1',
      'c'.repeat(64),
      'invalid',
      expect.objectContaining({ reason: 'activation-fee-output-mismatch' }),
    );
  });

  it('keeps pending_verification and returns warning when chronik is down', async () => {
    const { confirmActivationHandler } = (await import('../routes/campaigns.routes')) as {
      confirmActivationHandler: (req: any, res: any) => Promise<void>;
    };
    const ecashClient = await import('../blockchain/ecashClient');
    vi.mocked(ecashClient.addressToScriptPubKey).mockRejectedValue(new Error('chronik-down'));
    getCampaignMock
      .mockResolvedValueOnce(BASE_CAMPAIGN)
      .mockResolvedValueOnce({
        ...BASE_CAMPAIGN,
        status: 'pending_verification',
        activationFeePaid: false,
        activationFeeVerificationStatus: 'pending_verification',
        activationFeeTxid: 'd'.repeat(64),
      });

    const req = {
      params: { id: 'camp-1' },
      body: { txid: 'd'.repeat(64) },
    };
    const res = createMockRes();

    await confirmActivationHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('pending_verification');
    expect(res.body.verificationStatus).toBe('pending_verification');
    expect(res.body.warning).toBe('chronik-unavailable');
    expect(finalizeActivationFeeVerificationMock).toHaveBeenCalledWith(
      'camp-1',
      'd'.repeat(64),
      'pending_verification',
      expect.any(Object),
    );
  });

  it('is idempotent for same verified txid and does not duplicate transition calls', async () => {
    const { confirmActivationHandler } = (await import('../routes/campaigns.routes')) as {
      confirmActivationHandler: (req: any, res: any) => Promise<void>;
    };
    getCampaignMock.mockResolvedValue({
      ...BASE_CAMPAIGN,
      status: 'active',
      activationFeePaid: true,
      activationFeeTxid: 'e'.repeat(64),
      activationFeeVerificationStatus: 'verified',
    });

    const req = {
      params: { id: 'camp-1' },
      body: { txid: 'e'.repeat(64) },
    };
    const res = createMockRes();

    await confirmActivationHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.verificationStatus).toBe('verified');
    expect(res.body.txid).toBe('e'.repeat(64));
    expect(recordActivationFeeBroadcastMock).not.toHaveBeenCalled();
    expect(finalizeActivationFeeVerificationMock).not.toHaveBeenCalled();
  });
});

describe('activationStatusHandler', () => {
  it('keeps pending_verification when tx is still unconfirmed', async () => {
    const { activationStatusHandler } = (await import('../routes/campaigns.routes')) as {
      activationStatusHandler: (req: any, res: any) => Promise<void>;
    };
    const ecashClient = await import('../blockchain/ecashClient');
    vi.mocked(ecashClient.addressToScriptPubKey).mockResolvedValue('76a914abcd');
    vi.mocked(ecashClient.getTransactionInfo).mockResolvedValue({
      txid: 'f'.repeat(64),
      confirmations: 0,
      height: -1,
      outputs: [{ scriptPubKey: '76a914abcd', valueSats: 80000000n }],
    });
    getCampaignMock
      .mockResolvedValueOnce({
        ...BASE_CAMPAIGN,
        status: 'pending_verification',
        activationFeeVerificationStatus: 'pending_verification',
        activationFeeTxid: 'f'.repeat(64),
      })
      .mockResolvedValueOnce({
        ...BASE_CAMPAIGN,
        status: 'pending_verification',
        activationFeeVerificationStatus: 'pending_verification',
        activationFeeTxid: 'f'.repeat(64),
      });

    const req = { params: { id: 'camp-1' } };
    const res = createMockRes();
    await activationStatusHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('pending_verification');
    expect(res.body.verificationStatus).toBe('pending_verification');
    expect(res.body.txid).toBe('f'.repeat(64));
  });

  it('promotes campaign to active when confirmations reach 1+', async () => {
    const { activationStatusHandler } = (await import('../routes/campaigns.routes')) as {
      activationStatusHandler: (req: any, res: any) => Promise<void>;
    };
    const ecashClient = await import('../blockchain/ecashClient');
    vi.mocked(ecashClient.addressToScriptPubKey).mockResolvedValue('76a914abcd');
    vi.mocked(ecashClient.getTransactionInfo).mockResolvedValue({
      txid: '1'.repeat(64),
      confirmations: 1,
      height: 900001,
      outputs: [{ scriptPubKey: '76a914abcd', valueSats: 80000000n }],
    });
    getCampaignMock
      .mockResolvedValueOnce({
        ...BASE_CAMPAIGN,
        status: 'pending_verification',
        activationFeeVerificationStatus: 'pending_verification',
        activationFeeTxid: '1'.repeat(64),
      })
      .mockResolvedValueOnce({
        ...BASE_CAMPAIGN,
        status: 'active',
        activationFeePaid: true,
        activationFeeVerificationStatus: 'verified',
        activationFeeTxid: '1'.repeat(64),
      });

    const req = { params: { id: 'camp-1' } };
    const res = createMockRes();
    await activationStatusHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.verificationStatus).toBe('verified');
    expect(finalizeActivationFeeVerificationMock).toHaveBeenCalledWith(
      'camp-1',
      '1'.repeat(64),
      'verified',
      expect.any(Object),
    );
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
