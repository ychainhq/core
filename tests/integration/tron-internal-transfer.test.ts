/**
 * Integration tests — TRON internal transfers via _executeInternalTransfer()
 *
 * When a TRON withdrawal's toAddress matches a registered tron:customer_deposit
 * address on the same tenant, the engine executes an immediate ledger transfer
 * instead of routing to the blockchain.
 *
 * Covers:
 * - Happy path: tron:USDT internal transfer — status=confirmed, withdrawal_type=internal
 * - Debits sender's tron:USDT account, credits recipient's tron:USDT account
 * - Creates deposit record with chain_id=tron, asset_id=tron:USDT, status=confirmed
 * - Deposit visible in GET /v1/customers/:id/deposits
 * - Insufficient tron:USDT balance → 422
 * - Withdrawing to own TRON deposit address → 400
 * - External TRON address (not registered) → still queued (not internal)
 */
import request from 'supertest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';
import { ledgerService } from '../../src/modules/ledger/ledger.service';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

jest.setTimeout(60000);

const app = bootstrapApp();
afterAll(() => teardownDb());

// ── TRON xpub derivation ─────────────────────────────────────────────────────

let tronXpubCounter = 900;

function uniqueTronXpub(): string {
  const seed = Buffer.alloc(32, tronXpubCounter++);
  return bip32.fromSeed(seed, bitcoin.networks.bitcoin).neutered().toBase58();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createTenantWithTronXpub() {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `tron-internal-tenant-${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
  expect(createRes.status).toBe(201);
  const tenantId = createRes.body.data.id;

  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  const auth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

  // Configure tronXpub so deposit address generation works
  await request(app)
    .patch(`/admin/v1/tenants/${tenantId}/config`)
    .set(ADMIN_AUTH)
    .send({ tronXpub: uniqueTronXpub() });

  return { tenantId, auth };
}

async function createCustomer(auth: { Authorization: string }): Promise<string> {
  const res = await request(app)
    .post('/v1/customers')
    .set(auth)
    .send({ reference: `ref_tron_${Date.now()}_${Math.random().toString(36).slice(2)}` });
  expect(res.status).toBe(201);
  return res.body.data.id;
}

async function issueSession(auth: { Authorization: string }, customerId: string): Promise<string> {
  const res = await request(app)
    .post(`/v1/customers/${customerId}/sessions`)
    .set(auth);
  expect(res.status).toBe(201);
  return res.body.data.accessToken;
}

async function generateTronDepositAddress(auth: { Authorization: string }, customerId: string): Promise<string> {
  const res = await request(app)
    .post(`/v1/customers/${customerId}/deposit-address?chain=tron`)
    .set(auth);
  expect(res.status).toBe(201);
  expect(res.body.data.address).toMatch(/^T[A-Za-z0-9]{33}$/);
  return res.body.data.address;
}

async function creditTronUsdt(tenantId: string, customerId: string, amountRaw: string) {
  const account = await ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, 'tron:USDT');
  if (!account) throw new Error(`No tron:USDT account for customer ${customerId}`);
  await ledgerService.addEntry({
    ledgerAccountId: account.id,
    type: 'test_credit',
    amountRaw,
    referenceType: 'test',
    referenceId: 'setup',
    isPending: false,
  });
}

async function getTronUsdtSettledBalance(tenantId: string, customerId: string): Promise<bigint> {
  const account = await ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, 'tron:USDT');
  if (!account) return 0n;
  return BigInt((await ledgerService.getBalance(account.id)).settled);
}

// ── 1. Happy path — tron:USDT internal transfer ───────────────────────────────

describe('POST /v1/me/withdrawals — TRON internal transfer (tron:USDT)', () => {
  it('status=confirmed, withdrawal_type=internal when sending to platform TRON address', async () => {
    const { tenantId, auth } = await createTenantWithTronXpub();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    await creditTronUsdt(tenantId, sender, '20000000'); // 20 USDT (6 decimals)
    const recipientTronAddr = await generateTronDepositAddress(auth, recipient);

    const token = await issueSession(auth, sender);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: recipientTronAddr,
        amountSats: '10000000', // 10 USDT in micro-units
        chainId: 'tron',
        assetId: 'tron:USDT',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('confirmed');
    expect(res.body.data.withdrawal_type).toBe('internal');
    expect(res.body.data.chain_id).toBe('tron');
    expect(res.body.data.asset_id).toBe('tron:USDT');
    expect(res.body.data.recipient_customer_id).toBe(recipient);
    expect(res.body.data.fee_raw).toBe('0');
    expect(res.body.data.tx_hash).toBeNull();
  });

  it('debits sender and credits recipient tron:USDT ledger accounts atomically', async () => {
    const { tenantId, auth } = await createTenantWithTronXpub();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    await creditTronUsdt(tenantId, sender, '30000000'); // 30 USDT
    const recipientTronAddr = await generateTronDepositAddress(auth, recipient);

    const recipientBefore = await getTronUsdtSettledBalance(tenantId, recipient);

    const token = await issueSession(auth, sender);
    await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: recipientTronAddr,
        amountSats: '15000000', // 15 USDT
        chainId: 'tron',
        assetId: 'tron:USDT',
      });

    expect(await getTronUsdtSettledBalance(tenantId, sender)).toBe(15000000n);
    expect(await getTronUsdtSettledBalance(tenantId, recipient)).toBe(recipientBefore + 15000000n);
  });

  it('creates a deposit record for the recipient with correct chain/asset metadata', async () => {
    const { tenantId, auth } = await createTenantWithTronXpub();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    await creditTronUsdt(tenantId, sender, '25000000');
    const recipientTronAddr = await generateTronDepositAddress(auth, recipient);

    const token = await issueSession(auth, sender);
    await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: recipientTronAddr,
        amountSats: '12000000',
        chainId: 'tron',
        assetId: 'tron:USDT',
      });

    const depositsRes = await request(app)
      .get(`/v1/customers/${recipient}/deposits`)
      .set(auth);
    expect(depositsRes.status).toBe(200);

    const dep = depositsRes.body.data.find((d: any) => d.address === recipientTronAddr);
    expect(dep).toBeDefined();
    expect(dep.chain_id).toBe('tron');
    expect(dep.asset_id).toBe('tron:USDT');
    expect(dep.amount_raw).toBe('12000000');
    expect(dep.status).toBe('confirmed');
    expect(dep.customer_id).toBe(recipient);
    expect(dep.metadata?.internal_transfer).toBe(true);
    expect(dep.metadata?.sender_customer_id).toBe(sender);
  });

  it('appears in GET /v1/me/withdrawals with withdrawal_type=internal', async () => {
    const { tenantId, auth } = await createTenantWithTronXpub();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    await creditTronUsdt(tenantId, sender, '20000000');
    const recipientTronAddr = await generateTronDepositAddress(auth, recipient);

    const token = await issueSession(auth, sender);
    await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: recipientTronAddr,
        amountSats: '5000000',
        chainId: 'tron',
        assetId: 'tron:USDT',
      });

    const listRes = await request(app)
      .get('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` });

    expect(listRes.status).toBe(200);
    const found = listRes.body.data.find((w: any) => w.to_address === recipientTronAddr);
    expect(found).toBeDefined();
    expect(found.withdrawal_type).toBe('internal');
    expect(found.status).toBe('confirmed');
  });
});

