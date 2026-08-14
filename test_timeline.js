/**
 * test_timeline.js — project updates (admin -> customer) and service requests.
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
process.env.ALERT_SMS_TO = '+15559990000';

const stripe = {
    paymentIntents: { create: async () => ({ id: 'pi', latest_charge: 'ch' }) },
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
        Promise.resolve(handler({ body, params, query, headers: {}, user: { id: LEAD, email: 'a@x.com' } }, res))
            .catch((e) => resolve({ status: 500, body: { message: 'threw: ' + e.message } }));
    });
}
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);

async function main() {
    await pool.query(`TRUNCATE leads, client_projects, project_milestones, project_updates,
        service_requests, client_messages, billing_notifications, lifecycle_events,
        admin_notifications, admin_users, sales_agreements, email_log RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO admin_users (username,email,password_hash) VALUES ('taylor','t@x.com','h')`);
    const [lead] = await q(
        `INSERT INTO leads (name,email,phone,is_customer,client_password,portal_kind,lead_temperature,follow_up_count)
         VALUES ('Acme Corp','acme@x.com','+15550001',TRUE,'h','customer','hot',2) RETURNING *`);
    LEAD = lead.id;
    const [proj] = await q(
        `INSERT INTO client_projects (lead_id,project_name,status,start_date)
         VALUES ($1,'Website Rebuild','in_progress',CURRENT_DATE) RETURNING *`, [LEAD]);
    await pool.query(
        `INSERT INTO project_milestones (project_id,title,order_index,status) VALUES
         ($1,'Discovery',0,'pending'),($1,'Build',1,'pending'),($1,'Launch',2,'pending')`, [proj.id]);

    console.log('\n=== 1. admin sees the project feed ===');
    let r = await call('GET', '/api/admin/projects');
    check('endpoint exists', r.status === 200, JSON.stringify(r.body).slice(0, 80));
    check('project listed', (r.body.projects || []).length === 1);
    const row = r.body.projects[0];
    check('joins the customer name', row.customer_name === 'Acme Corp', row.customer_name);
    check('counts milestones', Number(row.total_milestones) === 3, String(row.total_milestones));
    check('no updates yet', Number(row.update_count) === 0);

    console.log('\n=== 2. admin posts an update ===');
    sent.email.length = 0; sent.sms.length = 0;
    r = await call('POST', '/api/admin/projects/:id/update', {
        params: { id: String(proj.id) },
        body: { title: 'Homepage design approved', body: 'Moving on to build this week.', percent: 35 },
    });
    check('update accepted', r.body.success === true, JSON.stringify(r.body).slice(0, 100));
    const ups = await q('SELECT * FROM project_updates WHERE project_id=$1', [proj.id]);
    check('update stored', ups.length === 1);
    check('title stored', ups[0].title === 'Homepage design approved');
    check('progress snapshot stored', Number(ups[0].progress) === 35, String(ups[0].progress));
    const [projAfter] = await q('SELECT * FROM client_projects WHERE id=$1', [proj.id]);
    check('project progress updated', Number(projAfter.progress) === 35, String(projAfter.progress));

    console.log('\n=== 3. the customer is told, three ways ===');
    check('update email sent', sent.email.some((e) => /Homepage design approved/i.test(e.subject)));
    check('SMS sent', sent.sms.some((x) => /update on Website Rebuild/i.test(x.message)));
    check('portal message created',
        (await q("SELECT COUNT(*)::int n FROM client_messages WHERE lead_id=$1", [LEAD]))[0].n >= 1);
    check('"you have messages" ping sent',
        sent.email.some((e) => /new message in your portal/i.test(e.subject)));
    check('update marked notified', !!(await q('SELECT notified_at FROM project_updates WHERE id=$1', [ups[0].id]))[0].notified_at);

    console.log('\n=== 4. silent updates are possible ===');
    sent.email.length = 0;
    r = await call('POST', '/api/admin/projects/:id/update', {
        params: { id: String(proj.id) },
        body: { title: 'Internal note', body: 'Waiting on client assets.', notify: false },
    });
    check('accepted', r.body.success === true);
    check('no email sent', sent.email.length === 0, String(sent.email.length));
    check('but still recorded',
        (await q('SELECT COUNT(*)::int n FROM project_updates WHERE project_id=$1', [proj.id]))[0].n === 2);

    console.log('\n=== 5. validation ===');
    r = await call('POST', '/api/admin/projects/:id/update', { params: { id: String(proj.id) }, body: {} });
    check('empty update rejected', r.status === 400, String(r.status));

    console.log('\n=== 6. the customer timeline shows it all ===');
    r = await call('GET', '/api/portal/timeline');
    check('endpoint exists', r.status === 200, JSON.stringify(r.body).slice(0, 80));
    const p = (r.body.projects || [])[0];
    check('project returned', !!p);
    check('milestones included', (p.milestones || []).length === 3);
    check('updates included, newest first', (p.updates || []).length === 2 &&
        p.updates[0].title === 'Internal note', p.updates[0] && p.updates[0].title);
    check('progress percentage exposed', p.progress_pct === 35, String(p.progress_pct));

    console.log('\n=== 7. milestone completion notifies once ===');
    const ms = await q('SELECT * FROM project_milestones WHERE project_id=$1 ORDER BY order_index', [proj.id]);
    sent.email.length = 0;
    r = await call('POST', '/api/admin/milestones/:id/complete', { params: { id: String(ms[0].id) } });
    check('milestone completed', r.body.success === true, JSON.stringify(r.body).slice(0, 90));
    check('customer emailed', sent.email.some((e) => /Milestone complete/i.test(e.subject)));
    sent.email.length = 0;
    r = await call('POST', '/api/admin/milestones/:id/complete', { params: { id: String(ms[0].id) } });
    check('repeat completion sends nothing', sent.email.length === 0, String(sent.email.length));

    console.log('\n=== 8. timeline reflects milestone progress ===');
    r = await call('GET', '/api/portal/timeline');
    const p2 = r.body.projects[0];
    check('one milestone done', p2.milestones_done === 1, String(p2.milestones_done));

    console.log('\n=== 9. service request notifies everyone ===');
    const [rq] = await q(
        `INSERT INTO service_requests (lead_id, service_type, project, preferred_date, details, status)
         VALUES ($1,'Website update','acme.com',CURRENT_DATE + 7,'Add a careers page','new') RETURNING *`, [LEAD]);
    sent.email.length = 0; sent.sms.length = 0;
    const out = await L.onServiceRequestCreated({ requestId: rq.id });
    check('notified', out.notified === true, JSON.stringify(out));
    check('customer confirmation email', sent.email.some((e) => /got your request/i.test(e.subject)));
    const conf = sent.email.find((e) => /got your request/i.test(e.subject));
    check('email names the request', conf && /Website update/.test(conf.html));
    check('email includes the details', conf && /careers page/i.test(conf.html));
    check('customer SMS sent', sent.sms.some((x) => x.phone === '+15550001'));
    check('BUSINESS SMS sent to Diamondback',
        sent.sms.some((x) => x.phone === '+15559990000' && /New service request/i.test(x.message)),
        JSON.stringify(sent.sms.map((x) => x.phone)));
    check('portal message created',
        (await q("SELECT COUNT(*)::int n FROM client_messages WHERE lead_id=$1 AND subject ILIKE '%got your request%'", [LEAD]))[0].n === 1);
    check('"you have messages" ping sent',
        sent.email.some((e) => /new message in your portal/i.test(e.subject)));
    check('admin notified',
        (await q("SELECT COUNT(*)::int n FROM admin_notifications WHERE kind='service_request'"))[0].n === 1);

    sent.email.length = 0;
    const again = await L.onServiceRequestCreated({ requestId: rq.id });
    check('duplicate submission notifies once', again.notified === false && sent.email.length === 0);

    console.log('\n=== 10. scoring firewall ===');
    const [leadEnd] = await q('SELECT * FROM leads WHERE id=$1', [LEAD]);
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