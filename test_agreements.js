/**
 * test_agreements.js — the admin Sales Agreements backend that was missing.
 *
 * Covers: client picker, create, assign, publish to portal, edit, signed-record
 * immutability, delete guards, and the full assign -> sign -> invoice chain.
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
    paymentIntents: { create: async () => ({ id: 'pi_' + Math.random(), latest_charge: 'ch' }) },
    refunds: { create: async () => ({ id: 're' }) },
    subscriptions: { cancel: async () => ({}) },
    customers: { create: async () => ({ id: 'cus' }) },
};

// Capture registered routes so we can invoke handlers directly.
const routes = [];
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (p, ...h) => routes.push({ m: m.toUpperCase(), p, h });
}

const L = require('/home/claude/work/diamondback-lifecycle.js')({
    app, pool, stripe, transporter: null,
    authenticateToken: (q, r, n) => n(), authenticatePortal: (q, r, n) => n(),
    resolveLeadId: async (i) => i, JWT_SECRET: 't', jwt: require('crypto'),
    PLATFORM_BREVO_KEY: 'k',
    sendViaBrevo: async (k, se, sn, to, subject, html) => { sent.email.push({ to, subject, html }); },
    sendSmsViaBrevo: async (k, s, phone, message) => { sent.sms.push({ phone, message }); },
    getBrevoKey: async () => 'k',
});

/** Invoke a registered route handler and capture its response. */
function call(method, path, { body = {}, params = {}, query = {} } = {}) {
    // Match on the registered PATTERN (e.g. /api/sales-agreements/:id), not the
    // concrete URL — routes are keyed by pattern.
    const r = routes.find((x) => x.m === method && x.p === path);
    if (!r) return Promise.resolve({ status: 0, body: { message: 'route not registered' } });
    const handler = r.h[r.h.length - 1];
    return new Promise((resolve) => {
        const res = {
            _s: 200,
            status(c) { this._s = c; return this; },
            json(o) { resolve({ status: this._s, body: o }); },
        };
        Promise.resolve(handler({ body, params, query, headers: {}, user: { id: 1 } }, res))
            .catch((e) => resolve({ status: 500, body: { message: 'threw: ' + e.message } }));
    });
}

const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);

