-- ============================================================================
-- 012_tax_and_processing_fee.sql — Diamondback Coding
--
-- Adds sales tax and a 3% card processing fee to recurring plans.
--
-- ────────────────────────────────────────────────────────────────────────────
-- READ THIS BEFORE RUNNING — TWO THINGS THAT CAN COST YOU MONEY
-- ────────────────────────────────────────────────────────────────────────────
--
-- 1. THE FEE APPLIES TO CREDIT CARDS ONLY, AND THAT IS NOT OPTIONAL.
--
--    Surcharging a DEBIT card is prohibited by federal law (the Durbin
--    Amendment, 15 U.S.C. 1693o-2), regardless of state law or card network
--    rules. Prepaid cards are treated the same way. There is no version of this
--    where a 3% fee on a debit transaction is allowed.
--
--    Telling credit from debit requires Stripe's card.funding value, which this
--    database has never stored — payment_methods has brand and last4 and
--    nothing else. That is what the `funding` column below is for. UNTIL IT IS
--    BACKFILLED, every existing card reads 'unknown', and the pricing code
--    treats unknown as NOT surchargeable. That is deliberate: undercharging by
--    3% is a rounding error, surcharging a debit card is a federal violation.
--
--    Backfill from Stripe with:  node scripts/backfill-card-funding.js
--
--    Credit surcharging also carries card-network conditions that are on you,
--    not on this code: register with Visa/Mastercard at least 30 days before
--    the first surcharge, cap it at the lower of 3% or your effective discount
--    rate, disclose it at the point of sale and on the receipt, and never
--    surcharge in a state that still bans it if you take out-of-state
--    customers. Texas's ban was struck down (Rowell v. Pettijohn, 5th Cir.
--    2018), so Texas itself is fine. Connecticut, Massachusetts and Puerto Rico
--    are not.
--
-- 2. THIS CHANGES WHAT ALREADY-SIGNED CUSTOMERS PAY.
--
--    You asked for it to apply to everyone now. It will. But the agreements
--    those customers signed say, in the autopay authorization they consented
--    to, that we give at least ten (10) days' written notice before an amount
--    changes and that a price increase requires a new signed agreement.
--
--    Raising a live autopay charge by ~11.5% without that notice is the single
--    most reliable way to generate chargebacks, and in a dispute the customer's
--    own signed agreement is the document that says you had to warn them.
--
--    So this migration sets the rates but does NOT switch anyone over. Every
--    existing plan gets `pricing_effective_from` = NULL, which the pricing code
--    reads as "old pricing until told otherwise". Section 5 has the one-line
--    UPDATE that switches everyone on, with a date. Run it AFTER the notice
--    goes out — `node scripts/notify-price-change.js` sends it and sets the
--    date to 10 days out for you.
--
--    If you want it live this instant anyway, section 5 tells you exactly what
--    to run. It is your business and your call; it just should not be the
--    thing that happens by default when a migration runs.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. Card funding type — what makes credit-only surcharging possible
-- ==========================================================================
DO $$ BEGIN
    -- 'credit' | 'debit' | 'prepaid' | 'unknown'. Straight from Stripe's
    -- PaymentMethod.card.funding.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='payment_methods' AND column_name='funding') THEN
        ALTER TABLE payment_methods ADD COLUMN funding VARCHAR(20) DEFAULT 'unknown';
    END IF;
    -- When the funding value was last confirmed against Stripe, so the backfill
    -- script can find the ones it hasn't reached yet.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='payment_methods' AND column_name='funding_checked_at') THEN
        ALTER TABLE payment_methods ADD COLUMN funding_checked_at TIMESTAMP;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_methods_funding_chk') THEN
        ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_funding_chk
            CHECK (funding IS NULL OR funding IN ('credit','debit','prepaid','unknown'));
    END IF;
END $$;

-- A bank account is not a card and is never surchargeable under network rules;
-- it can carry a fee, but not this one. Mark it definitively so the pricing
-- code never has to guess.
UPDATE payment_methods
   SET funding = 'unknown', funding_checked_at = NOW()
 WHERE type = 'us_bank_account' AND funding IS DISTINCT FROM 'unknown';

-- Everything else stays 'unknown' until the backfill confirms it from Stripe.
UPDATE payment_methods SET funding = 'unknown' WHERE funding IS NULL;

CREATE INDEX IF NOT EXISTS idx_payment_methods_unknown_funding
    ON payment_methods(lead_id) WHERE type = 'card' AND funding = 'unknown';