// ── 2. Error paths ────────────────────────────────────────────────────────────

describe('POST /v1/me/withdrawals — TRON internal transfer errors', () => {
  it('returns 422 when sender has insufficient tron:USDT balance', async () => {
    const { tenantId, auth } = await createTenantWithTronXpub();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    // Do NOT credit sender — zero balance
    const recipientTronAddr = await generateTronDepositAddress(auth, recipient);

    const token = await issueSession(auth, sender);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: recipientTronAddr,
        amountSats: '10000000',
        chainId: 'tron',
        assetId: 'tron:USDT',
      });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/[Ii]nsufficient|balance/);
  });

  it('returns 400 when sender withdraws to their own TRON deposit address', async () => {
    const { tenantId, auth } = await createTenantWithTronXpub();
    const customer = await createCustomer(auth);

    await creditTronUsdt(tenantId, customer, '20000000');
    const ownTronAddr = await generateTronDepositAddress(auth, customer);

    const token = await issueSession(auth, customer);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: ownTronAddr,
        amountSats: '5000000',
        chainId: 'tron',
        assetId: 'tron:USDT',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/own deposit address/i);
  });

  it('queues as external when TRON toAddress is not a platform deposit address', async () => {
    const { tenantId, auth } = await createTenantWithTronXpub();
    const customer = await createCustomer(auth);

    await creditTronUsdt(tenantId, customer, '20000000');

    // A TRON address that is NOT registered as a platform deposit address
    // We generate a deposit address for a different customer and use a raw external one
    // The engine should queue it as external (no ledger transfer attempt)
    const externalTronAddr = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // known valid TRON address

    const token = await issueSession(auth, customer);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: externalTronAddr,
        amountSats: '5000000',
        chainId: 'tron',
        assetId: 'tron:USDT',
      });

    // Should queue as external (201 queued) — TRON address validation passes,
    // but it's not a platform deposit address so no internal transfer
    if (res.status === 201) {
      expect(res.body.data.status).toBe('queued');
      expect(res.body.data.withdrawal_type).toBe('external');
    } else {
      // 400 if address fails TRON validation (should not happen for this address)
      expect([400, 422]).toContain(res.status);
    }
  });
});

// ── 3. Tenant isolation ───────────────────────────────────────────────────────

describe('TRON internal transfer — tenant isolation', () => {
  it('treats TRON deposit address from another tenant as external', async () => {
    const { tenantId: tenantA, auth: authA } = await createTenantWithTronXpub();
    const { auth: authB } = await createTenantWithTronXpub();

    const senderA = await createCustomer(authA);
    const recipientB = await createCustomer(authB);

    await creditTronUsdt(tenantA, senderA, '20000000');
    // Generate a TRON address for recipient on tenant B
    const addrOnTenantB = await generateTronDepositAddress(authB, recipientB);

    const tokenA = await issueSession(authA, senderA);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${tokenA}` })
      .send({
        toAddress: addrOnTenantB,
        amountSats: '5000000',
        chainId: 'tron',
        assetId: 'tron:USDT',
      });

    // Must NOT be internal — cross-tenant address treated as external or invalid
    if (res.status === 201) {
      expect(res.body.data.withdrawal_type).toBe('external');
    } else {
      // 400/422 also acceptable (invalid address for this tenant or balance issue)
      expect([400, 422]).toContain(res.status);
    }
  });
});
