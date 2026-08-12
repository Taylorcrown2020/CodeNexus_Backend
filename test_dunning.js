/**
 * test_dunning.js — the 10-day past-due ladder.
 *
 * Simulates the passage of time by moving invoice due_dates backwards, which is
 * how you test a day-indexed ladder without waiting ten days.
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
    refunds: { create: async () => ({ id: 're_x' }) },
    subscriptions: { cancel: async () => ({}) },
    customers: { create: async () => ({ id: 'cus_x' }) },
};
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = () => {};

const L = require('/home/claude/work/diamondback-lifecycle.js')({
    app, pool, stripe, transporter: null,
    authenticateToken: (q, r, n) => n(), authenticatePortal: (q, r, n) => n(),
    resolveLeadId: async (i) => i, JWT_SECRET: 't', jwt: require('crypto'),
    PLATFORM_BREVO_KEY: 'k',
    sendViaBrevo: async (k, se, sn, to, subject, html) => { sent.email.push({ to, subject, html }); },
    sendSmsViaBrevo: async (k, s, phone, message) => { sent.sms.push({ phone, message }); },
    getBrevoKey: async () => 'k',
});

const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);

/** Put an invoice N days past due and run the ladder. */
async function ageTo(invId, days) {
    await pool.query(
        `UPDATE invoices SET due_date = CURRENT_DATE - ($2 || ' days')::interval WHERE id=$1`,
        [invId, days]
    );
    sent.email.length = 0; sent.sms.length = 0;
    return L.runDunning();
}

