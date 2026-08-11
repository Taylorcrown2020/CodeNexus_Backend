-- ============================================================================
-- 001_customer_portal.sql — Diamondback Coding
--
-- Adds the four things the customer portal needs that this database does not
-- already have: client_messages, sales_agreements, service_requests, and the
-- portal_kind discriminator on leads.
--
-- Safe to run more than once. Every statement is IF NOT EXISTS or guarded.
--
--   psql "$DATABASE_URL" -f migrations/001_customer_portal.sql
--
-- WHY portal_kind EXISTS — READ THIS BEFORE RUNNING
--   This database has two different kinds of "client" in the leads table:
--     * CodeNexus CRM subscribers, who sign in at /api/client/login and reach
--       the CRM API (/api/client/leads, /api/client/company/add-user, ...)
--     * Customer-portal users, who sign in at /api/portal/login and reach only
--       their own invoices, messages, and agreements.
--   Both have client_password set, so without a discriminator either one's
--   token would open the other's data. portal_kind is that discriminator.
--
--   The default below is 'crm', which means EVERY EXISTING ACCOUNT stays a CRM
--   subscriber and NOBODY can sign in to the customer portal until you say so.
--   That is deliberate — it fails closed. Promote real customers explicitly:
--
--     UPDATE leads SET portal_kind = 'customer' WHERE email = 'them@example.com';
--     UPDATE leads SET portal_kind = 'both'     WHERE email = 'you@example.com';
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------- leads flags
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'leads' AND column_name = 'portal_kind') THEN
        ALTER TABLE leads ADD COLUMN portal_kind VARCHAR(20) DEFAULT 'crm';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'leads' AND column_name = 'portal_last_login') THEN
        ALTER TABLE leads ADD COLUMN portal_last_login TIMESTAMP;
    END IF;
END $$;

-- Reject anything outside the three known values, so a typo can't quietly
-- create an account that no login route will ever accept.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_portal_kind_chk') THEN
        ALTER TABLE leads ADD CONSTRAINT leads_portal_kind_chk
            CHECK (portal_kind IS NULL OR portal_kind IN ('crm', 'customer', 'both'));
    END IF;
END $$;

-- ------------------------------------------------------------ client_messages
-- The customer <-> staff thread. `sender` is 'client' or 'admin'; `kind` is
-- 'message' for the thread and 'marketing' for broadcast cards.
CREATE TABLE IF NOT EXISTS client_messages (
    id              SERIAL PRIMARY KEY,
    lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    request_id      INTEGER,
    sender          VARCHAR(10) NOT NULL,
    kind            VARCHAR(20) DEFAULT 'message',
    subject         VARCHAR(200),
    body            TEXT NOT NULL,
    read_by_admin   BOOLEAN DEFAULT FALSE,
    read_by_client  BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_client_messages_lead    ON client_messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_messages_created ON client_messages(created_at DESC);
-- Powers the admin unread badge without scanning the table.
CREATE INDEX IF NOT EXISTS idx_client_messages_unread
    ON client_messages(lead_id) WHERE read_by_admin = FALSE;

-- ----------------------------------------------------------- service_requests
-- `project` is the Diamondback-facing column name. `vehicle` is kept as a
-- nullable alias because the ported Crown handlers still write to it; the
-- customer portal front end sends both. Drop `vehicle` once nothing reads it.
CREATE TABLE IF NOT EXISTS service_requests (
    id              SERIAL PRIMARY KEY,
    lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    service_type    VARCHAR(120),
    project         VARCHAR(200),
    vehicle         VARCHAR(200),
    preferred_date  DATE,
    details         TEXT,
    status          VARCHAR(40) DEFAULT 'new',
    admin_response  TEXT,
    responded_at    TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'service_requests' AND column_name = 'project') THEN
        ALTER TABLE service_requests ADD COLUMN project VARCHAR(200);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'service_requests' AND column_name = 'admin_response') THEN
        ALTER TABLE service_requests ADD COLUMN admin_response TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'service_requests' AND column_name = 'responded_at') THEN
        ALTER TABLE service_requests ADD COLUMN responded_at TIMESTAMP;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_service_requests_lead   ON service_requests(lead_id);
CREATE INDEX IF NOT EXISTS idx_service_requests_status ON service_requests(status);

-- ----------------------------------------------------------- sales_agreements
CREATE TABLE IF NOT EXISTS sales_agreements (
    id                  SERIAL PRIMARY KEY,
    agreement_number    VARCHAR(40) UNIQUE,
    lead_id             INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    customer_name       VARCHAR(255),
    customer_email      VARCHAR(255),
    service_type        VARCHAR(60),
    package_name        VARCHAR(160),
    project             VARCHAR(200),
    vehicle             VARCHAR(200),
    price               NUMERIC(10,2) DEFAULT 0,
    deposit             NUMERIC(10,2) DEFAULT 0,
    deposit_pct         NUMERIC(5,2)  DEFAULT 0,
    require_deposit     BOOLEAN DEFAULT FALSE,
    invoice_id          INTEGER,
    balance_invoice_id  INTEGER,
    start_date          DATE,
    status              VARCHAR(40) DEFAULT 'draft',
    terms               TEXT,
    notes               TEXT,
    signed_at           TIMESTAMP,
    signature_name      VARCHAR(255),
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'sales_agreements' AND column_name = 'project') THEN
        ALTER TABLE sales_agreements ADD COLUMN project VARCHAR(200);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'sales_agreements' AND column_name = 'deposit_pct') THEN
        ALTER TABLE sales_agreements ADD COLUMN deposit_pct NUMERIC(5,2) DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'sales_agreements' AND column_name = 'require_deposit') THEN
        ALTER TABLE sales_agreements ADD COLUMN require_deposit BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'sales_agreements' AND column_name = 'invoice_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN invoice_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'sales_agreements' AND column_name = 'balance_invoice_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN balance_invoice_id INTEGER;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_agreements_lead   ON sales_agreements(lead_id);
CREATE INDEX IF NOT EXISTS idx_sales_agreements_status ON sales_agreements(status);

-- ---------------------------------------------------------------- appointments
CREATE TABLE IF NOT EXISTS appointments (
    id              SERIAL PRIMARY KEY,
    lead_email      VARCHAR(255),
    lead_name       VARCHAR(255),
    scheduled_time  TIMESTAMP,
    event_type      VARCHAR(80) DEFAULT 'consultation',
    status          VARCHAR(40) DEFAULT 'scheduled',
    notes           TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_appointments_time ON appointments(scheduled_time);

-- ------------------------------------------------- invoices: Stripe intent id
-- Written by /api/portal/invoices/:id/payment-intent and read by
-- confirm-paid, so a duplicate submit can't double-charge.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'invoices' AND column_name = 'stripe_payment_intent_id') THEN
        ALTER TABLE invoices ADD COLUMN stripe_payment_intent_id VARCHAR(255);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_stripe_pi
    ON invoices(stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

-- --------------------------------------------------------- SMS marketing auto
CREATE TABLE IF NOT EXISTS sms_marketing_auto (
    id           SERIAL PRIMARY KEY,
    lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    step         INTEGER DEFAULT 0,
    next_send_at TIMESTAMP,
    status       VARCHAR(30) DEFAULT 'active',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sms_marketing_auto_due
    ON sms_marketing_auto(next_send_at) WHERE status = 'active';

COMMIT;

-- ============================================================================
-- Verify:
--   SELECT portal_kind, COUNT(*) FROM leads GROUP BY portal_kind;
--   \d client_messages
-- ============================================================================