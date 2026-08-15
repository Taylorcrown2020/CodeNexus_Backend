-- ============================================================================
-- 010_missing_columns_and_signing_repair.sql — Diamondback Coding
--
-- THE ACTUAL ROOT CAUSE, found in the server log:
--
--     column sa.signed_at does not exist
--
-- `sales_agreements` in this database is an OLDER version of the table that
-- predates migration 001. Migration 001 creates it with CREATE TABLE IF NOT
-- EXISTS — so on a database where the table already existed, that statement did
-- nothing at all, and the 17 columns defined only inside it were never added.
-- 001's guarded ALTERs cover five columns; signed_at is not one of them.
--
-- Everything followed from that one missing column:
--
--   * SIGNING ERRORED — onAgreementSigned does
--       UPDATE sales_agreements SET status='signed', signed_at=NOW() ...
--     which threw. The once-guard had already been claimed, so the SECOND
--     attempt returned "already signed" and the UI reported success for
--     something that never happened. The portal kept showing "Review & sign",
--     billing kept saying awaiting signature, and it never reached Docs.
--
--   * SLA DELETE FAILED — the delete route SELECTs sa.signed_at before doing
--     anything, so every delete 500'd. This is the bug that "still doesn't
--     work" across several rounds. There was never anything wrong with the
--     delete logic.
--
--   * MIGRATION 006 NEVER APPLIED — its UPDATE references signed_at, so it
--     failed. The runner in db.js records a migration as applied EVEN WHEN ITS
--     STATEMENTS FAIL ("so a genuinely broken statement doesn't re-run
--     forever"), so 006 is marked done in schema_migrations and will never run
--     again. Same for any other statement that touched these columns.
--
--   * The portal logged "agreement signature join failed, falling back" on
--     every dashboard load, for the same reason.
--
-- This migration adds every missing column, THEN performs the repair. Order
-- matters: the repair references the columns being added.
--
-- Idempotent. Safe to run repeatedly.
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. The columns that only ever existed inside 001's CREATE TABLE
-- ==========================================================================
-- Types match 001 exactly. Adding a nullable column with a default is a
-- metadata-only change in Postgres 11+, so this is fast even on a big table.
DO $$
DECLARE
    col   TEXT;
    ddl   TEXT;
    added INTEGER := 0;
    specs TEXT[][] := ARRAY[
        ['agreement_number',   'VARCHAR(40)'],
        ['lead_id',            'INTEGER'],
        ['customer_name',      'VARCHAR(255)'],
        ['customer_email',     'VARCHAR(255)'],
        ['service_type',       'VARCHAR(60)'],
        ['package_name',       'VARCHAR(160)'],
        ['vehicle',            'VARCHAR(200)'],
        ['price',              'NUMERIC(10,2) DEFAULT 0'],
        ['deposit',            'NUMERIC(10,2) DEFAULT 0'],
        ['start_date',         'DATE'],
        ['status',             'VARCHAR(40) DEFAULT ''draft'''],
        ['terms',              'TEXT'],
        ['notes',              'TEXT'],
        ['signed_at',          'TIMESTAMP'],
        ['signature_name',     'VARCHAR(255)'],
        ['created_at',         'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
        ['updated_at',         'TIMESTAMP DEFAULT CURRENT_TIMESTAMP']
    ];
BEGIN
    FOR i IN 1 .. array_length(specs, 1) LOOP
        col := specs[i][1];
        ddl := specs[i][2];
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'sales_agreements' AND column_name = col) THEN
            EXECUTE format('ALTER TABLE sales_agreements ADD COLUMN %I %s', col, ddl);
            RAISE NOTICE 'ADDED sales_agreements.% (%)', col, ddl;
            added := added + 1;
        END IF;
    END LOOP;
    RAISE NOTICE '--- % missing column(s) added to sales_agreements ---', added;
END $$;

-- The unique constraint and foreign key that came with the CREATE TABLE, if the
-- columns were only just added.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_agreements_agreement_number_key')
       AND NOT EXISTS (SELECT 1 FROM pg_indexes
                       WHERE tablename='sales_agreements' AND indexname='idx_sa_number_unique') THEN
        -- A unique INDEX rather than a constraint: it can be created even if
        -- legacy rows share a NULL agreement_number (NULLs don't collide).
        CREATE UNIQUE INDEX idx_sa_number_unique
            ON sales_agreements(agreement_number) WHERE agreement_number IS NOT NULL;
    END IF;
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'agreement_number has duplicates — unique index skipped. Deduplicate, then re-run.';
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'sales_agreements'::regclass AND contype = 'f'
                     AND conname LIKE '%lead_id%') THEN
        BEGIN
            ALTER TABLE sales_agreements
                ADD CONSTRAINT sales_agreements_lead_id_fkey
                FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
        EXCEPTION WHEN others THEN
            RAISE NOTICE 'lead_id FK not added (%). Orphan rows likely — harmless.', SQLERRM;
        END;
    END IF;
END $$;

-- ==========================================================================
-- 2. Same treatment for the other tables 001-003 create-or-skip
-- ==========================================================================
-- If sales_agreements pre-existed, its siblings may have too.
DO $$
DECLARE
    t TEXT; col TEXT; ddl TEXT; added INTEGER := 0;
    specs TEXT[][] := ARRAY[
        ['client_messages',  'kind',           'VARCHAR(20) DEFAULT ''message'''],
        ['client_messages',  'read_by_admin',  'BOOLEAN DEFAULT FALSE'],
        ['client_messages',  'read_by_client', 'BOOLEAN DEFAULT FALSE'],
        ['client_messages',  'request_id',     'INTEGER'],
        ['client_messages',  'subject',        'VARCHAR(200)'],
        ['service_requests', 'status',         'VARCHAR(40) DEFAULT ''new'''],
        ['service_requests', 'preferred_date', 'DATE'],
        ['service_requests', 'details',        'TEXT'],
        ['service_requests', 'updated_at',     'TIMESTAMP DEFAULT CURRENT_TIMESTAMP']
    ];
BEGIN
    FOR i IN 1 .. array_length(specs, 1) LOOP
        t := specs[i][1]; col := specs[i][2]; ddl := specs[i][3];
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t)
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = t AND column_name = col) THEN
            EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s', t, col, ddl);
            RAISE NOTICE 'ADDED %.% (%)', t, col, ddl;
            added := added + 1;
        END IF;
    END LOOP;
    RAISE NOTICE '--- % missing column(s) added to sibling tables ---', added;
