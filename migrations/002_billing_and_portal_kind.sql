-- ============================================================================
-- 002_billing_and_portal_kind.sql — Diamondback Coding
--
-- Run AFTER 001_customer_portal.sql:
--     psql "$DATABASE_URL" -f migrations/002_billing_and_portal_kind.sql
--
-- Safe to run repeatedly. Every statement is IF NOT EXISTS or guarded.
--
-- WHAT THIS DOES
--   1. Repairs portal_kind. 001 defaulted it to 'crm', which locked every
--      promoted customer out of the customer portal. This backfills real
--      customers to 'customer', flips the column default, and leaves genuine
--      CRM subscribers alone.
--   2. Adds billing_schedules — Diamondback's OWN recurring invoicing.
--      Deliberately NOT recurring_invoices: that table is client_portal_id
--      NOT NULL, i.e. it belongs to CRM tenants billing their own customers.
--      Reusing it would mix your books with your subscribers' books.
--   3. Adds agreement_items + agreement_templates so sales agreements become
--      editable line-item documents instead of one fixed price field.
--   4. Adds invoice_dunning + invoice columns for the 10-day past-due ladder.
--   5. Adds billing_notifications — the audit trail for billing comms, and the
--      reason those comms can never feed lead scoring.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. portal_kind repair
-- ==========================================================================

-- Make sure 001 actually ran. If portal_kind is absent, add it — but with the
-- correct default this time.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'leads' AND column_name = 'portal_kind') THEN
        ALTER TABLE leads ADD COLUMN portal_kind VARCHAR(20) DEFAULT 'customer';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'leads' AND column_name = 'portal_last_login') THEN
        ALTER TABLE leads ADD COLUMN portal_last_login TIMESTAMP;
    END IF;
END $$;

-- New accounts created by /api/admin/client-accounts are customer-portal users.
-- CRM subscribers are set to 'crm' explicitly by the subscription checkout
-- path, so 'customer' is the correct default and it no longer fails closed
-- against the people who actually need in.
ALTER TABLE leads ALTER COLUMN portal_kind SET DEFAULT 'customer';

-- Backfill.
--
-- Order matters, and the obvious way to write this is wrong. If you classify
-- CRM subscribers first and then run a catch-all "anything still 'crm' with a
-- password becomes 'customer'", that catch-all cannot tell a row it just set to
-- 'crm' from a row nobody touched — so it overwrites real subscribers. Collect
-- the CRM lead ids first, then classify everyone in a single pass.
--
-- Rule: a lead is a CRM subscriber if it has a crm_subscriptions row, or a
-- client_companies row with seats purchased. Otherwise a lead holding a portal
-- password is a customer-portal user. 'both' is never assigned automatically --
-- it is a deliberate act (your own account), so an existing 'both' is left
-- alone.
CREATE TEMP TABLE _crm_lead_ids (lead_id INTEGER PRIMARY KEY);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='crm_subscriptions') THEN
        EXECUTE $q$
            INSERT INTO _crm_lead_ids (lead_id)
            SELECT DISTINCT lead_id FROM crm_subscriptions WHERE lead_id IS NOT NULL
            ON CONFLICT DO NOTHING
        $q$;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='client_companies') THEN
        EXECUTE $q$
            INSERT INTO _crm_lead_ids (lead_id)
            SELECT DISTINCT l.id
              FROM leads l
              JOIN client_companies c ON c.client_portal_id = l.client_portal_id
             WHERE l.client_portal_id IS NOT NULL
               AND COALESCE(c.purchased_seats, 0) > 0
            ON CONFLICT DO NOTHING
        $q$;
    END IF;
END $$;

UPDATE leads l
   SET portal_kind = CASE
           WHEN EXISTS (SELECT 1 FROM _crm_lead_ids x WHERE x.lead_id = l.id)
               THEN 'crm'
           WHEN l.client_password IS NOT NULL AND COALESCE(l.is_customer, FALSE)
               THEN 'customer'
           ELSE COALESCE(l.portal_kind, 'crm')
       END
 WHERE COALESCE(l.portal_kind, 'crm') <> 'both';

DROP TABLE _crm_lead_ids;

CREATE INDEX IF NOT EXISTS idx_leads_portal_kind ON leads(portal_kind);

