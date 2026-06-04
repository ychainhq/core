/**
 * chainEventsService.claimAndMarkProcessed unit tests.
 *
 * Verifies the two execution paths:
 *   - SQLite (isPostgres=false): plain SELECT + UPDATE, no transaction
 *   - PostgreSQL (isPostgres=true): SELECT FOR UPDATE SKIP LOCKED + UPDATE
 *     inside a single transaction, so two concurrent callers never claim
 *     the same batch.
 *
 * No real DB is used. getDbClient() is mocked with a fake DbClient.
 */

jest.mock('../../src/db/client', () => ({ getDbClient: jest.fn() }));

import { getDbClient } from '../../src/db/client';
import { chainEventsService } from '../../src/modules/chain-events/chain-events.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(id: string) {
  return {
    id,
    chain_id: 'bitcoin',
    node_id: 'node-1',
    event_type: 'utxo_created',
    tx_hash: `txhash_${id}`,
    vout_index: 0,
    spent_tx_hash: null,
    spent_vout: null,
    address: 'bcrt1qtest',
    amount_raw: '100000',
    block_height: 100,
    block_hash: 'bh',
    confirmations: 0,
    created_at: new Date().toISOString(),
  };
}

function makeMockDb(isPostgres: boolean) {
  const db = {
    isPostgres,
    all: jest.fn(),
    run: jest.fn(),
    get: jest.fn(),
    exec: jest.fn(),
    transaction: jest.fn(),
  };
  (getDbClient as jest.Mock).mockReturnValue(db);
  return db;
}

beforeEach(() => jest.clearAllMocks());

// ─── SQLite path ──────────────────────────────────────────────────────────────

describe('claimAndMarkProcessed — SQLite path (isPostgres=false)', () => {

  test('returns rows from SELECT', async () => {
    const db = makeMockDb(false);
    const events = [makeEvent('e1'), makeEvent('e2')];
    db.all.mockResolvedValue(events);
    db.run.mockResolvedValue({ changes: 2, lastInsertRowid: 0n });

    const result = await chainEventsService.claimAndMarkProcessed(50);

    expect(result).toEqual(events);
  });

  test('SELECT includes WHERE processed=0 and both event types', async () => {
    const db = makeMockDb(false);
    db.all.mockResolvedValue([makeEvent('e1')]);
    db.run.mockResolvedValue({ changes: 1, lastInsertRowid: 0n });

    await chainEventsService.claimAndMarkProcessed(50);

    const sql: string = db.all.mock.calls[0][0];
    expect(sql).toMatch(/processed\s*=\s*0/);
    expect(sql).toContain('utxo_created');
    expect(sql).toContain('utxo_spent');
    expect(sql).toContain('LIMIT');
    expect(sql).not.toContain('FOR UPDATE');
  });

  test('UPDATE uses the exact IDs returned by SELECT', async () => {
    const db = makeMockDb(false);
    const events = [makeEvent('e1'), makeEvent('e2')];
    db.all.mockResolvedValue(events);
    db.run.mockResolvedValue({ changes: 2, lastInsertRowid: 0n });

    await chainEventsService.claimAndMarkProcessed(50);

    const updateParams: unknown[] = db.run.mock.calls[0][1];
    expect(updateParams).toContain('e1');
    expect(updateParams).toContain('e2');
  });

  test('does not call db.run when SELECT returns empty', async () => {
    const db = makeMockDb(false);
    db.all.mockResolvedValue([]);

    const result = await chainEventsService.claimAndMarkProcessed(50);

    expect(result).toEqual([]);
    expect(db.run).not.toHaveBeenCalled();
  });

  test('does not call db.transaction', async () => {
    const db = makeMockDb(false);
    db.all.mockResolvedValue([makeEvent('e1')]);
    db.run.mockResolvedValue({ changes: 1, lastInsertRowid: 0n });

    await chainEventsService.claimAndMarkProcessed(50);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('passes batchSize as LIMIT param', async () => {
    const db = makeMockDb(false);
    db.all.mockResolvedValue([]);

    await chainEventsService.claimAndMarkProcessed(25);

    const params: unknown[] = db.all.mock.calls[0][1];
    expect(params).toContain(25);
  });
});

// ─── PostgreSQL path ──────────────────────────────────────────────────────────

describe('claimAndMarkProcessed — PostgreSQL path (isPostgres=true)', () => {

  function setupPgMock(events: ReturnType<typeof makeEvent>[]) {
    const db = makeMockDb(true);
    db.transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    db.all.mockResolvedValue(events);
    db.run.mockResolvedValue({ changes: events.length, lastInsertRowid: 0n });
    return db;
  }

  test('wraps work in db.transaction', async () => {
    const db = setupPgMock([makeEvent('e1')]);

    await chainEventsService.claimAndMarkProcessed(50);

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('SELECT includes FOR UPDATE SKIP LOCKED', async () => {
    const db = setupPgMock([makeEvent('e1')]);

    await chainEventsService.claimAndMarkProcessed(50);

    const sql: string = db.all.mock.calls[0][0];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  test('SELECT includes WHERE processed=0 and both event types', async () => {
    const db = setupPgMock([makeEvent('e1')]);

    await chainEventsService.claimAndMarkProcessed(50);

    const sql: string = db.all.mock.calls[0][0];
    expect(sql).toMatch(/processed\s*=\s*0/);
    expect(sql).toContain('utxo_created');
    expect(sql).toContain('utxo_spent');
  });

  test('UPDATE uses the exact IDs returned by SELECT', async () => {
    const db = setupPgMock([makeEvent('e1'), makeEvent('e2')]);

    await chainEventsService.claimAndMarkProcessed(50);

    const updateParams: unknown[] = db.run.mock.calls[0][1];
    expect(updateParams).toContain('e1');
    expect(updateParams).toContain('e2');
  });

  test('returns empty array and skips UPDATE when SELECT returns nothing', async () => {
    const db = setupPgMock([]);

    const result = await chainEventsService.claimAndMarkProcessed(50);

    expect(result).toEqual([]);
    expect(db.run).not.toHaveBeenCalled();
  });

  test('returns the claimed rows', async () => {
    const events = [makeEvent('e1'), makeEvent('e2')];
    setupPgMock(events);

    const result = await chainEventsService.claimAndMarkProcessed(50);

    expect(result).toEqual(events);
  });
});