async function main() {
    await pool.query(`TRUNCATE leads, sales_agreements, agreement_items, agreement_signatures,
        invoices, invoice_items, client_projects, project_milestones, lifecycle_events,
        admin_notifications, billing_notifications, client_messages, admin_users,
        maintenance_plans, payments RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO admin_users (username,email,password_hash) VALUES ('taylor','t@x.com','h')`);

    const [cust] = await q(
        `INSERT INTO leads (name,email,phone,is_customer,client_password,portal_kind,lead_temperature,follow_up_count)
         VALUES ('Acme Corp','acme@x.com','+15551112222',TRUE,'hash','customer','hot',2) RETURNING *`);
    const [noPortal] = await q(
        `INSERT INTO leads (name,email,is_customer,portal_kind) VALUES ('No Portal Co','np@x.com',TRUE,'customer') RETURNING *`);
    const [plainLead] = await q(
        `INSERT INTO leads (name,email,is_customer,status) VALUES ('Just A Lead','jal@x.com',FALSE,'new') RETURNING *`);

    console.log('\n=== 1. client picker (was returning 404 — endpoint did not exist) ===');
    let r = await call('GET', '/api/sales-agreement-clients');
    check('endpoint exists', r.status === 200, JSON.stringify(r.body).slice(0, 80));
    const clients = r.body.clients || [];
    check('returns all three', clients.length === 3, String(clients.length));
    check('customers sorted first', clients[0].is_customer === true);
    check('exposes has_portal so UI can warn',
        clients.find((c) => c.id === cust.id).has_portal === true &&
        clients.find((c) => c.id === noPortal.id).has_portal === false);
    check('includes unconverted leads too', clients.some((c) => c.id === plainLead.id));

    console.log('\n=== 2. list (was 404) ===');
    r = await call('GET', '/api/sales-agreements');
    check('endpoint exists', r.status === 200);
    check('empty to start', (r.body.agreements || []).length === 0);

    console.log('\n=== 3. create + ASSIGN to a customer, publish to portal ===');
    sent.email.length = 0; sent.sms.length = 0;
    const est = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    r = await call('POST', '/api/sales-agreements', { body: {
        lead_id: cust.id, service_type: 'web_development', package_name: 'Custom Web Platform',
        project: 'Marketing site rebuild', price: 8500, require_deposit: true, deposit_pct: 25,
        est_completion_date: est, status: 'sent', terms: 'Net 14 from completion.',
    }});
    check('created', r.status === 200 && r.body.success, JSON.stringify(r.body).slice(0, 100));
    const ag = r.body.agreement;
    check('agreement number assigned', /^SA-\d{5}$/.test(ag.agreement_number), ag.agreement_number);
    check('ASSIGNED to the customer', Number(ag.lead_id) === cust.id, String(ag.lead_id));
    check('customer name captured', ag.customer_name === 'Acme Corp', ag.customer_name);
    check('price stored', Number(ag.price) === 8500);
    check('deposit computed from pct', Number(ag.deposit) === 2125, String(ag.deposit));
    check('est completion stored', new Date(ag.est_completion_date).toISOString().slice(0, 10) === est);
    check('published to portal', r.body.sent === true, JSON.stringify(r.body.sendError));
    check('ready-to-sign email sent', sent.email.some((e) => /ready to sign/i.test(e.subject)));
    check('SMS sent', sent.sms.length === 1, String(sent.sms.length));
    check('portal message created',
        (await q('SELECT COUNT(*)::int n FROM client_messages WHERE lead_id=$1', [cust.id]))[0].n === 1);
    check('message names the customer', /Acme/i.test(r.body.message) || /portal/i.test(r.body.message), r.body.message);

    console.log('\n=== 4. create with LINE ITEMS (total derived from them) ===');
    r = await call('POST', '/api/sales-agreements', { body: {
        lead_id: cust.id, service_type: 'web_development', package_name: 'Phase 2',
        price: 999, status: 'draft',
        items: [
            { description: 'Discovery', quantity: 1, unit_price: 1500 },
            { description: 'Build', quantity: 1, unit_price: 4000 },
            { description: 'Optional SEO', quantity: 1, unit_price: 750, is_optional: true },
        ],
    }});
    const ag2 = r.body.agreement;
    check('line-item total overrides the price field', Number(ag2.price) === 6250, String(ag2.price));
    check('items persisted',
        (await q('SELECT COUNT(*)::int n FROM agreement_items WHERE agreement_id=$1', [ag2.id]))[0].n === 3);
    check('draft is NOT auto-sent', r.body.sent === false);

    console.log('\n=== 5. assigning someone with no portal account ===');
    r = await call('POST', '/api/sales-agreements', { body: {
        lead_id: noPortal.id, service_type: 'web_development', price: 500, status: 'sent',
    }});
    check('still created', r.body.success === true);
    check('not sent (nowhere to send it)', r.body.sent === false);
    check('message explains why', /no portal account/i.test(r.body.message), r.body.message);

    console.log('\n=== 6. validation ===');
    r = await call('POST', '/api/sales-agreements', { body: { lead_id: cust.id, price: 100 } });
    check('service_type required', r.status === 400, String(r.status));
    r = await call('POST', '/api/sales-agreements', { body: { lead_id: 99999, service_type: 'web_development' } });
    check('unknown client rejected', r.status === 404, String(r.status));

    console.log('\n=== 7. edit ===');
    r = await call('PATCH', '/api/sales-agreements/:id', { params: { id: String(ag2.id) }, body: { price: 7000, notes: 'Revised' } });
    check('patch works', r.body.success === true);
    check('price updated', Number(r.body.agreement.price) === 7000, String(r.body.agreement.price));
    check('notes updated', r.body.agreement.notes === 'Revised');

    console.log('\n=== 8. send an existing draft ===');
    sent.email.length = 0;
    r = await call('POST', '/api/sales-agreements/:id/send', { params: { id: String(ag2.id) } });
    check('send succeeded', r.body.success === true, JSON.stringify(r.body).slice(0, 90));
    check('email went out', sent.email.some((e) => /ready to sign/i.test(e.subject)));
    r = await call('POST', '/api/sales-agreements/:id/send', { params: { id: String(ag2.id) } });
    check('re-send is a no-op, not a duplicate', r.body.alreadySent === true, JSON.stringify(r.body).slice(0, 80));

    console.log('\n=== 9. the whole point: assigned SLA -> customer signs -> invoice ===');
    sent.email.length = 0;
    const signed = await L.onAgreementSigned({ agreementId: ag.id, signerName: 'John Acme' });
    check('signature recorded', signed.signed === true);
    check('invoice created from the SLA', !!signed.invoice);
    check('invoice total matches agreement', Number(signed.invoice.total_amount) === 8500, String(signed.invoice.total_amount));
    check('invoice due at est completion',
        new Date(signed.invoice.due_date).toISOString().slice(0, 10) === est);
    check('project timeline created', !!signed.project);
    check('admin assigned', !!signed.assignedAdmin);

    r = await call('GET', '/api/sales-agreements');
    const listed = r.body.agreements.find((x) => x.id === ag.id);
    check('list shows signature', !!listed.signature_at);
    check('list shows signer', listed.signer_name === 'John Acme', listed.signer_name);
    check('list joins customer name', listed.lead_name === 'Acme Corp', listed.lead_name);

    console.log('\n=== 10. a signed agreement is immutable ===');
    r = await call('PATCH', '/api/sales-agreements/:id', { params: { id: String(ag.id) }, body: { price: 1 } });
    check('editing a signed agreement is refused', r.status === 409, String(r.status));
    r = await call('PATCH', '/api/sales-agreements/:id', { params: { id: String(ag.id) }, body: { status: 'completed' } });
    check('but status may still change', r.body.success === true, JSON.stringify(r.body).slice(0, 80));
    r = await call('DELETE', '/api/sales-agreements/:id', { params: { id: String(ag.id) } });
    check('deleting a signed agreement is refused', r.status === 409, String(r.status));

    console.log('\n=== 11. delete an unsigned one ===');
    const [tmp] = await q(
        `INSERT INTO sales_agreements (agreement_number,lead_id,service_type,price,status)
         VALUES ('SA-09999',$1,'web_development',10,'draft') RETURNING *`, [cust.id]);
    r = await call('DELETE', '/api/sales-agreements/:id', { params: { id: String(tmp.id) } });
    check('unsigned delete allowed', r.body.success === true);
    check('row gone', (await q('SELECT COUNT(*)::int n FROM sales_agreements WHERE id=$1', [tmp.id]))[0].n === 0);

    console.log('\n=== 12. maintenance plan assignment ===');
    r = await call('POST', '/api/admin/maintenance-plans', { body: {
        leadId: cust.id, planType: 'monthly_maintenance', amount: 299, billingDay: 15,
        label: 'Monthly Maintenance', description: 'Updates, backups, monitoring', sendAgreement: true,
    }});
    check('plan created', r.body.success === true, JSON.stringify(r.body).slice(0, 90));
    check('ASSIGNED to the customer', Number(r.body.plan.lead_id) === cust.id);
    check('amount as specified', Number(r.body.plan.amount) === 299);
    check('billing day as specified', Number(r.body.plan.billing_day) === 15);
    check('starts pending_signature', r.body.plan.status === 'pending_signature', r.body.plan.status);
    check('maintenance agreement generated', !!r.body.agreement);
    check('agreement is kind=maintenance', r.body.agreement.agreement_kind === 'maintenance', r.body.agreement.agreement_kind);
    check('agreement terms mention 30-day cancellation', /30 days/.test(r.body.agreement.terms || ''), (r.body.agreement.terms||'').slice(0,60));
    r = await call('GET', '/api/admin/maintenance-plans');
    check('plan appears in the admin list', (r.body.plans || []).length >= 1);
    check('list joins customer name', r.body.plans[0].customer_name === 'Acme Corp', r.body.plans[0].customer_name);

    console.log('\n=== 13. scoring firewall still intact ===');
    const [leadEnd] = await q('SELECT * FROM leads WHERE id=$1', [cust.id]);
    check('lead_temperature untouched', leadEnd.lead_temperature === 'hot', String(leadEnd.lead_temperature));
    check('follow_up_count untouched', Number(leadEnd.follow_up_count) === 2);
    check('last_contact_date never written', leadEnd.last_contact_date === null);
    check('email_log untouched', (await q('SELECT COUNT(*)::int n FROM email_log'))[0].n === 0);

    console.log(`\n${'='.repeat(54)}`);
    console.log(`PASS ${pass}   FAIL ${fail}`);
    failures.forEach((f) => console.log('  - ' + f));
    console.log('='.repeat(54));
    await pool.end();
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('CRASH:', e); process.exit(2); });