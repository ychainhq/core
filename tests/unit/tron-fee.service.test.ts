/**
 * Unit tests — tronFeeService (tron-fee.service.ts)
 *
 * Covers:
 * - No staked resources: full bandwidth + energy cost
 * - Bandwidth fully staked: bandwidthCostSun=0
 * - Energy fully staked: energyCostSun=0
 * - Both staked: estimatedFeeSun=0, hotWalletHasEnoughResources=true
 * - TRX transfer (energyNeeded=0, no energyCostSun)
 * - getGeneralFeeParams: returns typical estimates
 * - recommendedFeeLimitSun = energyNeeded × price × 1.5, min 10 TRX
 * - _zeroFeeEstimate: returns safe defaults
 *
 * TronRpcClient is mocked at the module level — no real TRON node required.
 */

// ── Mock TronRpcClient before importing the service ───────────────────────────

const mockGetChainParameters = jest.fn();
const mockGetAccountResource  = jest.fn();
const mockSimulateTrc20Transfer = jest.fn();
const mockCreateUnsignedTrxTransfer = jest.fn();

jest.mock('../../src/chain-adapters/tron/rpc-client', () => ({
  TronRpcClient: jest.fn().mockImplementation(() => ({
    getChainParameters: mockGetChainParameters,
    getAccountResource:  mockGetAccountResource,
    simulateTrc20Transfer: mockSimulateTrc20Transfer,
    createUnsignedTrxTransfer: mockCreateUnsignedTrxTransfer,
  })),
}));

jest.mock('../../src/chain-adapters/node-selector', () => ({
  NodeSelector: jest.fn().mockImplementation(() => ({})),
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

import { tronFeeService } from '../../src/modules/tron/tron-fee.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FROM = 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN';
const TO   = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const CHAIN_PARAMS = { energyPriceSun: 420, bandwidthPriceSun: 1000 };

const RESOURCE_EMPTY = {
  freeNetLimit: 1500, freeNetUsed: 1500, // free BP exhausted
  netLimit: 0,  netUsed: 0,
  energyLimit: 0, energyUsed: 0,
};

const RESOURCE_BP_STAKED = {
  freeNetLimit: 1500, freeNetUsed: 0,
  netLimit: 100_000, netUsed: 0,
  energyLimit: 0, energyUsed: 0,
};

const RESOURCE_ENERGY_STAKED = {
  freeNetLimit: 1500, freeNetUsed: 1500,
  netLimit: 0, netUsed: 0,
  energyLimit: 1_000_000, energyUsed: 0,
};

const RESOURCE_BOTH_STAKED = {
  freeNetLimit: 1500, freeNetUsed: 0,
  netLimit: 100_000, netUsed: 0,
  energyLimit: 1_000_000, energyUsed: 0,
};

function setupMocks(opts: {
  resource?: typeof RESOURCE_EMPTY;
  energyUsed?: number;
  txSizeBytes?: number;
}) {
  const resource    = opts.resource    ?? RESOURCE_EMPTY;
  const energyUsed  = opts.energyUsed  ?? 65_000;
  const txSizeBytes = opts.txSizeBytes ?? 285;

  mockGetChainParameters.mockResolvedValue(CHAIN_PARAMS);
  mockGetAccountResource.mockResolvedValue(resource);
  mockSimulateTrc20Transfer.mockResolvedValue({ energyUsed, txSizeBytes });
  mockCreateUnsignedTrxTransfer.mockResolvedValue({
    raw_data_hex: 'aa'.repeat(txSizeBytes),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  tronFeeService._clearCache();
  jest.clearAllMocks();
});

describe('tronFeeService.estimateFeeForAddress — TRC-20 (USDT)', () => {
  it('no staking: charges full bandwidth + energy cost', async () => {
    setupMocks({ resource: RESOURCE_EMPTY, energyUsed: 65_000, txSizeBytes: 285 });

    const estimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: FROM, assetId: 'tron:USDT', toAddress: TO,
      amountRaw: '1000000', contractAddress: CONTRACT,
    });

    expect(BigInt(estimate.bandwidthCostSun)).toBe(BigInt(285) * 1000n);
    expect(BigInt(estimate.energyCostSun)).toBe(BigInt(65_000) * 420n);
    const expectedTotal = BigInt(285) * 1000n + BigInt(65_000) * 420n;
    expect(BigInt(estimate.estimatedFeeSun)).toBe(expectedTotal);
    expect(estimate.hotWalletHasEnoughResources).toBe(false);
  });

  it('bandwidth staked: bandwidthCostSun=0, only energy charged', async () => {
    setupMocks({ resource: RESOURCE_BP_STAKED, energyUsed: 65_000, txSizeBytes: 285 });

    const estimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: FROM, assetId: 'tron:USDT', toAddress: TO,
      amountRaw: '1000000', contractAddress: CONTRACT,
    });

    expect(estimate.bandwidthCostSun).toBe('0');
    expect(BigInt(estimate.energyCostSun)).toBe(BigInt(65_000) * 420n);
    expect(estimate.hotWalletHasEnoughResources).toBe(false);
  });

  it('energy staked: energyCostSun=0, only bandwidth charged', async () => {
    setupMocks({ resource: RESOURCE_ENERGY_STAKED, energyUsed: 65_000, txSizeBytes: 285 });

    const estimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: FROM, assetId: 'tron:USDT', toAddress: TO,
      amountRaw: '1000000', contractAddress: CONTRACT,
    });

    expect(estimate.energyCostSun).toBe('0');
    expect(BigInt(estimate.bandwidthCostSun)).toBe(BigInt(285) * 1000n);
    expect(estimate.hotWalletHasEnoughResources).toBe(false);
  });

  it('both staked: estimatedFeeSun=0, hotWalletHasEnoughResources=true', async () => {
    setupMocks({ resource: RESOURCE_BOTH_STAKED, energyUsed: 65_000, txSizeBytes: 285 });

    const estimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: FROM, assetId: 'tron:USDT', toAddress: TO,
      amountRaw: '1000000', contractAddress: CONTRACT,
    });

    expect(estimate.estimatedFeeSun).toBe('0');
    expect(estimate.bandwidthCostSun).toBe('0');
    expect(estimate.energyCostSun).toBe('0');
    expect(estimate.hotWalletHasEnoughResources).toBe(true);
  });

  it('recommendedFeeLimitSun = energyNeeded × price × 1.5, minimum 10 TRX', async () => {
    setupMocks({ resource: RESOURCE_EMPTY, energyUsed: 65_000 });

    const estimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: FROM, assetId: 'tron:USDT', toAddress: TO,
      amountRaw: '1000000', contractAddress: CONTRACT,
    });

    // 65000 × 420 × 1.5 = 40_950_000 > MIN_FEE_LIMIT_SUN (10_000_000)
    expect(estimate.recommendedFeeLimitSun).toBe(Math.ceil(65_000 * 420 * 1.5));
    expect(estimate.recommendedFeeLimitSun).toBeGreaterThanOrEqual(10_000_000);
  });
});