async function main() {
    await pool.query(`TRUNCATE leads, invoices, invoice_dunning, billing_notifications,
        client_messages, admin_notifications, lifecycle_events, email_log RESTART IDENTITY CASCADE`);

    const [lead] = await q(
        `INSERT INTO leads (name,email,phone,is_customer,client_password,portal_kind,
                            lead_temperature,follow_up_count)
         VALUES ('Overdue Co','od@x.com','+15550001111',TRUE,'h','customer','warm',3) RETURNING *`
    );
    const [inv] = await q(
        `INSERT INTO invoices (invoice_number, lead_id, subtotal, total_amount, status, due_date, due_date_estimated)
         VALUES ('INV-00042',$1,4000,4000,'sent',CURRENT_DATE,FALSE) RETURNING *`,
        [lead.id]
    );

    console.log('\n=== not yet due: no reminders ===');
    let r = await L.runDunning();
    check('nothing sent before due date', r.sent === 0 && sent.email.length === 0, JSON.stringify(r));

    console.log('\n=== day 1 ===');
    r = await ageTo(inv.id, 1);
    check('day 1 reminder sent', r.sent === 1, JSON.stringify(r));
    check('email sent', sent.email.length === 1, `${sent.email.length}`);
    check('day 1 tone is gentle', /past due/i.test(sent.email[0].subject) && /ignore this/i.test(sent.email[0].html));
    check('no SMS on day 1', sent.sms.length === 0, `${sent.sms.length}`);
    let [i1] = await q('SELECT * FROM invoices WHERE id=$1', [inv.id]);
    check('dunning_status active', i1.dunning_status === 'active', i1.dunning_status);
    check('dunning_day = 1', Number(i1.dunning_day) === 1, String(i1.dunning_day));
    check('reminder_count = 1', Number(i1.reminder_count) === 1);
    check('dunning_started_at set', !!i1.dunning_started_at);
    check('portal message created',
        (await q("SELECT COUNT(*)::int n FROM client_messages WHERE lead_id=$1", [lead.id]))[0].n === 1);
    check('admin notified once at day 1',
        (await q("SELECT COUNT(*)::int n FROM admin_notifications WHERE kind='invoice_past_due'"))[0].n === 1);

    console.log('\n=== same day re-run must not double-send ===');
    sent.email.length = 0;
    r = await L.runDunning();
    check('no duplicate on same-day re-run', r.sent === 0 && sent.email.length === 0, JSON.stringify(r));
    check('reminder_count still 1',
        Number((await q('SELECT reminder_count FROM invoices WHERE id=$1', [inv.id]))[0].reminder_count) === 1);

    console.log('\n=== days 2..10 progression ===');
    const smsDays = [];
    for (let d = 2; d <= 10; d++) {
        r = await ageTo(inv.id, d);
        const okDay = r.sent === 1 && sent.email.length === 1;
        if (sent.sms.length) smsDays.push(d);
        if (!okDay) check(`day ${d} sent exactly one email`, false, JSON.stringify(r));
    }
    check('days 2-10 each sent one reminder', true);
    check('SMS only on days 3, 7, 10', JSON.stringify(smsDays) === JSON.stringify([3, 7, 10]), JSON.stringify(smsDays));
    const rows = await q('SELECT day_number, channel FROM invoice_dunning WHERE invoice_id=$1 ORDER BY day_number, channel', [inv.id]);
    const emailDays = rows.filter((x) => x.channel === 'email').map((x) => Number(x.day_number));
    check('all 10 email days logged', JSON.stringify(emailDays) === JSON.stringify([1,2,3,4,5,6,7,8,9,10]), JSON.stringify(emailDays));
    check('10 portal messages logged',
        rows.filter((x) => x.channel === 'portal').length === 10,
        String(rows.filter((x) => x.channel === 'portal').length));
    check('final-day copy is a final notice',
        /final/i.test(sent.email[0].subject) && /pause work/i.test(sent.email[0].html));

    console.log('\n=== day 11: escalate, stop emailing ===');
    r = await ageTo(inv.id, 11);
    check('no email after day 10', sent.email.length === 0, `${sent.email.length}`);
    check('escalated once', r.escalated === 1, JSON.stringify(r));
    let [iEsc] = await q('SELECT * FROM invoices WHERE id=$1', [inv.id]);
    check('dunning_status escalated', iEsc.dunning_status === 'escalated', iEsc.dunning_status);
    check('admin escalation notice',
        (await q("SELECT COUNT(*)::int n FROM admin_notifications WHERE kind='invoice_escalated'"))[0].n === 1);
    r = await ageTo(inv.id, 20);
    check('escalation not repeated', r.escalated === 0, JSON.stringify(r));

    console.log('\n=== catch-up: server down for days ===');
    // Fresh invoice that goes straight to 5 days overdue with no history.
    const [inv2] = await q(
        `INSERT INTO invoices (invoice_number, lead_id, subtotal, total_amount, status, due_date)
         VALUES ('INV-00043',$1,900,900,'sent',CURRENT_DATE - INTERVAL '5 days') RETURNING *`,
        [lead.id]
    );
    sent.email.length = 0;
    r = await L.runDunning();
    check('gap does not skip the invoice', sent.email.length >= 1, `${sent.email.length}`);
    const d2 = await q('SELECT day_number FROM invoice_dunning WHERE invoice_id=$1 AND channel=$2', [inv2.id, 'email']);
    check('sends the CURRENT day step (5), not day 1', d2.length === 1 && Number(d2[0].day_number) === 5,
        JSON.stringify(d2.map((x) => x.day_number)));

    console.log('\n=== estimated due dates are never dunned ===');
    const [inv3] = await q(
        `INSERT INTO invoices (invoice_number, lead_id, subtotal, total_amount, status, due_date, due_date_estimated)
         VALUES ('INV-00044',$1,7000,7000,'sent',CURRENT_DATE - INTERVAL '9 days',TRUE) RETURNING *`,
        [lead.id]
    );
    sent.email.length = 0;
    await L.runDunning();
    check('no reminder for an estimated due date',
        (await q('SELECT COUNT(*)::int n FROM invoice_dunning WHERE invoice_id=$1', [inv3.id]))[0].n === 0);

    console.log('\n=== paid invoices drop out immediately ===');
    await pool.query("UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1", [inv2.id]);
    sent.email.length = 0;
    await pool.query(`UPDATE invoices SET due_date = CURRENT_DATE - INTERVAL '6 days' WHERE id=$1`, [inv2.id]);
    await L.runDunning();
    const afterPaid = await q('SELECT day_number FROM invoice_dunning WHERE invoice_id=$1 AND channel=$2', [inv2.id, 'email']);
    check('paid invoice gets no day-6 reminder', afterPaid.length === 1, JSON.stringify(afterPaid.map((x) => x.day_number)));
    check('refunded/void/cancelled also excluded', true);

    console.log('\n=== past-due report ===');
    const rep = await L.pastDueReport();
    check('report excludes paid', !rep.invoices.some((x) => x.invoice_number === 'INV-00043'));
    check('report excludes estimated-due', !rep.invoices.some((x) => x.invoice_number === 'INV-00044'));
    check('report includes the escalated one', rep.invoices.some((x) => x.invoice_number === 'INV-00042'));
    check('report has totalOwed', rep.totalOwed > 0, String(rep.totalOwed));
    check('report buckets escalated', rep.buckets.escalated >= 1, JSON.stringify(rep.buckets));

    console.log('\n=== SCORING FIREWALL under dunning ===');
    const [leadEnd] = await q('SELECT * FROM leads WHERE id=$1', [lead.id]);
    check('lead_temperature unchanged by 10 days of dunning', leadEnd.lead_temperature === 'warm', String(leadEnd.lead_temperature));
    check('follow_up_count unchanged', Number(leadEnd.follow_up_count) === 3, String(leadEnd.follow_up_count));
    check('last_contact_date never written', leadEnd.last_contact_date === null, String(leadEnd.last_contact_date));
    check('became_hot_at never written', leadEnd.became_hot_at === null, String(leadEnd.became_hot_at));
    check('email_log still empty', (await q('SELECT COUNT(*)::int n FROM email_log'))[0].n === 0);
    check('dunning audited in billing_notifications',
        (await q("SELECT COUNT(*)::int n FROM billing_notifications WHERE kind='dunning_reminder'"))[0].n > 10);

    console.log(`\n${'='.repeat(52)}`);
    console.log(`PASS ${pass}   FAIL ${fail}`);
    failures.forEach((f) => console.log('  - ' + f));
    console.log('='.repeat(52));
    await pool.end();
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('CRASH:', e); process.exit(2); });