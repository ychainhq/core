export type TicklerCategory =
  | 'platform'
  | 'tenant'
  | 'customer'
  | 'wallet'
  | 'address'
  | 'payment_request'
  | 'deposit'
  | 'transaction'
  | 'ledger'
  | 'webhook'
  | 'withdrawal'
  | 'withdrawal_batch'
  | 'signing_task'
  | 'external_signer'
  | 'sweep';

export interface TicklerPayload {
  tenantId: string | null;
  category: TicklerCategory;
  subcategory: string;
  entityId?: string | null;
  actorLogin?: string | null;
  field1?: string | null;
  field2?: string | null;
  field3?: string | null;
  field4?: string | null;
  field5?: string | null;
  prevValue?: unknown;
  newValue?: unknown;
}

export interface TicklerRecord {
  id: string;
  occurred_at: number;
  tenant_id: string | null;
  category: string;
  subcategory: string;
  entity_id: string | null;
  actor_login: string | null;
  field1: string | null;
  field2: string | null;
  field3: string | null;
  field4: string | null;
  field5: string | null;
  prev_value: unknown | null;
  new_value: unknown | null;
}
