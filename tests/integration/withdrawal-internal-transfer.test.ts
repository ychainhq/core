/**
 * Integration tests — On-Platform Withdrawal Routing (Internal Settlement).
 *
 * When a customer withdraws to a platform deposit address (same tenant),
 * the engine executes an immediate ledger transfer instead of routing through
 * the blockchain. These tests verify the detection, execution, and edge cases.
 */
import request from 'supertest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';
import { ledgerService } from '../../src/modules/ledger/ledger.service';
import { getDb } from '../../src/db/sqlite';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const app = bootstrapApp();
afterAll(() => teardownDb());

// Each tenant needs its own xpub so derived deposit addresses don't collide on UNIQUE(chain_id, address).
let xpubCounter = 50;
function uniqueXpub(): string {
  const seed = Buffer.alloc(32, xpubCounter++);
  return bip32.fromSeed(seed, bitcoin.networks.bitcoin).neutered().toBase58();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTenantWithKey() {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `internal-transfer-tenant-${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr(), xpub: uniqueXpub() }] });
  expect(createRes.status).toBe(201);
  const tenantId = createRes.body.data.id;
  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  return { tenantId, auth: { Authorization: `Bearer ${keyRes.body.data.apiKey}` } };
}

async function createCustomer(auth: Record<string, string>) {
  const res = await request(app)
    .post('/v1/customers')
    .set(auth)
    .send({ reference: `ref_${Date.now()}_${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; status: string };
}

async function issueSession(auth: Record<string, string>, customerId: string) {
  const res = await request(app)
    .post(`/v1/customers/${customerId}/sessions`)
    .set(auth);
  expect(res.status).toBe(201);
  return res.body.data.accessToken as string;
}

/** Credit a customer's ledger account with settled sats (test setup only). */
function creditCustomer(tenantId: string, customerId: string, sats: string) {
  const account = ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, 'bitcoin:BTC');
  if (!account) throw new Error(`No BTC account for ${customerId}`);
  ledgerService.addEntry({
    ledgerAccountId: account.id,
    type: 'test_credit',
    amountRaw: sats,
    referenceType: 'test',
    referenceId: 'setup',
    isPending: false,
  });
  return account;
}

/** Register a platform deposit address for a customer and return the address string. */
async function registerDepositAddress(auth: Record<string, string>, customerId: string): Promise<string> {
  const res = await request(app)
    .post(`/v1/customers/${customerId}/deposit-address`)
    .set(auth);
  expect(res.status).toBe(201);
  return res.body.data.address as string;
}

function getSettledBalance(tenantId: string, customerId: string): bigint {
  const account = ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, 'bitcoin:BTC');
  if (!account) return 0n;
  return BigInt(ledgerService.getBalance(account.id).settled);
}

// ---------------------------------------------------------------------------
// 1. Happy path — internal transfer
// ---------------------------------------------------------------------------
describe('POST /v1/me/withdrawals — internal transfer (on-platform address)', () => {
  it('returns status=confirmed and withdrawal_type=internal immediately', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    creditCustomer(tenantId, sender.id, '500000');
    const recipientDepositAddr = await registerDepositAddress(auth, recipient.id);

    const token = await issueSession(auth, sender.id);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: recipientDepositAddr, amountSats: '100000' });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('confirmed');
    expect(res.body.data.withdrawal_type).toBe('internal');
    expect(res.body.data.recipient_customer_id).toBe(recipient.id);
    expect(res.body.data.fee_raw).toBe('0');
    expect(res.body.data.psbt).toBeNull();
    expect(res.body.data.tx_hash).toBeNull();
  });

  it('debits sender and credits recipient atomically', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    creditCustomer(tenantId, sender.id, '300000');
    const initialRecipientBalance = getSettledBalance(tenantId, recipient.id);
    const recipientDepositAddr = await registerDepositAddress(auth, recipient.id);

    const token = await issueSession(auth, sender.id);
    await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: recipientDepositAddr, amountSats: '150000' });

    expect(getSettledBalance(tenantId, sender.id)).toBe(150000n);
    expect(getSettledBalance(tenantId, recipient.id)).toBe(initialRecipientBalance + 150000n);
  });

  it('appears in GET /v1/me/withdrawals with withdrawal_type=internal', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    creditCustomer(tenantId, sender.id, '200000');
    const recipientDepositAddr = await registerDepositAddress(auth, recipient.id);

    const token = await issueSession(auth, sender.id);
    await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: recipientDepositAddr, amountSats: '50000' });

    const listRes = await request(app)
      .get('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` });

    expect(listRes.status).toBe(200);
    const found = listRes.body.data.find((w: any) => w.to_address === recipientDepositAddr);
    expect(found).toBeDefined();
    expect(found.withdrawal_type).toBe('internal');
    expect(found.status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency — duplicate call returns same record
// ---------------------------------------------------------------------------
describe('POST /v1/me/withdrawals — idempotency for internal transfer', () => {
  it('returns the same withdrawal record on duplicate idempotency key', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    creditCustomer(tenantId, sender.id, '400000');
    const recipientDepositAddr = await registerDepositAddress(auth, recipient.id);

    const token = await issueSession(auth, sender.id);
    const idemKey = `idem_${Date.now()}`;

    const r1 = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: recipientDepositAddr, amountSats: '100000', idempotencyKey: idemKey });

    const r2 = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: recipientDepositAddr, amountSats: '100000', idempotencyKey: idemKey });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.data.id).toBe(r2.body.data.id);
    // Only one transfer should have occurred
    expect(getSettledBalance(tenantId, sender.id)).toBe(300000n);
  });
});

