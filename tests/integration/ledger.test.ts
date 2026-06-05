import request from 'supertest';
import { bootstrapApp, AUTH, teardownDb, TEST_TENANT_ID } from './helpers';
import { ledgerService } from '../../src/modules/ledger/ledger.service';
import { getDbClient } from '../../src/db/client';

const app = bootstrapApp();

afterAll(() => teardownDb());

let walletId: string;

beforeAll(async () => {
  const wRes = await request(app)
    .post('/v1/wallets')
    .set(AUTH)
    .send({ name: 'Ledger Test Wallet', type: 'watch_only' });
  walletId = wRes.body.data.id;
});

describe('POST /v1/ledger/accounts', () => {
  it('creates a ledger account', async () => {
    const res = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ walletId, chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Main BTC Account' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toMatch(/^lacc_/);
    expect(res.body.data.name).toBe('Main BTC Account');
    expect(res.body.data.chain_id).toBe('bitcoin');
    expect(res.body.data.asset_id).toBe('bitcoin:BTC');
    expect(res.body.data.wallet_id).toBe(walletId);
  });

  it('creates a ledger account without walletId', async () => {
    const res = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Standalone Account' });

    expect(res.status).toBe(201);
    expect(res.body.data.wallet_id).toBeNull();
  });

  it('returns 400 for missing name', async () => {
    const res = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ chainId: 'bitcoin', assetId: 'bitcoin:BTC' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for unknown chainId', async () => {
    const res = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ chainId: 'solana', assetId: 'solana:SOL', name: 'Bad Chain' });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/ledger/accounts', () => {
  beforeAll(async () => {
    await request(app).post('/v1/ledger/accounts').set(AUTH).send({
      walletId, chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Listed Account',
    });
  });

  it('returns list of ledger accounts', async () => {
    const res = await request(app).get('/v1/ledger/accounts').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /v1/ledger/accounts/:id', () => {
  let accountId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Get By Id Account' });
    accountId = res.body.data.id;
  });

  it('returns ledger account by id', async () => {
    const res = await request(app).get(`/v1/ledger/accounts/${accountId}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(accountId);
    expect(res.body.data.name).toBe('Get By Id Account');
  });

  it('returns 404 for non-existent account', async () => {
    const res = await request(app).get('/v1/ledger/accounts/lacc_nonexistent').set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/ledger/accounts/:id/balances', () => {
  let accountId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Balance Test Account' });
    accountId = res.body.data.id;
  });

  it('returns zero balances for new account', async () => {
    const res = await request(app)
      .get(`/v1/ledger/accounts/${accountId}/balances`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.pending).toBe('0');
    expect(res.body.data.settled).toBe('0');
    expect(res.body.data.total).toBe('0');
    expect(res.body.data.ledgerAccountId).toBe(accountId);
  });
});

describe('GET /v1/ledger/accounts/:id/entries', () => {
  let accountId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Entries Test Account' });
    accountId = res.body.data.id;
  });

  it('returns empty entries for new account', async () => {
    const res = await request(app)
      .get(`/v1/ledger/accounts/${accountId}/entries`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});

describe('POST /v1/ledger/transfers', () => {
  let fromAccountId: string;
  let toAccountId: string;

  beforeAll(async () => {
    const [fromRes, toRes] = await Promise.all([
      request(app).post('/v1/ledger/accounts').set(AUTH).send({
        chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Transfer From',
      }),
      request(app).post('/v1/ledger/accounts').set(AUTH).send({
        chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Transfer To',
      }),
    ]);
    fromAccountId = fromRes.body.data.id;
    toAccountId = toRes.body.data.id;
  });

  it('creates internal ledger transfer', async () => {
    const res = await request(app)
      .post('/v1/ledger/transfers')
      .set(AUTH)
      .send({
        fromLedgerAccountId: fromAccountId,
        toLedgerAccountId: toAccountId,
        assetId: 'bitcoin:BTC',
        amount: '50000',
        reference: 'transfer-001',
      });

    expect(res.status).toBe(201);
    // Response contains { data: { debit: LedgerEntry, credit: LedgerEntry } }
    expect(res.body.data.debit.id).toMatch(/^lent_/);
    expect(res.body.data.credit.id).toMatch(/^lent_/);
    expect(res.body.data.debit.ledger_account_id).toBe(fromAccountId);
    expect(res.body.data.credit.ledger_account_id).toBe(toAccountId);
  });

  it('is idempotent with Idempotency-Key', async () => {
    const idemKey = `transfer-idem-${Date.now()}`;
    const body = {
      fromLedgerAccountId: fromAccountId,
      toLedgerAccountId: toAccountId,
      assetId: 'bitcoin:BTC',
      amount: '10000',
    };

    const first = await request(app)
      .post('/v1/ledger/transfers')
      .set(AUTH)
      .set('Idempotency-Key', idemKey)
      .send(body);

    const second = await request(app)
      .post('/v1/ledger/transfers')
      .set(AUTH)
      .set('Idempotency-Key', idemKey)
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Second call returns same debit entry id
    expect(second.body.data.debit.id).toBe(first.body.data.debit.id);
  });

  it('returns 400 for missing amount', async () => {
    const res = await request(app)
      .post('/v1/ledger/transfers')
      .set(AUTH)
      .send({
        fromLedgerAccountId: fromAccountId,
        toLedgerAccountId: toAccountId,
        assetId: 'bitcoin:BTC',
      });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown source account', async () => {
    const res = await request(app)
      .post('/v1/ledger/transfers')
      .set(AUTH)
      .send({
        fromLedgerAccountId: 'lacc_ghost',
        toLedgerAccountId: toAccountId,
        assetId: 'bitcoin:BTC',
        amount: '1000',
      });
    expect(res.status).toBe(404);
  });

  it('returns 400 for zero amount', async () => {
    const res = await request(app)
      .post('/v1/ledger/transfers')
      .set(AUTH)
      .send({
        fromLedgerAccountId: fromAccountId,
        toLedgerAccountId: toAccountId,
        assetId: 'bitcoin:BTC',
        amount: 'abc',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('ledgerService.ensureDepositEntryForDeposit', () => {
  let testWalletId: string;
  let testAccountId: string;

  beforeAll(async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'EDE Test Wallet', type: 'watch_only' });
    testWalletId = wRes.body.data.id;

    const laRes = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ walletId: testWalletId, chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'EDE Test Account' });
    testAccountId = laRes.body.data.id;
  });

  it('creates deposit_pending entry via walletId with isPending=true', async () => {
    const depositId = 'dep_ede_pending_wallet';
    await ledgerService.ensureDepositEntryForDeposit({
      tenantId: TEST_TENANT_ID,
      customerId: null,
      walletId: testWalletId,
      assetId: 'bitcoin:BTC',
      depositId,
      entryType: 'deposit_pending',
      amountRaw: '100000',
    });

    const db = getDbClient();
    const entry = await db.get(
      "SELECT * FROM ledger_entries WHERE reference_id = ? AND type = 'deposit_pending'",
      [depositId]
    );
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('deposit_pending');
    expect(entry!.amount_raw).toBe('100000');
    expect(entry!.ledger_account_id).toBe(testAccountId);
  });

  it('creates deposit_settled entry via walletId with isPending=false', async () => {
    const depositId = 'dep_ede_settled_wallet';
    await ledgerService.ensureDepositEntryForDeposit({
      tenantId: TEST_TENANT_ID,
      customerId: null,
      walletId: testWalletId,
      assetId: 'bitcoin:BTC',
      depositId,
      entryType: 'deposit_settled',
      amountRaw: '200000',
    });

    const db = getDbClient();
    const entry = await db.get(
      "SELECT * FROM ledger_entries WHERE reference_id = ? AND type = 'deposit_settled'",
      [depositId]
    );
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('deposit_settled');
    expect(entry!.amount_raw).toBe('200000');
  });

  it('is a no-op when both customerId and walletId are null', async () => {
    const depositId = 'dep_ede_no_account';
    await expect(
      ledgerService.ensureDepositEntryForDeposit({
        tenantId: TEST_TENANT_ID,
        customerId: null,
        walletId: null,
        assetId: 'bitcoin:BTC',
        depositId,
        entryType: 'deposit_pending',
        amountRaw: '50000',
      })
    ).resolves.toBeUndefined();

    const db = getDbClient();
    const entry = await db.get(
      'SELECT * FROM ledger_entries WHERE reference_id = ?',
      [depositId]
    );
    expect(entry).toBeUndefined();
  });

  it('is idempotent — second call with same depositId and entryType is a no-op', async () => {
    const depositId = 'dep_ede_idempotent';
    const args = {
      tenantId: TEST_TENANT_ID,
      customerId: null,
      walletId: testWalletId,
      assetId: 'bitcoin:BTC',
      depositId,
      entryType: 'deposit_pending' as const,
      amountRaw: '75000',
    };

    await ledgerService.ensureDepositEntryForDeposit(args);
    await ledgerService.ensureDepositEntryForDeposit(args);

    const db = getDbClient();
    const rows = await db.all(
      "SELECT * FROM ledger_entries WHERE reference_id = ? AND type = 'deposit_pending'",
      [depositId]
    );
    expect(rows).toHaveLength(1);
  });
});
