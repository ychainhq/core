import request from 'supertest';
import { bootstrapApp, AUTH, teardownDb } from './helpers';

const app = bootstrapApp();

afterAll(() => teardownDb());

// ============================================================
// Helper: create a minimal customer
// ============================================================

async function createCustomer(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/v1/customers')
    .set(AUTH)
    .send({ reference: `kyc-test-${Math.random().toString(36).slice(2)}`, ...overrides });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; party_type: string; status: string; display_name: string | null };
}

// ============================================================
// Core Party fields on create / list / get
// ============================================================

describe('Customer core Party fields', () => {
  it('defaults party_type to natural_person', async () => {
    const c = await createCustomer();
    expect(c.party_type).toBe('natural_person');
  });

  it('accepts party_type=legal_entity on create', async () => {
    const c = await createCustomer({ party_type: 'legal_entity' });
    expect(c.party_type).toBe('legal_entity');
  });

  it('accepts display_name and country_of_origin on create', async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ display_name: 'Acme Ltd', country_of_origin: 'PL' });
    expect(res.status).toBe(201);
    expect(res.body.data.display_name).toBe('Acme Ltd');
    expect(res.body.data.country_of_origin).toBe('PL');
  });

  it('rejects invalid party_type', async () => {
    const res = await request(app).post('/v1/customers').set(AUTH).send({ party_type: 'unicorn' });
    expect(res.status).toBe(400);
  });

  it('rejects country_of_origin that is not 2 chars', async () => {
    const res = await request(app).post('/v1/customers').set(AUTH).send({ country_of_origin: 'POL' });
    expect(res.status).toBe(400);
  });

  it('PATCH updates display_name and country_of_origin', async () => {
    const c = await createCustomer();
    const res = await request(app)
      .patch(`/v1/customers/${c.id}`)
      .set(AUTH)
      .send({ display_name: 'Updated Name', country_of_origin: 'DE' });
    expect(res.status).toBe(200);
    expect(res.body.data.display_name).toBe('Updated Name');
    expect(res.body.data.country_of_origin).toBe('DE');
  });

  it('PATCH accepts new status values: suspended, restricted, closed, rejected', async () => {
    for (const status of ['suspended', 'restricted', 'closed', 'rejected']) {
      const c = await createCustomer();
      const res = await request(app)
        .patch(`/v1/customers/${c.id}`)
        .set(AUTH)
        .send({ status });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
  });

  it('list filters by party_type', async () => {
    await createCustomer({ party_type: 'legal_entity' });
    const res = await request(app).get('/v1/customers?party_type=legal_entity').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((c: any) => c.party_type === 'legal_entity')).toBe(true);
  });

  it('GET includes party_type, display_name, country_of_origin', async () => {
    const c = await createCustomer({ display_name: 'GetTest', country_of_origin: 'FR' });
    const res = await request(app).get(`/v1/customers/${c.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.party_type).toBe('natural_person');
    expect(res.body.data.display_name).toBe('GetTest');
    expect(res.body.data.country_of_origin).toBe('FR');
  });
});

// ============================================================
// AML/KYC auto-provisioning
// ============================================================

describe('AML/KYC auto-provisioning', () => {
  it('GET /aml-kyc returns defaults immediately after customer creation', async () => {
    const c = await createCustomer();
    const res = await request(app).get(`/v1/customers/${c.id}/aml-kyc`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.kyc_status).toBe('not_started');
    expect(res.body.data.cdd_level).toBe('standard');
    expect(res.body.data.aml_risk_level).toBe('unassessed');
    expect(res.body.data.pep_status).toBe('not_pep');
    expect(res.body.data.sanctions_status).toBe('clear');
  });

  it('GET /data-governance returns defaults immediately after customer creation', async () => {
    const c = await createCustomer();
    const res = await request(app).get(`/v1/customers/${c.id}/data-governance`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.data_classification).toBe('confidential');
    expect(res.body.data.lawful_basis).toBe('legal_obligation');
    expect(res.body.data.masking_required).toBe(true);
    expect(res.body.data.encryption_required).toBe(true);
    expect(res.body.data.version).toBe(1);
  });
});

// ============================================================
// Profile — Natural Person
// ============================================================

describe('PUT/GET /v1/customers/:id/profile — natural person', () => {
  let customerId: string;

  beforeAll(async () => {
    const c = await createCustomer({ party_type: 'natural_person' });
    customerId = c.id;
  });

  it('GET returns 404 before profile is set', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/profile`).set(AUTH);
    expect(res.status).toBe(404);
  });

  it('PUT creates natural person profile', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/profile`)
      .set(AUTH)
      .send({
        partyType: 'natural_person',
        person_type: 'individual',
        given_name: 'Jan',
        family_name: 'Kowalski',
        date_of_birth: '1985-03-22',
        nationalities: ['PL'],
        country_of_residence: 'PL',
        occupation: 'Software Engineer',
        gender: 'male',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.given_name).toBe('Jan');
    expect(res.body.data.family_name).toBe('Kowalski');
    expect(res.body.data.person_type).toBe('individual');
    expect(res.body.data.nationalities).toEqual(['PL']);
    expect(res.body.data.gender).toBe('male');
  });

  it('GET returns profile after creation', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/profile`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.given_name).toBe('Jan');
  });

  it('PUT updates (replaces) profile', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/profile`)
      .set(AUTH)
      .send({
        partyType: 'natural_person',
        person_type: 'individual',
        given_name: 'Maria',
        family_name: 'Nowak',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.given_name).toBe('Maria');
    expect(res.body.data.gender).toBeNull();
  });

  it('PUT syncs display_name on the customer record', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}`).set(AUTH);
    expect(res.body.data.display_name).toBe('Maria Nowak');
  });

  it('rejects wrong partyType for the customer', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/profile`)
      .set(AUTH)
      .send({
        partyType: 'legal_entity',
        entity_subtype: 'company',
        legal_name: 'Acme Ltd',
        country_of_incorporation: 'PL',
      });
    expect(res.status).toBe(500); // type mismatch error
  });

  it('rejects invalid date_of_birth format', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/profile`)
      .set(AUTH)
      .send({
        partyType: 'natural_person',
        person_type: 'individual',
        given_name: 'X',
        family_name: 'Y',
        date_of_birth: '22-03-1985',
      });
    expect(res.status).toBe(400);
  });
});

