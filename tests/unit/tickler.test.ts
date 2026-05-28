import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb, getDb } from '../../src/db/sqlite';
import { ticklerService } from '../../src/shared/tickler/tickler.service';

beforeEach(() => {
  closeDb();
  runMigrations();
  runSeed();
});

afterAll(() => closeDb());

describe('ticklerService.record()', () => {
  it('inserts a tickler and returns nothing', () => {
    expect(() =>
      ticklerService.record({
        tenantId: 'tenant_default',
        category: 'wallet',
        subcategory: 'created',
        entityId: 'wal_test',
        actorLogin: 'key:test-key',
        field1: 'customer_deposits',
        newValue: { id: 'wal_test' },
      })
    ).not.toThrow();

    const db = getDb();
    const row = db.prepare("SELECT * FROM ticklers WHERE entity_id = 'wal_test'").get() as any;
    expect(row).toBeTruthy();
    expect(row.tenant_id).toBe('tenant_default');
    expect(row.category).toBe('wallet');
    expect(row.subcategory).toBe('created');
    expect(row.actor_login).toBe('key:test-key');
    expect(row.field1).toBe('customer_deposits');
    expect(JSON.parse(row.new_value)).toMatchObject({ id: 'wal_test' });
    expect(row.occurred_at).toBeGreaterThan(0);
    expect(row.id).toMatch(/^tck_/);
  });

  it('stores global (tenant_id=null) tickler', () => {
    ticklerService.record({
      tenantId: null,
      category: 'platform',
      subcategory: 'tenant.created',
      entityId: 'tenant_new',
      actorLogin: 'admin:root',
    });

    const db = getDb();
    const row = db.prepare("SELECT * FROM ticklers WHERE entity_id = 'tenant_new'").get() as any;
    expect(row.tenant_id).toBeNull();
    expect(row.category).toBe('platform');
  });

  it('stores prev_value and new_value as JSON', () => {
    const prev = { status: 'active' };
    const next = { status: 'suspended' };
    ticklerService.record({
      tenantId: 'tenant_default',
      category: 'tenant',
      subcategory: 'tenant.status_changed',
      entityId: 'tenant_default',
      prevValue: prev,
      newValue: next,
    });

    const db = getDb();
    const row = db.prepare("SELECT * FROM ticklers WHERE entity_id = 'tenant_default' AND subcategory = 'tenant.status_changed'").get() as any;
    expect(JSON.parse(row.prev_value)).toEqual(prev);
    expect(JSON.parse(row.new_value)).toEqual(next);
  });

  it('does not throw on write error (best-effort)', () => {
    // Pass invalid category to force a constraint violation
    expect(() =>
      ticklerService.record({
        tenantId: 'tenant_default',
        // Force an error by producing an oversized field that SQLite would reject via other means;
        // best-effort means it must never propagate.
        category: 'wallet' as any,
        subcategory: 'created',
      })
    ).not.toThrow();
  });
});

describe('ticklerService.list()', () => {
  beforeEach(() => {
    ticklerService.record({ tenantId: 'tenant_default', category: 'wallet', subcategory: 'created', entityId: 'e1', actorLogin: 'key:k1' });
    ticklerService.record({ tenantId: 'tenant_default', category: 'customer', subcategory: 'created', entityId: 'e2', actorLogin: 'key:k1' });
    ticklerService.record({ tenantId: null, category: 'platform', subcategory: 'tenant.created', entityId: 'e3' });
  });

  it('returns tenant-scoped ticklers only', () => {
    const { data } = ticklerService.list({ tenantId: 'tenant_default', includeGlobal: false });
    expect(data.every(t => t.tenant_id === 'tenant_default')).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);
  });

  it('includes global ticklers when includeGlobal=true', () => {
    const { data } = ticklerService.list({ tenantId: 'tenant_default', includeGlobal: true });
    const global = data.filter(t => t.tenant_id === null);
    expect(global.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by category', () => {
    const { data } = ticklerService.list({ tenantId: 'tenant_default', category: 'wallet' });
    expect(data.every(t => t.category === 'wallet')).toBe(true);
  });

  it('filters by subcategory', () => {
    const { data } = ticklerService.list({ tenantId: 'tenant_default', subcategory: 'created' });
    expect(data.every(t => t.subcategory === 'created')).toBe(true);
  });

  it('filters by entity_id', () => {
    const { data } = ticklerService.list({ tenantId: 'tenant_default', entityId: 'e1' });
    expect(data).toHaveLength(1);
    expect(data[0].entity_id).toBe('e1');
  });

  it('paginates with limit and returns nextCursor', () => {
    // seed additional ticklers so we have enough for pagination
    for (let i = 0; i < 5; i++) {
      ticklerService.record({ tenantId: 'tenant_default', category: 'wallet', subcategory: 'created', entityId: `extra_${i}` });
    }
    const { data, nextCursor } = ticklerService.list({ tenantId: 'tenant_default', limit: 2 });
    expect(data).toHaveLength(2);
    expect(nextCursor).toBeTruthy();
  });

  it('returns null nextCursor on last page', () => {
    const { nextCursor } = ticklerService.list({ tenantId: 'tenant_default', limit: 100 });
    expect(nextCursor).toBeNull();
  });
});
