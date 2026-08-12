-- ============================================================================
-- 003_customer_first_and_maintenance.sql — Diamondback Coding
--
-- Run AFTER 002:
--     psql "$DATABASE_URL" -f migrations/003_customer_first_and_maintenance.sql
--
-- Idempotent. Safe to run repeatedly.
--
-- WHAT THIS CORRECTS
--   002 fixed portal_kind's default but kept the old mental model, in which a
--   promoted customer might be a CRM account. The correct model is:
--
--       lead -> customer            => CUSTOMER PORTAL account. Always. Only.
--       customer buys CRM plan      => CRM access ADDED onto that same account
--
--   So portal_kind's honest default is 'customer', and CRM access becomes an
--   additive flag rather than an alternative identity. A customer who later
--   subscribes to CodeNexus becomes 'both' — never 'crm' instead of
--   'customer', because they are still your customer.
--
--   This migration therefore RE-backfills portal_kind under the corrected
--   rule, overriding 002's classification.
--
-- WHAT IT ADDS
--   * payments            — the per-customer payment ledger, with refunds.
--                           Shown in the admin portal AND the customer portal.
--   * refunds             — one row per refund, linked to a payment.
--   * maintenance_plans   — monthly / Brevo / database recurring auto-charge
--                           plans with 30-day cancellation.
--   * plan_cancellations  — the 30-day wind-down: notice date, effective date,
--                           reinstatement reminders, admin notification.
--   * payment_methods     — saved Stripe cards and ACH bank accounts.
--   * agreement_signatures — the e-signature record for an SLA.
--   * lifecycle_events    — the automation audit trail: what fired, when, for
--                           whom, and whether it succeeded. This is what makes
--                           "fully automated" debuggable instead of magic.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. Corrected account model
-- ==========================================================================

-- 'customer' is the default because every promoted lead is a customer-portal
-- user. CRM is something you ADD.
ALTER TABLE leads ALTER COLUMN portal_kind SET DEFAULT 'customer';

-- Additive CRM flag. crm_access_at records when they bought in; NULL means no
-- CRM. Keeping this separate from portal_kind means a CRM cancellation can
-- revoke CRM without touching their customer identity.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='crm_access') THEN
        ALTER TABLE leads ADD COLUMN crm_access BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='crm_access_at') THEN
        ALTER TABLE leads ADD COLUMN crm_access_at TIMESTAMP;
    END IF;
    -- Which admin owns this customer's project. Set when the SLA is signed.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='assigned_admin_id') THEN
        ALTER TABLE leads ADD COLUMN assigned_admin_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='assigned_admin_at') THEN
        ALTER TABLE leads ADD COLUMN assigned_admin_at TIMESTAMP;
    END IF;
    -- Stripe customer id may already exist from the subscription path; ensure it.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='stripe_customer_id') THEN
        ALTER TABLE leads ADD COLUMN stripe_customer_id VARCHAR(255);
    END IF;
END $$;

-- Re-backfill under the corrected rule.
--   anyone with a portal password + is_customer  -> at least 'customer'
--   plus a CRM subscription / purchased seats    -> 'both' and crm_access
CREATE TEMP TABLE _crm_leads (lead_id INTEGER PRIMARY KEY);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='crm_subscriptions') THEN
        EXECUTE $q$
            INSERT INTO _crm_leads (lead_id)
            SELECT DISTINCT lead_id FROM crm_subscriptions
             WHERE lead_id IS NOT NULL
               AND COALESCE(status,'active') NOT IN ('cancelled','canceled','expired')
            ON CONFLICT DO NOTHING
        $q$;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='client_companies') THEN
        EXECUTE $q$
            INSERT INTO _crm_leads (lead_id)
            SELECT DISTINCT l.id
              FROM leads l
              JOIN client_companies c ON c.client_portal_id = l.client_portal_id
             WHERE l.client_portal_id IS NOT NULL
               AND COALESCE(c.purchased_seats, 0) > 0
            ON CONFLICT DO NOTHING
        $q$;
    END IF;
END $$;

