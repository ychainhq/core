/**
 * Integration tests — GET /v1/chains/tron/fees
 *
 * TRON node is not available in test env — tronFeeService is mocked to avoid
 * real HTTP calls. We test:
 *  1. Without params: 200 with general fee params
 *  2. With assetId+amount: 200 with full breakdown
 *  3. Without auth: 401
 *  4. Invalid assetId: 400
 *  5. Amount without assetId: general params (amount ignored alone)
 */
import request from 'supertest';
import { bootstrapApp, AUTH, teardownDb } from './helpers';
import { tronFeeService } from '../../src/modules/tron/tron-fee.service';

jest.mock('../../src/modules/tron/tron-fee.service', () => ({
  tronFeeService: {
    getGeneralFeeParams: jest.fn(),
    estimateFee:         jest.fn(),
    estimateFeeForAddress: jest.fn(),
    _zeroFeeEstimate:    jest.fn(),
    _clearCache:         jest.fn(),
  },
}));

const mockTronFeeService = tronFeeService as jest.Mocked<typeof tronFeeService>;

const GENERAL_PARAMS = {
  energyPriceSun: 420,
  bandwidthPriceSun: 1000,
  typical: {
    trxTransfer:  { feeSun: '185000', feeTrx: '0.185000' },
    usdtTransfer: { feeSun: '27300000', feeTrx: '27.300000' },
  },
  note: 'Typical estimates assume no staked resources.',
  timestamp: '2026-01-01T00:00:00.000Z',
};

const USDT_ESTIMATE = {
  estimatedFeeSun: '27300000',
  bandwidthCostSun: '285000',
  energyCostSun: '27300000',
  bandwidthNeeded: 285,
  bandwidthFreeRemaining: 0,
  energyNeeded: 65000,
  energyFreeRemaining: 0,
  energyPriceSun: 420,
  bandwidthPriceSun: 1000,
  recommendedFeeLimitSun: 40950000,
  hotWalletHasEnoughResources: false,
  assetId: 'tron:USDT',
};

const app = bootstrapApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockTronFeeService.getGeneralFeeParams.mockResolvedValue(GENERAL_PARAMS as any);
  mockTronFeeService.estimateFee.mockResolvedValue(USDT_ESTIMATE as any);
});

afterAll(() => teardownDb());

describe('GET /v1/chains/tron/fees — no params', () => {
  it('returns 200 with general fee parameters', async () => {
    const res = await request(app)
      .get('/v1/chains/tron/fees')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.chain).toBe('tron');
    expect(res.body.data.energyPriceSun).toBe(420);
    expect(res.body.data.bandwidthPriceSun).toBe(1000);
    expect(res.body.data.typical.usdtTransfer.feeSun).toBe('27300000');
    expect(mockTronFeeService.getGeneralFeeParams).toHaveBeenCalledTimes(1);
    expect(mockTronFeeService.estimateFee).not.toHaveBeenCalled();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/chains/tron/fees');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/chains/tron/fees — with assetId + amount', () => {
  it('returns 200 with full fee breakdown for tron:USDT', async () => {
    const res = await request(app)
      .get('/v1/chains/tron/fees?assetId=tron:USDT&amount=1000000')
      .set(AUTH);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.chain).toBe('tron');
    expect(d.assetId).toBe('tron:USDT');
    expect(d.estimatedFeeSun).toBeDefined();
    expect(d.estimatedFeeTrx).toBeDefined();
    expect(d.breakdown).toMatchObject({
      energyNeeded:   expect.any(Number),
      energyCostSun:  expect.any(String),
      bandwidthNeeded: expect.any(Number),
    });
    expect(d.feeLimitSun).toBeDefined();
    expect(d.hotWalletHasEnoughResources).toBeDefined();
    expect(mockTronFeeService.estimateFee).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with full fee breakdown for tron:TRX', async () => {
    mockTronFeeService.estimateFee.mockResolvedValue({
      ...USDT_ESTIMATE,
      assetId: 'tron:TRX',
      energyCostSun: '0',
      energyNeeded: 0,
      recommendedFeeLimitSun: 0,
    } as any);

    const res = await request(app)
      .get('/v1/chains/tron/fees?assetId=tron:TRX&amount=5000000')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.assetId).toBe('tron:TRX');
    expect(mockTronFeeService.estimateFee).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for invalid assetId', async () => {
    const res = await request(app)
      .get('/v1/chains/tron/fees?assetId=tron:ETH&amount=1000000')
      .set(AUTH);

    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer amount', async () => {
    const res = await request(app)
      .get('/v1/chains/tron/fees?assetId=tron:USDT&amount=1.5')
      .set(AUTH);

    expect(res.status).toBe(400);
  });

  it('falls back to general params when only amount is given (no assetId)', async () => {
    const res = await request(app)
      .get('/v1/chains/tron/fees?amount=1000000')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(mockTronFeeService.getGeneralFeeParams).toHaveBeenCalledTimes(1);
    expect(mockTronFeeService.estimateFee).not.toHaveBeenCalled();
  });
});
