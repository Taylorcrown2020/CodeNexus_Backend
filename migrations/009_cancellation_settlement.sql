-- ============================================================================
-- 009_cancellation_settlement.sql — Diamondback Coding
--
--  1. Records what a cancellation had to settle, and what was paid to clear it.
--  2. Reinstatement agreements — reinstating after a cancellation is a signed
--     act, not a button.
--  3. A document index per client, so every SLA, plan and subscription document
--     hangs off the customer's account in the admin portal.
--
-- Idempotent.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. Settlement on cancellation
-- ==========================================================================
DO $$ BEGIN
    -- What was owed at the moment they asked to cancel, and the invoice raised
    -- to clear it. Stored rather than recomputed so the figure they agreed to
    -- can't drift if prices change afterwards.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='plan_cancellations' AND column_name='settlement_amount') THEN
        ALTER TABLE plan_cancellations ADD COLUMN settlement_amount NUMERIC(10,2) DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='plan_cancellations' AND column_name='settlement_invoice_id') THEN
        ALTER TABLE plan_cancellations ADD COLUMN settlement_invoice_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='plan_cancellations' AND column_name='settled_at') THEN
        ALTER TABLE plan_cancellations ADD COLUMN settled_at TIMESTAMP;
    END IF;
    -- The reinstatement document, once one exists.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='plan_cancellations' AND column_name='reinstatement_agreement_id') THEN
        ALTER TABLE plan_cancellations ADD COLUMN reinstatement_agreement_id INTEGER;
    END IF;
END $$;

-- ==========================================================================
-- 2. Reinstatement agreements
-- ==========================================================================
-- Reuses sales_agreements so a reinstatement lands in Docs, is signable and is
-- downloadable exactly like any other document, rather than needing a parallel
-- signing flow of its own.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_agreements_kind_chk') THEN
        ALTER TABLE sales_agreements DROP CONSTRAINT sales_agreements_kind_chk;
    END IF;
    ALTER TABLE sales_agreements ADD CONSTRAINT sales_agreements_kind_chk
        CHECK (agreement_kind IS NULL OR agreement_kind IN ('sla','maintenance','reinstatement','subscription'));
END $$;

DO $$ BEGIN
    -- Which plan or subscription a document belongs to, so the admin can see
    -- every document attached to a customer and what each one is for.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='maintenance_plan_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN maintenance_plan_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='subscription_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN subscription_id INTEGER;
    END IF;
END $$;

-- Backfill the link for maintenance agreements already created.
UPDATE sales_agreements sa
   SET maintenance_plan_id = mp.id
  FROM maintenance_plans mp
 WHERE mp.agreement_id = sa.id
   AND sa.maintenance_plan_id IS NULL;

-- Invoices need a link to the subscription they belong to, so a CRM
-- cancellation can find what is unpaid on it. Without this the settlement
-- query references a column that doesn't exist and the cancel route 500s.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='subscription_id') THEN
        ALTER TABLE invoices ADD COLUMN subscription_id INTEGER;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_subscription ON invoices(subscription_id);
CREATE INDEX IF NOT EXISTS idx_sales_agreements_plan ON sales_agreements(maintenance_plan_id);
CREATE INDEX IF NOT EXISTS idx_sales_agreements_kind ON sales_agreements(lead_id, agreement_kind);

COMMIT;

-- ============================================================================
-- VERIFY
--   SELECT agreement_number, agreement_kind, maintenance_plan_id
--     FROM sales_agreements ORDER BY created_at DESC;
--   \d plan_cancellations
-- ============================================================================