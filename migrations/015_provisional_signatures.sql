-- ============================================================================
-- 015_provisional_signatures.sql — Diamondback Coding
--
-- A SIGNATURE WITHOUT A PAYMENT METHOD IS NOT A SIGNED AGREEMENT.
--
-- Until now, typing your name set `signed_at` immediately, and the plan then sat
-- waiting for a card. Everything downstream — the portal, the admin list, the
-- Docs tab — read `signed_at` and reported the agreement as signed, because
-- from their point of view it was.
--
-- We tried to patch that by undoing the signature when the customer closed the
-- payment sheet. That works only if the portal gets a chance to call back: close
-- the tab, lose signal, or kill the app and the signature stayed, and the
-- agreement still read "signed" with nothing behind it.
--
-- So the state itself now carries the truth:
--
--     provisional_signed_at   they typed their name
--     signed_at               ...AND a payment method exists
--
-- `signed_at` is only ever set when both are true. Nothing downstream changes:
-- every screen that reads `signed_at` now shows "Review & sign" until the card
-- lands, with no cleanup call to miss. Abandoning halfway is the default
-- outcome rather than something we have to catch.
--
-- The signature evidence is NOT discarded. agreement_signatures keeps the typed
-- name, timestamp, IP, browser and document hash, so if they later add a card
-- the commit uses the original signing moment — not the moment the card
-- arrived.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='provisional_signed_at') THEN
        ALTER TABLE sales_agreements ADD COLUMN provisional_signed_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='provisional_signer_name') THEN
        ALTER TABLE sales_agreements ADD COLUMN provisional_signer_name VARCHAR(200);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='provisional_signed_at') THEN
        ALTER TABLE maintenance_plans ADD COLUMN provisional_signed_at TIMESTAMP;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agreements_provisional
    ON sales_agreements(provisional_signed_at)
    WHERE provisional_signed_at IS NOT NULL AND signed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plans_provisional
    ON maintenance_plans(provisional_signed_at)
    WHERE provisional_signed_at IS NOT NULL AND signed_at IS NULL;

-- ==========================================================================
-- Repair plans that are already stuck in the old broken state
-- ==========================================================================
-- A plan reading "signed" with no payment method and no charge ever taken was
-- signed under the old behaviour and never started. Move it to provisional so
-- it displays honestly: the customer sees "Review & sign" again, and the
-- signature evidence is preserved in provisional_signed_at.
--
-- Anything with a payment method, or that has ever been charged, is left
-- completely alone — those are real, running plans.
UPDATE maintenance_plans mp
   SET provisional_signed_at = mp.signed_at,
       signed_at = NULL,
       status = 'pending_payment_method',
       updated_at = NOW()
  FROM leads l
 WHERE l.id = mp.lead_id
   AND mp.signed_at IS NOT NULL
   AND mp.provisional_signed_at IS NULL
   AND COALESCE(mp.charges_completed, 0) = 0
   AND mp.last_charge_date IS NULL
   AND mp.payment_method_id IS NULL
   AND l.default_payment_method_id IS NULL
   AND mp.status <> 'cancelled';

UPDATE sales_agreements sa
   SET provisional_signed_at = sa.signed_at,
       provisional_signer_name = sa.signature_name,
       signed_at = NULL,
       signature_name = NULL,
       status = 'sent',
       updated_at = NOW()
  FROM maintenance_plans mp
 WHERE mp.agreement_id = sa.id
   AND mp.provisional_signed_at IS NOT NULL
   AND mp.signed_at IS NULL
   AND sa.signed_at IS NOT NULL;

COMMIT;

-- ============================================================================
-- VERIFY
--
--   -- Agreements the customer has typed their name on but not yet paid for.
--   -- These correctly show as UNSIGNED until a card is added:
--   SELECT agreement_number, provisional_signed_at, signed_at, status
--     FROM sales_agreements
--    WHERE provisional_signed_at IS NOT NULL AND signed_at IS NULL;
--
--   -- Should return 0: a signed plan with no way to charge it.
--   SELECT COUNT(*) FROM maintenance_plans mp
--     JOIN leads l ON l.id = mp.lead_id
--    WHERE mp.signed_at IS NOT NULL
--      AND COALESCE(mp.charges_completed,0) = 0
--      AND mp.payment_method_id IS NULL
--      AND l.default_payment_method_id IS NULL;
-- ============================================================================