describe('tronFeeService.estimateFeeForAddress — TRX native transfer', () => {
  it('no energy cost, only bandwidth; recommendedFeeLimitSun=0', async () => {
    setupMocks({ resource: RESOURCE_EMPTY, txSizeBytes: 185 });

    const estimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: FROM, assetId: 'tron:TRX', toAddress: TO,
      amountRaw: '5000000',
    });

    expect(estimate.energyCostSun).toBe('0');
    expect(estimate.energyNeeded).toBe(0);
    expect(estimate.recommendedFeeLimitSun).toBe(0);
    expect(BigInt(estimate.bandwidthCostSun)).toBe(BigInt(185) * 1000n);
  });
});

describe('tronFeeService.getGeneralFeeParams', () => {
  it('returns energy price, bandwidth price and typical estimates', async () => {
    mockGetChainParameters.mockResolvedValue({ energyPriceSun: 420, bandwidthPriceSun: 1000 });

    const result = await tronFeeService.getGeneralFeeParams();

    expect(result.energyPriceSun).toBe(420);
    expect(result.bandwidthPriceSun).toBe(1000);
    // usdtTransfer typical = 65000 × 420 = 27 300 000 sun
    expect(result.typical.usdtTransfer.feeSun).toBe((65_000n * 420n).toString());
    expect(result.typical.trxTransfer.feeSun).toBeDefined();
  });
});

describe('tronFeeService._zeroFeeEstimate', () => {
  it('returns safe zero-cost estimate with min fee_limit', () => {
    const estimate = tronFeeService._zeroFeeEstimate('tron:USDT');
    expect(estimate.estimatedFeeSun).toBe('0');
    expect(estimate.hotWalletHasEnoughResources).toBe(true);
    expect(estimate.recommendedFeeLimitSun).toBe(10_000_000);
    expect(estimate.assetId).toBe('tron:USDT');
  });
});
