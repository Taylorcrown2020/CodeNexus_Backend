/**
 * test_portal_flow.js — the customer portal as the browser actually drives it.
 *
 * Mounts BOTH modules the way server.js does, then walks:
 *   dashboard -> sign -> dashboard again
 * asserting the agreement reads signed and the invoice appears in the
 * outstanding balance, exactly as the portal computes it.
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:pw@127.0.0.1:5432/db3', ssl: false });

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail = '') {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

const sent = { email: [], sms: [] };
const stripe = {
    paymentIntents: { create: async () => ({ id: 'pi_' + Math.random(), latest_charge: 'ch', client_secret: 'cs_x' }) },
    refunds: { create: async () => ({ id: 're' }) },
    customers: { create: async () => ({ id: 'cus' }) },
    paymentMethods: { attach: async (pm) => ({ id: pm }), detach: async () => ({}) },
    subscriptions: { retrieve: async (id) => ({ id, default_payment_method: null }), update: async () => ({}), cancel: async () => ({}) },
};

const routes = [];
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (p, ...h) => routes.push({ m: m.toUpperCase(), p, h });
}

let LEAD = null;
const common = {
    app, pool, stripe, transporter: null,
    authenticateToken: (q, r, n) => n(),
    authenticatePortal: (q, r, n) => n(),
    resolveLeadId: async () => LEAD,
    JWT_SECRET: 't', jwt: require('crypto'),
    PLATFORM_BREVO_KEY: 'k',
    PLATFORM_SENDER_EMAIL: 'c@d.com', PLATFORM_SENDER_NAME: 'Diamondback',
    sendViaBrevo: async (k, se, sn, to, subject, html) => { sent.email.push({ to, subject, html }); },
    sendSmsViaBrevo: async (k, s, phone, message) => { sent.sms.push({ phone, message }); },
    getBrevoKey: async () => 'k',
};

const L = require('/home/claude/work/diamondback-lifecycle.js')(common);
// Portal mounted the way server.js does, including the late-bound notifier.
require('/home/claude/work/diamondback-portal.js')({
    ...common,
    onServiceRequestCreated: (a) => L.onServiceRequestCreated(a),
});

function call(method, pattern, { body = {}, params = {}, query = {} } = {}) {
    const r = routes.find((x) => x.m === method && x.p === pattern);
    if (!r) return Promise.resolve({ status: 0, body: { message: 'ROUTE NOT REGISTERED: ' + pattern } });
    const handler = r.h[r.h.length - 1];
    return new Promise((resolve) => {
        const res = {
            _s: 200,
            status(c) { this._s = c; return this; },
            json(o) { resolve({ status: this._s, body: o }); },
            setHeader() {}, send(x) { resolve({ status: this._s, body: x, raw: true }); },
        };
        Promise.resolve(handler({ body, params, query, headers: {}, user: { id: LEAD, email: 'acme@x.com' } }, res))
            .catch((e) => resolve({ status: 500, body: { message: 'threw: ' + e.message } }));
    });
}
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);

/* The portal's own logic, copied verbatim so the test fails when the UI would. */
const isSigned = a => !!(a && (a.signed_at || a.status === 'signed'));
const openInvoices = list =>
    (list || []).filter(i => !['paid', 'void', 'cancelled', 'refunded', 'draft'].includes(i.status));
const outstanding = list => openInvoices(list).reduce((t, i) => t + Number(i.total_amount || 0), 0);

