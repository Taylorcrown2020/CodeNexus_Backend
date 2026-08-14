/**
 * test_auth_billing.js — password/username recovery, the single account-level
 * payment method, the "never leave an account without one" rule, and annual
 * domain renewals.
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
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
const L = require('/home/claude/work/diamondback-lifecycle.js')({
    app, pool, stripe, transporter: null,
    authenticateToken: (q, r, n) => n(), authenticatePortal: (q, r, n) => n(),
    resolveLeadId: async () => LEAD, JWT_SECRET: 't', jwt: require('crypto'),
    PLATFORM_BREVO_KEY: 'k',
    sendViaBrevo: async (k, se, sn, to, subject, html) => { sent.email.push({ to, subject, html }); },
    sendSmsViaBrevo: async (k, s, phone, message) => { sent.sms.push({ phone, message }); },
    getBrevoKey: async () => 'k',
});

function call(method, pattern, { body = {}, params = {}, query = {} } = {}) {
    const r = routes.find((x) => x.m === method && x.p === pattern);
    if (!r) return Promise.resolve({ status: 0, body: { message: 'route not registered: ' + pattern } });
    const handler = r.h[r.h.length - 1];
    return new Promise((resolve) => {
        const res = { _s: 200, status(c) { this._s = c; return this; }, json(o) { resolve({ status: this._s, body: o }); } };
        Promise.resolve(handler({ body, params, query, headers: {}, ip: '203.0.113.5', user: { id: LEAD, email: 'a@x.com' } }, res))
            .catch((e) => resolve({ status: 500, body: { message: 'threw: ' + e.message } }));
    });
}
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const linkFrom = html => (String(html).match(/token=([a-f0-9]{64})/) || [])[1];

async function main() {
    await pool.query(`TRUNCATE leads, auth_tokens, payment_methods, maintenance_plans,
        plan_cancellations, crm_subscriptions, payments, client_messages, billing_notifications,
        lifecycle_events, admin_notifications, admin_users, sales_agreements, email_log
        RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO admin_users (username,email,password_hash) VALUES ('taylor','t@x.com','h')`);
    const hash = await bcrypt.hash('old-password', 10);
    const [lead] = await q(
        `INSERT INTO leads (name,email,phone,is_customer,client_password,portal_kind,lead_temperature,follow_up_count)
         VALUES ('Acme Corp','acme@x.com','+15550001',TRUE,$1,'customer','hot',2) RETURNING *`, [hash]);
    LEAD = lead.id;

    console.log('\n=== 1. forgot password ===');
    sent.email.length = 0;
    let r = await call('POST', '/api/auth/forgot-password', { body: { email: 'acme@x.com' } });
    check('endpoint exists', r.status === 200, JSON.stringify(r.body).slice(0, 80));
    check('reset email sent', sent.email.some(e => /Reset your/i.test(e.subject)));
    const token = linkFrom(sent.email.map(e => e.html).join(''));
    check('email carries a token link', !!token, String(token));
    const stored = await q('SELECT * FROM auth_tokens WHERE purpose=$1', ['password_reset']);
    check('token row created', stored.length === 1);
    check('token stored HASHED, not in the clear',
        stored[0].token_hash !== token && stored[0].token_hash.length === 64);
    check('token has an expiry', new Date(stored[0].expires_at) > new Date());

    console.log('\n=== 2. unknown email does not leak ===');
    sent.email.length = 0;
    const r2 = await call('POST', '/api/auth/forgot-password', { body: { email: 'nobody@x.com' } });
    check('same success response', r2.body.success === true && r2.body.message === r.body.message);
    check('no email sent', sent.email.length === 0, String(sent.email.length));

    console.log('\n=== 3. token check ===');
    r = await call('GET', '/api/auth/reset-token', { query: { token } });
    check('valid token accepted', r.body.success === true, JSON.stringify(r.body).slice(0, 80));
    check('returns the account email', r.body.email === 'acme@x.com', r.body.email);
    r = await call('GET', '/api/auth/reset-token', { query: { token: 'f'.repeat(64) } });
    check('bogus token rejected', r.status === 400 && r.body.reason === 'unknown', JSON.stringify(r.body).slice(0,70));

    console.log('\n=== 4. reset the password ===');
    sent.email.length = 0;
    r = await call('POST', '/api/auth/reset-password', { body: { token, password: 'short' } });
    check('short password rejected', r.status === 400, String(r.status));
    r = await call('POST', '/api/auth/reset-password', { body: { token, password: 'a-new-password' } });
    check('reset succeeds', r.body.success === true, JSON.stringify(r.body).slice(0, 90));
    const [after] = await q('SELECT client_password FROM leads WHERE id=$1', [LEAD]);
    check('new password works', await bcrypt.compare('a-new-password', after.client_password));
    check('old password no longer works', !(await bcrypt.compare('old-password', after.client_password)));
    check('"password changed" email sent', sent.email.some(e => /password was changed/i.test(e.subject)));

    console.log('\n=== 5. a reset link is single-use ===');
    r = await call('POST', '/api/auth/reset-password', { body: { token, password: 'another-one' } });
    check('reuse refused', r.status === 400 && /already been used/i.test(r.body.message), r.body.message);
    const [still] = await q('SELECT client_password FROM leads WHERE id=$1', [LEAD]);
    check('password unchanged by the replay', await bcrypt.compare('a-new-password', still.client_password));

    console.log('\n=== 6. expired links are refused ===');
    sent.email.length = 0;
    await call('POST', '/api/auth/forgot-password', { body: { email: 'acme@x.com' } });
    const t2 = linkFrom(sent.email.map(e => e.html).join(''));
    await pool.query(`UPDATE auth_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE used_at IS NULL`);
    r = await call('POST', '/api/auth/reset-password', { body: { token: t2, password: 'yet-another' } });
    check('expired link refused', r.status === 400 && /expired/i.test(r.body.message), r.body.message);

    console.log('\n=== 7. a new request invalidates the old link ===');
    sent.email.length = 0;
    await pool.query('UPDATE auth_tokens SET used_at = NULL, expires_at = NOW() + INTERVAL $$1 hour$$');
    await call('POST', '/api/auth/forgot-password', { body: { email: 'acme@x.com' } });
    const t3 = linkFrom(sent.email.map(e => e.html).join(''));
    const live = await q(`SELECT COUNT(*)::int n FROM auth_tokens WHERE used_at IS NULL AND purpose='password_reset'`);
    check('only one live token at a time', live[0].n === 1, String(live[0].n));
    r = await call('POST', '/api/auth/reset-password', { body: { token: t3, password: 'final-password' } });
    check('newest link works', r.body.success === true);

    console.log('\n=== 8. forgot username ===');
    sent.email.length = 0;
    r = await call('POST', '/api/auth/forgot-username', { body: { email: 'acme@x.com' } });
    check('endpoint exists', r.body.success === true);
    check('sign-in details emailed', sent.email.some(e => /sign-in details/i.test(e.subject)));
    const uEmail = sent.email.find(e => /sign-in details/i.test(e.subject));
    check('email contains the address', uEmail && /acme@x\.com/.test(uEmail.html));

    console.log('\n=== 9. CRM audience without CRM access is redirected, not silent ===');
    sent.email.length = 0;
    await call('POST', '/api/auth/forgot-password', { body: { email: 'acme@x.com', audience: 'crm' } });
    check('told they have a customer account instead',
        sent.email.some(e => /CodeNexus CRM sign-in/i.test(e.subject)), JSON.stringify(sent.email.map(e=>e.subject)));

    console.log('\n=== 10. rate limiting ===');
    sent.email.length = 0;
    for (let i = 0; i < 8; i++) await call('POST', '/api/auth/forgot-password', { body: { email: 'acme@x.com' } });
    check('throttled after 5 an hour', sent.email.filter(e => /Reset your/i.test(e.subject)).length <= 5,
        String(sent.email.filter(e => /Reset your/i.test(e.subject)).length));

    console.log('\n=== 11. ONE payment method for the whole account ===');
    const [pmA] = await q(
        `INSERT INTO payment_methods (lead_id,stripe_customer_id,stripe_pm_id,type,brand,last4)
         VALUES ($1,'cus','pm_visa','card','Visa','4242') RETURNING *`, [LEAD]);
    await L.setAccountPaymentMethod(LEAD, pmA.id);
    let [l2] = await q('SELECT default_payment_method_id FROM leads WHERE id=$1', [LEAD]);
    check('account default set', l2.default_payment_method_id === pmA.id);

    // Two plans, neither with a per-plan method: both must resolve to the account one.
    const [mp] = await q(
        `INSERT INTO maintenance_plans (lead_id,plan_type,label,amount,billing_day,status,signed_at,next_charge_date)
         VALUES ($1,'monthly_maintenance','Monthly Maintenance',299,15,'active',NOW(),CURRENT_DATE) RETURNING *`, [LEAD]);
    const [dom] = await q(
        `INSERT INTO maintenance_plans (lead_id,plan_type,label,amount,billing_day,billing_month,
                                        interval_unit,item_reference,status,signed_at,next_charge_date)
         VALUES ($1,'domain_renewal','Domain Renewal — acme.com',22,14,3,'year','acme.com','active',NOW(),CURRENT_DATE) RETURNING *`, [LEAD]);

    const rp1 = await L.resolvePaymentMethod(LEAD, mp.payment_method_id);
    const rp2 = await L.resolvePaymentMethod(LEAD, dom.payment_method_id);
    check('both plans resolve to the SAME method', rp1 && rp2 && rp1.id === pmA.id && rp2.id === pmA.id);

    console.log('\n=== 12. changing it changes it everywhere ===');
    const [pmB] = await q(
        `INSERT INTO payment_methods (lead_id,stripe_customer_id,stripe_pm_id,type,brand,last4)
         VALUES ($1,'cus','pm_mc','card','Mastercard','5555') RETURNING *`, [LEAD]);
    r = await call('POST', '/api/portal/plans/:kind/:id/payment-method', {
        params: { kind: 'maintenance', id: String(mp.id) }, body: { paymentMethodId: pmB.id } });
    check('accepted', r.body.success === true, JSON.stringify(r.body).slice(0, 90));
    check('message says it applies account-wide', /everything on your account/i.test(r.body.message || ''), r.body.message);
    [l2] = await q('SELECT default_payment_method_id FROM leads WHERE id=$1', [LEAD]);
    check('account default moved', l2.default_payment_method_id === pmB.id);
    const both = await Promise.all([
        L.resolvePaymentMethod(LEAD, null), L.resolvePaymentMethod(LEAD, null)]);
    check('the DOMAIN plan now bills the new card too', both[1].id === pmB.id, String(both[1].id));
    const overrides = await q(
        'SELECT COUNT(*)::int n FROM maintenance_plans WHERE lead_id=$1 AND payment_method_id IS NOT NULL', [LEAD]);
    check('no per-plan overrides left behind', overrides[0].n === 0, String(overrides[0].n));

    console.log('\n=== 13. an account with a plan can never be left with no method ===');
    await pool.query("UPDATE payment_methods SET status='removed' WHERE id=$1", [pmA.id]);
    r = await call('DELETE', '/api/portal/payment-methods/:id', { params: { id: String(pmB.id) } });
    check('removing the last method is refused', r.status === 409, String(r.status));
    check('refusal explains the fix', /add a new one first/i.test(r.body.message || ''), r.body.message);
    check('code is LAST_METHOD', r.body.code === 'LAST_METHOD');
    const stillThere = await q("SELECT status FROM payment_methods WHERE id=$1", [pmB.id]);
    check('method NOT removed', stillThere[0].status === 'active', stillThere[0].status);

    // With a replacement present, removal is allowed and the default moves.
    const [pmC] = await q(
        `INSERT INTO payment_methods (lead_id,stripe_customer_id,stripe_pm_id,type,brand,last4)
         VALUES ($1,'cus','pm_amex','card','Amex','0005') RETURNING *`, [LEAD]);
    r = await call('DELETE', '/api/portal/payment-methods/:id', { params: { id: String(pmB.id) } });
    check('removal allowed once a replacement exists', r.body.success === true, JSON.stringify(r.body).slice(0,80));
    [l2] = await q('SELECT default_payment_method_id FROM leads WHERE id=$1', [LEAD]);
    check('default handed to the replacement', l2.default_payment_method_id === pmC.id, String(l2.default_payment_method_id));

    console.log('\n=== 14. annual domain billing ===');
    const mar = L.nextAnnualDate(3, 14, new Date('2027-01-10T00:00:00Z'));
    check('renews in the given month', mar.toISOString().slice(0,10) === '2027-03-14', mar.toISOString().slice(0,10));
    const nextYear = L.nextAnnualDate(3, 14, new Date('2027-06-01T00:00:00Z'));
    check('rolls to next year once past', nextYear.toISOString().slice(0,10) === '2028-03-14', nextYear.toISOString().slice(0,10));
    const feb = L.nextAnnualDate(2, 31, new Date('2027-01-05T00:00:00Z'));
    check('day 31 clamps to Feb 28', feb.toISOString().slice(0,10) === '2027-02-28', feb.toISOString().slice(0,10));
    const leap = L.nextAnnualDate(2, 31, new Date('2028-01-05T00:00:00Z'));
    check('clamps to Feb 29 in a leap year', leap.toISOString().slice(0,10) === '2028-02-29', leap.toISOString().slice(0,10));

    console.log('\n=== 15. charging a domain plan advances a YEAR, not a month ===');
    sent.email.length = 0;
    const [domPlan] = await q('SELECT * FROM maintenance_plans WHERE id=$1', [dom.id]);
    const charged = await L.chargeMaintenancePlan(domPlan);
    check('charge succeeded', charged.ok === true, JSON.stringify(charged.error));
    const [domAfter] = await q('SELECT * FROM maintenance_plans WHERE id=$1', [dom.id]);
    const nd = new Date(domAfter.next_charge_date);
    const monthsOut = (nd.getUTCFullYear() - new Date().getUTCFullYear()) * 12 + (nd.getUTCMonth() - new Date().getUTCMonth());
    check('next charge is ~a year away, not a month', monthsOut >= 6, `${monthsOut} months`);
    check('renews on the set month', nd.getUTCMonth() + 1 === 3, String(nd.getUTCMonth() + 1));
    check('receipt emailed', sent.email.some(e => /payment received/i.test(e.subject)));

    console.log('\n=== 16. creating a domain plan through the admin route ===');
    r = await call('POST', '/api/admin/maintenance-plans', { body: {
        leadId: LEAD, planType: 'domain_renewal', amount: 22,
        renewalDate: '2027-09-04', itemReference: 'acme.com', sendAgreement: false } });
    check('created', r.body.success === true, JSON.stringify(r.body).slice(0, 110));
    const np = r.body.plan;
    check('interval is yearly', np.interval_unit === 'year', np.interval_unit);
    check('month derived from the renewal date', Number(np.billing_month) === 9, String(np.billing_month));
    check('day derived from the renewal date', Number(np.billing_day) === 4, String(np.billing_day));
    check('domain recorded', np.item_reference === 'acme.com', np.item_reference);
    check('label names the domain', /acme\.com/.test(np.label || ''), np.label);
    check('first charge is the renewal date',
        String(np.next_charge_date).slice(0,10) === '2027-09-04' ||
        new Date(np.next_charge_date).toISOString().slice(0,10) === '2027-09-04',
        String(np.next_charge_date));

    r = await call('POST', '/api/admin/maintenance-plans', { body: {
        leadId: LEAD, planType: 'domain_renewal', amount: 22, sendAgreement: false } });
    check('annual plan without a date is rejected', r.status === 400, String(r.status));

    console.log('\n=== 17. scoring firewall ===');
    const [leadEnd] = await q('SELECT * FROM leads WHERE id=$1', [LEAD]);
    check('lead_temperature untouched', leadEnd.lead_temperature === 'hot', String(leadEnd.lead_temperature));
    check('follow_up_count untouched', Number(leadEnd.follow_up_count) === 2);
    check('email_log untouched', (await q('SELECT COUNT(*)::int n FROM email_log'))[0].n === 0);

    console.log(`\n${'='.repeat(54)}`);
    console.log(`PASS ${pass}   FAIL ${fail}`);
    failures.forEach((f) => console.log('  - ' + f));
    console.log('='.repeat(54));
    await pool.end();
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('CRASH:', e); process.exit(2); });