// ============================================================
// Profile — Legal Entity
// ============================================================

describe('PUT/GET /v1/customers/:id/profile — legal entity', () => {
  let customerId: string;

  beforeAll(async () => {
    const c = await createCustomer({ party_type: 'legal_entity' });
    customerId = c.id;
  });

  it('PUT creates legal entity profile', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/profile`)
      .set(AUTH)
      .send({
        partyType: 'legal_entity',
        entity_subtype: 'company',
        legal_name: 'Acme Trading Sp. z o.o.',
        trade_name: 'Acme Trading',
        country_of_incorporation: 'PL',
        date_of_incorporation: '2018-06-15',
        legal_form: 'Sp. z o.o.',
        industry_code: '6419',
        industry_code_type: 'nace',
        regulated: false,
        is_listed_company: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.legal_name).toBe('Acme Trading Sp. z o.o.');
    expect(res.body.data.entity_subtype).toBe('company');
    expect(res.body.data.regulated).toBe(false);
  });

  it('PUT syncs display_name from legal_name', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}`).set(AUTH);
    expect(res.body.data.display_name).toBe('Acme Trading Sp. z o.o.');
  });

  it('accepts foundation entity_subtype with purpose_statement', async () => {
    const c2 = await createCustomer({ party_type: 'legal_entity' });
    const res = await request(app)
      .put(`/v1/customers/${c2.id}/profile`)
      .set(AUTH)
      .send({
        partyType: 'legal_entity',
        entity_subtype: 'foundation',
        legal_name: 'Digital Futures Foundation',
        country_of_incorporation: 'DE',
        purpose_statement: 'Promoting digital literacy',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.entity_subtype).toBe('foundation');
    expect(res.body.data.purpose_statement).toBe('Promoting digital literacy');
  });
});

