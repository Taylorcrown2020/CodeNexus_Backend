-- ============================================================================
-- 007_billing_start_and_outstanding.sql — Diamondback Coding
--
--  1. A billing START DATE on every recurring plan: the first day they're
--     charged, and the anchor for every charge after it.
--  2. Deposit tracking on agreements, so a project that requires a deposit can
--     show that deposit as outstanding while the project balance is not.
--  3. An `obligation` marker on invoices separating money owed NOW from money
--     that only falls due at project completion.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. Billing start date
-- ==========================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='billing_start_date') THEN
        ALTER TABLE maintenance_plans ADD COLUMN billing_start_date DATE;
    END IF;
END $$;

-- Existing plans keep billing exactly as they are: their current next charge is
-- treated as the start, so nothing shifts under a live customer.
UPDATE maintenance_plans
   SET billing_start_date = COALESCE(billing_start_date, next_charge_date, CURRENT_DATE)
 WHERE billing_start_date IS NULL;

-- ==========================================================================
-- 2. Deposits on agreements
-- ==========================================================================
-- require_deposit / deposit already exist (migration 001). What was missing is
-- somewhere to record that the deposit was invoiced and settled, which is what
-- gates the project starting.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='deposit_invoice_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN deposit_invoice_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='deposit_paid_at') THEN
        ALTER TABLE sales_agreements ADD COLUMN deposit_paid_at TIMESTAMP;
    END IF;
    -- The billing start date for a recurring agreement, mirrored from the plan
    -- so the signed document and the plan can't disagree.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='billing_start_date') THEN
        ALTER TABLE sales_agreements ADD COLUMN billing_start_date DATE;
    END IF;
END $$;

-- ==========================================================================
-- 3. What an invoice actually obliges
-- ==========================================================================
-- 'due_now'     — maintenance, annual renewals, deposits. Owed on issue.
-- 'on_completion' — project balances. Not outstanding until the project ends,
--                   so they must not inflate the customer's balance meanwhile.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='obligation') THEN
        ALTER TABLE invoices ADD COLUMN obligation VARCHAR(20) DEFAULT 'due_now';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='is_deposit') THEN
        ALTER TABLE invoices ADD COLUMN is_deposit BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invoices_obligation_chk') THEN
        ALTER TABLE invoices ADD CONSTRAINT invoices_obligation_chk
            CHECK (obligation IN ('due_now','on_completion'));
    END IF;
END $$;

-- Backfill: a project invoice whose due date is an estimate is a completion
-- balance, not money owed today. Everything else stays due_now.
UPDATE invoices
   SET obligation = 'on_completion'
 WHERE obligation = 'due_now'
   AND COALESCE(due_date_estimated, FALSE) = TRUE
   AND status NOT IN ('paid','void','cancelled','refunded');

CREATE INDEX IF NOT EXISTS idx_invoices_obligation
    ON invoices(lead_id, obligation)
    WHERE status NOT IN ('paid','void','cancelled','refunded','draft');

COMMIT;

-- ============================================================================
-- VERIFY
--   SELECT id, label, billing_start_date, next_charge_date FROM maintenance_plans;
--   SELECT invoice_number, obligation, is_deposit, due_date FROM invoices;
-- ============================================================================