-- ==========================================================================
-- 2. billing_schedules — Diamondback's own recurring invoicing
-- ==========================================================================
CREATE TABLE IF NOT EXISTS billing_schedules (
    id                  SERIAL PRIMARY KEY,
    lead_id             INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    agreement_id        INTEGER,
    label               VARCHAR(255) NOT NULL,
    description         TEXT,
    amount              NUMERIC(10,2) NOT NULL DEFAULT 0,
    tax_rate            NUMERIC(5,2)  DEFAULT 0,
    -- 1..31. 29/30/31 clamp to the last day of shorter months at run time.
    day_of_month        INTEGER NOT NULL DEFAULT 1,
    frequency           VARCHAR(20) NOT NULL DEFAULT 'monthly',
    -- How many days after issue the invoice is due. Drives past-due detection.
    net_days            INTEGER NOT NULL DEFAULT 7,
    -- Charge a saved Stripe card automatically vs. email a pay link.
    auto_charge         BOOLEAN DEFAULT FALSE,
    stripe_customer_id  VARCHAR(255),
    stripe_pm_id        VARCHAR(255),
    notify_email        BOOLEAN DEFAULT TRUE,
    notify_sms          BOOLEAN DEFAULT TRUE,
    notify_portal       BOOLEAN DEFAULT TRUE,
    status              VARCHAR(20) DEFAULT 'active',
    next_run_date       DATE,
    last_run_date       DATE,
    last_invoice_id     INTEGER,
    runs_completed      INTEGER DEFAULT 0,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_schedules_freq_chk') THEN
        ALTER TABLE billing_schedules ADD CONSTRAINT billing_schedules_freq_chk
            CHECK (frequency IN ('monthly', 'quarterly', 'annual'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_schedules_dom_chk') THEN
        ALTER TABLE billing_schedules ADD CONSTRAINT billing_schedules_dom_chk
            CHECK (day_of_month BETWEEN 1 AND 31);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_schedules_status_chk') THEN
        ALTER TABLE billing_schedules ADD CONSTRAINT billing_schedules_status_chk
            CHECK (status IN ('active', 'paused', 'cancelled'));
    END IF;
END $$;

-- The scheduler's hot path: "what is due today and still active".
CREATE INDEX IF NOT EXISTS idx_billing_schedules_due
    ON billing_schedules(next_run_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_billing_schedules_lead
    ON billing_schedules(lead_id);

-- ==========================================================================
-- 3. Customizable sales agreements
-- ==========================================================================

-- Line items. An agreement's total is the sum of these once any exist; the
-- legacy sales_agreements.price stays as the fallback for older records.
CREATE TABLE IF NOT EXISTS agreement_items (
    id              SERIAL PRIMARY KEY,
    agreement_id    INTEGER NOT NULL REFERENCES sales_agreements(id) ON DELETE CASCADE,
    sort_order      INTEGER DEFAULT 0,
    description     VARCHAR(500) NOT NULL,
    detail          TEXT,
    quantity        NUMERIC(10,2) DEFAULT 1,
    unit_price      NUMERIC(10,2) DEFAULT 0,
    -- Stored rather than computed so a later price edit can't silently restate
    -- an already-signed agreement.
    amount          NUMERIC(10,2) DEFAULT 0,
    is_optional     BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agreement_items_agreement
    ON agreement_items(agreement_id, sort_order);

-- Reusable agreement shells: default terms, default line items, branding notes.
CREATE TABLE IF NOT EXISTS agreement_templates (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(200) NOT NULL,
    service_type    VARCHAR(120),
    intro           TEXT,
    default_terms   TEXT,
    -- JSON array of {description, detail, quantity, unit_price, is_optional}
    default_items   JSONB DEFAULT '[]'::jsonb,
    default_net_days INTEGER DEFAULT 7,
    default_deposit_pct NUMERIC(5,2) DEFAULT 0,
    is_default      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Extra fields the agreement editor needs.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='template_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN template_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='intro') THEN
        ALTER TABLE sales_agreements ADD COLUMN intro TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='tax_rate') THEN
        ALTER TABLE sales_agreements ADD COLUMN tax_rate NUMERIC(5,2) DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='net_days') THEN
        ALTER TABLE sales_agreements ADD COLUMN net_days INTEGER DEFAULT 7;
    END IF;
    -- Set when "Create invoice from agreement" runs, so the button is
    -- idempotent and the admin UI can show "already invoiced".
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='invoiced_at') THEN
        ALTER TABLE sales_agreements ADD COLUMN invoiced_at TIMESTAMP;
    END IF;
    -- Optional: finalizing an agreement can also start a recurring schedule.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='billing_schedule_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN billing_schedule_id INTEGER;
    END IF;
END $$;

-- ==========================================================================
-- 4. Invoices: recurring + dunning
-- ==========================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='billing_schedule_id') THEN
        ALTER TABLE invoices ADD COLUMN billing_schedule_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='agreement_id') THEN
        ALTER TABLE invoices ADD COLUMN agreement_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='auto_generated') THEN
        ALTER TABLE invoices ADD COLUMN auto_generated BOOLEAN DEFAULT FALSE;
    END IF;
    -- Dunning state. dunning_day is 0 until the invoice goes past due, then
    -- 1..10 as the ladder advances. dunning_status: 'none' | 'active' |
    -- 'resolved' | 'escalated' (past day 10, still unpaid).
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='dunning_day') THEN
        ALTER TABLE invoices ADD COLUMN dunning_day INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='dunning_status') THEN
        ALTER TABLE invoices ADD COLUMN dunning_status VARCHAR(20) DEFAULT 'none';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='dunning_started_at') THEN
        ALTER TABLE invoices ADD COLUMN dunning_started_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='last_reminder_at') THEN
        ALTER TABLE invoices ADD COLUMN last_reminder_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='reminder_count') THEN
        ALTER TABLE invoices ADD COLUMN reminder_count INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='updated_at') THEN
        ALTER TABLE invoices ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$;