END $$;

-- ==========================================================================
-- 3. Re-run migration 006, which failed on the missing column and was then
--    recorded as applied
-- ==========================================================================
UPDATE sales_agreements sa
   SET status     = CASE WHEN sa.status IN ('sent','draft') OR sa.status IS NULL
                         THEN 'signed' ELSE sa.status END,
       signed_at  = COALESCE(sa.signed_at, sig.signed_at),
       signature_name = COALESCE(sa.signature_name, sig.signer_name),
       updated_at = NOW()
  FROM agreement_signatures sig
 WHERE sig.agreement_id = sa.id
   AND (sa.signed_at IS NULL OR sa.status IN ('sent','draft') OR sa.status IS NULL);

UPDATE maintenance_plans mp
   SET signed_at  = COALESCE(mp.signed_at, sig.signed_at),
       updated_at = NOW()
  FROM sales_agreements sa
  JOIN agreement_signatures sig ON sig.agreement_id = sa.id
 WHERE mp.agreement_id = sa.id
   AND mp.signed_at IS NULL;

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

-- ==========================================================================
-- 4. Release stuck signing claims
-- ==========================================================================
-- A 'sla_signed' claim on an agreement with NO signature and NO signed_at is a
-- latch left by an attempt that died on the missing column. It is what makes
-- the agreement permanently unsignable. Claims on genuinely signed agreements
-- are left alone — they are a real audit record.
DELETE FROM lifecycle_events le
 WHERE le.stage = 'sla_signed'
   AND EXISTS (
        SELECT 1 FROM sales_agreements sa
         WHERE le.once_key = 'sla_signed:agreement:' || sa.id::text
           AND sa.signed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM agreement_signatures sig
                            WHERE sig.agreement_id = sa.id));

