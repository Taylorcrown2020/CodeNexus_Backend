-- ============================================================================
-- 008_agreement_milestones.sql — Diamondback Coding
--
-- Milestones are defined ON THE AGREEMENT, before anyone signs. Signing turns
-- them into the customer's project timeline — which is why there is no longer
-- any "create project timeline" action.
--
-- Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS agreement_milestones (
    id            SERIAL PRIMARY KEY,
    agreement_id  INTEGER NOT NULL REFERENCES sales_agreements(id) ON DELETE CASCADE,
    sort_order    INTEGER DEFAULT 0,
    title         VARCHAR(300) NOT NULL,
    description   TEXT,
    due_date      DATE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agreement_milestones_agreement
    ON agreement_milestones(agreement_id, sort_order);

-- project_milestones gets the target date carried over from the agreement, so
-- the customer's timeline can show what was promised.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='project_milestones' AND column_name='due_date') THEN
        ALTER TABLE project_milestones ADD COLUMN due_date DATE;
    END IF;
END $$;

COMMIT;