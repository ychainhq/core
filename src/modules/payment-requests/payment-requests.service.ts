import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ValidationError, ConflictError } from '../../shared/errors/index';
import { btcToSatoshi, satoshiToBtc } from '../../shared/money/index';
import { config } from '../../config/index';
import { toUnixTs } from '../../shared/time/index';

export interface PaymentRequest {
  id: string;
  tenant_id: string | null;
  customer_id: string | null;
  chain_id: string;
  asset_id: string;
  wallet_id: string | null;
  address: string;
  amount_raw: string;
  amount_display: string;
  reference: string | null;
  status: string;
  expires_at: string | null;
  confirmations_required: number;
  qr_payload: string | null;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

function mapPaymentRequest(row: any): PaymentRequest {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

function buildBip21Uri(address: string, amountBtc: string, reference?: string): string {
  const params = new URLSearchParams();
  params.set('amount', amountBtc);
  if (reference) {
    params.set('label', reference);
    params.set('message', reference);
  }
  return `bitcoin:${address}?${params.toString()}`;
}

export interface CreatePaymentRequestInput {
  chain: string;
  asset: string;
  amount: string;           // in display units (BTC)
  walletId?: string;
  address?: string;
  customerId?: string;
  reference?: string;
  expiresAt?: string;
  confirmationsRequired?: number;
  metadata?: Record<string, unknown>;
}

export const paymentRequestsService = {
  create(tenantId: string, input: CreatePaymentRequestInput): PaymentRequest {
    const db = getDb();

    // Validate chain
    const chain = db.prepare('SELECT id FROM chains WHERE id = ?').get(input.chain);
    if (!chain) throw new NotFoundError('Chain', input.chain);

    // Validate asset
    const assetId = `${input.chain}:${input.asset}`;
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as any;
    if (!asset) throw new NotFoundError('Asset', assetId);

    // Resolve address — scoped to tenant's wallet
    let address = input.address;
    if (!address && input.walletId) {
      const addrRow = db
        .prepare("SELECT address FROM addresses WHERE tenant_id = ? AND wallet_id = ? AND chain_id = ? AND status = 'active' LIMIT 1")
        .get(tenantId, input.walletId, input.chain) as { address: string } | undefined;
      if (addrRow) address = addrRow.address;
    }
    if (!address) {
      throw new ValidationError('No address provided and no address found for wallet');
    }

    // Convert amount
    let amountRaw: string;
    let amountDisplay: string;
    try {
      amountRaw = btcToSatoshi(input.amount).toString();
      amountDisplay = satoshiToBtc(amountRaw);
    } catch {
      throw new ValidationError(`Invalid amount: ${input.amount}`);
    }

    const id = `payreq_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const confirmationsRequired = input.confirmationsRequired ?? config.BTC_DEFAULT_CONFIRMATIONS;

    // Build QR payload (BIP-21)
    const qrPayload = input.chain === 'bitcoin'
      ? buildBip21Uri(address, amountDisplay, input.reference)
      : null;

    db.prepare(`
      INSERT INTO payment_requests
        (id, tenant_id, customer_id, chain_id, asset_id, wallet_id, address, amount_raw, amount_display, reference, status,
         expires_at, confirmations_required, qr_payload, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      tenantId,
      input.customerId ?? null,
      input.chain,
      assetId,
      input.walletId ?? null,
      address,
      amountRaw,
      amountDisplay,
      input.reference ?? null,
      input.expiresAt ?? null,
      confirmationsRequired,
      qrPayload,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now
    );

    return paymentRequestsService.getById(tenantId, id);
  },

  list(tenantId: string, filters: {
    status?: string;
    chain?: string;
    reference?: string;
    walletId?: string;
    limit?: number;
    cursor?: string;
  } = {}): { data: PaymentRequest[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM payment_requests WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.chain) { query += ' AND chain_id = ?'; params.push(filters.chain); }
    if (filters.reference) { query += ' AND reference = ?'; params.push(filters.reference); }
    if (filters.walletId) { query += ' AND wallet_id = ?'; params.push(filters.walletId); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapPaymentRequest),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  getById(tenantId: string, id: string): PaymentRequest {
    const db = getDb();
    const row = db.prepare('SELECT * FROM payment_requests WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('PaymentRequest', id);
    return mapPaymentRequest(row);
  },

  getByReference(tenantId: string, reference: string): PaymentRequest[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM payment_requests WHERE tenant_id = ? AND reference = ? ORDER BY created_at DESC')
      .all(tenantId, reference);
    return rows.map(mapPaymentRequest);
  },

  cancel(tenantId: string, id: string): PaymentRequest {
    const db = getDb();
    const existing = paymentRequestsService.getById(tenantId, id);
    if (existing.status === 'paid') {
      throw new ConflictError('Cannot cancel a paid payment request');
    }
    if (['cancelled', 'expired'].includes(existing.status)) {
      throw new ConflictError(`Payment request is already ${existing.status}`);
    }
    db.prepare("UPDATE payment_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND tenant_id = ?").run(
      new Date().toISOString(),
      id,
      tenantId
    );
    return paymentRequestsService.getById(tenantId, id);
  },

  updateStatus(id: string, status: string): void {
    const db = getDb();
    db.prepare('UPDATE payment_requests SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      new Date().toISOString(),
      id
    );
  },

  /**
   * Find pending payment requests for a given address.
   */
  findPendingByAddress(address: string, chainId: string): PaymentRequest[] {
    const db = getDb();
    const rows = db
      .prepare(`
        SELECT * FROM payment_requests
        WHERE address = ? AND chain_id = ? AND status IN ('pending', 'detected', 'partially_paid')
        ORDER BY created_at DESC
      `)
      .all(address, chainId);
    return rows.map(mapPaymentRequest);
  },
};
