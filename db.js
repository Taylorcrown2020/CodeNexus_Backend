/**
 * db.js — database connection + schema bootstrap
 * CraftedCode Co. / CodeNexus backend
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * server.js's initializeDatabase() runs ~79 DDL statements inside a SINGLE
 * transaction, and its first statements are DO $$ blocks that ALTER tables
 * (support_tickets, leads, email_log) BEFORE any CREATE TABLE runs. Against an
 * empty database the ALTER throws "relation does not exist", Postgres aborts
 * the transaction, every later statement is skipped, and the final COMMIT is
 * silently downgraded to a ROLLBACK. Net result on a fresh database: zero
 * tables, no thrown error, and a server that boots and then 500s on every
 * route.
 *
 * So the schema has to be laid down BEFORE server.js touches it. ensureSchema()
 * does that from schema.sql, statement by statement, each independently — one
 * failure can no longer wipe out the other 61 tables.
 *
 * USAGE IN server.js
 * ------------------
 *   1. Replace the `const pool = new Pool({...})` block (~line 921) with:
 *
 *          const { pool, ensureSchema, verifySchema } = require('./db');
 *
 *   2. At the very top of startServer(), BEFORE initializeDatabase(pool):
 *
 *          await ensureSchema();
 *          await verifySchema();
 *          await initializeDatabase(pool);
 *
 * Everything else in server.js keeps working unchanged — the exported `pool` is
 * a normal pg.Pool with the same interface.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const CONNECTION_STRING = process.env.DATABASE_URL;

if (!CONNECTION_STRING) {
    console.error('[DB] FATAL: DATABASE_URL is not set.');
    console.error('[DB] On Render: your service > Environment > add DATABASE_URL');
    console.error('[DB] Use the Internal Database URL if the DB is in the same region.');
    process.exit(1);
}

/**
 * Render's managed Postgres terminates TLS with a certificate that doesn't
 * chain to a public root, so rejectUnauthorized must be false there. A local
 * Postgres normally has no TLS at all and will refuse an SSL handshake, so we
 * detect that case instead of forcing SSL on everything.
 */
function resolveSsl(connectionString) {
    if (process.env.DATABASE_SSL === 'false') return false;
    if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };

    let host = '';
    try {
        host = new URL(connectionString).hostname;
    } catch {
        // Not a parseable URL (key=value DSN). Assume hosted, so assume SSL.
        return { rejectUnauthorized: false };
    }

    const isLocal =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '' ||
        host.endsWith('.local');

    return isLocal ? false : { rejectUnauthorized: false };
}

const pool = new Pool({
    connectionString: CONNECTION_STRING,
    ssl: resolveSsl(CONNECTION_STRING),

    // Render's free/starter Postgres tiers cap connections fairly low. Leave
    // headroom for psql/pgAdmin sessions and for a second instance during a
    // rolling deploy.
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // A hung query should not hold a pooled connection forever.
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT || 30_000),
});

// An idle client erroring out (Render restarting the DB, network blip) emits on
// the pool. Without this listener Node treats it as an unhandled 'error' event
// and kills the process.
pool.on('error', (err) => {
    console.error('[DB] Idle client error (pool will recover):', err.message);
});

// ---------------------------------------------------------------------------
// SQL splitting
// ---------------------------------------------------------------------------

/**
 * Split a SQL script into individual statements.
 *
 * node-postgres sends a whole multi-statement string as one implicit
 * transaction, which reintroduces the exact all-or-nothing failure mode this
 * file exists to avoid. So we split and send them one at a time.
 *
 * The splitter has to respect:
 *   - dollar-quoted blocks, including tagged ones ($$ ... $$, $sms$ ... $sms$),
 *     because schema.sql is full of DO $$ ... END $$; blocks whose bodies
 *     contain semicolons
 *   - single-quoted literals (with '' escaping)
 *   - line comments (--) and block comments (/* ... *\/)
 */
