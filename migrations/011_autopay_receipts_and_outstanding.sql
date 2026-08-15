-- ============================================================================
-- 011_autopay_receipts_and_outstanding.sql — Diamondback Coding
--
-- Backs the five changes in this round:
--
--   1. AUTOPAY CONSENT IS RECORDED, NOT ASSUMED. A recurring agreement now
--      carries an explicit ACH/card authorization, and the signature row
--      records that the customer saw it and agreed. Without a stored consent
--      record, a chargeback dispute on a recurring charge is very hard to
--      defend — "they signed something" is not the same as "they authorized
--      recurring debits of $X on day N".
--
--   2. THE WHOLE DOCUMENT IS PROVABLY SHOWN. agreement_signatures gains a
--      document_hash and document_snapshot: the exact text displayed at the
--      moment of signing. This is the single most useful thing you can hold in
--      a dispute — it removes "that's not what I agreed to" as an argument.
--
--   3. RECEIPTS ARE FIRST-CLASS. Every payment gets a stable receipt number
--      (they were generated ad hoc and some rows have none), so a receipt PDF
--      can be regenerated identically forever.
--
--   4. OUTSTANDING SPLITS BY CADENCE. maintenance_plans gets
--      current_period_start / current_period_paid_at so a MONTHLY plan can be
--      shown as outstanding from the moment its period opens — before the due
--      date — while an ANNUAL plan is not.
--
--   5. The business address is Austin, TX. Nothing schema-level, but noted
--      here because the document templates changed with it.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. Autopay authorization on the agreement
-- ==========================================================================
DO $$ BEGIN
    -- TRUE when this document authorizes recurring automatic payment. Set at
    -- creation for every maintenance/subscription agreement.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='autopay') THEN
        ALTER TABLE sales_agreements ADD COLUMN autopay BOOLEAN DEFAULT FALSE;
    END IF;
    -- 'month' | 'year' — mirrored from the plan so the signed document states
    -- the cadence itself rather than pointing at a row that can later change.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='autopay_interval') THEN
        ALTER TABLE sales_agreements ADD COLUMN autopay_interval VARCHAR(10);
    END IF;
    -- The exact amount authorized, frozen at signing. A later price change
    -- requires a new signature (the PATCH route already enforces confirmResign);
    -- this column is what makes that enforceable after the fact.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='autopay_amount') THEN
        ALTER TABLE sales_agreements ADD COLUMN autopay_amount NUMERIC(10,2);
    END IF;
    -- Day of month (monthly) or day-of-month within billing_month (annual).
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='autopay_day') THEN
        ALTER TABLE sales_agreements ADD COLUMN autopay_day INTEGER;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sales_agreements_autopay_interval_chk') THEN
        ALTER TABLE sales_agreements ADD CONSTRAINT sales_agreements_autopay_interval_chk
            CHECK (autopay_interval IS NULL OR autopay_interval IN ('month','year'));
    END IF;
END $$;

-- Backfill: every existing maintenance agreement IS an autopay agreement, and
-- its cadence is whatever its plan says.
UPDATE sales_agreements sa
   SET autopay          = TRUE,
       autopay_interval = COALESCE(sa.autopay_interval, mp.interval_unit, 'month'),
       autopay_amount   = COALESCE(sa.autopay_amount, sa.price),
       autopay_day      = COALESCE(sa.autopay_day, mp.billing_day)
  FROM maintenance_plans mp
 WHERE mp.agreement_id = sa.id
   AND COALESCE(sa.autopay, FALSE) = FALSE;

-- ==========================================================================
-- 2. Proof of what was displayed at signing
-- ==========================================================================
-- document_snapshot is the rendered plain text of the agreement as the customer
-- saw it. document_hash is sha256 of that text — cheap to compare, and enough
-- on its own to show the stored copy is unaltered.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='agreement_signatures' AND column_name='document_hash') THEN
        ALTER TABLE agreement_signatures ADD COLUMN document_hash VARCHAR(64);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='agreement_signatures' AND column_name='document_snapshot') THEN
        ALTER TABLE agreement_signatures ADD COLUMN document_snapshot TEXT;
    END IF;
    -- TRUE when the signing UI confirmed the customer scrolled to the end of
    -- the document before the sign control unlocked.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='agreement_signatures' AND column_name='viewed_in_full') THEN
        ALTER TABLE agreement_signatures ADD COLUMN viewed_in_full BOOLEAN DEFAULT FALSE;
    END IF;
    -- Separate, explicit consent to recurring automatic payment — distinct from
    -- consent to the agreement as a whole, because that is what a card network
    -- or bank asks you to produce.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='agreement_signatures' AND column_name='autopay_consent') THEN
        ALTER TABLE agreement_signatures ADD COLUMN autopay_consent BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='agreement_signatures' AND column_name='autopay_consent_text') THEN
        ALTER TABLE agreement_signatures ADD COLUMN autopay_consent_text TEXT;
    END IF;
