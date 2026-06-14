/**
 * TRON-specific types for fee estimation.
 *
 * TRON has two independent fee components:
 *   Bandwidth — consumed by all transactions; 1000 sun/byte if not free/staked.
 *     Free daily allowance: 1500 BP/day per account.
 *     Staked bandwidth from frozen TRX covers the rest.
 *   Energy — consumed only by smart contract calls (TRC-20 transfers).
 *     No free energy; must stake TRX or burn TRX at current energy_price.
 *
 * fee_limit in triggersmartcontract is a SAFETY CAP on how much TRX can be
 * burned for energy in one tx — NOT the actual fee paid. Store it separately
 * from estimatedFeeSun (the actual predicted cost).
 */

export interface TronChainParams {
  energyPriceSun: number;   // sun/energy unit — from getchainparameters.getEnergyFee
  bandwidthPriceSun: number; // always 1000 sun/byte per protocol
}

export interface TronAccountResource {
  freeNetLimit: number;   // daily free bandwidth allowance (typically 1500)
  freeNetUsed: number;    // free bandwidth consumed today
  netLimit: number;       // staked bandwidth limit (0 if no staking)
  netUsed: number;        // staked bandwidth consumed today
  energyLimit: number;    // staked energy limit (0 if no staking)
  energyUsed: number;     // staked energy consumed today
}

export interface TronFeeEstimate {
  // Actual predicted cost — use as feeRaw in DB
  estimatedFeeSun: string;        // BigInt string, may be "0" if staked
  // Cost breakdown
  bandwidthCostSun: string;       // "0" if covered by free daily allowance or staking
  energyCostSun: string;          // "0" for TRX tx; "0" if fully staked for TRC-20
  // Resource usage
  bandwidthNeeded: number;        // tx size in bytes
  bandwidthFreeRemaining: number; // remaining free+staked bandwidth for today
  energyNeeded: number;           // energy units required (0 for TRX transfers)
  energyFreeRemaining: number;    // remaining staked energy for today
  // Pricing
  energyPriceSun: number;         // sun/unit (from chain params)
  bandwidthPriceSun: number;      // always 1000
  // Derived
  recommendedFeeLimitSun: number; // safety cap: energyNeeded * energyPrice * 1.5
  hotWalletHasEnoughResources: boolean; // true when estimatedFeeSun === "0"
  assetId: string;
}
