-- ============================================================================
-- 013_late_fees_and_admin.sql — Diamondback Coding
--
--  1. LATE FEES. 1.5% of the amount owed, charged once a payment is genuinely
--     LATE — which is not the same as outstanding.
--
--     OUTSTANDING = owed but not yet due. A monthly plan is outstanding from
--                   the day its period opens. Nothing is wrong.
--     PAST DUE     = the due date passed and it is still unpaid, usually
--                   because no payment method is on file or the charge failed.
--                   This is what earns a late fee.
--
--     The distinction matters legally as much as practically: charging a fee
--     on money that was never late is the kind of thing that gets a whole fee
--     schedule thrown out.
--
--  2. WAIVERS. Every fee can be dropped from the admin portal, and the waiver
--     is recorded — who, when, why — rather than the row being deleted. If a
--     customer ever disputes what they were charged, "we waived it on the 3rd"
--     needs to be provable.
--
--  3. WELCOME EMAILS. Tracks when a portal welcome was last sent so it can be
--     resent from the admin portal without guessing.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. Late fees
-- ==========================================================================
CREATE TABLE IF NOT EXISTS late_fees (
    id                   SERIAL PRIMARY KEY,
    lead_id              INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

    -- What it is attached to. Exactly one of these is set.
    invoice_id           INTEGER,
    maintenance_plan_id  INTEGER,
    agreement_id         INTEGER,

    -- The money the fee was calculated on, and the rate used. Both stored, so
    -- a later change to the rate cannot restate a fee already charged.
    base_amount          NUMERIC(10,2) NOT NULL,
    rate                 NUMERIC(6,4)  NOT NULL DEFAULT 0.015,
    amount               NUMERIC(10,2) NOT NULL,

    -- The date the underlying payment became late, and the period it covers.
    -- period_key stops the same month being charged twice: one fee per
    -- obligation per period, enforced by the unique index below.
    due_date             DATE,
    period_key           VARCHAR(40),

    status               VARCHAR(20) NOT NULL DEFAULT 'outstanding',
    -- 'outstanding' | 'paid' | 'waived'

    -- Waiver record. Kept rather than deleting the row.
    waived_at            TIMESTAMP,
    waived_by            VARCHAR(120),
    waive_reason         TEXT,

    paid_at              TIMESTAMP,
    payment_id           INTEGER,

    notes                TEXT,
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='late_fees_status_chk') THEN
        ALTER TABLE late_fees ADD CONSTRAINT late_fees_status_chk
            CHECK (status IN ('outstanding','paid','waived'));
    END IF;
END $$;

-- ONE FEE PER OBLIGATION PER PERIOD. This is the guard that stops a nightly
-- job from stacking a new 1.5% on the same late month every time it runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_late_fees_once
    ON late_fees(lead_id, COALESCE(invoice_id,0), COALESCE(maintenance_plan_id,0), period_key);

CREATE INDEX IF NOT EXISTS idx_late_fees_lead
    ON late_fees(lead_id, status) WHERE status = 'outstanding';
CREATE INDEX IF NOT EXISTS idx_late_fees_invoice ON late_fees(invoice_id);
CREATE INDEX IF NOT EXISTS idx_late_fees_plan    ON late_fees(maintenance_plan_id);

-- ==========================================================================
-- 2. Late fee totals on the documents that show them
-- ==========================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='late_fee_amount') THEN
        ALTER TABLE invoices ADD COLUMN late_fee_amount NUMERIC(10,2) DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='payments' AND column_name='late_fee_amount') THEN
        ALTER TABLE payments ADD COLUMN late_fee_amount NUMERIC(10,2) DEFAULT 0;
    END IF;
    -- When this plan's current period actually became late. NULL while it is
    -- merely outstanding.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='past_due_since') THEN
        ALTER TABLE maintenance_plans ADD COLUMN past_due_since DATE;
    END IF;
    -- Per-plan override of the 1.5% rate, and a way to exempt a customer
    -- entirely without editing code.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='late_fee_rate') THEN
        ALTER TABLE maintenance_plans ADD COLUMN late_fee_rate NUMERIC(6,4);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='late_fees_exempt') THEN
        ALTER TABLE leads ADD COLUMN late_fees_exempt BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- ==========================================================================
-- 3. Welcome email tracking
-- ==========================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='portal_welcome_sent_at') THEN
        ALTER TABLE leads ADD COLUMN portal_welcome_sent_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='portal_welcome_count') THEN
        ALTER TABLE leads ADD COLUMN portal_welcome_count INTEGER DEFAULT 0;
    END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY
--   \d late_fees
--   SELECT * FROM late_fees WHERE status='outstanding';
--   SELECT id, label, past_due_since, late_fee_rate FROM maintenance_plans;
-- ============================================================================