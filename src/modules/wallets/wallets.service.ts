import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';
import { toUnixTs } from '../../shared/time/index';

export interface Wallet {
  id: string;
  tenant_id: string;
  name: string;
  type: string;
  wallet_role: string;
  status: string;
  metadata: Record<string, unknown> | null;
  chains: string[];
  created_at: number;
  updated_at: number;
}

function mapWallet(row: any): Omit<Wallet, 'chains'> {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

async function fetchWalletChains(db: ReturnType<typeof getDbClient>, walletId: string): Promise<string[]> {
  const rows = await db.all<{ chain_id: string }>(
    "SELECT DISTINCT chain_id FROM addresses WHERE wallet_id = ? AND status = 'active'",
    [walletId]
  );
  return rows.map(r => r.chain_id);
}

function generateWalletId(): string {
  return `wallet_${crypto.randomBytes(6).toString('hex')}`;
}

export interface CreateWalletInput {
  name: string;
  type: 'watch_only' | 'external_signer';
  walletRole?: 'watch_only' | 'tenant_hot' | 'tenant_cold' | 'customer_deposits' | 'external_signer';
  metadata?: Record<string, unknown>;
}

export interface ListWalletsInput {
  limit?: number;
  cursor?: string;
  type?: string;
}

export const walletsService = {
  async create(tenantId: string, input: CreateWalletInput): Promise<Wallet> {
    const db = getDbClient();
    const id = generateWalletId();
    const now = new Date().toISOString();
    const walletRole = input.walletRole ?? 'watch_only';

    await db.run(
      `INSERT INTO wallets (id, tenant_id, name, type, wallet_role, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [
        id,
        tenantId,
        input.name,
        input.type,
        walletRole,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
      ]
    );

    return walletsService.getById(tenantId, id);
  },

  async list(tenantId: string, input: ListWalletsInput = {}): Promise<{ data: Wallet[]; nextCursor: string | null }> {
    const db = getDbClient();
    const limit = Math.min(input.limit ?? 20, 100);
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (input.type) {
      conditions.push('type = ?');
      params.push(input.type);
    }
    if (input.cursor) {
      conditions.push('id > ?');
      params.push(input.cursor);
    }

    let query = 'SELECT * FROM wallets WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const data = await Promise.all(
      items.map(async (row) => ({
        ...mapWallet(row),
        chains: await fetchWalletChains(db, (row as any).id),
      }))
    );

    return {
      data,
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  async getById(tenantId: string, id: string): Promise<Wallet> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM wallets WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw new NotFoundError('Wallet', id);
    return {
      ...mapWallet(row),
      chains: await fetchWalletChains(db, id),
    };
  },
};