function splitStatements(sql) {
    const statements = [];
    let buf = '';
    let i = 0;

    while (i < sql.length) {
        const ch = sql[i];
        const rest = sql.slice(i);

        // line comment
        if (rest.startsWith('--')) {
            const nl = sql.indexOf('\n', i);
            const end = nl === -1 ? sql.length : nl;
            buf += sql.slice(i, end);
            i = end;
            continue;
        }

        // block comment
        if (rest.startsWith('/*')) {
            const close = sql.indexOf('*/', i + 2);
            const end = close === -1 ? sql.length : close + 2;
            buf += sql.slice(i, end);
            i = end;
            continue;
        }

        // single-quoted literal
        if (ch === "'") {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
                if (sql[j] === "'") { j += 1; break; }
                j += 1;
            }
            buf += sql.slice(i, j);
            i = j;
            continue;
        }

        // dollar-quoted block: $tag$ ... $tag$
        const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
        if (dollar) {
            const tag = dollar[0];
            const close = sql.indexOf(tag, i + tag.length);
            const end = close === -1 ? sql.length : close + tag.length;
            buf += sql.slice(i, end);
            i = end;
            continue;
        }

        // statement terminator
        if (ch === ';') {
            const stmt = buf.trim();
            if (stmt) statements.push(stmt);
            buf = '';
            i += 1;
            continue;
        }

        buf += ch;
        i += 1;
    }

    const tail = buf.trim();
    if (tail) statements.push(tail);

    // Drop comment-only fragments.
    return statements.filter((s) =>
        s.split('\n').some((line) => line.trim() && !line.trim().startsWith('--'))
    );
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

const SCHEMA_PATH = process.env.SCHEMA_PATH || path.join(__dirname, 'schema.sql');

/**
 * Apply schema.sql. Idempotent — every statement is IF NOT EXISTS guarded, so
 * this is safe to run on every boot. Statements are sent individually and
 * failures are collected rather than thrown, so a single bad statement can't
 * prevent the rest of the schema from being created.
 *
 * @returns {Promise<{applied:number, skipped:number, failures:Array}>}
 */
async function ensureSchema() {
    if (!fs.existsSync(SCHEMA_PATH)) {
        throw new Error(
            `[DB] schema.sql not found at ${SCHEMA_PATH}. ` +
            'It must be committed to the repo next to db.js, or SCHEMA_PATH must point at it.'
        );
    }

    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const statements = splitStatements(sql);

    console.log(`[DB] Applying schema: ${statements.length} statements from ${path.basename(SCHEMA_PATH)}`);

    const client = await pool.connect();
    let applied = 0;
    let skipped = 0;
    const failures = [];

    try {
        for (const stmt of statements) {
            try {
                await client.query(stmt);
                applied += 1;
            } catch (err) {
                // 42701 duplicate_column, 42P07 duplicate_table,
                // 42710 duplicate_object — all mean "already there", which is
                // the expected steady state on every boot after the first.
                if (['42701', '42P07', '42710'].includes(err.code)) {
                    skipped += 1;
                    continue;
                }
                failures.push({
                    code: err.code,
                    message: err.message,
                    statement: stmt.slice(0, 160).replace(/\s+/g, ' '),
                });
            }
        }
    } finally {
        client.release();
    }

    console.log(`[DB] Schema applied: ${applied} ok, ${skipped} already present, ${failures.length} failed`);

    if (failures.length) {
        console.warn('[DB] Schema statement failures:');
        for (const f of failures) {
            console.warn(`  [${f.code}] ${f.message}`);
            console.warn(`         ${f.statement}...`);
        }
    }

    return { applied, skipped, failures };
}

/**
 * Tables server.js queries. If one is missing, the routes that touch it will
 * 500 at runtime — better to know at boot than from a customer.
 */
const EXPECTED_TABLES = [
    'activity_log', 'admin_files', 'admin_sessions', 'admin_users', 'applications',
    'appointments', 'auto_campaigns', 'bookings', 'client_appointments',
    'client_chain_queue', 'client_companies', 'client_contacts', 'client_deals',
    'client_email_chain_steps', 'client_email_chains', 'client_email_log',
    'client_email_settings', 'client_email_templates', 'client_products',
    'client_projects', 'client_sms_chain_queue', 'client_sms_chain_steps',
    'client_sms_chains', 'client_sms_templates', 'client_tasks',
    'client_unsubscribes', 'client_uploads', 'company_users', 'cookie_consent',
    'crm_integration_webhooks', 'crm_integrations', 'crm_subscriptions',
    'deal_activities', 'document_shares', 'document_versions', 'documents',
    'email_log', 'employees', 'expenses', 'invoice_items', 'invoices', 'jobs',
    'lead_notes', 'lead_products', 'lead_scores', 'leads', 'message_log',
    'pipeline_deals', 'pipeline_stages', 'portal_bg_images', 'portal_usage_events',
    'portal_usage_log', 'project_milestones', 'recurring_invoices', 'score_history',
    'scoring_rules', 'sms_auto_sequences', 'sms_templates', 'subscription_events',
    'support_tickets', 'tasks', 'ticket_responses',
    // --- customer portal (migrations/001) -------------------------------
    // These were missing, so verifySchema() reported "all tables present"
    // while every customer-portal route 500'd on a missing relation.
    'client_messages', 'sales_agreements', 'service_requests', 'sms_marketing_auto',
    // --- billing + dunning (migrations/002) -----------------------------
    'billing_schedules', 'agreement_items', 'agreement_templates',
    'invoice_dunning', 'billing_notifications',
    // --- lifecycle (migrations/003) -------------------------------------
    'payments', 'refunds', 'payment_methods', 'maintenance_plans',
    'plan_cancellations', 'agreement_signatures', 'lifecycle_events',
    'admin_notifications',
];