async function main() {
    await pool.query(`TRUNCATE leads, sales_agreements, agreement_items, agreement_signatures,
        invoices, invoice_items, client_projects, project_milestones, project_updates,
        lifecycle_events, admin_notifications, billing_notifications, client_messages,
        admin_users, payments, maintenance_plans, email_log RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO admin_users (username,email,password_hash) VALUES ('taylor','t@x.com','h')`);
    const [lead] = await q(
        `INSERT INTO leads (name,email,phone,is_customer,client_password,portal_kind)
         VALUES ('Acme Corp','acme@x.com','+15550001',TRUE,'h','customer') RETURNING *`);
    LEAD = lead.id;

    console.log('\n=== 1. admin creates an SLA and sends it ===');
    const est = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
    let r = await call('POST', '/api/sales-agreements', { body: {
        lead_id: LEAD, service_type: 'web_development', package_name: 'Website Rebuild',
        price: 7500, est_completion_date: est, status: 'sent', terms: 'Net 14 from completion.',
    }});
    check('agreement created', r.body.success === true, JSON.stringify(r.body).slice(0, 120));
    const ag = r.body.agreement;

    console.log('\n=== 2. the portal dashboard shows it as unsigned ===');
    r = await call('GET', '/api/portal/dashboard');
    check('dashboard loads', r.status === 200, JSON.stringify(r.body).slice(0, 120));
    let dash = r.body.dashboard || {};
    check('agreement returned to the portal', (dash.salesAgreements || []).length === 1,
        String((dash.salesAgreements || []).length));
    let a0 = (dash.salesAgreements || [])[0];
    check('reads as NOT signed', isSigned(a0) === false, JSON.stringify({s: a0 && a0.status, at: a0 && a0.signed_at}));
    check('no invoices yet', (dash.invoices || []).length === 0);
    check('outstanding is 0', outstanding(dash.invoices) === 0, String(outstanding(dash.invoices)));

    console.log('\n=== 3. customer signs it in the portal ===');
    sent.email.length = 0;
    r = await call('POST', '/api/portal/sales-agreements/:id/sign', {
        params: { id: String(ag.id) },
        body: { typedName: 'John Acme', agree: true },
    });
    check('SIGN SUCCEEDS', r.body.success === true, JSON.stringify(r.body).slice(0, 200));
    check('response reports an invoice', !!r.body.invoice, JSON.stringify(r.body.invoice));

    console.log('\n=== 4. THE BUG: does the agreement now read as signed? ===');
    const rowsNow = await q('SELECT id, status, signed_at FROM sales_agreements WHERE id=$1', [ag.id]);
    check('DB: status is signed', rowsNow[0].status === 'signed', rowsNow[0].status);
    check('DB: signed_at is set', !!rowsNow[0].signed_at, String(rowsNow[0].signed_at));

    r = await call('GET', '/api/portal/dashboard');
    dash = r.body.dashboard || {};
    a0 = (dash.salesAgreements || [])[0];
    check('PORTAL: agreement reads as SIGNED', isSigned(a0) === true,
        JSON.stringify({status: a0 && a0.status, signed_at: a0 && a0.signed_at}));
    check('PORTAL: status field present', a0 && a0.status === 'signed', a0 && a0.status);
    check('PORTAL: signed_at field present', !!(a0 && a0.signed_at), String(a0 && a0.signed_at));

    console.log('\n=== 5. THE BUG: is the invoice there and counted? ===');
    const invDb = await q('SELECT * FROM invoices WHERE lead_id=$1', [LEAD]);
    check('DB: invoice created', invDb.length === 1, String(invDb.length));
    check('DB: invoice belongs to the customer', invDb[0] && Number(invDb[0].lead_id) === LEAD);
    check('DB: invoice total is right', Number(invDb[0].total_amount) === 7500, String(invDb[0] && invDb[0].total_amount));
    check('DB: invoice status is billable', !['paid','void','cancelled','refunded','draft'].includes(invDb[0].status),
        invDb[0] && invDb[0].status);

    check('PORTAL: invoice returned by the dashboard', (dash.invoices || []).length === 1,
        String((dash.invoices || []).length));
    check('PORTAL: invoice counts as OPEN', openInvoices(dash.invoices).length === 1,
        JSON.stringify((dash.invoices || []).map(i => i.status)));
    check('PORTAL: OUTSTANDING BALANCE is 7500', outstanding(dash.invoices) === 7500,
        String(outstanding(dash.invoices)));

    console.log('\n=== 6. Docs view: signed agreement is filed there ===');
    const all = (dash.salesAgreements || []).filter(x => (x.status || '') !== 'cancelled');
    check('appears under Signed', all.filter(isSigned).length === 1, String(all.filter(isSigned).length));
    check('no longer under Awaiting signature', all.filter(x => !isSigned(x)).length === 0,
        String(all.filter(x => !isSigned(x)).length));

    console.log('\n=== 7. project timeline created ===');
    r = await call('GET', '/api/portal/timeline');
    check('timeline endpoint works', r.status === 200, JSON.stringify(r.body).slice(0, 90));
    check('project present', (r.body.projects || []).length === 1, String((r.body.projects || []).length));

    console.log('\n=== 8. re-signing is refused ===');
    r = await call('POST', '/api/portal/sales-agreements/:id/sign', {
        params: { id: String(ag.id) }, body: { typedName: 'John Acme', agree: true } });
    check('already-signed rejected', r.status === 409, String(r.status));
    check('still ONE invoice (no duplicate)',
        (await q('SELECT COUNT(*)::int n FROM invoices WHERE lead_id=$1', [LEAD]))[0].n === 1);

    console.log('\n=== 9. validation on the sign route ===');
    const [ag2] = await q(
        `INSERT INTO sales_agreements (agreement_number,lead_id,customer_name,customer_email,
                                       service_type,package_name,price,status)
         VALUES ('SA-00002',$1,'Acme Corp','acme@x.com','web_development','Phase 2',1200,'sent') RETURNING *`, [LEAD]);
    r = await call('POST', '/api/portal/sales-agreements/:id/sign', {
        params: { id: String(ag2.id) }, body: { typedName: 'John Acme', agree: false } });
    check('unticked consent refused', r.status === 400, String(r.status));
    r = await call('POST', '/api/portal/sales-agreements/:id/sign', {
        params: { id: String(ag2.id) }, body: { typedName: 'J', agree: true } });
    check('one-letter name refused', r.status === 400, String(r.status));

    console.log('\n=== 10. a second signed agreement adds to the balance ===');
    r = await call('POST', '/api/portal/sales-agreements/:id/sign', {
        params: { id: String(ag2.id) }, body: { typedName: 'John Acme', agree: true } });
    check('second sign works', r.body.success === true, JSON.stringify(r.body).slice(0, 140));
    r = await call('GET', '/api/portal/dashboard');
    dash = r.body.dashboard || {};
    check('two invoices now', (dash.invoices || []).length === 2, String((dash.invoices || []).length));
    check('OUTSTANDING is 8700', outstanding(dash.invoices) === 8700, String(outstanding(dash.invoices)));
    check('both agreements read signed',
        (dash.salesAgreements || []).filter(isSigned).length === 2,
        String((dash.salesAgreements || []).filter(isSigned).length));

    console.log('\n=== 11. paying one drops it out of outstanding ===');
    await pool.query(`UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1`, [invDb[0].id]);
    r = await call('GET', '/api/portal/dashboard');
    dash = r.body.dashboard || {};
    check('outstanding drops to 1200', outstanding(dash.invoices) === 1200, String(outstanding(dash.invoices)));
    check('still shows both invoices', (dash.invoices || []).length === 2);


    console.log('\n=== 12. THE REPORTED MISMATCH: signature present, row stale ===');
    // Exactly the state earlier broken signing runs left behind: the admin sees
    // a signature, the customer's row still says 'sent'.
    const [ag3] = await q(
        `INSERT INTO sales_agreements (agreement_number,lead_id,customer_name,customer_email,
                                       service_type,package_name,price,status,signed_at)
         VALUES ('SA-00003',$1,'Acme Corp','acme@x.com','web_development','Legacy',900,'sent',NULL) RETURNING *`, [LEAD]);
    await pool.query(
        `INSERT INTO agreement_signatures (agreement_id, lead_id, signer_name, signed_at)
         VALUES ($1,$2,'John Acme',NOW())`, [ag3.id, LEAD]);

    r = await call('GET', '/api/portal/dashboard');
    dash = r.body.dashboard || {};
    const legacy = (dash.salesAgreements || []).find(x => x.id === ag3.id);
    check('portal reads the SIGNATURE, not just the stale status',
        isSigned(legacy) === true,
        JSON.stringify({status: legacy && legacy.status, signed_at: legacy && legacy.signed_at}));
    check('status reported as signed', legacy && legacy.status === 'signed', legacy && legacy.status);
    check('signer name exposed', !!(legacy && legacy.signer_name), String(legacy && legacy.signer_name));

    console.log(`\n${'='.repeat(54)}`);
    console.log(`PASS ${pass}   FAIL ${fail}`);
    failures.forEach((f) => console.log('  - ' + f));
    console.log('='.repeat(54));
    await pool.end();
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('CRASH:', e); process.exit(2); });