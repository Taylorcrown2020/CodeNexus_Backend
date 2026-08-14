-- ============================================================================
-- 005_reset_and_annual.sql — Diamondback Coding
--
--  1. Password / username recovery tokens, shared by the customer portal and
--     the CRM.
--  2. Annual billing (domain renewals) on the existing maintenance_plans table.
--  3. An account-level default payment method, so one card covers everything.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. Recovery tokens
-- ==========================================================================
-- Only a HASH of the token is stored. A leaked database backup then can't be
-- used to reset anyone's password, which is the whole point of the table.
CREATE TABLE IF NOT EXISTS auth_tokens (
    id           SERIAL PRIMARY KEY,
    lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    admin_id     INTEGER,
    -- 'customer' (customer portal) or 'crm' (client_portal.html)
    audience     VARCHAR(20) NOT NULL DEFAULT 'customer',
    -- 'password_reset' | 'username_recovery'
    purpose      VARCHAR(30) NOT NULL DEFAULT 'password_reset',
    token_hash   VARCHAR(128) NOT NULL,
    email        VARCHAR(255),
    expires_at   TIMESTAMP NOT NULL,
    used_at      TIMESTAMP,
    -- Evidence, for a disputed reset.
    requested_ip VARCHAR(64),
    user_agent   TEXT,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);
-- The lookup the reset page performs: unused and unexpired.
CREATE INDEX IF NOT EXISTS idx_auth_tokens_live
    ON auth_tokens(expires_at) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_tokens_lead ON auth_tokens(lead_id, created_at DESC);
-- Rate limiting reads this: how many requests from one email recently.
CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_tokens(email, created_at DESC);

-- ==========================================================================
-- 2. Annual billing — domain renewals
-- ==========================================================================
-- maintenance_plans already carries amount, payment method, status and the
-- 30-day cancellation machinery, so an annual plan is the same row with a
-- different interval rather than a parallel table that would need all of it
-- duplicating.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='interval_unit') THEN
        ALTER TABLE maintenance_plans ADD COLUMN interval_unit VARCHAR(10) DEFAULT 'month';
    END IF;
    -- Which month an annual plan bills in (1-12). Ignored for monthly plans.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='billing_month') THEN
        ALTER TABLE maintenance_plans ADD COLUMN billing_month INTEGER;
    END IF;
    -- What's being renewed, e.g. the domain name itself.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='item_reference') THEN
        ALTER TABLE maintenance_plans ADD COLUMN item_reference VARCHAR(255);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_plans_interval_chk') THEN
        ALTER TABLE maintenance_plans ADD CONSTRAINT maintenance_plans_interval_chk
            CHECK (interval_unit IN ('month','year'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_plans_month_chk') THEN
        ALTER TABLE maintenance_plans ADD CONSTRAINT maintenance_plans_month_chk
            CHECK (billing_month IS NULL OR (billing_month BETWEEN 1 AND 12));
    END IF;
END $$;

-- The plan_type check constraint predates domain renewals, so widen it.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_plans_type_chk') THEN
        ALTER TABLE maintenance_plans DROP CONSTRAINT maintenance_plans_type_chk;
    END IF;
    ALTER TABLE maintenance_plans ADD CONSTRAINT maintenance_plans_type_chk
        CHECK (plan_type IN ('monthly_maintenance','brevo_maintenance',
                             'database_maintenance','domain_renewal','hosting'));
END $$;

-- ==========================================================================
-- 3. Account-level default payment method
-- ==========================================================================
-- One method for everything. maintenance_plans.payment_method_id stays as an
-- optional override, but nothing sets it per-plan any more: the charger falls
-- back to this, so adding a card once covers every plan on the account.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='default_payment_method_id') THEN
        ALTER TABLE leads ADD COLUMN default_payment_method_id INTEGER;
    END IF;
END $$;

-- Backfill from whatever is already marked default, so existing accounts don't
-- suddenly look like they have no method on file.
UPDATE leads l
   SET default_payment_method_id = pm.id
  FROM payment_methods pm
 WHERE pm.lead_id = l.id
   AND pm.status = 'active'
   AND l.default_payment_method_id IS NULL
   AND pm.is_default = TRUE;

-- Then anyone with exactly one active method.
UPDATE leads l
   SET default_payment_method_id = (
        SELECT pm.id FROM payment_methods pm
         WHERE pm.lead_id = l.id AND pm.status = 'active'
         ORDER BY pm.id DESC LIMIT 1)
 WHERE l.default_payment_method_id IS NULL
   AND EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.lead_id = l.id AND pm.status = 'active');

COMMIT;

-- ============================================================================
-- VERIFY
--   \d auth_tokens
--   SELECT plan_type, interval_unit, billing_month FROM maintenance_plans;
--   SELECT COUNT(*) FROM leads WHERE default_payment_method_id IS NOT NULL;
-- ============================================================================