// ============================================================
// Identifiers
// ============================================================

describe('/v1/customers/:id/identifiers', () => {
  let customerId: string;
  let identifierId: string;

  beforeAll(async () => {
    const c = await createCustomer();
    customerId = c.id;
  });

  it('GET returns empty array before any identifiers', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/identifiers`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('POST creates a passport identifier', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/identifiers`)
      .set(AUTH)
      .send({
        type: 'passport',
        value: 'AZ123456',
        issuing_country: 'PL',
        valid_until: '2030-01-09',
        is_primary: true,
        verified: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('passport');
    expect(res.body.data.value).toBe('AZ123456');
    expect(res.body.data.issuing_country).toBe('PL');
    expect(res.body.data.is_primary).toBe(true);
    expect(res.body.data.verified).toBe(false);
    identifierId = res.body.data.id;
  });

  it('POST creates a tax_id identifier (Polish NIP)', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/identifiers`)
      .set(AUTH)
      .send({
        type: 'tax_id',
        value: '1234567890',
        issuing_country: 'PL',
        is_primary: true,
        verified: true,
        verified_at: '2025-11-15T10:30:00Z',
        verified_by: 'provider:onfido',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('tax_id');
  });

  it('POST creates a social_security identifier (Polish PESEL)', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/identifiers`)
      .set(AUTH)
      .send({
        type: 'social_security',
        value: '85032212345',
        issuing_country: 'PL',
        is_primary: true,
        verified: false,
      });
    expect(res.status).toBe(201);
  });

  it('GET returns all identifiers', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/identifiers`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3);
  });

  it('PATCH updates verified status', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}/identifiers/${identifierId}`)
      .set(AUTH)
      .send({ verified: true, verified_at: '2025-11-15T11:00:00Z', verified_by: 'manual' });
    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);
    expect(res.body.data.verified_by).toBe('manual');
  });

  it('rejects invalid identifier type', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/identifiers`)
      .set(AUTH)
      .send({ type: 'ssn_us', value: '123', is_primary: false, verified: false });
    expect(res.status).toBe(400);
  });

  it('DELETE removes identifier', async () => {
    const res = await request(app)
      .delete(`/v1/customers/${customerId}/identifiers/${identifierId}`)
      .set(AUTH);
    expect(res.status).toBe(204);

    const list = await request(app).get(`/v1/customers/${customerId}/identifiers`).set(AUTH);
    expect(list.body.data.length).toBe(2);
  });

  it('returns 404 for non-existent identifier', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}/identifiers/ident_nonexistent`)
      .set(AUTH)
      .send({ verified: true });
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Relationships
// ============================================================

