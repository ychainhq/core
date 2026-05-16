/**
 * Money utilities for handling Bitcoin amounts safely.
 * IMPORTANT: Never use floating point for monetary amounts.
 * All internal storage uses satoshi as bigint / string.
 */

const SATOSHI_PER_BTC = BigInt(100_000_000);

/**
 * Convert satoshi (as bigint or numeric string) to BTC string with 8 decimal places.
 */
export function satoshiToBtc(satoshi: bigint | string): string {
  const sat = typeof satoshi === 'string' ? BigInt(satoshi) : satoshi;
  const negative = sat < BigInt(0);
  const absSat = negative ? -sat : sat;

  const btcPart = absSat / SATOSHI_PER_BTC;
  const satPart = absSat % SATOSHI_PER_BTC;

  const satStr = satPart.toString().padStart(8, '0');
  const result = `${btcPart}.${satStr}`;
  return negative ? `-${result}` : result;
}

/**
 * Convert BTC string to satoshi as bigint.
 * Handles strings like "0.001", "1.5", "0.00000001"
 */
export function btcToSatoshi(btc: string): bigint {
  const trimmed = btc.trim();
  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;

  if (!abs || abs.trim() === '') {
    throw new Error(`Invalid BTC amount: ${btc}`);
  }

  const parts = abs.split('.');
  if (parts.length > 2) {
    throw new Error(`Invalid BTC amount: ${btc}`);
  }

  const intPart = parts[0] || '0';
  const fracPart = (parts[1] || '').padEnd(8, '0').slice(0, 8);

  if (!/^\d+$/.test(intPart) || !/^\d+$/.test(fracPart)) {
    throw new Error(`Invalid BTC amount: ${btc}`);
  }

  const satoshi = BigInt(intPart) * SATOSHI_PER_BTC + BigInt(fracPart);
  return negative ? -satoshi : satoshi;
}

/**
 * Format raw amount (as string in smallest unit) to display amount with given decimals.
 */
export function formatAmount(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const negative = value < BigInt(0);
  const absValue = negative ? -value : value;

  const divisor = BigInt(10) ** BigInt(decimals);
  const intPart = absValue / divisor;
  const fracPart = absValue % divisor;
  const fracStr = fracPart.toString().padStart(decimals, '0');

  const result = decimals > 0 ? `${intPart}.${fracStr}` : intPart.toString();
  return negative ? `-${result}` : result;
}

/**
 * Add two satoshi amounts (as strings).
 */
export function addSatoshi(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

/**
 * Subtract b from a (satoshi strings). Returns signed result.
 */
export function subtractSatoshi(a: string, b: string): string {
  return (BigInt(a) - BigInt(b)).toString();
}

/**
 * Compare two satoshi amounts (as strings). Returns -1, 0, or 1.
 */
export function compareSatoshi(a: string, b: string): number {
  const bigA = BigInt(a);
  const bigB = BigInt(b);
  if (bigA < bigB) return -1;
  if (bigA > bigB) return 1;
  return 0;
}
