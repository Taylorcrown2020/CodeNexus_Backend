/**
 * test_lifecycle.js — exercises diamondback-lifecycle.js against a real
 * Postgres, with Stripe / email / SMS stubbed so nothing leaves the box.
 *
 * Traces the spec's happy path and asserts the state at each step, then probes
 * the failure modes that matter: double-signing, double-charging, refunds
 * beyond balance, cancellation/reinstatement, and the scoring firewall.
 */

const { Pool } = require('pg');
const path = require('path');

const pool = new Pool({
    connectionString: 'postgres://postgres:pw@127.0.0.1:5432/db3',
    ssl: false,
});

// ---- stubs -----------------------------------------------------------------
const sent = { email: [], sms: [], portal: [] };

const stripe = {
    paymentIntents: {
        create: async (args) => {
            if (args.payment_method === 'pm_decline') {
                const e = new Error('Your card was declined.');
                e.code = 'card_declined';
                throw e;
            }
            return { id: 'pi_' + Math.random().toString(36).slice(2, 12), latest_charge: 'ch_test' };
        },
    },
    refunds: { create: async () => ({ id: 're_' + Math.random().toString(36).slice(2, 10) }) },
    subscriptions: { cancel: async () => ({ status: 'canceled' }) },
};

async function sendViaBrevo(key, sEmail, sName, to, subject, html) {
    sent.email.push({ to, subject, html });
    return { messageId: 'stub' };
}
async function sendSmsViaBrevo(key, sender, phone, message) {
    sent.sms.push({ phone, message });
    return { ok: true };
}

// Minimal express double: records route registrations without serving.
const routes = [];
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (p, ...h) => routes.push({ method: m.toUpperCase(), path: p, handlers: h });
}

const authStub = (req, res, next) => next();
const resolveLeadId = async (id) => id;

const initLifecycle = require('/home/claude/work/diamondback-lifecycle.js');
const L = initLifecycle({
    app, pool, stripe,
    transporter: null,
    authenticateToken: authStub,
    authenticatePortal: authStub,
    resolveLeadId,
    JWT_SECRET: 'test', jwt: require('crypto'),
    PLATFORM_BREVO_KEY: 'stub-key',
    sendViaBrevo, sendSmsViaBrevo,
    getBrevoKey: async () => 'stub-key',
});

// ---- test scaffolding ------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail = '') {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);

