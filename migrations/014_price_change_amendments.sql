-- ============================================================================
-- 014_price_change_amendments.sql — Diamondback Coding
--
-- A PRICE CHANGE IS AN AMENDMENT, NOT A NEW PLAN.
--
-- Until now, changing the price of a signed plan did this:
--   * blanked the plan's signed_at and set it to 'pending_signature',
--   * DELETED the original signature,
--   * rewrote the original agreement in place.
--
-- Three problems with that. The plan stopped billing until they re-signed, so
-- a price change cost you a month. The original signed document — the thing
-- that proves what they agreed to at the old price — was destroyed. And the
-- customer saw their existing agreement silently change underneath them.
--
-- Now: the plan and its original agreement are left completely alone. A
-- separate AMENDMENT document is raised for the price change only. The plan
-- keeps billing at the OLD price until the amendment is signed, and switches
-- to the new price the moment it is.
--
-- One plan, one running agreement, and a paper trail of every price it has
-- ever been at.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. The amendment kind
-- ==========================================================================
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_agreements_kind_chk') THEN
        ALTER TABLE sales_agreements DROP CONSTRAINT sales_agreements_kind_chk;
    END IF;
    ALTER TABLE sales_agreements ADD CONSTRAINT sales_agreements_kind_chk
        CHECK (agreement_kind IS NULL OR agreement_kind IN
               ('sla','maintenance','reinstatement','subscription','price_change'));
END $$;

DO $$ BEGIN
    -- Which agreement this one amends. The original stays signed and intact;
    -- this points back at it so the history is walkable in either direction.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='amends_agreement_id') THEN
        ALTER TABLE sales_agreements ADD COLUMN amends_agreement_id INTEGER;
    END IF;
    -- The price before and after, frozen on the amendment. Storing both means
    -- the document can state the change itself rather than pointing at a plan
    -- row that will have moved on by the time anyone reads it.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='previous_price') THEN
        ALTER TABLE sales_agreements ADD COLUMN previous_price NUMERIC(10,2);
    END IF;
    -- When the new price starts. Normally the next charge after signing.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='price_effective_from') THEN
        ALTER TABLE sales_agreements ADD COLUMN price_effective_from DATE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_agreements_amends
    ON sales_agreements(amends_agreement_id) WHERE amends_agreement_id IS NOT NULL;

-- ==========================================================================
-- 2. The pending price on the plan
-- ==========================================================================
-- The plan keeps its current `amount` and keeps billing at it. The proposed
-- price sits alongside until the amendment is signed, at which point it moves
-- into `amount` and these clear.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='pending_amount') THEN
        ALTER TABLE maintenance_plans ADD COLUMN pending_amount NUMERIC(10,2);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='pending_agreement_id') THEN
        ALTER TABLE maintenance_plans ADD COLUMN pending_agreement_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='pending_since') THEN
        ALTER TABLE maintenance_plans ADD COLUMN pending_since TIMESTAMP;
    END IF;
    -- A change to the DAY you are charged is a change to the automatic payment
    -- authorization just as much as a change to the amount is. It needs the
    -- same signature and the same "keep the old one until you sign" handling,
    -- so it parks here alongside pending_amount.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='pending_billing_day') THEN
        ALTER TABLE maintenance_plans ADD COLUMN pending_billing_day INTEGER;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_maintenance_plans_pending
    ON maintenance_plans(pending_agreement_id) WHERE pending_agreement_id IS NOT NULL;

-- ==========================================================================
-- 3. Repair plans broken by the OLD price-change behaviour
-- ==========================================================================
-- A plan that was pushed to 'pending_signature' by a price edit, whose
-- agreement has no signature left, is stuck: runMaintenanceCharges requires
-- signed_at, so it has silently stopped billing. Anything with a real
-- signature is left alone.
DO $$
DECLARE stuck INTEGER;
BEGIN
    SELECT COUNT(*) INTO stuck
      FROM maintenance_plans mp
     WHERE mp.status = 'pending_signature'
       AND mp.signed_at IS NULL
       AND mp.agreement_id IS NOT NULL;
    IF stuck > 0 THEN
        RAISE NOTICE '% plan(s) are sitting at pending_signature with no signature.', stuck;
        RAISE NOTICE 'These stopped billing when their price was edited under the old behaviour.';
        RAISE NOTICE 'Review them in the admin portal: each needs its agreement re-sent, or';
        RAISE NOTICE 'the price reverting. This migration does NOT resume billing on its own —';
        RAISE NOTICE 'charging a customer who has not signed the current price is exactly the';
        RAISE NOTICE 'thing the signature is there to prevent.';
    END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY
--   -- Amendments raised, and what they change:
--   SELECT agreement_number, agreement_kind, amends_agreement_id,
--          previous_price, price, price_effective_from, signed_at
--     FROM sales_agreements WHERE agreement_kind = 'price_change'
--    ORDER BY created_at DESC;
--
--   -- Plans with a price change waiting on a signature:
--   SELECT id, label, amount AS billing_at_now, pending_amount AS becomes,
--          pending_since
--     FROM maintenance_plans WHERE pending_agreement_id IS NOT NULL;
--
--   -- Plans stuck by the old behaviour (should be empty once reviewed):
--   SELECT id, label, status, signed_at FROM maintenance_plans
--    WHERE status='pending_signature' AND signed_at IS NULL;
-- ============================================================================