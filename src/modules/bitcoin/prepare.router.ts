import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { adapterRegistry } from '../../chain-adapters/registry';
import { getDb } from '../../db/sqlite';
import { ValidationError, UnprocessableEntityError } from '../../shared/errors/index';
import { satoshiToBtc, btcToSatoshi } from '../../shared/money/index';
import { validateRawTransaction, validatePsbt } from '../../shared/validation/bitcoin';

export const prepareRouter = Router();

// Estimated sizes in vbytes for common output types
const INPUT_SIZE = 68;    // P2WPKH input
const OUTPUT_SIZE = 31;   // P2WPKH output
const TX_OVERHEAD = 10;   // version, locktime, segwit marker

interface CoinSelectionInput {
  fromAddresses: string[];
  outputs: Array<{ address: string; amount: string }>;
  feeRate: number;
  changeAddress: string;
}

interface SelectedInput {
  txHash: string;
  vout: number;
  address: string;
  amount: string;
  scriptPubKey: string;
  confirmations: number;
}

async function selectCoins(input: CoinSelectionInput): Promise<{
  selectedInputs: SelectedInput[];
  outputs: Array<{ address: string; amount: string }>;
  estimatedFee: string;
  changeAmount: string;
}> {
  const adapter = adapterRegistry.get('bitcoin');

  // Collect all UTXOs from provided addresses
  let allUtxos: any[] = [];
  for (const addr of input.fromAddresses) {
    const utxos = await adapter.getUtxosForAddress(addr, 0);
    allUtxos.push(...utxos);
  }

  // Sort by confirmation count descending (prefer confirmed UTXOs), then by amount descending
  allUtxos.sort((a, b) => {
    if (b.confirmations !== a.confirmations) return b.confirmations - a.confirmations;
    return Number(BigInt(b.amount) - BigInt(a.amount));
  });

  const targetAmount = input.outputs.reduce(
    (sum, o) => sum + BigInt(o.amount),
    BigInt(0)
  );

  // Greedy coin selection
  const selected: typeof allUtxos = [];
  let selectedTotal = BigInt(0);

  for (const utxo of allUtxos) {
    selected.push(utxo);
    selectedTotal += BigInt(utxo.amount);

    // Estimate fee for current selection
    const estimatedSize =
      selected.length * INPUT_SIZE +
      (input.outputs.length + 1) * OUTPUT_SIZE + // +1 for change
      TX_OVERHEAD;
    const estimatedFee = BigInt(Math.ceil(estimatedSize * input.feeRate));

    if (selectedTotal >= targetAmount + estimatedFee) {
      const changeAmount = selectedTotal - targetAmount - estimatedFee;
      return {
        selectedInputs: selected.map((u) => ({
          txHash: u.txHash,
          vout: u.vout,
          address: u.address,
          amount: u.amount,
          scriptPubKey: u.scriptPubKey,
          confirmations: u.confirmations,
        })),
        outputs: input.outputs,
        estimatedFee: estimatedFee.toString(),
        changeAmount: changeAmount.toString(),
      };
    }
  }

  throw new UnprocessableEntityError(
    'Insufficient funds for the requested transaction',
    {
      available: selectedTotal.toString(),
      required: targetAmount.toString(),
    }
  );
}

