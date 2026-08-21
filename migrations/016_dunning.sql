-- ============================================================================
-- 016_dunning.sql — Diamondback Coding
--
-- WHAT HAPPENS WHEN A CARD KEEPS DECLINING.
--
-- Before this, a failed charge was retried on every daily run — so a dead card
-- was hit once a day forever. Two problems with that:
--
--   1. Card networks penalise repeated declines. Visa and Mastercard both cap
--      retries on the same card for the same purchase (Visa's limit is 15 in 30
--      days) and issuers start hard-declining an account that keeps getting
--      hammered. You can end up unable to charge a card that would otherwise
--      have worked once the customer topped it up.
--
--   2. Nothing ever stopped. The plan sat at 'past_due' and the customer kept
--      receiving the service indefinitely.
--
-- The schedule below is the ordinary commercial one: retry on days 1, 3, 5, 7
-- and 10, suspend the service on day 14, end the plan on day 30. Every step is
-- configurable, and the debt is never written off by any of them.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

DO $$ BEGIN
    -- When to attempt the card again. NULL means "not in dunning".
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='next_retry_at') THEN
        ALTER TABLE maintenance_plans ADD COLUMN next_retry_at TIMESTAMP;
    END IF;
    -- The day the first charge for this run of failures was declined. Every
    -- step below is measured from here, not from the last attempt, so a retry
    -- cannot quietly restart the clock and keep service alive forever.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='dunning_started_at') THEN
        ALTER TABLE maintenance_plans ADD COLUMN dunning_started_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='suspended_at') THEN
        ALTER TABLE maintenance_plans ADD COLUMN suspended_at TIMESTAMP;
    END IF;
    -- The last decline reason from Stripe, so the admin screen can say
    -- "insufficient funds" rather than "it failed".
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='last_failure_reason') THEN
        ALTER TABLE maintenance_plans ADD COLUMN last_failure_reason TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='maintenance_plans' AND column_name='last_failure_at') THEN
        ALTER TABLE maintenance_plans ADD COLUMN last_failure_at TIMESTAMP;
    END IF;
END $$;

-- Suspension is on the CUSTOMER as well, so anything checking whether to serve
-- them has one flag to read rather than joining plans every time.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='service_suspended_at') THEN
        ALTER TABLE leads ADD COLUMN service_suspended_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='leads' AND column_name='service_suspended_reason') THEN
        ALTER TABLE leads ADD COLUMN service_suspended_reason TEXT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_plans_retry
    ON maintenance_plans(next_retry_at) WHERE next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plans_suspended
    ON maintenance_plans(suspended_at) WHERE suspended_at IS NOT NULL;

COMMIT;

-- ============================================================================
-- VERIFY
--   SELECT id, label, consecutive_failures, dunning_started_at, next_retry_at,
--          suspended_at, last_failure_reason
--     FROM maintenance_plans WHERE consecutive_failures > 0;
--
--   SELECT id, name, service_suspended_at, service_suspended_reason
--     FROM leads WHERE service_suspended_at IS NOT NULL;
-- ============================================================================