/**
 * Verify every expected table exists. Logs and returns the missing ones; does
 * not throw, so a partial schema still lets you boot and inspect.
 */
async function verifySchema() {
    const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const present = new Set(rows.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));

    if (missing.length === 0) {
        console.log(`[DB] Schema verified: all ${EXPECTED_TABLES.length} expected tables present`);
    } else {
        console.error(`[DB] Schema INCOMPLETE — ${missing.length} table(s) missing:`);
        console.error('     ' + missing.join(', '));
        console.error('     Routes touching these will fail. Check the failures logged above.');
    }

    return { present: present.size, missing };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Run a single parameterized query. Logs anything slower than 1s. */
async function query(text, params) {
    const started = Date.now();
    try {
        const result = await pool.query(text, params);
        const ms = Date.now() - started;
        if (ms > 1000) {
            console.warn(`[DB] Slow query (${ms}ms): ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
        }
        return result;
    } catch (err) {
        console.error(`[DB] Query failed [${err.code}]: ${err.message}`);
        console.error(`     ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
        throw err;
    }
}

/**
 * Run a function inside a transaction, with COMMIT/ROLLBACK and client release
 * handled for you.
 *
 *   await withTransaction(async (client) => {
 *       await client.query('UPDATE client_companies SET ... WHERE ...', [x]);
 *       await client.query('INSERT INTO company_users ...', [y]);
 *   });
 *
 * Note the failure mode this avoids: in a transaction, ONE failed statement
 * poisons the whole thing. Don't swallow errors inside the callback with
 * .catch(() => {}) — the transaction is already dead at that point and the
 * COMMIT will roll back. That is the exact bug in initializeDatabase().
 */
async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error('[DB] ROLLBACK failed:', rollbackErr.message);
        }
        throw err;
    } finally {
        client.release();
    }
}

/** Connectivity + latency check. Good for a /health endpoint. */
async function healthCheck() {
    const started = Date.now();
    try {
        const { rows } = await pool.query('SELECT NOW() AS now, current_database() AS db');
        return {
            ok: true,
            latencyMs: Date.now() - started,
            database: rows[0].db,
            serverTime: rows[0].now,
            pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        };
    } catch (err) {
        return { ok: false, error: err.message, latencyMs: Date.now() - started };
    }
}

/** Close the pool. Call on SIGTERM so Render's deploys drain cleanly. */
async function closePool() {
    console.log('[DB] Closing connection pool...');
    await pool.end();
    console.log('[DB] Pool closed');
}

// ---------------------------------------------------------------------------
// CLI: `node db.js` sets up the database without booting the server.
// Useful right after creating a new Render Postgres instance.
// ---------------------------------------------------------------------------

if (require.main === module) {
    (async () => {
        try {
            const health = await healthCheck();
            if (!health.ok) {
                console.error('[DB] Cannot connect:', health.error);
                process.exit(1);
            }
            console.log(`[DB] Connected to "${health.database}" in ${health.latencyMs}ms`);

            const { failures } = await ensureSchema();
            const { missing } = await verifySchema();

            await closePool();
            process.exit(failures.length || missing.length ? 1 : 0);
        } catch (err) {
            console.error('[DB] Setup failed:', err.message);
            process.exit(1);
        }
    })();
}

module.exports = {
    pool,
    query,
    withTransaction,
    ensureSchema,
    verifySchema,
    healthCheck,
    closePool,
    splitStatements, // exported for testing
    EXPECTED_TABLES,
};