// POST /v1/chains/bitcoin/transactions/coin-selection
prepareRouter.post('/coin-selection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      fromAddresses: z.array(z.string().min(1)).min(1),
      outputs: z.array(z.object({
        address: z.string().min(1),
        amount: z.string().regex(/^\d+$/, 'Amount must be satoshi integer string'),
      })).min(1),
      feeRate: z.number().positive(),
      changeAddress: z.string().min(1),
    });

    const body = schema.parse(req.body);
    const adapter = adapterRegistry.get('bitcoin');

    // Validate all addresses
    for (const addr of [...body.fromAddresses, body.changeAddress]) {
      if (!adapter.isValidAddress(addr)) {
        throw new ValidationError(`Invalid Bitcoin address: ${addr}`);
      }
    }
    for (const out of body.outputs) {
      if (!adapter.isValidAddress(out.address)) {
        throw new ValidationError(`Invalid Bitcoin output address: ${out.address}`);
      }
    }

    const result = await selectCoins(body);

    const changeAmount = BigInt(result.changeAmount);
    const allOutputs = [...result.outputs];
    if (changeAmount > BigInt(546)) { // dust threshold
      allOutputs.push({ address: body.changeAddress, amount: changeAmount.toString() });
    }

    res.json({
      data: {
        selectedInputs: result.selectedInputs.map((i) => ({
          ...i,
          amount_display: satoshiToBtc(i.amount),
        })),
        outputs: allOutputs.map((o) => ({
          ...o,
          amount_display: satoshiToBtc(o.amount),
        })),
        estimatedFee: result.estimatedFee,
        estimatedFee_display: satoshiToBtc(result.estimatedFee),
        feeRate: body.feeRate,
        changeAddress: body.changeAddress,
        changeAmount: changeAmount > BigInt(546) ? changeAmount.toString() : '0',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/chains/bitcoin/transactions/prepare
prepareRouter.post('/prepare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      fromAddresses: z.array(z.string().min(1)).min(1),
      outputs: z.array(z.object({
        address: z.string().min(1),
        amount: z.string().regex(/^\d+$/, 'Amount must be satoshi integer string'),
      })).min(1),
      changeAddress: z.string().min(1),
      feePolicy: z.object({
        feeRate: z.number().positive().optional(),
        targetBlocks: z.number().int().min(1).optional(),
      }).optional(),
      format: z.enum(['psbt', 'raw']).default('psbt'),
      walletId: z.string().optional(),
    });

    const body = schema.parse(req.body);
    const adapter = adapterRegistry.get('bitcoin');

    // Resolve fee rate
    let feeRate: number;
    if (body.feePolicy?.feeRate) {
      feeRate = body.feePolicy.feeRate;
    } else {
      const feeEst = await adapter.estimateSmartFee(body.feePolicy?.targetBlocks ?? 6);
      feeRate = feeEst.feeRate;
    }

    // Coin selection
    const coinSel = await selectCoins({
      fromAddresses: body.fromAddresses,
      outputs: body.outputs,
      feeRate,
      changeAddress: body.changeAddress,
    });

    const changeAmount = BigInt(coinSel.changeAmount);
    const finalOutputs = [...body.outputs];
    if (changeAmount > BigInt(546)) {
      finalOutputs.push({ address: body.changeAddress, amount: changeAmount.toString() });
    }

    const db = getDb();
    const txId = `tx_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    let psbtResult: any = null;

    // Try PSBT if wallet is configured
    if (body.format === 'psbt') {
      try {
        const inputs = coinSel.selectedInputs.map((i) => ({
          txid: i.txHash,
          vout: i.vout,
        }));
        const outputs = finalOutputs.map((o) => ({
          [o.address]: Number((BigInt(o.amount) * BigInt(100)) / BigInt(100_000_000)) / 100,
        }));
        psbtResult = await adapter.walletCreateFundedPsbt(inputs, outputs, { feeRate: feeRate / 100000 });
      } catch {
        // Fall back to raw format data
      }
    }

    // Save transaction record
    db.prepare(`
      INSERT INTO transactions (id, chain_id, tx_hash, psbt, status, fee_raw, fee_rate, wallet_id, metadata, created_at, updated_at)
      VALUES (?, 'bitcoin', NULL, ?, 'prepared', ?, ?, ?, ?, ?, ?)
    `).run(
      txId,
      psbtResult?.psbt ?? null,
      coinSel.estimatedFee,
      feeRate.toString(),
      body.walletId ?? null,
      JSON.stringify({ fromAddresses: body.fromAddresses }),
      now,
      now
    );

    res.status(201).json({
      data: {
        txId,
        format: psbtResult ? 'psbt' : 'raw',
        psbt: psbtResult?.psbt ?? null,
        inputs: coinSel.selectedInputs.map((i) => ({
          ...i,
          amount_display: satoshiToBtc(i.amount),
        })),
        outputs: finalOutputs.map((o) => ({
          ...o,
          amount_display: satoshiToBtc(o.amount),
        })),
        estimatedFee: coinSel.estimatedFee,
        estimatedFee_display: satoshiToBtc(coinSel.estimatedFee),
        feeRate,
        status: 'prepared',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/chains/bitcoin/transactions/finalize
prepareRouter.post('/finalize', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      psbt: z.string().min(1),
    });

    const body = schema.parse(req.body);

    if (!validatePsbt(body.psbt)) {
      throw new ValidationError('Invalid PSBT format');
    }

    const adapter = adapterRegistry.get('bitcoin');
    const result = await adapter.finalizePsbt(body.psbt);

    if (!result.complete) {
      throw new UnprocessableEntityError('PSBT is not complete — missing signatures');
    }

    res.json({
      data: {
        rawTransaction: result.hex,
        complete: result.complete,
      },
    });
  } catch (err) {
    next(err);
  }
});