async function main() {
    console.log('\n=== reset fixtures ===');
    await pool.query(`TRUNCATE leads, sales_agreements, agreement_items, agreement_signatures,
        invoices, invoice_items, payments, refunds, payment_methods, maintenance_plans,
        plan_cancellations, client_projects, project_milestones, lifecycle_events,
        admin_notifications, billing_notifications, client_messages, admin_users,
        client_companies, crm_subscriptions, email_log
        RESTART IDENTITY CASCADE`);

    await pool.query(`INSERT INTO admin_users (username, email, password_hash)
        VALUES ('taylor','taylor@x.com','h'), ('assistant','asst@x.com','h')`);
    const [lead] = await q(
        `INSERT INTO leads (name, email, phone, status, lead_temperature, follow_up_count)
         VALUES ('Acme Corp','acme@x.com','+15551234567','contacted','hot',2) RETURNING *`
    );

    // =====================================================================
    console.log('\n=== 1. lead -> customer (customer portal ONLY) ===');
    const created = await L.onCustomerCreated({ leadId: lead.id });
    const [afterCreate] = await q('SELECT * FROM leads WHERE id=$1', [lead.id]);
    check('portal_kind is customer', afterCreate.portal_kind === 'customer', afterCreate.portal_kind);
    check('is_customer true', afterCreate.is_customer === true);
    check('crm_access false', afterCreate.crm_access === false);
    check('client_password set', !!afterCreate.client_password);
    check('NO client_portal_id (no CRM scaffolding)', !afterCreate.client_portal_id, String(afterCreate.client_portal_id));
    const companies = await q('SELECT * FROM client_companies');
    check('NO client_companies row created', companies.length === 0, `${companies.length} rows`);
    check('credentials email sent', sent.email.some((e) => /portal is ready/i.test(e.subject)));
    check('temp password returned', !!created.temporaryPassword);

    // idempotency
    sent.email.length = 0;
    const again = await L.onCustomerCreated({ leadId: lead.id });
    check('re-run does not re-send credentials', sent.email.length === 0, `${sent.email.length} emails`);
    check('re-run reports alreadyExisted', again.alreadyExisted === true);

    // =====================================================================
    console.log('\n=== 2. CRM subscription is ADDITIVE ===');
    await L.onCrmSubscriptionActivated({ leadId: lead.id, companyName: 'Acme', seats: 2 });
    const [afterCrm] = await q('SELECT * FROM leads WHERE id=$1', [lead.id]);
    check("portal_kind becomes 'both' not 'crm'", afterCrm.portal_kind === 'both', afterCrm.portal_kind);
    check('crm_access true', afterCrm.crm_access === true);
    check('client_portal_id now allocated', !!afterCrm.client_portal_id);
    const comp2 = await q('SELECT * FROM client_companies');
    check('client_companies created only now', comp2.length === 1, `${comp2.length}`);
    check('purchased_seats recorded', Number(comp2[0].purchased_seats) === 2);

    // =====================================================================
    console.log('\n=== 3. SLA created + sent ===');
    const est = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const [ag] = await q(
        `INSERT INTO sales_agreements
            (agreement_number, lead_id, customer_name, customer_email, package_name,
             price, status, est_completion_date, net_days, tax_rate, agreement_kind)
         VALUES ('SA-00001',$1,'Acme Corp','acme@x.com','Custom Web Platform',
                 0,'draft',$2,14,0,'sla') RETURNING *`,
        [lead.id, est]
    );
    await pool.query(
        `INSERT INTO agreement_items (agreement_id, sort_order, description, quantity, unit_price, amount)
         VALUES ($1,0,'Discovery and design',1,2500,2500),
                ($1,1,'Build and integration',1,6000,6000),
                ($1,2,'Launch and handover',1,1500,1500)`,
        [ag.id]
    );
    const total = await L.agreementTotal(ag.id);
    check('total sums line items (not price field)', total === 10000, String(total));

    sent.email.length = 0; sent.sms.length = 0;
    await L.onAgreementSent({ agreementId: ag.id });
    check('ready-to-sign email sent', sent.email.some((e) => /ready to sign/i.test(e.subject)));
    check('ready-to-sign SMS sent', sent.sms.length === 1, `${sent.sms.length}`);
    check('SMS mentions portal message', /message/i.test(sent.sms[0].message));
    const msgs = await q('SELECT * FROM client_messages WHERE lead_id=$1', [lead.id]);
    check('portal message row created', msgs.length >= 1, `${msgs.length}`);
    check("portal message kind='billing'", msgs[0].kind === 'billing', msgs[0].kind);

    // =====================================================================
    console.log('\n=== 4. customer signs -> signature, admin, invoice, timeline ===');
    sent.email.length = 0; sent.sms.length = 0;
    const signed = await L.onAgreementSigned({
        agreementId: ag.id, signerName: 'John Acme', ip: '203.0.113.9', userAgent: 'jest',
    });

    const [sig] = await q('SELECT * FROM agreement_signatures WHERE agreement_id=$1', [ag.id]);
    check('signature row created', !!sig);
    check('signature SVG generated', sig && sig.signature_svg.includes('<svg'));
    check('signature contains typed name', sig && sig.signature_svg.includes('John Acme'));
    check('consent text stored', sig && /electronically/i.test(sig.consent_text));
    check('IP captured', sig && sig.ip_address === '203.0.113.9');

    // deterministic signature
    check('signature is deterministic for same name',
        L.generateSignatureSVG('John Acme') === L.generateSignatureSVG('John Acme'));
    check('signature differs for different name',
        L.generateSignatureSVG('John Acme') !== L.generateSignatureSVG('Jane Roe'));

    const [agAfter] = await q('SELECT * FROM sales_agreements WHERE id=$1', [ag.id]);
    check('agreement status signed', agAfter.status === 'signed', agAfter.status);
    check('agreement linked to invoice', !!agAfter.invoice_id);
    check('agreement linked to project', !!agAfter.project_id);

    const [leadAssigned] = await q('SELECT * FROM leads WHERE id=$1', [lead.id]);
    check('admin assigned to customer', !!leadAssigned.assigned_admin_id, String(leadAssigned.assigned_admin_id));
    check('assignment timestamped', !!leadAssigned.assigned_admin_at);

    const inv = signed.invoice;
    check('invoice created', !!inv);
    check('invoice total = 10000', Number(inv.total_amount) === 10000, String(inv.total_amount));
    check('invoice due = est completion date', new Date(inv.due_date).toISOString().slice(0, 10) === est,
        `${new Date(inv.due_date).toISOString().slice(0,10)} vs ${est}`);
    check('due date flagged estimated', inv.due_date_estimated === true);
    const invItems = await q('SELECT * FROM invoice_items WHERE invoice_id=$1', [inv.id]);
    check('invoice line items copied (3)', invItems.length === 3, `${invItems.length}`);

    const [proj] = await q('SELECT * FROM client_projects WHERE agreement_id=$1', [ag.id]);
    check('project timeline created', !!proj);
    check('project has est completion', new Date(proj.est_completion_date).toISOString().slice(0, 10) === est);
    const miles = await q('SELECT * FROM project_milestones WHERE project_id=$1 ORDER BY order_index', [proj.id]);
    check('milestones seeded from line items (3)', miles.length === 3, `${miles.length}`);
    check('first milestone matches item', miles[0] && /Discovery/.test(miles[0].title));

    check('signed email sent', sent.email.some((e) => /signed/i.test(e.subject)));
    const signedEmail = sent.email.find((e) => /signed/i.test(e.subject));
    check('signed email names assigned admin', signedEmail && /taylor|assistant|project lead/i.test(signedEmail.html));
    check('signed email states due date is estimate',
        signedEmail && /finish sooner/i.test(signedEmail.html));
    check('signed SMS sent', sent.sms.length >= 1);
    const adminNotifs = await q("SELECT * FROM admin_notifications WHERE kind='sla_signed'");
    check('admin notified of signature', adminNotifs.length === 1, `${adminNotifs.length}`);

    // double-sign guard
    sent.email.length = 0;
    const dbl = await L.onAgreementSigned({ agreementId: ag.id, signerName: 'John Acme' });
    check('double-sign blocked', dbl.alreadySigned === true);
    const invCount = await q('SELECT COUNT(*)::int AS n FROM invoices WHERE agreement_id=$1', [ag.id]);
    check('double-sign did NOT create 2nd invoice', invCount[0].n === 1, `${invCount[0].n}`);
    check('double-sign sent no email', sent.email.length === 0, `${sent.email.length}`);

    // =====================================================================
    console.log('\n=== 5. milestones ===');
    sent.email.length = 0;
    await L.onMilestoneCompleted({ milestoneId: miles[0].id });
    check('milestone email sent', sent.email.some((e) => /Milestone complete/i.test(e.subject)));
    const mEmail = sent.email.find((e) => /Milestone complete/i.test(e.subject));
    check('milestone email shows progress 1 of 3', mEmail && /1 of 3/.test(mEmail.html));
    sent.email.length = 0;
    await L.onMilestoneCompleted({ milestoneId: miles[0].id });
    check('duplicate milestone email suppressed', sent.email.length === 0, `${sent.email.length}`);

    // =====================================================================
    console.log('\n=== 6. project completion firms up the due date ===');
    sent.email.length = 0; sent.sms.length = 0;
    const done = await L.onProjectCompleted({ projectId: proj.id, dueInDays: 7 });
    const [projDone] = await q('SELECT * FROM client_projects WHERE id=$1', [proj.id]);
    check('project marked completed', projDone.status === 'completed');
    const remaining = await q(
        "SELECT COUNT(*)::int AS n FROM project_milestones WHERE project_id=$1 AND status<>'completed'", [proj.id]);
    check('all milestones completed', remaining[0].n === 0, `${remaining[0].n}`);
    const newDue = new Date(done.invoice.due_date).toISOString().slice(0, 10);
    const expectDue = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    check('due date moved IN when finishing early', newDue === expectDue, `${newDue} vs ${expectDue}`);
    check('due date no longer flagged estimated', done.invoice.due_date_estimated === false);
    check('project-complete email sent', sent.email.some((e) => /is complete/i.test(e.subject)));
    check('separate invoice-due email sent', sent.email.some((e) => /is due/i.test(e.subject)));
    check('completion SMS sent', sent.sms.length >= 1);

    // =====================================================================
    console.log('\n=== 7. payment + receipt ===');
    sent.email.length = 0; sent.sms.length = 0;
    const { payment } = await L.recordPayment({
        leadId: lead.id, invoiceId: inv.id, amount: 10000, kind: 'invoice',
        method: 'card', methodLast4: '4242', methodBrand: 'Visa',
        stripePaymentIntentId: 'pi_realpay1',
    });
    check('payment recorded', !!payment && Number(payment.amount) === 10000);
    check('receipt number generated', !!payment.receipt_number);
    const [invPaid] = await q('SELECT * FROM invoices WHERE id=$1', [inv.id]);
    check('invoice marked paid', invPaid.status === 'paid', invPaid.status);
    check('invoice dunning resolved', invPaid.dunning_status === 'resolved', invPaid.dunning_status);

    const dup = await L.recordPayment({
        leadId: lead.id, invoiceId: inv.id, amount: 10000,
        stripePaymentIntentId: 'pi_realpay1',
    });
    check('duplicate webhook does NOT double-record', dup.created === false);
    const payCount = await q('SELECT COUNT(*)::int AS n FROM payments WHERE lead_id=$1', [lead.id]);
    check('exactly 1 payment row', payCount[0].n === 1, `${payCount[0].n}`);

    const notified = await L.onPaymentReceived({ paymentId: payment.id });
    check('paid email sent', sent.email.some((e) => /Payment received/i.test(e.subject)));
    check('paid SMS sent', sent.sms.some((s) => /payment of/i.test(s.message)));
    check('receipt in portal message', (await q(
        "SELECT COUNT(*)::int AS n FROM client_messages WHERE lead_id=$1 AND subject ILIKE '%Payment received%'", [lead.id]
    ))[0].n === 1);
    check('reports zero outstanding invoices', notified.outstandingInvoices === 0, String(notified.outstandingInvoices));
    const paidEmail = sent.email.find((e) => /Payment received/i.test(e.subject));
    check('paid email states no outstanding', paidEmail && /no outstanding/i.test(paidEmail.html));
    sent.email.length = 0;
    const reNotify = await L.onPaymentReceived({ paymentId: payment.id });
    check('paid notification not repeated', sent.email.length === 0 && reNotify.notified === false);

    // =====================================================================
    console.log('\n=== 8. refunds ===');
    sent.email.length = 0;
    const r1 = await L.issueRefund({ paymentId: payment.id, amount: 2500, reason: 'Scope reduced', adminId: 1 });
    check('partial refund created', Number(r1.amount) === 2500);
    let [payAfter] = await q('SELECT * FROM payments WHERE id=$1', [payment.id]);
    check('status partially_refunded', payAfter.status === 'partially_refunded', payAfter.status);
    check('refunded_amount tracked', Number(payAfter.refunded_amount) === 2500);
    check('refund email sent', sent.email.some((e) => /Refund issued/i.test(e.subject)));

    let over = null;
    try { await L.issueRefund({ paymentId: payment.id, amount: 9999, adminId: 1 }); }
    catch (e) { over = e.message; }
    check('over-refund rejected', !!over && /exceeds/i.test(over), String(over));

    await L.issueRefund({ paymentId: payment.id, amount: 7500, reason: 'Full', adminId: 1 });
    [payAfter] = await q('SELECT * FROM payments WHERE id=$1', [payment.id]);
    check('fully refunded status', payAfter.status === 'refunded', payAfter.status);
    const [invRef] = await q('SELECT * FROM invoices WHERE id=$1', [inv.id]);
    check('invoice flipped to refunded', invRef.status === 'refunded', invRef.status);

    // =====================================================================
    console.log('\n=== 9. maintenance plan: signature -> autopay ===');
    const [plan] = await q(
        `INSERT INTO maintenance_plans (lead_id, plan_type, label, amount, billing_day, status, next_charge_date)
         VALUES ($1,'monthly_maintenance','Monthly Maintenance',299,15,'active',CURRENT_DATE) RETURNING *`,
        [lead.id]
    );
    // no payment method yet
    const noPm = await L.chargeMaintenancePlan(plan);
    check('charge without method fails safely', noPm.ok === false && /payment method/i.test(noPm.error));
    let [planNoPm] = await q('SELECT * FROM maintenance_plans WHERE id=$1', [plan.id]);
    check('plan paused pending_payment_method', planNoPm.status === 'pending_payment_method', planNoPm.status);
    check('admin warned about missing method',
        (await q("SELECT COUNT(*)::int AS n FROM admin_notifications WHERE kind='maintenance_no_method'"))[0].n === 1);

    await pool.query(
        `INSERT INTO payment_methods (lead_id, stripe_customer_id, stripe_pm_id, type, brand, last4, is_default)
         VALUES ($1,'cus_test','pm_card_ok','card','Visa','4242',TRUE)`, [lead.id]
    );
    await pool.query("UPDATE maintenance_plans SET status='active' WHERE id=$1", [plan.id]);
    const [planReady] = await q('SELECT * FROM maintenance_plans WHERE id=$1', [plan.id]);

    sent.email.length = 0; sent.sms.length = 0;
    const charged = await L.chargeMaintenancePlan(planReady);
    check('autopay charge succeeded', charged.ok === true, JSON.stringify(charged.error));
    check('NO invoice generated by default (autopay)', charged.invoice === null || charged.invoice === undefined);
    check('payment logged with kind=maintenance',
        (await q("SELECT COUNT(*)::int AS n FROM payments WHERE maintenance_plan_id=$1 AND kind='maintenance'", [plan.id]))[0].n === 1);
    check('monthly payment email sent', sent.email.some((e) => /payment received/i.test(e.subject)));
    check('monthly payment SMS sent', sent.sms.some((s) => /processed/i.test(s.message)));
    const chargeEmail = sent.email.find((e) => /payment received/i.test(e.subject));
    check('receipt email shows next payment date', chargeEmail && /Next payment/i.test(chargeEmail.html));
    check('receipt email mentions 30-day cancellation', chargeEmail && /30 days/.test(chargeEmail.html));
    const [planCharged] = await q('SELECT * FROM maintenance_plans WHERE id=$1', [plan.id]);
    check('next_charge_date advanced', !!planCharged.next_charge_date &&
        new Date(planCharged.next_charge_date) > new Date());
    check('charges_completed incremented', Number(planCharged.charges_completed) === 1);
    check('billing day 15 preserved', new Date(planCharged.next_charge_date).getUTCDate() === 15,
        String(new Date(planCharged.next_charge_date).getUTCDate()));

    // invoice-generating variant
    const [plan2] = await q(
        `INSERT INTO maintenance_plans (lead_id, plan_type, label, amount, billing_day, status, next_charge_date, generate_invoice)
         VALUES ($1,'database_maintenance','Database Maintenance',149,1,'active',CURRENT_DATE,TRUE) RETURNING *`,
        [lead.id]
    );
    const charged2 = await L.chargeMaintenancePlan(plan2);
    check('generate_invoice=TRUE does create an invoice', !!charged2.invoice);

    // decline path
    await pool.query("UPDATE payment_methods SET stripe_pm_id='pm_decline' WHERE lead_id=$1", [lead.id]);
    const [plan3] = await q(
        `INSERT INTO maintenance_plans (lead_id, plan_type, label, amount, billing_day, status, next_charge_date)
         VALUES ($1,'brevo_maintenance','Brevo Maintenance',99,1,'active',CURRENT_DATE) RETURNING *`,
        [lead.id]
    );
    sent.email.length = 0;
    const declined = await L.chargeMaintenancePlan(plan3);
    check('declined card handled', declined.ok === false && /declined/i.test(declined.error));
    check('failure email sent', sent.email.some((e) => /couldn't process/i.test(e.subject)));
    check('failure counted',
        Number((await q('SELECT consecutive_failures FROM maintenance_plans WHERE id=$1', [plan3.id]))[0].consecutive_failures) === 1);
    await pool.query("UPDATE payment_methods SET stripe_pm_id='pm_card_ok' WHERE lead_id=$1", [lead.id]);

    // =====================================================================
    console.log('\n=== 10. 30-day cancellation ===');
    sent.email.length = 0; sent.sms.length = 0;
    const cancel = await L.requestPlanCancellation({ planId: plan.id, leadId: lead.id, reason: 'Budget' });
    const daysOut = Math.round((new Date(cancel.effectiveAt) - Date.now()) / 86400000);
    check('effective date is 30 days out', daysOut === 30, `${daysOut} days`);
    let [planCancelling] = await q('SELECT * FROM maintenance_plans WHERE id=$1', [plan.id]);
    check('plan status pending_cancellation', planCancelling.status === 'pending_cancellation', planCancelling.status);
    check('cancellation confirmation email sent', sent.email.some((e) => /Cancellation confirmed/i.test(e.subject)));
    check('cancellation SMS sent', sent.sms.some((s) => /cancellation confirmed/i.test(s.message)));
    const confEmail = sent.email.find((e) => /Cancellation confirmed/i.test(e.subject));
    check('email states service continues to date', confEmail && /stays active until/i.test(confEmail.html));
    const cancelNotif = await q("SELECT * FROM admin_notifications WHERE kind='plan_cancellation_requested'");
    check('admin notified of pending cancellation', cancelNotif.length === 1);
    check('admin notice says cancels in 30 days', cancelNotif[0] && /30 days/.test(cancelNotif[0].body));

    const dupCancel = await L.requestPlanCancellation({ planId: plan.id, leadId: lead.id });
    check('duplicate cancellation request is a no-op', dupCancel.alreadyPending === true);

    // billing continues during notice period
    await pool.query('UPDATE maintenance_plans SET next_charge_date=CURRENT_DATE WHERE id=$1', [plan.id]);
    const midNotice = await L.runMaintenanceCharges();
    const chargedDuringNotice = midNotice.find((r) => r.planId === plan.id);
    check('plan STILL bills during notice period', chargedDuringNotice && chargedDuringNotice.ok === true,
        JSON.stringify(chargedDuringNotice));

    // reminders
    sent.email.length = 0;
    await pool.query(
        `UPDATE plan_cancellations SET effective_at = NOW() + INTERVAL '7 days'
          WHERE maintenance_plan_id=$1 AND status='pending'`, [plan.id]);
    const rem = await L.runCancellationReminders();
    check('7-day reminder sent', rem.sent === 1, JSON.stringify(rem));
    check('reminder mentions reinstating', sent.email.some((e) => /reinstate/i.test(e.subject + e.html)));
    const rem2 = await L.runCancellationReminders();
    check('reminder not repeated same day', rem2.sent === 0, JSON.stringify(rem2));

    // reinstate
    sent.email.length = 0;
    await L.reinstatePlan({ planId: plan.id, leadId: lead.id });
    let [planBack] = await q('SELECT * FROM maintenance_plans WHERE id=$1', [plan.id]);
    check('plan active again after reinstate', planBack.status === 'active', planBack.status);
    check('reinstate email sent', sent.email.some((e) => /reinstated/i.test(e.subject)));
    check('cancellation marked reinstated',
        (await q("SELECT status FROM plan_cancellations WHERE maintenance_plan_id=$1 ORDER BY id DESC LIMIT 1", [plan.id]))[0].status === 'reinstated');

    // full cancellation completion
    sent.email.length = 0; sent.sms.length = 0;
    await L.requestPlanCancellation({ planId: plan.id, leadId: lead.id, reason: 'Done' });
    await pool.query(
        `UPDATE plan_cancellations SET effective_at = NOW() - INTERVAL '1 minute'
          WHERE maintenance_plan_id=$1 AND status='pending'`, [plan.id]);
    const completed = await L.completePlanCancellations();
    check('cancellation completed', completed.completed === 1, JSON.stringify(completed));
    [planBack] = await q('SELECT * FROM maintenance_plans WHERE id=$1', [plan.id]);
    check('plan status cancelled', planBack.status === 'cancelled', planBack.status);
    check('next_charge_date cleared', planBack.next_charge_date === null);
    check('cancelled email sent', sent.email.some((e) => /has been cancelled/i.test(e.subject)));
    check('cancelled SMS sent', sent.sms.some((s) => /now cancelled/i.test(s.message)));
    const cancelledEmail = sent.email.find((e) => /has been cancelled/i.test(e.subject));
    check('cancelled email says portal stays open', cancelledEmail && /portal account stays open/i.test(cancelledEmail.html));

    // cancelled plan must not bill again
    await pool.query('UPDATE maintenance_plans SET next_charge_date=CURRENT_DATE WHERE id=$1', [plan.id]);
    const afterCancelRun = await L.runMaintenanceCharges();
    check('cancelled plan does NOT bill', !afterCancelRun.find((r) => r.planId === plan.id));

    // =====================================================================
    console.log('\n=== 11. SCORING FIREWALL ===');
    const [leadFinal] = await q('SELECT * FROM leads WHERE id=$1', [lead.id]);
    check('lead_temperature untouched by billing', leadFinal.lead_temperature === 'hot', String(leadFinal.lead_temperature));
    check('follow_up_count untouched', Number(leadFinal.follow_up_count) === 2, String(leadFinal.follow_up_count));
    check('last_contact_date never written', leadFinal.last_contact_date === null, String(leadFinal.last_contact_date));
    check('became_hot_at never written by billing', leadFinal.became_hot_at === null, String(leadFinal.became_hot_at));
    const emailLog = await q('SELECT COUNT(*)::int AS n FROM email_log WHERE lead_id=$1', [lead.id]);
    check('NOTHING written to email_log (marketing table)', emailLog[0].n === 0, `${emailLog[0].n} rows`);
    const bn = await q('SELECT COUNT(*)::int AS n FROM billing_notifications WHERE lead_id=$1', [lead.id]);
    check('all sends audited in billing_notifications', bn[0].n > 20, `${bn[0].n} rows`);

    // unknown kind refused
    const bad = await L.notify({ leadId: lead.id, kind: 'marketing_blast', subject: 'x', bodyHtml: 'x' });
    check('unknown message kind refused', bad.ok === false && bad.error === 'unknown_kind');

    // =====================================================================
    console.log('\n=== 12. billing-day clamping ===');
    const feb = L.nextBillingDate(31, new Date('2027-02-05T00:00:00Z'));
    check('day 31 clamps to Feb 28', feb.toISOString().slice(0, 10) === '2027-02-28', feb.toISOString().slice(0, 10));
    const leap = L.nextBillingDate(31, new Date('2028-02-05T00:00:00Z'));
    check('day 31 clamps to Feb 29 in leap year', leap.toISOString().slice(0, 10) === '2028-02-29', leap.toISOString().slice(0, 10));
    const roll = L.nextBillingDate(1, new Date('2027-03-15T00:00:00Z'));
    check('past billing day rolls to next month', roll.toISOString().slice(0, 10) === '2027-04-01', roll.toISOString().slice(0, 10));

    // =====================================================================
    console.log('\n=== 13. routes registered ===');
    const want = [
        'GET /api/portal/payments',
        'GET /api/portal/maintenance-plans',
        'POST /api/portal/maintenance-plans/:id/cancel',
        'POST /api/portal/maintenance-plans/:id/reinstate',
        'POST /api/portal/sales-agreements/:id/sign',
        'GET /api/admin/customers/:leadId/payments',
        'POST /api/admin/payments/:id/refund',
        'GET /api/admin/maintenance-plans',
        'POST /api/admin/maintenance-plans',
        'GET /api/admin/lifecycle-notifications',
        'POST /api/cron/lifecycle-daily',
    ];
    for (const w of want) {
        const [m, p] = w.split(' ');
        check(`route ${w}`, routes.some((r) => r.method === m && r.path === p));
    }

    // =====================================================================
    console.log(`\n${'='.repeat(58)}`);
    console.log(`PASS ${pass}   FAIL ${fail}`);
    if (failures.length) {
        console.log('\nFAILURES:');
        failures.forEach((f) => console.log('  - ' + f));
    }
    console.log('='.repeat(58));

    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\nHARNESS CRASH:', e); process.exit(2); });