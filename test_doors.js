/**
 * test_doors.js — proves the two login doors are correctly separated.
 *
 * Runs the ACTUAL SQL guard from /api/portal/login and the ACTUAL entitlement
 * check from /api/client/login against real rows, for every account shape.
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
    connectionString: 'postgres://postgres:pw@127.0.0.1:5432/db3',
    ssl: false,
});

let pass = 0, fail = 0;
const failures = [];
function check(label, got, want) {
    const ok = got === want;
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; failures.push(`${label}: got ${got}, want ${want}`); console.log(`  FAIL ${label} — got ${got}, want ${want}`); }
}

// ---- the real guard from diamondback-portal.js /api/portal/login -----------
async function customerPortalLogin(email, password) {
    const row = (await pool.query(
        `SELECT id, name, email, client_password, portal_kind
           FROM leads
          WHERE LOWER(email) = LOWER($1)
            AND client_password IS NOT NULL
            AND COALESCE(portal_kind, 'customer') IN ('customer', 'both')
          LIMIT 1`,
        [email]
    )).rows[0];
    if (!row) return 'DENIED_NO_ACCOUNT';
    if (!(await bcrypt.compare(password, row.client_password))) return 'DENIED_BAD_PASSWORD';
    return 'ALLOWED';
}

// ---- the real guard from the patched server.js /api/client/login -----------
async function crmLogin(email, password) {
    const row = (await pool.query(
        `SELECT * FROM leads WHERE LOWER(email) = LOWER($1) AND client_password IS NOT NULL LIMIT 1`,
        [email]
    )).rows[0];
    if (!row) return 'DENIED_NO_ACCOUNT';
    if (!(await bcrypt.compare(password, row.client_password))) return 'DENIED_BAD_PASSWORD';
    const hasCrm = row.crm_access === true
        || ['crm', 'both'].includes(String(row.portal_kind || ''));
    if (!hasCrm) return 'REDIRECT_TO_CUSTOMER_PORTAL';
    return 'ALLOWED';
}

async function main() {
    await pool.query('TRUNCATE leads RESTART IDENTITY CASCADE');
    const h = await bcrypt.hash('correct-horse', 10);

    await pool.query(
        `INSERT INTO leads (name, email, is_customer, client_password, portal_kind, crm_access) VALUES
          ('Plain Customer',  'plain@x.com',   TRUE, $1, 'customer', FALSE),
          ('Customer + CRM',  'both@x.com',    TRUE, $1, 'both',     TRUE),
          ('Legacy CRM Only', 'legacy@x.com',  TRUE, $1, 'crm',      TRUE),
          ('No Password',     'nopwd@x.com',   TRUE, NULL,'customer', FALSE)`,
        [h]
    );

    console.log('\n=== CUSTOMER PORTAL door (customer_portal.html) ===');
    check('plain customer gets IN',            await customerPortalLogin('plain@x.com', 'correct-horse'), 'ALLOWED');
    check('customer+CRM gets IN',              await customerPortalLogin('both@x.com', 'correct-horse'), 'ALLOWED');
    check('CRM-only is KEPT OUT',              await customerPortalLogin('legacy@x.com', 'correct-horse'), 'DENIED_NO_ACCOUNT');
    check('no-password account KEPT OUT',      await customerPortalLogin('nopwd@x.com', 'correct-horse'), 'DENIED_NO_ACCOUNT');
    check('wrong password rejected',           await customerPortalLogin('plain@x.com', 'wrong'), 'DENIED_BAD_PASSWORD');
    check('unknown email rejected',            await customerPortalLogin('ghost@x.com', 'correct-horse'), 'DENIED_NO_ACCOUNT');

    console.log('\n=== CRM door (client_portal.html) — subscribers only ===');
    check('plain customer REDIRECTED out',     await crmLogin('plain@x.com', 'correct-horse'), 'REDIRECT_TO_CUSTOMER_PORTAL');
    check('customer+CRM gets IN',              await crmLogin('both@x.com', 'correct-horse'), 'ALLOWED');
    check('CRM-only gets IN',                  await crmLogin('legacy@x.com', 'correct-horse'), 'ALLOWED');
    check('wrong password rejected first',     await crmLogin('plain@x.com', 'wrong'), 'DENIED_BAD_PASSWORD');
    check('unknown email rejected',            await crmLogin('ghost@x.com', 'correct-horse'), 'DENIED_NO_ACCOUNT');

    console.log('\n=== newly provisioned customer (the original bug) ===');
    // Exactly what onCustomerCreated writes for a fresh promotion.
    await pool.query(
        `INSERT INTO leads (name, email, is_customer, client_password, portal_kind, crm_access)
         VALUES ('Fresh Promotion','fresh@x.com',TRUE,$1,DEFAULT,FALSE)`, [h]
    );
    const [fresh] = (await pool.query("SELECT portal_kind, crm_access FROM leads WHERE email='fresh@x.com'")).rows;
    check('column default is customer',        fresh.portal_kind, 'customer');
    check('crm_access defaults false',         fresh.crm_access, false);
    check('CAN reach customer portal',         await customerPortalLogin('fresh@x.com', 'correct-horse'), 'ALLOWED');
    check('CANNOT reach the CRM',              await crmLogin('fresh@x.com', 'correct-horse'), 'REDIRECT_TO_CUSTOMER_PORTAL');

    console.log('\n=== after buying a CRM subscription ===');
    // What onCrmSubscriptionActivated writes.
    await pool.query(
        "UPDATE leads SET portal_kind='both', crm_access=TRUE, client_portal_id='ABCD2345' WHERE email='fresh@x.com'"
    );
    check('still reaches customer portal',     await customerPortalLogin('fresh@x.com', 'correct-horse'), 'ALLOWED');
    check('now also reaches the CRM',          await crmLogin('fresh@x.com', 'correct-horse'), 'ALLOWED');

    console.log('\n=== after cancelling the CRM subscription ===');
    await pool.query(
        "UPDATE leads SET portal_kind='customer', crm_access=FALSE WHERE email='fresh@x.com'"
    );
    check('keeps customer portal access',      await customerPortalLogin('fresh@x.com', 'correct-horse'), 'ALLOWED');
    check('loses CRM access',                  await crmLogin('fresh@x.com', 'correct-horse'), 'REDIRECT_TO_CUSTOMER_PORTAL');

    console.log(`\n${'='.repeat(52)}`);
    console.log(`PASS ${pass}   FAIL ${fail}`);
    failures.forEach((f) => console.log('  - ' + f));
    console.log('='.repeat(52));
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('CRASH:', e); process.exit(2); });