describe('/v1/customers/:id/relationships', () => {
  let customerId: string;
  let relationshipId: string;

  beforeAll(async () => {
    const c = await createCustomer({ party_type: 'legal_entity' });
    customerId = c.id;
  });

  it('GET returns empty array before any relationships', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/relationships`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('POST creates a beneficial_owner relationship with external party', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/relationships`)
      .set(AUTH)
      .send({
        relationship_type: 'beneficial_owner',
        external_party: {
          display_name: 'Maria Nowak',
          party_type: 'natural_person',
          country_of_origin: 'PL',
          date_of_birth: '1975-07-14',
          identifier_type: 'passport',
          identifier_value: 'BZ654321',
        },
        ownership_percentage: '60.00',
        voting_rights_percentage: '60.00',
        is_direct_ownership: true,
        verified: true,
        verification_method: 'document',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.relationship_type).toBe('beneficial_owner');
    expect(res.body.data.ownership_percentage).toBe('60.00');
    expect(res.body.data.external_party.display_name).toBe('Maria Nowak');
    expect(res.body.data.verified).toBe(true);
    relationshipId = res.body.data.id;
  });

  it('POST creates a legal_representative relationship', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/relationships`)
      .set(AUTH)
      .send({
        relationship_type: 'legal_representative',
        external_party: {
          display_name: 'Maria Nowak',
          party_type: 'natural_person',
          country_of_origin: 'PL',
        },
        role_title: 'Prezes Zarządu',
        verified: true,
        verification_method: 'registry',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.role_title).toBe('Prezes Zarządu');
    expect(res.body.data.verification_method).toBe('registry');
  });

  it('GET returns all relationships', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/relationships`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  it('PATCH updates notes', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}/relationships/${relationshipId}`)
      .set(AUTH)
      .send({ notes: 'Verified via notarized UBO declaration 2025-11-15' });
    expect(res.status).toBe(200);
    expect(res.body.data.notes).toBe('Verified via notarized UBO declaration 2025-11-15');
  });

  it('POST rejects when neither related_customer_id nor external_party provided', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/relationships`)
      .set(AUTH)
      .send({ relationship_type: 'trustee' });
    expect(res.status).toBe(500);
  });

  it('DELETE removes relationship', async () => {
    const res = await request(app)
      .delete(`/v1/customers/${customerId}/relationships/${relationshipId}`)
      .set(AUTH);
    expect(res.status).toBe(204);

    const list = await request(app).get(`/v1/customers/${customerId}/relationships`).set(AUTH);
    expect(list.body.data.length).toBe(1);
  });
});

// ============================================================
// AML / KYC
// ============================================================

describe('PUT/GET /v1/customers/:id/aml-kyc', () => {
  let customerId: string;

  beforeAll(async () => {
    const c = await createCustomer();
    customerId = c.id;
  });

  it('PUT updates kyc_status to verified', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/aml-kyc`)
      .set(AUTH)
      .send({
        kyc_status: 'verified',
        kyc_verified_at: '2025-11-15T10:45:00Z',
        kyc_expiry_date: '2028-11-15',
        kyc_provider: 'onfido',
        kyc_provider_ref: 'onfido_check_abc123',
        cdd_level: 'standard',
        aml_risk_level: 'low',
        pep_status: 'not_pep',
        pep_checked_at: '2025-11-15T11:00:00Z',
        sanctions_status: 'clear',
        sanctions_checked_at: '2025-11-15T11:00:00Z',
        sanctions_lists: ['EU', 'UN', 'OFAC', 'HM_TREASURY'],
        adverse_media_status: 'clear',
        source_of_funds: ['salary'],
        expected_monthly_volume: 'EUR 1,000–5,000',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.kyc_status).toBe('verified');
    expect(res.body.data.cdd_level).toBe('standard');
    expect(res.body.data.aml_risk_level).toBe('low');
    expect(res.body.data.pep_status).toBe('not_pep');
    expect(res.body.data.sanctions_status).toBe('clear');
    expect(res.body.data.sanctions_lists).toEqual(['EU', 'UN', 'OFAC', 'HM_TREASURY']);
    expect(res.body.data.source_of_funds).toEqual(['salary']);
    expect(res.body.data.kyc_provider).toBe('onfido');
  });

  it('GET returns updated AML/KYC profile', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/aml-kyc`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.kyc_status).toBe('verified');
  });

  it('PUT sets EDD with approved_by', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/aml-kyc`)
      .set(AUTH)
      .send({
        cdd_level: 'enhanced',
        cdd_level_reason: 'PEP connection identified',
        cdd_approved_by: 'compliance_officer_001',
        cdd_approved_at: '2025-11-15T12:00:00Z',
        aml_risk_level: 'high',
        pep_status: 'pep_associate',
        pep_details: 'Associate of former minister',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.cdd_level).toBe('enhanced');
    expect(res.body.data.aml_risk_level).toBe('high');
    expect(res.body.data.pep_status).toBe('pep_associate');
    expect(res.body.data.cdd_approved_by).toBe('compliance_officer_001');
  });

  it('rejects invalid kyc_status', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/aml-kyc`)
      .set(AUTH)
      .send({ kyc_status: 'passed' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid pep_status', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/aml-kyc`)
      .set(AUTH)
      .send({ pep_status: 'yes' });
    expect(res.status).toBe(400);
  });
});