// ---------------------------------------------------------------------------
// 3. External address — unchanged behavior
// ---------------------------------------------------------------------------
describe('POST /v1/me/withdrawals — external address not affected', () => {
  it('queues an external withdrawal when toAddress is not a platform deposit address', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);

    creditCustomer(tenantId, customer.id, '200000');

    const token = await issueSession(auth, customer.id);
    const externalAddr = uniqueAddr();

    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: externalAddr, amountSats: '50000' });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('queued');
    expect(res.body.data.withdrawal_type).toBe('external');
    expect(res.body.data.recipient_customer_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Error: same customer sending to own deposit address
// ---------------------------------------------------------------------------
describe('POST /v1/me/withdrawals — cannot transfer to own deposit address', () => {
  it('returns 400 when sender and recipient are the same customer', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);

    creditCustomer(tenantId, customer.id, '200000');
    const ownDepositAddr = await registerDepositAddress(auth, customer.id);

    const token = await issueSession(auth, customer.id);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: ownDepositAddr, amountSats: '50000' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/own deposit address/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Error: recipient customer is not active
// ---------------------------------------------------------------------------
describe('POST /v1/me/withdrawals — recipient not active', () => {
  it('returns 422 when recipient customer is disabled', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    creditCustomer(tenantId, sender.id, '200000');
    const recipientDepositAddr = await registerDepositAddress(auth, recipient.id);

    // Disable recipient
    await request(app).post(`/v1/customers/${recipient.id}/disable`).set(auth);

    const token = await issueSession(auth, sender.id);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: recipientDepositAddr, amountSats: '50000' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not active/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Error: insufficient balance
// ---------------------------------------------------------------------------
describe('POST /v1/me/withdrawals — insufficient balance for internal transfer', () => {
  it('returns 422 when sender balance is too low', async () => {
    const { auth } = await createTenantWithKey();
    const sender = await createCustomer(auth);
    const recipient = await createCustomer(auth);

    // sender has no balance
    const recipientDepositAddr = await registerDepositAddress(auth, recipient.id);

    const token = await issueSession(auth, sender.id);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: recipientDepositAddr, amountSats: '50000' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/[Ii]nsufficient/);
  });
});

// ---------------------------------------------------------------------------
// 7. Tenant isolation — platform address from another tenant is treated as external
// ---------------------------------------------------------------------------
describe('POST /v1/me/withdrawals — tenant isolation', () => {
  it('treats a deposit address from another tenant as external (queued, not internal)', async () => {
    const { auth: authA } = await createTenantWithKey();
    const { tenantId: tenantB, auth: authB } = await createTenantWithKey();

    const senderA = await createCustomer(authA);
    const { tenantId: tenantA } = await (async () => {
      // Get tenantA id from the sender account
      const db = getDb();
      const row = db.prepare('SELECT tenant_id FROM customers WHERE id = ?').get(senderA.id) as any;
      return { tenantId: row.tenant_id as string };
    })();

    creditCustomer(tenantA, senderA.id, '200000');

    // Register a deposit address for a customer on tenant B
    const recipientB = await createCustomer(authB);
    creditCustomer(tenantB, recipientB.id, '0'); // ensure account exists
    const addrOnTenantB = await registerDepositAddress(authB, recipientB.id);

    const token = await issueSession(authA, senderA.id);
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: addrOnTenantB, amountSats: '50000' });

    // Should either queue as external (200/201 queued) or 400 invalid address.
    // Either way it must NOT be internal.
    if (res.status === 201) {
      expect(res.body.data.withdrawal_type).toBe('external');
    } else {
      // 400 — invalid BTC address is also acceptable if derived addr fails format check
      expect([400, 422]).toContain(res.status);
    }
  });
});