-- Finds past-due invoices without scanning: unpaid, with a due date.
CREATE INDEX IF NOT EXISTS idx_invoices_open_due
    ON invoices(due_date)
    WHERE status NOT IN ('paid', 'void', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_invoices_dunning
    ON invoices(dunning_status, dunning_day)
    WHERE dunning_status = 'active';
CREATE INDEX IF NOT EXISTS idx_invoices_schedule
    ON invoices(billing_schedule_id);
CREATE INDEX IF NOT EXISTS idx_invoices_agreement
    ON invoices(agreement_id);

-- One row per reminder actually sent. Prevents double-sending day N when the
-- scheduler runs twice, and gives you the "who got told what, when" history.
CREATE TABLE IF NOT EXISTS invoice_dunning (
    id              SERIAL PRIMARY KEY,
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    day_number      INTEGER NOT NULL,
    days_overdue    INTEGER,
    channel         VARCHAR(20) NOT NULL,
    status          VARCHAR(20) DEFAULT 'sent',
    detail          TEXT,
    sent_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The idempotency guard: day N on channel C happens at most once per invoice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_dunning_once
    ON invoice_dunning(invoice_id, day_number, channel);
CREATE INDEX IF NOT EXISTS idx_invoice_dunning_lead
    ON invoice_dunning(lead_id, sent_at DESC);

-- ==========================================================================
-- 5. billing_notifications — audit trail, and the scoring firewall
-- ==========================================================================
-- Every billing/dunning message is recorded here instead of going through the
-- marketing email path. Nothing in this table feeds lead_temperature,
-- last_contact_date, follow_up_count, or the follow-up queues.
CREATE TABLE IF NOT EXISTS billing_notifications (
    id              SERIAL PRIMARY KEY,
    lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    invoice_id      INTEGER,
    schedule_id     INTEGER,
    channel         VARCHAR(20) NOT NULL,
    kind            VARCHAR(40) NOT NULL,
    subject         VARCHAR(300),
    body_preview    VARCHAR(500),
    status          VARCHAR(20) DEFAULT 'sent',
    error           TEXT,
    sent_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_billing_notifications_lead
    ON billing_notifications(lead_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_notifications_invoice
    ON billing_notifications(invoice_id);

-- client_messages already has `kind`; billing threads use kind='billing' so
-- the customer portal can style them and the marketing broadcast queries can
-- exclude them.
CREATE INDEX IF NOT EXISTS idx_client_messages_kind
    ON client_messages(lead_id, kind);

-- Emitted when an in-portal billing message is created, so the "you have a
-- message" email can be sent exactly once.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_messages' AND column_name='notified_at') THEN
        ALTER TABLE client_messages ADD COLUMN notified_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_messages' AND column_name='invoice_id') THEN
        ALTER TABLE client_messages ADD COLUMN invoice_id INTEGER;
    END IF;
END $$;

-- Saved card for auto-charge, on the lead itself.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='stripe_pm_id') THEN
        ALTER TABLE leads ADD COLUMN stripe_pm_id VARCHAR(255);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='autopay_enabled') THEN
        ALTER TABLE leads ADD COLUMN autopay_enabled BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY
--   SELECT portal_kind, COUNT(*) FROM leads GROUP BY portal_kind;
--     -> promoted customers should now read 'customer', not 'crm'
--   SELECT COUNT(*) FROM leads WHERE client_password IS NOT NULL
--          AND portal_kind IN ('customer','both');
--     -> this is how many people can now sign in at customer_portal.html
--   \d billing_schedules
--   \d invoice_dunning
-- ============================================================================