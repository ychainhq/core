import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb, getDb } from '../../src/db/sqlite';
import { customersService } from '../../src/modules/customers/customers.service';
import { ledgerService } from '../../src/modules/ledger/ledger.service';
import { withdrawalsService } from '../../src/modules/withdrawals/withdrawals.service';
import { ValidationError, UnprocessableEntityError } from '../../src/shared/errors/index';

const TENANT = 'tenant_default';

beforeAll(async () => {
  closeDb();
  runMigrations();
  await runSeed();
});

afterAll(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCustomer(ref: string) {
  return customersService.create(TENANT, { reference: ref });
}

function credit(customerId: string, sats: string) {
  const acc = ledgerService.findAccountByCustomerAndAsset(TENANT, customerId, 'bitcoin:BTC');
  if (!acc) throw new Error(`No BTC account for ${customerId}`);
  ledgerService.addEntry({
    ledgerAccountId: acc.id,
    type: 'deposit_settled',
    amountRaw: sats,
    isPending: false,
  });
  return acc;
}

function settledBalance(customerId: string): bigint {
  const acc = ledgerService.findAccountByCustomerAndAsset(TENANT, customerId, 'bitcoin:BTC');
  if (!acc) return 0n;
  return BigInt(ledgerService.getBalance(acc.id).settled);
}

function callTransfer(opts: {
  senderCustomerId: string;
  recipientCustomerId: string;
  senderAccountId: string;
  amountSats: bigint;
  toAddress?: string;
}) {
  return withdrawalsService._executeInternalTransfer(getDb(), {
    tenantId: TENANT,
    senderCustomerId: opts.senderCustomerId,
    recipientCustomerId: opts.recipientCustomerId,
    senderAccount: { id: opts.senderAccountId },
    amountBigInt: opts.amountSats,
    toAddress: opts.toAddress ?? 'bc1qrecipientaddr',
  });
}

// ---------------------------------------------------------------------------
// Guard: sender === recipient
// ---------------------------------------------------------------------------

describe('_executeInternalTransfer — guard: same customer', () => {
  it('throws ValidationError when sender and recipient are the same customer', () => {
    const c = makeCustomer('unit-int-self');
    const acc = credit(c.id, '100000');

    expect(() =>
      callTransfer({
        senderCustomerId: c.id,
        recipientCustomerId: c.id,
        senderAccountId: acc.id,
        amountSats: 50000n,
      })
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Guard: recipient does not exist
// ---------------------------------------------------------------------------

describe('_executeInternalTransfer — guard: recipient not found', () => {
  it('throws UnprocessableEntityError when recipient customer does not exist', () => {
    const sender = makeCustomer('unit-int-nosuch-sender');
    const acc = credit(sender.id, '100000');

    expect(() =>
      callTransfer({
        senderCustomerId: sender.id,
        recipientCustomerId: 'cust_does_not_exist',
        senderAccountId: acc.id,
        amountSats: 50000n,
      })
    ).toThrow(UnprocessableEntityError);
  });
});

// ---------------------------------------------------------------------------
// Guard: recipient disabled
// ---------------------------------------------------------------------------

describe('_executeInternalTransfer — guard: recipient disabled', () => {
  it('throws UnprocessableEntityError when recipient is not active', () => {
    const sender = makeCustomer('unit-int-disabled-sender');
    const recipient = makeCustomer('unit-int-disabled-recip');
    const acc = credit(sender.id, '100000');

    customersService.disable(TENANT, recipient.id);

    expect(() =>
      callTransfer({
        senderCustomerId: sender.id,
        recipientCustomerId: recipient.id,
        senderAccountId: acc.id,
        amountSats: 50000n,
      })
    ).toThrow(UnprocessableEntityError);
  });
});

// ---------------------------------------------------------------------------
// Guard: recipient has no BTC ledger account
// ---------------------------------------------------------------------------

describe('_executeInternalTransfer — guard: recipient missing ledger account', () => {
  it('throws UnprocessableEntityError when recipient has no bitcoin:BTC account', () => {
    const sender = makeCustomer('unit-int-noacc-sender');
    const recipient = makeCustomer('unit-int-noacc-recip');
    const acc = credit(sender.id, '100000');

    getDb()
      .prepare("DELETE FROM ledger_accounts WHERE customer_id = ? AND asset_id = 'bitcoin:BTC'")
      .run(recipient.id);

    expect(() =>
      callTransfer({
        senderCustomerId: sender.id,
        recipientCustomerId: recipient.id,
        senderAccountId: acc.id,
        amountSats: 50000n,
      })
    ).toThrow(UnprocessableEntityError);
  });
});

// ---------------------------------------------------------------------------
// Happy path: withdrawal record
// ---------------------------------------------------------------------------

describe('_executeInternalTransfer — creates withdrawal record', () => {
  it('returns a withdrawal with type=internal, status=confirmed, correct amount and recipient', () => {
    const sender = makeCustomer('unit-int-wd-sender');
    const recipient = makeCustomer('unit-int-wd-recip');
    const acc = credit(sender.id, '300000');

    const wd = callTransfer({
      senderCustomerId: sender.id,
      recipientCustomerId: recipient.id,
      senderAccountId: acc.id,
      amountSats: 120000n,
      toAddress: 'bc1qtest-withdrawal-addr',
    });

    expect(wd.withdrawal_type).toBe('internal');
    expect(wd.status).toBe('confirmed');
    expect(wd.amount_raw).toBe('120000');
    expect(wd.fee_raw).toBe('0');
    expect(wd.psbt).toBeNull();
    expect(wd.tx_hash).toBeNull();
    expect(wd.recipient_customer_id).toBe(recipient.id);
    expect(wd.customer_id).toBe(sender.id);
    expect(wd.to_address).toBe('bc1qtest-withdrawal-addr');
  });
});

// ---------------------------------------------------------------------------
// Happy path: ledger balances
// ---------------------------------------------------------------------------

describe('_executeInternalTransfer — ledger atomicity', () => {
  it('debits sender and credits recipient by the exact transfer amount', () => {
    const sender = makeCustomer('unit-int-ledger-sender');
    const recipient = makeCustomer('unit-int-ledger-recip');
    const acc = credit(sender.id, '500000');

    const senderBefore = settledBalance(sender.id);
    const recipientBefore = settledBalance(recipient.id);

    callTransfer({
      senderCustomerId: sender.id,
      recipientCustomerId: recipient.id,
      senderAccountId: acc.id,
      amountSats: 200000n,
    });

    expect(settledBalance(sender.id)).toBe(senderBefore - 200000n);
    expect(settledBalance(recipient.id)).toBe(recipientBefore + 200000n);
  });
});

// ---------------------------------------------------------------------------
// Happy path: deposit record created for recipient
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Happy path: ticklers
// ---------------------------------------------------------------------------

describe('_executeInternalTransfer — ticklers', () => {
  it('records a withdrawal:internal_transfer tickler for the sender', () => {
    const sender = makeCustomer('unit-int-tick-w-sender');
    const recipient = makeCustomer('unit-int-tick-w-recip');
    const acc = credit(sender.id, '300000');

    const wd = callTransfer({
      senderCustomerId: sender.id,
      recipientCustomerId: recipient.id,
      senderAccountId: acc.id,
      amountSats: 60000n,
    });

    const row = getDb()
      .prepare("SELECT * FROM ticklers WHERE category = 'withdrawal' AND subcategory = 'internal_transfer' AND entity_id = ?")
      .get(wd.id) as any;

    expect(row).toBeDefined();
    expect(row.field3).toBe(sender.id);
    expect(row.field4).toBe(recipient.id);
  });

  it('records a deposit:internal_transfer tickler for the recipient deposit', () => {
    const sender = makeCustomer('unit-int-tick-d-sender');
    const recipient = makeCustomer('unit-int-tick-d-recip');
    const acc = credit(sender.id, '300000');

    const wd = callTransfer({
      senderCustomerId: sender.id,
      recipientCustomerId: recipient.id,
      senderAccountId: acc.id,
      amountSats: 60000n,
      toAddress: 'bc1qtickler-deposit-addr',
    });

    const { data: deposits } = customersService.getDeposits(TENANT, recipient.id);
    const dep = deposits.find((d: any) => d.tx_hash === `internal:${wd.id}`);
    expect(dep).toBeDefined();

    const row = getDb()
      .prepare("SELECT * FROM ticklers WHERE category = 'deposit' AND subcategory = 'internal_transfer' AND entity_id = ?")
      .get(dep.id) as any;

    expect(row).toBeDefined();
    expect(row.field3).toBe(recipient.id);
    expect(row.field4).toBe(wd.id);
    expect(row.field2).toBe('60000');
  });
});

// ---------------------------------------------------------------------------

describe('_executeInternalTransfer — deposit record for recipient', () => {
  it('creates a confirmed deposit visible in the recipient deposit list', () => {
    const sender = makeCustomer('unit-int-dep-sender');
    const recipient = makeCustomer('unit-int-dep-recip');
    const acc = credit(sender.id, '400000');

    const wd = callTransfer({
      senderCustomerId: sender.id,
      recipientCustomerId: recipient.id,
      senderAccountId: acc.id,
      amountSats: 80000n,
      toAddress: 'bc1qtest-deposit-addr',
    });

    const { data: deposits } = customersService.getDeposits(TENANT, recipient.id);
    const dep = deposits.find((d: any) => d.tx_hash === `internal:${wd.id}`);

    expect(dep).toBeDefined();
    expect(dep.amount_raw).toBe('80000');
    expect(dep.status).toBe('confirmed');
    expect(dep.customer_id).toBe(recipient.id);
    expect(dep.address).toBe('bc1qtest-deposit-addr');
    expect(dep.metadata?.internal_transfer).toBe(true);
    expect(dep.metadata?.sender_customer_id).toBe(sender.id);
  });

  it('deposit tx_hash is unique per transfer so repeated transfers do not collide', () => {
    const sender = makeCustomer('unit-int-dep2-sender');
    const recipient = makeCustomer('unit-int-dep2-recip');
    credit(sender.id, '600000');
    const acc = ledgerService.findAccountByCustomerAndAsset(TENANT, sender.id, 'bitcoin:BTC')!;

    const wd1 = callTransfer({
      senderCustomerId: sender.id,
      recipientCustomerId: recipient.id,
      senderAccountId: acc.id,
      amountSats: 100000n,
    });
    const wd2 = callTransfer({
      senderCustomerId: sender.id,
      recipientCustomerId: recipient.id,
      senderAccountId: acc.id,
      amountSats: 100000n,
    });

    expect(wd1.id).not.toBe(wd2.id);

    const { data: deposits } = customersService.getDeposits(TENANT, recipient.id);
    const hashes = deposits.map((d: any) => d.tx_hash);
    expect(hashes).toContain(`internal:${wd1.id}`);
    expect(hashes).toContain(`internal:${wd2.id}`);
  });
});
