import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { CustomerDocument, DocumentType, DocumentVerificationStatus } from './customers.types';

function mapDocument(row: any): CustomerDocument {
  return {
    id: row.id,
    customer_id: row.customer_id,
    tenant_id: row.tenant_id,
    document_type: row.document_type,
    document_subtype: row.document_subtype ?? null,
    storage_ref: row.storage_ref,
    storage_system: row.storage_system,
    issuing_country: row.issuing_country ?? null,
    issuing_authority: row.issuing_authority ?? null,
    issued_date: row.issued_date ?? null,
    expiry_date: row.expiry_date ?? null,
    document_number: row.document_number ?? null,
    linked_identifier_id: row.linked_identifier_id ?? null,
    verification_status: row.verification_status,
    verified_at: row.verified_at ?? null,
    verified_by: row.verified_by ?? null,
    rejection_reason: row.rejection_reason ?? null,
    file_hash: row.file_hash ?? null,
    uploaded_at: row.uploaded_at,
    uploaded_by: row.uploaded_by ?? null,
  };
}

function guardCustomer(tenantId: string, customerId: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT id FROM customers WHERE id = ? AND tenant_id = ?')
    .get(customerId, tenantId);
  if (!row) throw new NotFoundError('Customer', customerId);
}

function guardDocument(tenantId: string, customerId: string, documentId: string): any {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT * FROM customer_documents WHERE id = ? AND customer_id = ? AND tenant_id = ?'
    )
    .get(documentId, customerId, tenantId) as any;
  if (!row) throw new NotFoundError('CustomerDocument', documentId);
  return row;
}

export interface CreateDocumentInput {
  document_type: DocumentType;
  document_subtype?: string | null;
  storage_ref: string;
  storage_system: string;
  issuing_country?: string | null;
  issuing_authority?: string | null;
  issued_date?: string | null;
  expiry_date?: string | null;
  document_number?: string | null;
  linked_identifier_id?: string | null;
  verification_status?: DocumentVerificationStatus;
  verified_at?: string | null;
  verified_by?: string | null;
  file_hash?: string | null;
  uploaded_by?: string | null;
}

export interface UpdateDocumentInput {
  document_subtype?: string | null;
  storage_ref?: string;
  storage_system?: string;
  issuing_country?: string | null;
  issuing_authority?: string | null;
  issued_date?: string | null;
  expiry_date?: string | null;
  document_number?: string | null;
  linked_identifier_id?: string | null;
  verification_status?: DocumentVerificationStatus;
  verified_at?: string | null;
  verified_by?: string | null;
  rejection_reason?: string | null;
  file_hash?: string | null;
}

export const customersDocumentsService = {
  create(
    tenantId: string,
    customerId: string,
    input: CreateDocumentInput
  ): CustomerDocument {
    const db = getDb();
    guardCustomer(tenantId, customerId);

    if (input.linked_identifier_id) {
      const ident = db
        .prepare(
          'SELECT id FROM customer_identifiers WHERE id = ? AND customer_id = ? AND tenant_id = ?'
        )
        .get(input.linked_identifier_id, customerId, tenantId);
      if (!ident) throw new NotFoundError('CustomerIdentifier', input.linked_identifier_id);
    }

    const id = `doc_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO customer_documents (
        id, customer_id, tenant_id, document_type, document_subtype,
        storage_ref, storage_system, issuing_country, issuing_authority,
        issued_date, expiry_date, document_number, linked_identifier_id,
        verification_status, verified_at, verified_by, file_hash,
        uploaded_at, uploaded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, customerId, tenantId,
      input.document_type, input.document_subtype ?? null,
      input.storage_ref, input.storage_system,
      input.issuing_country ?? null, input.issuing_authority ?? null,
      input.issued_date ?? null, input.expiry_date ?? null,
      input.document_number ?? null, input.linked_identifier_id ?? null,
      input.verification_status ?? 'pending',
      input.verified_at ?? null, input.verified_by ?? null,
      input.file_hash ?? null, now,
      input.uploaded_by ?? null
    );

    return mapDocument(
      db.prepare('SELECT * FROM customer_documents WHERE id = ?').get(id)
    );
  },

  list(tenantId: string, customerId: string): CustomerDocument[] {
    const db = getDb();
    guardCustomer(tenantId, customerId);
    const rows = db
      .prepare(
        'SELECT * FROM customer_documents WHERE customer_id = ? AND tenant_id = ? ORDER BY uploaded_at DESC'
      )
      .all(customerId, tenantId) as any[];
    return rows.map(mapDocument);
  },

  update(
    tenantId: string,
    customerId: string,
    documentId: string,
    input: UpdateDocumentInput
  ): CustomerDocument {
    const db = getDb();
    guardDocument(tenantId, customerId, documentId);

    if (input.linked_identifier_id !== undefined && input.linked_identifier_id !== null) {
      const ident = db
        .prepare(
          'SELECT id FROM customer_identifiers WHERE id = ? AND customer_id = ? AND tenant_id = ?'
        )
        .get(input.linked_identifier_id, customerId, tenantId);
      if (!ident) throw new NotFoundError('CustomerIdentifier', input.linked_identifier_id);
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.document_subtype !== undefined)      { sets.push('document_subtype = ?');      params.push(input.document_subtype); }
    if (input.storage_ref !== undefined)           { sets.push('storage_ref = ?');           params.push(input.storage_ref); }
    if (input.storage_system !== undefined)        { sets.push('storage_system = ?');        params.push(input.storage_system); }
    if (input.issuing_country !== undefined)       { sets.push('issuing_country = ?');       params.push(input.issuing_country); }
    if (input.issuing_authority !== undefined)     { sets.push('issuing_authority = ?');     params.push(input.issuing_authority); }
    if (input.issued_date !== undefined)           { sets.push('issued_date = ?');           params.push(input.issued_date); }
    if (input.expiry_date !== undefined)           { sets.push('expiry_date = ?');           params.push(input.expiry_date); }
    if (input.document_number !== undefined)       { sets.push('document_number = ?');       params.push(input.document_number); }
    if (input.linked_identifier_id !== undefined)  { sets.push('linked_identifier_id = ?');  params.push(input.linked_identifier_id); }
    if (input.verification_status !== undefined)   { sets.push('verification_status = ?');   params.push(input.verification_status); }
    if (input.verified_at !== undefined)           { sets.push('verified_at = ?');           params.push(input.verified_at); }
    if (input.verified_by !== undefined)           { sets.push('verified_by = ?');           params.push(input.verified_by); }
    if (input.rejection_reason !== undefined)      { sets.push('rejection_reason = ?');      params.push(input.rejection_reason); }
    if (input.file_hash !== undefined)             { sets.push('file_hash = ?');             params.push(input.file_hash); }

    if (sets.length === 0) {
      return mapDocument(guardDocument(tenantId, customerId, documentId));
    }

    params.push(documentId, customerId, tenantId);
    db.prepare(
      `UPDATE customer_documents SET ${sets.join(', ')} WHERE id = ? AND customer_id = ? AND tenant_id = ?`
    ).run(...params);

    return mapDocument(
      db.prepare('SELECT * FROM customer_documents WHERE id = ?').get(documentId)
    );
  },

  delete(tenantId: string, customerId: string, documentId: string): void {
    const db = getDb();
    guardDocument(tenantId, customerId, documentId);
    db.prepare(
      'DELETE FROM customer_documents WHERE id = ? AND customer_id = ? AND tenant_id = ?'
    ).run(documentId, customerId, tenantId);
  },
};