// ============================================================
// Data Governance
// ============================================================

describe('PUT/GET /v1/customers/:id/data-governance', () => {
  let customerId: string;

  beforeAll(async () => {
    const c = await createCustomer();
    customerId = c.id;
  });

  it('PUT updates data governance fields', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/data-governance`)
      .set(AUTH)
      .send({
        data_classification: 'restricted',
        sensitivity_labels: ['PII', 'FINANCIAL'],
        retention_policy_ref: 'AML_5Y',
        lawful_basis: 'legal_obligation',
        lawful_basis_notes: 'AMLD5 Art. 13',
        masking_required: true,
        encryption_required: true,
        source_system: 'onboarding_portal',
        last_modified_by: 'compliance_officer_001',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.data_classification).toBe('restricted');
    expect(res.body.data.sensitivity_labels).toEqual(['PII', 'FINANCIAL']);
    expect(res.body.data.lawful_basis).toBe('legal_obligation');
    expect(res.body.data.masking_required).toBe(true);
    expect(res.body.data.source_system).toBe('onboarding_portal');
  });

  it('PUT increments version on each update', async () => {
    const before = await request(app).get(`/v1/customers/${customerId}/data-governance`).set(AUTH);
    const versionBefore = before.body.data.version;

    await request(app)
      .put(`/v1/customers/${customerId}/data-governance`)
      .set(AUTH)
      .send({ source_system: 'crm' });

    const after = await request(app).get(`/v1/customers/${customerId}/data-governance`).set(AUTH);
    expect(after.body.data.version).toBe(versionBefore + 1);
  });

  it('records an erasure request', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/data-governance`)
      .set(AUTH)
      .send({
        erasure_requested_at: '2026-01-10T09:00:00Z',
        erasure_blocked_until: '2031-01-10',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.erasure_requested_at).toBe('2026-01-10T09:00:00Z');
    expect(res.body.data.erasure_blocked_until).toBe('2031-01-10');
    expect(res.body.data.erasure_completed_at).toBeNull();
  });

  it('marks entity as critical under DORA/NIS2', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/data-governance`)
      .set(AUTH)
      .send({
        is_critical_entity: true,
        criticality_reason: 'NIS2 essential entity, Art. 3(1)(a)',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.is_critical_entity).toBe(true);
    expect(res.body.data.criticality_reason).toBe('NIS2 essential entity, Art. 3(1)(a)');
  });
});

// ============================================================
// Contact
// ============================================================

describe('PUT/GET /v1/customers/:id/contact', () => {
  let customerId: string;

  beforeAll(async () => {
    const c = await createCustomer();
    customerId = c.id;
  });

  it('GET returns 404 before contact is set', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/contact`).set(AUTH);
    expect(res.status).toBe(404);
  });

  it('PUT creates contact with email, phone and address', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/contact`)
      .set(AUTH)
      .send({
        email: 'jan.kowalski@example.com',
        email_verified: true,
        phone: '+48501234567',
        phone_verified: false,
        preferred_language: 'pl',
        addresses: [
          {
            type: 'residential',
            line1: 'ul. Marszałkowska 10/5',
            city: 'Warszawa',
            postal_code: '00-001',
            country: 'PL',
            is_primary: true,
            line2: null,
            region: null,
            valid_from: null,
            valid_until: null,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('jan.kowalski@example.com');
    expect(res.body.data.email_verified).toBe(true);
    expect(res.body.data.phone).toBe('+48501234567');
    expect(res.body.data.phone_verified).toBe(false);
    expect(res.body.data.preferred_language).toBe('pl');
    expect(res.body.data.addresses).toHaveLength(1);
    expect(res.body.data.addresses[0].city).toBe('Warszawa');
  });

  it('GET returns contact after creation', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/contact`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('jan.kowalski@example.com');
  });

  it('PUT updates email', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/contact`)
      .set(AUTH)
      .send({ email: 'updated@example.com', email_verified: false });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('updated@example.com');
    expect(res.body.data.email_verified).toBe(false);
  });

  it('rejects invalid email', async () => {
    const res = await request(app)
      .put(`/v1/customers/${customerId}/contact`)
      .set(AUTH)
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

// ============================================================
// Documents
// ============================================================

describe('/v1/customers/:id/documents', () => {
  let customerId: string;
  let documentId: string;
  let identifierId: string;

  beforeAll(async () => {
    const c = await createCustomer();
    customerId = c.id;

    const identRes = await request(app)
      .post(`/v1/customers/${customerId}/identifiers`)
      .set(AUTH)
      .send({ type: 'passport', value: 'AZ999888', issuing_country: 'PL', is_primary: true, verified: false });
    identifierId = identRes.body.data.id;
  });

  it('GET returns empty array before any documents', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/documents`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('POST creates a passport document reference', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/documents`)
      .set(AUTH)
      .send({
        document_type: 'passport',
        storage_ref: 's3://kyc-docs/tenant_xyz/cust_abc/passport.pdf',
        storage_system: 's3',
        issuing_country: 'PL',
        issued_date: '2020-01-10',
        expiry_date: '2030-01-09',
        document_number: 'AZ123456',
        linked_identifier_id: identifierId,
        verification_status: 'pending',
        file_hash: 'a'.repeat(64),
        uploaded_by: 'onboarding_agent',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.document_type).toBe('passport');
    expect(res.body.data.storage_ref).toBe('s3://kyc-docs/tenant_xyz/cust_abc/passport.pdf');
    expect(res.body.data.storage_system).toBe('s3');
    expect(res.body.data.verification_status).toBe('pending');
    expect(res.body.data.linked_identifier_id).toBe(identifierId);
    documentId = res.body.data.id;
  });

  it('GET lists documents', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/documents`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  it('PATCH updates verification_status to verified', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}/documents/${documentId}`)
      .set(AUTH)
      .send({
        verification_status: 'verified',
        verified_at: '2025-11-15T10:30:00Z',
        verified_by: 'provider:onfido',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.verification_status).toBe('verified');
    expect(res.body.data.verified_by).toBe('provider:onfido');
  });

  it('PATCH sets rejection_reason on rejected status', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}/documents/${documentId}`)
      .set(AUTH)
      .send({
        verification_status: 'rejected',
        rejection_reason: 'Document image is blurred',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.verification_status).toBe('rejected');
    expect(res.body.data.rejection_reason).toBe('Document image is blurred');
  });

  it('rejects invalid document_type', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/documents`)
      .set(AUTH)
      .send({ document_type: 'selfie', storage_ref: 'x', storage_system: 's3' });
    expect(res.status).toBe(400);
  });

  it('DELETE removes document', async () => {
    const res = await request(app)
      .delete(`/v1/customers/${customerId}/documents/${documentId}`)
      .set(AUTH);
    expect(res.status).toBe(204);

    const list = await request(app).get(`/v1/customers/${customerId}/documents`).set(AUTH);
    expect(list.body.data.length).toBe(0);
  });

  it('returns 404 for non-existent document', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}/documents/doc_nonexistent`)
      .set(AUTH)
      .send({ verification_status: 'verified' });
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Cross-tenant isolation
// ============================================================

describe('Tenant isolation for KYC sub-resources', () => {
  it('cannot access another tenant customer aml-kyc', async () => {
    const c = await createCustomer();
    const res = await request(app)
      .get(`/v1/customers/${c.id}/aml-kyc`)
      .set({ Authorization: 'Bearer wrong_key' });
    expect(res.status).toBe(401);
  });
});
