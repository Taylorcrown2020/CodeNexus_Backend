-- ============================================================================
-- 010_signing_repair_and_guards.sql — Diamondback Coding
--
-- Repairs the damage the signing bug left behind, and adds the columns the
-- billing guards need.
--
-- THE BUG THIS REPAIRS
--   onAgreementSigned() took its once-guard (a lifecycle_events row) BEFORE
--   doing any work. If anything downstream threw — a missing column, a Stripe
--   hiccup, a failed email — the guard survived the failure. Every retry then
--   returned early saying "already signed", so:
--     * sales_agreements.status stayed 'sent'
--     * the customer portal kept showing "Review & sign", forever
--     * billing kept saying "awaiting signature"
--     * the agreement never reached Docs
--     * but the UI reported success on the second attempt
--
--   The code fix stops it recurring. This repairs the rows already stuck.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. Release stuck signing claims
-- ==========================================================================
-- A 'sla_signed' claim on an agreement that has NO signature and NO signed_at
-- is a latch left by a failed attempt. It is the thing making the agreement
-- permanently unsignable, so it goes. Claims on genuinely signed agreements are
-- left alone — they are a real audit record.
DELETE FROM lifecycle_events le
 WHERE le.stage = 'sla_signed'
   AND EXISTS (
        SELECT 1 FROM sales_agreements sa
         WHERE le.once_key = 'sla_signed:agreement:' || sa.id::text
           AND sa.signed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM agreement_signatures sig WHERE sig.agreement_id = sa.id)
   );

-- ==========================================================================
-- 2. Reconcile agreements that DID sign but never got written back
-- ==========================================================================
-- Same repair as 006, re-run here because the bug kept producing these rows
-- after 006 was applied.
UPDATE sales_agreements sa
   SET status     = CASE WHEN sa.status IN ('sent','draft') THEN 'signed' ELSE sa.status END,
       signed_at  = COALESCE(sa.signed_at, sig.signed_at),
       signature_name = COALESCE(sa.signature_name, sig.signer_name),
       updated_at = NOW()
  FROM agreement_signatures sig
 WHERE sig.agreement_id = sa.id
   AND (sa.signed_at IS NULL OR sa.status IN ('sent','draft'));

-- Maintenance plans behind those agreements.
UPDATE maintenance_plans mp
   SET signed_at  = COALESCE(mp.signed_at, sig.signed_at),
       updated_at = NOW()
  FROM sales_agreements sa
  JOIN agreement_signatures sig ON sig.agreement_id = sa.id
 WHERE mp.agreement_id = sa.id
   AND mp.signed_at IS NULL;

-- ==========================================================================
-- 3. Suspension tracking
-- ==========================================================================
-- Without somewhere to record it, a plan that could not be billed simply sat in
-- 'pending_payment_method' and the customer kept the service for free.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='suspended_at') THEN
        ALTER TABLE maintenance_plans ADD COLUMN suspended_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='consecutive_failures') THEN
        ALTER TABLE maintenance_plans ADD COLUMN consecutive_failures INTEGER DEFAULT 0;
    END IF;
END $$;

-- 'suspended' is a new status value; widen the constraint if one exists.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_plans_status_chk') THEN
        ALTER TABLE maintenance_plans DROP CONSTRAINT maintenance_plans_status_chk;
        ALTER TABLE maintenance_plans ADD CONSTRAINT maintenance_plans_status_chk
            CHECK (status IN ('pending_signature','pending_payment_method','active',
                              'past_due','suspended','pending_cancellation','cancelled'));
    END IF;
END $$;

-- ==========================================================================
-- 4. Nothing is outstanding against an unsigned document
-- ==========================================================================
-- Invoices raised against an agreement or plan that was never signed are not
-- obligations. They are parked as 'draft' rather than deleted: the record of
-- what was intended is kept, and draft is already excluded from every
-- outstanding, dunning and balance query in the codebase.
UPDATE invoices i
   SET status = 'draft', updated_at = NOW()
 WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
   AND i.agreement_id IS NOT NULL
   AND NOT EXISTS (
        SELECT 1 FROM sales_agreements sa
         WHERE sa.id = i.agreement_id
           AND (sa.signed_at IS NOT NULL OR sa.status = 'signed'));

UPDATE invoices i
   SET status = 'draft', updated_at = NOW()
 WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
   AND i.maintenance_plan_id IS NOT NULL
   AND NOT EXISTS (
        SELECT 1 FROM maintenance_plans mp
         WHERE mp.id = i.maintenance_plan_id
           AND mp.signed_at IS NOT NULL);

-- ==========================================================================
-- 5. Indexes for the signed-gate lookups
-- ==========================================================================
CREATE INDEX IF NOT EXISTS idx_sales_agreements_signed
    ON sales_agreements(id) WHERE signed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_signed
    ON maintenance_plans(id) WHERE signed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_due
    ON maintenance_plans(next_charge_date)
    WHERE signed_at IS NOT NULL AND status IN ('active','pending_cancellation');

COMMIT;

-- ============================================================================
-- VERIFY
--
--   -- Should return NO rows: agreements stuck "claimed but unsigned".
--   SELECT sa.id, sa.agreement_number, sa.status
--     FROM sales_agreements sa
--     JOIN lifecycle_events le
--       ON le.once_key = 'sla_signed:agreement:' || sa.id::text
--    WHERE sa.signed_at IS NULL;
--
--   -- Both columns should agree on every row.
--   SELECT sa.id, sa.status, sa.signed_at IS NOT NULL AS customer_sees_signed,
--          (sig.id IS NOT NULL) AS admin_sees_signed
--     FROM sales_agreements sa
--     LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id;
--
--   -- Should return NO rows: money owed against an unsigned document.
--   SELECT i.invoice_number, i.total_amount
--     FROM invoices i
--     LEFT JOIN sales_agreements sa ON sa.id = i.agreement_id
--    WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
--      AND i.agreement_id IS NOT NULL
--      AND sa.signed_at IS NULL;
-- ============================================================================