-- ==========================================================================
-- 2. Rates on the plan
-- ==========================================================================
-- Stored per plan rather than read from a constant, so that a plan signed at
-- 8.25% keeps being charged 8.25% if the rate later changes. The signed
-- document states a rate; the plan must be able to honour it.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='tax_rate') THEN
        ALTER TABLE maintenance_plans ADD COLUMN tax_rate NUMERIC(6,4);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='processing_fee_pct') THEN
        ALTER TABLE maintenance_plans ADD COLUMN processing_fee_pct NUMERIC(6,4);
    END IF;
    -- NULL = this plan is still on its old, tax-and-fee-free pricing.
    -- A date = the pricing below applies to charges on or after it.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='pricing_effective_from') THEN
        ALTER TABLE maintenance_plans ADD COLUMN pricing_effective_from DATE;
    END IF;
    -- When the ten-day notice was sent, and to whom. Evidence, for a dispute.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='price_change_notified_at') THEN
        ALTER TABLE maintenance_plans ADD COLUMN price_change_notified_at TIMESTAMP;
    END IF;
END $$;

-- Set the rates on every plan. This does NOT change any charge on its own —
-- pricing_effective_from is still NULL, and the pricing code requires a date
-- before it applies either rate.
UPDATE maintenance_plans
   SET tax_rate           = COALESCE(tax_rate, 0.0825),
       processing_fee_pct = COALESCE(processing_fee_pct, 0.03)
 WHERE tax_rate IS NULL OR processing_fee_pct IS NULL;

-- ==========================================================================
-- 3. The same three numbers on the agreement
-- ==========================================================================
-- The signed document has to state the rates it was signed under, for the same
-- reason autopay_amount lives on the agreement: a row that can be edited later
-- must not be the only record of what the customer agreed to.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='tax_rate') THEN
        ALTER TABLE sales_agreements ADD COLUMN tax_rate NUMERIC(6,4);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='sales_agreements' AND column_name='processing_fee_pct') THEN
        ALTER TABLE sales_agreements ADD COLUMN processing_fee_pct NUMERIC(6,4);
    END IF;
END $$;

-- ==========================================================================
-- 4. Fee breakdown on invoices and payments
-- ==========================================================================
-- The surcharge must appear as its own line on the receipt — that is a card
-- network disclosure requirement, not a presentation choice.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='invoices' AND column_name='processing_fee') THEN
        ALTER TABLE invoices ADD COLUMN processing_fee NUMERIC(10,2) DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='payments' AND column_name='tax_amount') THEN
        ALTER TABLE payments ADD COLUMN tax_amount NUMERIC(10,2) DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='payments' AND column_name='processing_fee') THEN
        ALTER TABLE payments ADD COLUMN processing_fee NUMERIC(10,2) DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='payments' AND column_name='base_amount') THEN
        ALTER TABLE payments ADD COLUMN base_amount NUMERIC(10,2);
    END IF;
END $$;

-- Historical payments predate the fee: their whole amount was the base.
UPDATE payments SET base_amount = amount WHERE base_amount IS NULL;

COMMIT;

-- ============================================================================
-- 5. SWITCHING EXISTING CUSTOMERS OVER — a separate, deliberate step
-- ============================================================================
-- Nothing above changes a single charge. To actually apply tax and the fee to
-- existing plans, a date has to be set.
--
-- THE RIGHT WAY (sends the notice the signed agreements promise, then sets the
-- date to ten days out, per plan):
--
--     node scripts/notify-price-change.js --dry-run     # see who is affected
--     node scripts/notify-price-change.js               # send and schedule
--
-- IF YOU WANT IT LIVE IMMEDIATELY ANYWAY, this is the statement. It is left
-- commented on purpose — uncommenting it is you deciding to charge more than
-- your customers' signed agreements say you would, without the notice those
-- agreements promise. That is a chargeback risk and, if disputed, the customer
-- holds a signed document saying you owed them ten days:
--
--     UPDATE maintenance_plans
--        SET pricing_effective_from = CURRENT_DATE, updated_at = NOW()
--      WHERE status IN ('active','past_due','pending_cancellation');
--
-- New plans created from now on get the pricing at signing and need none of
-- this — their customers agree to it in the document itself.
-- ============================================================================

-- ============================================================================
-- VERIFY
--
--   -- 1. Cards still needing a funding lookup (each one cannot be surcharged
--   --    until this returns 0):
--   SELECT COUNT(*) FROM payment_methods WHERE type='card' AND funding='unknown';
--
--   -- 2. Rates are set, and nobody has been switched over yet:
--   SELECT id, label, amount, tax_rate, processing_fee_pct, pricing_effective_from
--     FROM maintenance_plans ORDER BY id;
--
--   -- 3. After notifying, who is scheduled and when:
--   SELECT id, label, price_change_notified_at, pricing_effective_from
--     FROM maintenance_plans WHERE pricing_effective_from IS NOT NULL;
-- ============================================================================