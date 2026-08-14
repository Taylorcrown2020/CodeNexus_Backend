-- ============================================================================
-- 004_project_updates.sql — Diamondback Coding
--
-- Adds the project update feed: the admin posts an update, the customer sees it
-- on their timeline and is emailed and messaged about it.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS project_updates (
    id          SERIAL PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
    lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    title       VARCHAR(200) NOT NULL,
    body        TEXT,
    -- Snapshot of the status/progress at the time of the update, so the
    -- customer's timeline reads as a history rather than only a current state.
    status      VARCHAR(40),
    progress    INTEGER,
    created_by  INTEGER,
    notified_at TIMESTAMP,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_updates_project
    ON project_updates(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_updates_lead
    ON project_updates(lead_id, created_at DESC);

-- Percent complete on the project itself. Distinct from the milestone count:
-- an admin may want to say "60%" without a milestone having closed.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='client_projects' AND column_name='progress') THEN
        ALTER TABLE client_projects ADD COLUMN progress INTEGER;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='client_projects_progress_chk') THEN
        ALTER TABLE client_projects ADD CONSTRAINT client_projects_progress_chk
            CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100));
    END IF;
END $$;

-- service_requests.project is written by the portal; make sure it exists even
-- if 001 ran in an older form.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='service_requests' AND column_name='project') THEN
        ALTER TABLE service_requests ADD COLUMN project VARCHAR(200);
    END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY
--   \d project_updates
--   SELECT progress FROM client_projects LIMIT 1;
-- ============================================================================