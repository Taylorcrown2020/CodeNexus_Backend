-- ============================================================================
-- 006_reconcile_signatures.sql — Diamondback Coding
--
-- REPAIRS THE ADMIN/CUSTOMER MISMATCH.
--
-- The admin portal decides an agreement is signed from the agreement_signatures
-- row; the customer portal decides from sales_agreements.status / signed_at.
-- Any agreement that got a signature WITHOUT its own row being updated — which
-- is what earlier, partly-broken signing runs left behind — therefore reads
-- "signed" to you and "Review & sign" to the customer, forever.
--
-- This backfills the agreement row from the signature, which is the
-- authoritative record of the customer's act. Same for maintenance plans, whose
-- signed_at was never written at all before the signing fix.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ---------------------------------------------- agreements with a signature
UPDATE sales_agreements sa
   SET status     = CASE WHEN sa.status IN ('sent','draft') THEN 'signed' ELSE sa.status END,
       signed_at  = COALESCE(sa.signed_at, sig.signed_at),
       signature_name = COALESCE(sa.signature_name, sig.signer_name),
       updated_at = NOW()
  FROM agreement_signatures sig
 WHERE sig.agreement_id = sa.id
   AND (sa.signed_at IS NULL OR sa.status IN ('sent','draft'));

-- --------------------------------------- maintenance plans with a signature
-- Before the signing fix, maintenance_plans.signed_at was read in four places
-- and written in none, so a signed plan sat at 'pending_signature' forever.
UPDATE maintenance_plans mp
   SET signed_at = COALESCE(mp.signed_at, sig.signed_at),
       updated_at = NOW()
  FROM sales_agreements sa
  JOIN agreement_signatures sig ON sig.agreement_id = sa.id
 WHERE mp.agreement_id = sa.id
   AND mp.signed_at IS NULL;

-- A signed plan with a payment method on file is active; without one it's
-- waiting for a card, not for a signature.
UPDATE maintenance_plans mp
   SET status = CASE
           WHEN COALESCE(mp.payment_method_id, l.default_payment_method_id) IS NOT NULL
                THEN 'active' ELSE 'pending_payment_method' END,
       activated_at = CASE
           WHEN COALESCE(mp.payment_method_id, l.default_payment_method_id) IS NOT NULL
                THEN COALESCE(mp.activated_at, NOW()) ELSE mp.activated_at END,
       updated_at = NOW()
  FROM leads l
 WHERE l.id = mp.lead_id
   AND mp.status = 'pending_signature'
   AND mp.signed_at IS NOT NULL;

-- ------------------------------------------------ a signed SLA owes a bill
-- An agreement can be signed with no invoice if the signing run failed after
-- the signature. Those are logged rather than invented — creating money records
-- from a migration is not something that should happen silently.
DO $$
DECLARE
    orphan INTEGER;
BEGIN
    SELECT COUNT(*) INTO orphan
      FROM sales_agreements sa
     WHERE sa.signed_at IS NOT NULL
       AND COALESCE(sa.agreement_kind,'sla') = 'sla'
       AND sa.invoice_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.agreement_id = sa.id);
    IF orphan > 0 THEN
        RAISE NOTICE 'NOTE: % signed agreement(s) have no invoice. Open each in the admin portal and use "Create invoice" — this migration will not invent billing records.', orphan;
    END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY — both sides should now agree:
--   SELECT sa.id, sa.status, sa.signed_at IS NOT NULL AS customer_sees_signed,
--          (sig.id IS NOT NULL) AS admin_sees_signed
--     FROM sales_agreements sa
--     LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id;
--
--   SELECT id, label, status, signed_at FROM maintenance_plans;
-- ============================================================================