END $$;

-- ==========================================================================
-- 3. Receipts
-- ==========================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='payments' AND column_name='receipt_number') THEN
        ALTER TABLE payments ADD COLUMN receipt_number VARCHAR(60);
    END IF;
END $$;

-- Any historical payment without a receipt number gets a deterministic one, so
-- a receipt downloaded today and one downloaded next year carry the same
-- identifier. Derived from the payment id, not from a clock or a random value.
UPDATE payments
   SET receipt_number = 'RCPT-' || LPAD(id::text, 6, '0')
 WHERE receipt_number IS NULL OR receipt_number = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt_number
    ON payments(receipt_number) WHERE receipt_number IS NOT NULL;

-- ==========================================================================
-- 4. Recurring period tracking — what makes "outstanding" work
-- ==========================================================================
-- A monthly plan is OUTSTANDING for its current period from the moment that
-- period opens, whether or not the charge date has arrived. These two columns
-- are what let that be answered without guessing from the payments table.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='current_period_start') THEN
        ALTER TABLE maintenance_plans ADD COLUMN current_period_start DATE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='current_period_paid_at') THEN
        ALTER TABLE maintenance_plans ADD COLUMN current_period_paid_at TIMESTAMP;
    END IF;
END $$;

-- Open the current period on every live plan. billing_start_date is the anchor
-- (007); fall back to next_charge_date, then today.
UPDATE maintenance_plans
   SET current_period_start = COALESCE(current_period_start, billing_start_date,
                                       next_charge_date, CURRENT_DATE)
 WHERE current_period_start IS NULL;

-- A plan already paid for its current period should not suddenly read as
-- outstanding the moment this migration lands. If the most recent successful
-- payment for the plan is on or after the period start, the period is settled.
UPDATE maintenance_plans mp
   SET current_period_paid_at = p.paid_at
  FROM (
        SELECT maintenance_plan_id, MAX(paid_at) AS paid_at
          FROM payments
         WHERE status = 'succeeded' AND maintenance_plan_id IS NOT NULL
         GROUP BY maintenance_plan_id
       ) p
 WHERE p.maintenance_plan_id = mp.id
   AND mp.current_period_paid_at IS NULL
   AND p.paid_at::date >= mp.current_period_start;

-- The index the home-screen outstanding query hits: monthly, live, unpaid.
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_period_due
    ON maintenance_plans(lead_id, interval_unit, current_period_start)
    WHERE current_period_paid_at IS NULL
      AND status IN ('active','past_due','pending_cancellation');

COMMIT;

-- ============================================================================
-- VERIFY
--
--   -- 1. Autopay is recorded on every recurring agreement:
--   SELECT agreement_number, agreement_kind, autopay, autopay_interval,
--          autopay_amount, autopay_day
--     FROM sales_agreements WHERE agreement_kind IN ('maintenance','subscription');
--
--   -- 2. Signature table can hold the proof:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='agreement_signatures'
--      AND column_name IN ('document_hash','document_snapshot','viewed_in_full',
--                          'autopay_consent','autopay_consent_text');
--
--   -- 3. Every payment can produce a receipt (must return 0):
--   SELECT COUNT(*) FROM payments WHERE receipt_number IS NULL;
--
--   -- 4. Monthly plans currently outstanding (this is what the home screen shows):
--   SELECT id, label, amount, current_period_start
--     FROM maintenance_plans
--    WHERE interval_unit = 'month'
--      AND current_period_paid_at IS NULL
--      AND status IN ('active','past_due','pending_cancellation');
-- ============================================================================