-- CRM holders keep customer standing too — hence 'both', not 'crm'.
UPDATE leads l
   SET portal_kind = 'both',
       crm_access = TRUE,
       crm_access_at = COALESCE(l.crm_access_at, NOW())
 WHERE EXISTS (SELECT 1 FROM _crm_leads x WHERE x.lead_id = l.id);

-- Everyone else who can log in is a customer-portal user.
UPDATE leads
   SET portal_kind = 'customer'
 WHERE client_password IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM _crm_leads x WHERE x.lead_id = leads.id)
   AND COALESCE(portal_kind,'') <> 'customer';

DROP TABLE _crm_leads;

CREATE INDEX IF NOT EXISTS idx_leads_crm_access ON leads(crm_access) WHERE crm_access = TRUE;

-- ==========================================================================
-- 2. payments — the ledger
-- ==========================================================================
-- One row per money movement in. Refunds live in their own table and reduce
-- refunded_amount here, so a payment row always shows gross paid plus what
-- came back. This table is the single source for both the admin per-customer
-- payment log and the customer portal's payment history.
CREATE TABLE IF NOT EXISTS payments (
    id                  SERIAL PRIMARY KEY,
    lead_id             INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    invoice_id          INTEGER,
    -- Set when the charge came from a recurring plan rather than an invoice.
    maintenance_plan_id INTEGER,
    subscription_id     INTEGER,
    amount              NUMERIC(10,2) NOT NULL,
    currency            VARCHAR(10) DEFAULT 'usd',
    -- 'card' | 'us_bank_account' | 'manual' | 'other'
    method              VARCHAR(40),
    method_last4        VARCHAR(8),
    method_brand        VARCHAR(40),
    -- 'invoice' | 'maintenance' | 'crm_subscription' | 'deposit' | 'manual'
    kind                VARCHAR(40) DEFAULT 'invoice',
    description         VARCHAR(400),
    -- 'succeeded' | 'pending' | 'failed' | 'refunded' | 'partially_refunded'
    status              VARCHAR(30) DEFAULT 'succeeded',
    refunded_amount     NUMERIC(10,2) DEFAULT 0,
    stripe_payment_intent_id VARCHAR(255),
    stripe_charge_id    VARCHAR(255),
    receipt_number      VARCHAR(60),
    receipt_url         TEXT,
    -- TRUE once the paid-confirmation email/SMS has gone out, so a retry of
    -- the webhook cannot double-notify.
    notified_at         TIMESTAMP,
    failure_reason      TEXT,
    paid_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stripe delivers webhooks more than once. This is the idempotency guard, and
-- recordPayment() relies on it via ON CONFLICT (stripe_payment_intent_id).
-- It must NOT be partial: ON CONFLICT cannot infer a partial index, and a
-- partial one here fails with 42P10 at runtime, letting duplicate webhooks
-- create duplicate payment rows. NULLs are distinct in a unique index, so
-- manual payments with no intent id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_pi
    ON payments(stripe_payment_intent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt
    ON payments(receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_lead    ON payments(lead_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_plan    ON payments(maintenance_plan_id);

CREATE TABLE IF NOT EXISTS refunds (
    id                  SERIAL PRIMARY KEY,
    payment_id          INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    lead_id             INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    amount              NUMERIC(10,2) NOT NULL,
    reason              VARCHAR(300),
    -- Which admin issued it. Refunds are money going out; always attributable.
    issued_by           INTEGER,
    status              VARCHAR(30) DEFAULT 'succeeded',
    stripe_refund_id    VARCHAR(255),
    notified_at         TIMESTAMP,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_stripe
    ON refunds(stripe_refund_id) WHERE stripe_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_lead    ON refunds(lead_id, created_at DESC);

-- ==========================================================================
-- 3. payment_methods — saved card / bank for auto-charge
-- ==========================================================================
-- Only Stripe tokens are stored. No PAN, no routing number, no account
-- number — Stripe holds those; this table holds references and display hints.
CREATE TABLE IF NOT EXISTS payment_methods (
    id                  SERIAL PRIMARY KEY,
    lead_id             INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    stripe_customer_id  VARCHAR(255),
    stripe_pm_id        VARCHAR(255) NOT NULL,
    -- 'card' | 'us_bank_account'
    type                VARCHAR(40) NOT NULL DEFAULT 'card',
    brand               VARCHAR(40),
    last4               VARCHAR(8),
    exp_month           INTEGER,
    exp_year            INTEGER,
    bank_name           VARCHAR(120),
    is_default          BOOLEAN DEFAULT FALSE,
    status              VARCHAR(30) DEFAULT 'active',
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_pm ON payment_methods(stripe_pm_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_lead ON payment_methods(lead_id)
    WHERE status = 'active';

-- ==========================================================================
-- 4. maintenance_plans — recurring auto-charge, no invoice chasing
-- ==========================================================================
-- plan_type distinguishes the three offerings. These charge the saved payment
-- method automatically; generate_invoice defaults FALSE because maintenance is
-- autopay and the customer gets a receipt instead of a bill to act on.
CREATE TABLE IF NOT EXISTS maintenance_plans (
    id                  SERIAL PRIMARY KEY,
    lead_id             INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    -- 'monthly_maintenance' | 'brevo_maintenance' | 'database_maintenance'
    plan_type           VARCHAR(40) NOT NULL,
    label               VARCHAR(200) NOT NULL,
    description         TEXT,
    -- Whatever you decide to charge. Set per customer, not per price book.
    amount              NUMERIC(10,2) NOT NULL DEFAULT 0,
    billing_day         INTEGER NOT NULL DEFAULT 1,
    -- Maintenance is autopay, so no invoice by default. Flip TRUE per plan if
    -- a particular customer wants a document anyway.
    generate_invoice    BOOLEAN DEFAULT FALSE,
    payment_method_id   INTEGER,
    stripe_subscription_id VARCHAR(255),
    -- 'pending_signature' | 'pending_payment_method' | 'active' |
    -- 'pending_cancellation' | 'cancelled' | 'past_due'
    status              VARCHAR(40) DEFAULT 'pending_signature',
    agreement_id        INTEGER,
    -- Autopay may not begin until they have signed AND added a method.
    signed_at           TIMESTAMP,
    activated_at        TIMESTAMP,
    next_charge_date    DATE,
    last_charge_date    DATE,
    last_payment_id     INTEGER,
    charges_completed   INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_plans_type_chk') THEN
        ALTER TABLE maintenance_plans ADD CONSTRAINT maintenance_plans_type_chk
            CHECK (plan_type IN ('monthly_maintenance','brevo_maintenance','database_maintenance'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_plans_day_chk') THEN
        ALTER TABLE maintenance_plans ADD CONSTRAINT maintenance_plans_day_chk
            CHECK (billing_day BETWEEN 1 AND 31);
    END IF;
END $$;

-- The charger's hot path.
CREATE INDEX IF NOT EXISTS idx_maintenance_due
    ON maintenance_plans(next_charge_date)
    WHERE status IN ('active','pending_cancellation');
CREATE INDEX IF NOT EXISTS idx_maintenance_lead ON maintenance_plans(lead_id);
-- Drives the admin "monthly maintenance" tab.
CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_plans(status, plan_type);

-- ==========================================================================
-- 5. plan_cancellations — the 30-day wind-down
-- ==========================================================================
-- A cancellation is a scheduled future event, not an immediate delete. The
-- plan keeps billing until effective_at, the customer can reinstate before
-- then, and the admin portal reads pending rows to show "cancels in N days".
CREATE TABLE IF NOT EXISTS plan_cancellations (
    id                  SERIAL PRIMARY KEY,
    maintenance_plan_id INTEGER REFERENCES maintenance_plans(id) ON DELETE CASCADE,
    subscription_id     INTEGER,
    lead_id             INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    requested_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- requested_at + 30 days. Stored rather than computed so changing the
    -- notice period later cannot retroactively move someone's end date.
    effective_at        TIMESTAMP NOT NULL,
    notice_days         INTEGER DEFAULT 30,
    requested_by        VARCHAR(20) DEFAULT 'customer',
    reason              TEXT,
    -- 'pending' | 'completed' | 'reinstated'
    status              VARCHAR(30) DEFAULT 'pending',
    reinstated_at       TIMESTAMP,
    completed_at        TIMESTAMP,
    -- Days-remaining reminders already sent, so the reminder job can't repeat
    -- one. e.g. {21,14,7,3,1}
    reminders_sent      INTEGER[] DEFAULT '{}',
    admin_notified_at   TIMESTAMP,
    confirmation_sent_at TIMESTAMP,
    cancelled_email_sent_at TIMESTAMP,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One live cancellation per plan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_cancel_active
    ON plan_cancellations(maintenance_plan_id)
    WHERE status = 'pending' AND maintenance_plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plan_cancel_due
    ON plan_cancellations(effective_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_plan_cancel_lead ON plan_cancellations(lead_id);

-- ==========================================================================
-- 6. agreement_signatures — e-signing an SLA
-- ==========================================================================
-- signature_svg holds the generated signature mark. The platform generates it
-- from the typed name (see the SLA flow), so there is always a rendered
-- signature to place on the PDF even without a drawn one.
CREATE TABLE IF NOT EXISTS agreement_signatures (
    id                  SERIAL PRIMARY KEY,
    agreement_id        INTEGER NOT NULL REFERENCES sales_agreements(id) ON DELETE CASCADE,
    lead_id             INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    signer_name         VARCHAR(255) NOT NULL,
    signer_email        VARCHAR(255),
    typed_name          VARCHAR(255),
    signature_svg       TEXT,
    -- Evidence, for a disputed signature.
    ip_address          VARCHAR(64),
    user_agent          TEXT,
    consent_text        TEXT,
    signed_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_sig_once ON agreement_signatures(agreement_id);
CREATE INDEX IF NOT EXISTS idx_agreement_sig_lead ON agreement_signatures(lead_id);

-- SLA fields the lifecycle needs on the agreement itself.
DO $$ BEGIN
    -- The estimated completion date. Becomes the generated invoice's due date.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='est_completion_date') THEN
        ALTER TABLE sales_agreements ADD COLUMN est_completion_date DATE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='project_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN project_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='sent_at') THEN
        ALTER TABLE sales_agreements ADD COLUMN sent_at TIMESTAMP;
    END IF;
    -- 'sla' for service level agreements, 'maintenance' for plan agreements.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='agreement_kind') THEN
        ALTER TABLE sales_agreements ADD COLUMN agreement_kind VARCHAR(30) DEFAULT 'sla';
    END IF;
END $$;

-- ==========================================================================
-- 7. Project timeline additions
-- ==========================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_projects' AND column_name='agreement_id') THEN
        ALTER TABLE client_projects ADD COLUMN agreement_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_projects' AND column_name='invoice_id') THEN
        ALTER TABLE client_projects ADD COLUMN invoice_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_projects' AND column_name='est_completion_date') THEN
        ALTER TABLE client_projects ADD COLUMN est_completion_date DATE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_projects' AND column_name='completed_at') THEN
        ALTER TABLE client_projects ADD COLUMN completed_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_projects' AND column_name='assigned_admin_id') THEN
        ALTER TABLE client_projects ADD COLUMN assigned_admin_id INTEGER;
    END IF;
    -- Set when the completion email fires, so it fires once.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_projects' AND column_name='completion_notified_at') THEN
        ALTER TABLE client_projects ADD COLUMN completion_notified_at TIMESTAMP;
    END IF;
END $$;

-- Milestone completion emails must be sent exactly once per milestone.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='project_milestones' AND column_name='notified_at') THEN
        ALTER TABLE project_milestones ADD COLUMN notified_at TIMESTAMP;
    END IF;
END $$;

-- ==========================================================================
-- 8. lifecycle_events — the automation audit trail
-- ==========================================================================
-- Every automated step writes here: which stage fired, for which lead, with
-- what result. Two jobs: (a) you can see why a customer did or didn't get an
-- email, (b) once_key makes a stage idempotent, so a retried webhook or a
-- double-clicked button cannot send the same customer two credential emails.
CREATE TABLE IF NOT EXISTS lifecycle_events (
    id              SERIAL PRIMARY KEY,
    lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    -- e.g. 'lead_captured', 'customer_created', 'sla_sent', 'sla_signed',
    -- 'invoice_created', 'milestone_completed', 'project_completed',
    -- 'payment_received', 'maintenance_charged', 'cancellation_requested'
    stage           VARCHAR(60) NOT NULL,
    entity_type     VARCHAR(40),
    entity_id       INTEGER,
    -- Uniqueness key for "this exact step for this exact thing", e.g.
    -- 'sla_signed:agreement:42'. NULL for events that may legitimately repeat.
    once_key        VARCHAR(200),
    channels        VARCHAR(120),
    status          VARCHAR(30) DEFAULT 'ok',
    detail          TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NOT a partial index. `ON CONFLICT (once_key)` cannot infer a partial
-- unique index (Postgres raises "no unique or exclusion constraint matching
-- the ON CONFLICT specification"), which would silently disable every
-- idempotency guard in the lifecycle module. A plain unique index is safe:
-- SQL treats NULLs as distinct, so rows with once_key IS NULL never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_once
    ON lifecycle_events(once_key);
CREATE INDEX IF NOT EXISTS idx_lifecycle_lead ON lifecycle_events(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_stage ON lifecycle_events(stage, created_at DESC);

-- ==========================================================================
-- 9. Admin notifications
-- ==========================================================================
-- The admin portal bell. Pending cancellations, failed charges, new
-- signatures, past-due escalations.
CREATE TABLE IF NOT EXISTS admin_notifications (
    id              SERIAL PRIMARY KEY,
    kind            VARCHAR(60) NOT NULL,
    title           VARCHAR(300) NOT NULL,
    body            TEXT,
    lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    entity_type     VARCHAR(40),
    entity_id       INTEGER,
    severity        VARCHAR(20) DEFAULT 'info',
    is_read         BOOLEAN DEFAULT FALSE,
    once_key        VARCHAR(200),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Same reasoning as idx_lifecycle_once: not partial, so ON CONFLICT works.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_notif_once
    ON admin_notifications(once_key);
CREATE INDEX IF NOT EXISTS idx_admin_notif_unread
    ON admin_notifications(created_at DESC) WHERE is_read = FALSE;

-- ==========================================================================
-- 10. Invoice: link to project, and "subject to change" due date
-- ==========================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='project_id') THEN
        ALTER TABLE invoices ADD COLUMN project_id INTEGER;
    END IF;
    -- TRUE while the due date is only an estimate tied to project completion.
    -- Cleared when the project completes and the real due date is set.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='due_date_estimated') THEN
        ALTER TABLE invoices ADD COLUMN due_date_estimated BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='maintenance_plan_id') THEN
        ALTER TABLE invoices ADD COLUMN maintenance_plan_id INTEGER;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);

-- ==========================================================================
-- 11. reminders — referenced by /api/reminders but never created
-- ==========================================================================
-- No UI calls that route today, so this is dormant rather than broken. Creating
-- the table means it returns an empty list instead of a 500 if anything ever
-- does call it.
CREATE TABLE IF NOT EXISTS reminders (
    id              SERIAL PRIMARY KEY,
    lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    reminder_type   VARCHAR(60),
    reminder_date   TIMESTAMP,
    message         TEXT,
    is_completed    BOOLEAN DEFAULT FALSE,
    completed_at    TIMESTAMP,
    created_by      INTEGER,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reminders_due
    ON reminders(reminder_date) WHERE is_completed = FALSE;

COMMIT;

-- ============================================================================
-- VERIFY
--   -- No promoted customer should be 'crm' any more:
--   SELECT portal_kind, crm_access, COUNT(*) FROM leads
--    WHERE client_password IS NOT NULL GROUP BY 1,2;
--
--   -- CRM holders should read 'both', never 'crm':
--   SELECT COUNT(*) FROM leads WHERE portal_kind = 'crm' AND client_password IS NOT NULL;
--   -- expect 0
--
--   \d payments
--   \d maintenance_plans
--   \d plan_cancellations
-- ============================================================================