-- ==========================================================================
-- 5. Suspension tracking (billing loophole guards)
-- ==========================================================================
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

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_plans_status_chk') THEN
        ALTER TABLE maintenance_plans DROP CONSTRAINT maintenance_plans_status_chk;
        ALTER TABLE maintenance_plans ADD CONSTRAINT maintenance_plans_status_chk
            CHECK (status IN ('pending_signature','pending_payment_method','active',
                              'past_due','suspended','pending_cancellation','cancelled'));
    END IF;
END $$;

-- ==========================================================================
-- 6. Nothing is outstanding against an unsigned document
-- ==========================================================================
-- Parked as 'draft', not deleted: the record of what was intended survives, and
-- draft is already excluded from every outstanding, dunning and balance query.
UPDATE invoices i
   SET status = 'draft', updated_at = NOW()
 WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
   AND i.agreement_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sales_agreements sa
                    WHERE sa.id = i.agreement_id
                      AND (sa.signed_at IS NOT NULL OR sa.status = 'signed'));

UPDATE invoices i
   SET status = 'draft', updated_at = NOW()
 WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
   AND i.maintenance_plan_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM maintenance_plans mp
                    WHERE mp.id = i.maintenance_plan_id
                      AND mp.signed_at IS NOT NULL);

-- ==========================================================================
-- 7. Indexes
-- ==========================================================================
CREATE INDEX IF NOT EXISTS idx_sales_agreements_signed
    ON sales_agreements(id) WHERE signed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_signed
    ON maintenance_plans(id) WHERE signed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_due
    ON maintenance_plans(next_charge_date)
    WHERE signed_at IS NOT NULL AND status IN ('active','pending_cancellation');

-- ==========================================================================
-- 8. Let 006 run again
-- ==========================================================================
-- It is marked applied but failed on the missing column. Its work is redone in
-- section 3 above; clearing the row means a future re-run is possible rather
-- than permanently blocked.
DELETE FROM schema_migrations WHERE filename = '006_reconcile_signatures.sql';

COMMIT;

-- ============================================================================
-- VERIFY — run all four. The first must list the columns; the rest must be empty.
--
--   -- 1. signed_at (and friends) now exist:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'sales_agreements'
--      AND column_name IN ('signed_at','signature_name','status','price','terms')
--    ORDER BY column_name;
--
--   -- 2. No agreement stuck "claimed but unsigned":
--   SELECT sa.id, sa.agreement_number, sa.status
--     FROM sales_agreements sa
--     JOIN lifecycle_events le
--       ON le.once_key = 'sla_signed:agreement:' || sa.id::text
--    WHERE sa.signed_at IS NULL;
--
--   -- 3. Admin and customer views agree on every agreement:
--   SELECT sa.id, sa.status, sa.signed_at IS NOT NULL AS customer_sees_signed,
--          (sig.id IS NOT NULL) AS admin_sees_signed
--     FROM sales_agreements sa
--     LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id
--    WHERE (sa.signed_at IS NOT NULL) <> (sig.id IS NOT NULL);
--
--   -- 4. No money owed against an unsigned document:
--   SELECT i.invoice_number, i.total_amount
--     FROM invoices i
--     LEFT JOIN sales_agreements sa ON sa.id = i.agreement_id
--    WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
--      AND i.agreement_id IS NOT NULL AND sa.signed_at IS NULL;
-- ============================================================================