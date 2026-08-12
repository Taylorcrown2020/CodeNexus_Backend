// ============================================================================
// diamondback-lifecycle.js — Diamondback Coding
//
// The automated customer lifecycle, from "lead becomes a customer" through
// project delivery, payment, and recurring maintenance.
//
// MOUNT IT — in server.js, next to the other init calls (after `stripe`,
// `pool`, `authenticateToken`, `resolveLeadId` exist, BEFORE the 404 handler):
//
//     const initLifecycle = require('./diamondback-lifecycle.js');
//     const lifecycle = initLifecycle({
//         app, pool, stripe, transporter,
//         authenticateToken, authenticatePortal, resolveLeadId,
//         JWT_SECRET, jwt,
//         PLATFORM_BREVO_KEY, PLATFORM_SENDER_EMAIL, PLATFORM_SENDER_NAME,
//         sendViaBrevo, sendSmsViaBrevo, getBrevoKey,
//     });
//
// `lifecycle` exposes the stage functions so existing server.js routes can
// trigger them (e.g. the lead->customer conversion calls onCustomerCreated).
//
// ---------------------------------------------------------------------------
// THE ACCOUNT MODEL — read this before changing anything
// ---------------------------------------------------------------------------
// A promoted lead gets a CUSTOMER PORTAL account. Always, and only.
//   portal_kind = 'customer', no client_companies row, no CRM scaffolding.
//
// CRM access (client_portal.html) is ADDITIVE, granted only when they buy a
// CodeNexus subscription:
//   portal_kind = 'both', crm_access = TRUE, and THEN the client_companies
//   tenant row is created.
//
// A CRM subscriber is still your customer, so they never become 'crm' instead
// of 'customer'. That distinction is what previously locked customers out.
//
// ---------------------------------------------------------------------------
// THE SCORING FIREWALL — the reason notify() exists
// ---------------------------------------------------------------------------
// Every transactional message here goes through notify(), never through the
// marketing/follow-up email path. Three properties matter:
//
//   1. emailType is always one of TRANSACTIONAL_TYPES, which server.js's
//      tracked-email helper treats as a confirmation — no open pixel, no
//      wrapped links. With nothing to track, engagement scoring has no input.
//   2. notify() never writes lead_temperature, became_hot_at,
//      last_contact_date, or follow_up_count.
//   3. Sends are logged to billing_notifications / lifecycle_events, which no
//      follow-up query reads.
//
// If you add a message here, add its type to TRANSACTIONAL_TYPES too, or it
// will start heating up leads who merely got a receipt.
// ============================================================================

'use strict';

// Required at module scope, not inside onCustomerCreated. A lazy require means a
// missing dependency surfaces the first time you promote a customer — i.e. in
// front of a real customer — instead of at boot.
const bcrypt = require('bcryptjs');

module.exports = function initLifecycle({
    app,
    pool,
    stripe,
    transporter,
    authenticateToken,
    authenticatePortal,
    resolveLeadId,
    JWT_SECRET,
    jwt,
    PLATFORM_BREVO_KEY,
    PLATFORM_SENDER_EMAIL = 'contact@diamondbackcoding.com',
    PLATFORM_SENDER_NAME = 'Diamondback Coding',
    sendViaBrevo,
    sendSmsViaBrevo,
    getBrevoKey,
    PORTAL_URL = process.env.PORTAL_URL || 'https://diamondbackcoding.com/customer_portal.html',
    CANCELLATION_NOTICE_DAYS = Number(process.env.CANCELLATION_NOTICE_DAYS || 30),
}) {

    // Every message type this module can send. Adding one here is what keeps
    // it out of engagement tracking — see the firewall note in the header.
    const TRANSACTIONAL_TYPES = [
        'portal_credentials',
        'sla_ready_to_sign',
        'sla_signed',
        'admin_assigned',
        'invoice_created',
        'invoice_due',
        'invoice_paid',
        'milestone_completed',
        'project_completed',
        'portal_message_waiting',
        'maintenance_agreement',
        'maintenance_charged',
        'maintenance_charge_failed',
        'cancellation_confirmed',
        'cancellation_reminder',
        'cancellation_completed',
        'refund_issued',
        'crm_subscription_active',
        'dunning_reminder',
    ];

    // ======================================================================
    // Small helpers
    // ======================================================================

    const money = (n) => `$${Number(n || 0).toFixed(2)}`;
    const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

    function prettyDate(d) {
        if (!d) return 'TBD';
        return new Date(d).toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        });
    }

    /**
     * Advance a date to the next occurrence of `day`, clamping to the last day
     * of shorter months. Billing day 31 in February bills on the 28th/29th
     * rather than silently skipping the month.
     */
    function nextBillingDate(day, from = new Date()) {
        const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
        const target = new Date(d);
        const lastThis = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        target.setUTCDate(Math.min(day, lastThis));
        if (target <= from) {
            const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
            const lastNext = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
            n.setUTCDate(Math.min(day, lastNext));
            return n;
        }
        return target;
    }

    /**
     * Record that a lifecycle stage ran. Returns false when once_key was
     * already taken, i.e. this step already happened — callers use that to
     * bail out instead of double-sending.
     */
    async function claimStage(leadId, stage, onceKey, extra = {}) {
        try {
            const r = await pool.query(
                `INSERT INTO lifecycle_events (lead_id, stage, entity_type, entity_id, once_key, channels, status, detail)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (once_key) DO NOTHING
                 RETURNING id`,
                [leadId, stage, extra.entityType || null, extra.entityId || null,
                 onceKey || null, extra.channels || null, extra.status || 'ok', extra.detail || null]
            );
            if (onceKey && r.rows.length === 0) {
                console.log(`[LIFECYCLE] ${stage} already done (${onceKey}) — skipping`);
                return false;
            }
            return true;
        } catch (e) {
            console.warn(`[LIFECYCLE] claimStage(${stage}) failed:`, e.message);
            // Fail open: a broken audit table must not stop the business flow.
            return true;
        }
    }

    async function adminNotify({ kind, title, body, leadId, entityType, entityId, severity = 'info', onceKey }) {
        try {
            await pool.query(
                `INSERT INTO admin_notifications (kind, title, body, lead_id, entity_type, entity_id, severity, once_key)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (once_key) DO NOTHING`,
                [kind, title, body || null, leadId || null, entityType || null, entityId || null, severity, onceKey || null]
            );
        } catch (e) {
            console.warn('[LIFECYCLE] adminNotify failed:', e.message);
        }
    }

    // ======================================================================
    // notify() — the only send path in this module
    // ======================================================================

    function shell(title, bodyHtml, cta) {
        return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141414;border-radius:12px;overflow:hidden">
  <tr><td style="padding:28px 32px 8px">
    <div style="font-size:12px;letter-spacing:1.5px;color:#10b981;text-transform:uppercase">Diamondback Coding</div>
    <h1 style="margin:12px 0 0;font-size:22px;line-height:1.3;color:#fff;font-weight:700">${title}</h1>
  </td></tr>
  <tr><td style="padding:8px 32px 24px;color:#b4b4b4;font-size:15px;line-height:1.65">${bodyHtml}</td></tr>
  ${cta ? `<tr><td style="padding:0 32px 32px"><a href="${cta.url}" style="display:inline-block;background:#10b981;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px">${cta.label}</a></td></tr>` : ''}
  <tr><td style="padding:20px 32px;background:#0f0f0f;color:#6b6b6b;font-size:12px;line-height:1.6">
    Diamondback Coding &middot; <a href="mailto:contact@diamondbackcoding.com" style="color:#10b981;text-decoration:none">contact@diamondbackcoding.com</a>
  </td></tr>
</table></td></tr></table></body></html>`;
    }

    /**
     * Send a transactional message on any combination of channels.
     *
     * Channels:
     *   email  — Brevo if keyed, else the nodemailer transporter
     *   sms    — Brevo transactional SMS
     *   portal — a client_messages row, which the customer portal shows. When
     *            `portalEmailPing` is set, the customer also gets a short
     *            "you have a message" email, which is what the spec asks for.
     *
     * Never touches lead scoring. See the firewall note in the header.
     */
    async function notify({
        leadId, lead, kind, subject, bodyHtml, smsText, cta,
        channels = ['email'], invoiceId = null, scheduleId = null,
        attachments = [], portalEmailPing = false,
    }) {
        if (!TRANSACTIONAL_TYPES.includes(kind)) {
            // Loud, because the consequence of a missing type is silent lead
            // heating — exactly the bug this module is supposed to prevent.
            console.error(`[LIFECYCLE] REFUSING to send unknown kind '${kind}'. ` +
                          'Add it to TRANSACTIONAL_TYPES or it will feed lead scoring.');
            return { ok: false, error: 'unknown_kind' };
        }

        if (!lead && leadId) {
            lead = (await pool.query(
                'SELECT id, name, email, phone FROM leads WHERE id=$1', [leadId]
            )).rows[0];
        }
        if (!lead) return { ok: false, error: 'no_lead' };
        leadId = lead.id;

        const results = {};
        const html = bodyHtml.trim().startsWith('<!DOCTYPE') ? bodyHtml : shell(subject, bodyHtml, cta);

        // ---- portal message ------------------------------------------------
        if (channels.includes('portal')) {
            try {
                const ins = await pool.query(
                    `INSERT INTO client_messages (lead_id, sender, kind, subject, body, invoice_id, read_by_admin, read_by_client)
                     VALUES ($1,'admin','billing',$2,$3,$4,TRUE,FALSE) RETURNING id`,
                    [leadId, subject, smsText || subject, invoiceId]
                );
                results.portal = { ok: true, id: ins.rows[0].id };
            } catch (e) {
                console.warn('[LIFECYCLE] portal message failed:', e.message);
                results.portal = { ok: false, error: e.message };
            }
        }

        // ---- email ---------------------------------------------------------
        if (channels.includes('email') && lead.email) {
            try {
                if (PLATFORM_BREVO_KEY && typeof sendViaBrevo === 'function') {
                    await sendViaBrevo(PLATFORM_BREVO_KEY, PLATFORM_SENDER_EMAIL, PLATFORM_SENDER_NAME,
                                       lead.email, subject, html, attachments);
                } else if (transporter) {
                    await transporter.sendMail({
                        to: lead.email, subject, html,
                        attachments: attachments && attachments.length ? attachments : undefined,
                    });
                } else {
                    throw new Error('no email transport configured');
                }
                results.email = { ok: true };
            } catch (e) {
                console.warn(`[LIFECYCLE] email '${kind}' failed:`, e.message);
                results.email = { ok: false, error: e.message };
            }
        }

        // ---- "you have a message" ping -------------------------------------
        // Deliberately content-free: the detail lives in the portal, the email
        // only says to go look. Counts as its own kind so it can be muted.
        if (portalEmailPing && lead.email && !channels.includes('email')) {
            try {
                const pingHtml = shell('You have a new message',
                    `<p style="margin:0 0 12px">There's a new message waiting in your customer portal.</p>
                     <p style="margin:0">Sign in to read it and reply.</p>`,
                    { url: PORTAL_URL, label: 'Open your portal' });
                if (PLATFORM_BREVO_KEY && typeof sendViaBrevo === 'function') {
                    await sendViaBrevo(PLATFORM_BREVO_KEY, PLATFORM_SENDER_EMAIL, PLATFORM_SENDER_NAME,
                                       lead.email, 'You have a new message in your portal', pingHtml);
                } else if (transporter) {
                    await transporter.sendMail({
                        to: lead.email,
                        subject: 'You have a new message in your portal',
                        html: pingHtml,
                    });
                }
                results.ping = { ok: true };
            } catch (e) {
                results.ping = { ok: false, error: e.message };
            }
        }

        // ---- sms -----------------------------------------------------------
        if (channels.includes('sms') && lead.phone && smsText) {
            try {
                const key = typeof getBrevoKey === 'function' ? await getBrevoKey() : PLATFORM_BREVO_KEY;
                if (!key) throw new Error('no Brevo key for SMS');
                await sendSmsViaBrevo(key, PLATFORM_SENDER_NAME.slice(0, 11), lead.phone, smsText);
                results.sms = { ok: true };
            } catch (e) {
                console.warn(`[LIFECYCLE] sms '${kind}' failed:`, e.message);
                results.sms = { ok: false, error: e.message };
            }
        }

        // ---- audit ---------------------------------------------------------
        // billing_notifications, NOT email_log — email_log is what the
        // follow-up and analytics queries read.
        try {
            for (const ch of Object.keys(results)) {
                await pool.query(
                    `INSERT INTO billing_notifications (lead_id, invoice_id, schedule_id, channel, kind, subject, body_preview, status, error)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                    [leadId, invoiceId, scheduleId, ch, kind, subject,
                     (smsText || subject || '').slice(0, 500),
                     results[ch].ok ? 'sent' : 'failed', results[ch].error || null]
                );
            }
        } catch (e) {
            console.warn('[LIFECYCLE] notification audit failed:', e.message);
        }

        return { ok: true, results };
    }

    // ======================================================================
    // Signature generation
    // ======================================================================

    /**
     * Build a handwriting-style signature from a typed name.
     *
     * The spec asks for "an automatic signature created for the platform", so
     * the customer types their name and the platform renders the mark. It is
     * deterministic per name — the same name always yields the same signature,
     * so a re-render of an old agreement doesn't produce a different squiggle.
     */
    function generateSignatureSVG(name) {
        const clean = String(name || '').trim().slice(0, 48) || 'Customer';
        // Deterministic seed from the name.
        let seed = 0;
        for (let i = 0; i < clean.length; i++) seed = (seed * 31 + clean.charCodeAt(i)) % 100000;
        const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

        const width = 420, height = 110, baseline = 74;
        // A flowing underline whose wobble is derived from the name.
        const pts = [];
        const segs = 26;
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            const x = 24 + t * (width - 60);
            const y = baseline + 12
                + Math.sin(t * Math.PI * 3 + rand() * 0.4) * 5
                + Math.sin(t * Math.PI * 7) * 1.6;
            pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        const escaped = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Signature of ${escaped}">
  <text x="28" y="${baseline}" font-family="'Segoe Script','Brush Script MT','Lucida Handwriting',cursive" font-size="40" fill="#111">${escaped}</text>
  <polyline points="${pts.join(' ')}" fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round" opacity="0.75"/>
</svg>`;
    }

    // ======================================================================
    // Invoice creation
    // ======================================================================

    async function nextInvoiceNumber(client = pool) {
        const r = await client.query(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(invoice_number,'\\D','','g'),'')::bigint),0)+1 AS n
               FROM invoices WHERE invoice_number LIKE 'INV-%'`
        );
        return `INV-${String(r.rows[0].n).padStart(5, '0')}`;
    }

    /**
     * Create an invoice. When `estimated` is true the due date is the
     * project's estimated completion and is flagged as subject to change —
     * the spec's "not due until xx.xx.xxxx, may change if we finish early".
     */
    async function createInvoice({
        leadId, amount, taxRate = 0, description, dueDate, estimated = false,
        agreementId = null, projectId = null, scheduleId = null,
        maintenancePlanId = null, autoGenerated = false, items = [],
    }) {
        const subtotal = Number(amount || 0);
        const taxAmount = +(subtotal * (Number(taxRate) || 0) / 100).toFixed(2);
        const total = +(subtotal + taxAmount).toFixed(2);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const number = await nextInvoiceNumber(client);
            const ins = await client.query(
                `INSERT INTO invoices
                    (invoice_number, lead_id, issue_date, due_date, subtotal, tax_rate, tax_amount,
                     total_amount, status, short_description, notes, agreement_id, project_id,
                     billing_schedule_id, maintenance_plan_id, auto_generated, due_date_estimated, created_at)
                 VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,'sent',$8,$9,$10,$11,$12,$13,$14,$15,NOW())
                 RETURNING *`,
                [number, leadId, dueDate, subtotal, taxRate, taxAmount, total,
                 (description || '').slice(0, 255), null, agreementId, projectId,
                 scheduleId, maintenancePlanId, autoGenerated, estimated]
            );
            const invoice = ins.rows[0];

            for (const [i, it] of (items || []).entries()) {
                await client.query(
                    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
                     VALUES ($1,$2,$3,$4,$5)`,
                    // invoice_items.quantity is INTEGER in this schema, so a
                    // NUMERIC 1.00 from agreement_items is rejected. Round it.
                    [invoice.id, (it.description || '').slice(0, 500),
                     Math.max(1, Math.round(Number(it.quantity) || 1)), it.unit_price || 0,
                     it.amount != null ? it.amount : (Number(it.quantity) || 1) * (Number(it.unit_price) || 0)]
                ).catch((e) => console.warn('[LIFECYCLE] invoice_item insert:', e.message));
            }

            await client.query('COMMIT');
            return invoice;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    // ======================================================================
    // Payment ledger
    // ======================================================================

    /**
     * Record a payment and, when it settles an invoice, mark that invoice paid
     * and clear its dunning state. Idempotent on the Stripe payment intent, so
     * a redelivered webhook cannot create a second ledger row.
     */
    async function recordPayment({
        leadId, invoiceId = null, maintenancePlanId = null, amount, kind = 'invoice',
        method = 'card', methodLast4 = null, methodBrand = null, description = null,
        stripePaymentIntentId = null, stripeChargeId = null, status = 'succeeded',
    }) {
        const receipt = `RCPT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;

        const ins = await pool.query(
            `INSERT INTO payments
                (lead_id, invoice_id, maintenance_plan_id, amount, method, method_last4, method_brand,
                 kind, description, status, stripe_payment_intent_id, stripe_charge_id, receipt_number, paid_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
             ON CONFLICT (stripe_payment_intent_id) DO NOTHING
             RETURNING *`,
            [leadId, invoiceId, maintenancePlanId, amount, method, methodLast4, methodBrand,
             kind, description, status, stripePaymentIntentId, stripeChargeId, receipt]
        );

        if (ins.rows.length === 0) {
            // Already recorded under this payment intent.
            const existing = await pool.query(
                'SELECT * FROM payments WHERE stripe_payment_intent_id=$1', [stripePaymentIntentId]
            );
            return { payment: existing.rows[0], created: false };
        }

        const payment = ins.rows[0];

        if (invoiceId && status === 'succeeded') {
            await pool.query(
                `UPDATE invoices
                    SET status='paid', paid_at=NOW(),
                        payment_method=$2, payment_reference=$3,
                        dunning_status='resolved', dunning_day=0,
                        updated_at=NOW()
                  WHERE id=$1`,
                [invoiceId, method, payment.receipt_number]
            );
        }

        return { payment, created: true };
    }

    async function issueRefund({ paymentId, amount, reason, adminId }) {
        const pRes = await pool.query('SELECT * FROM payments WHERE id=$1', [paymentId]);
        const payment = pRes.rows[0];
        if (!payment) throw new Error('Payment not found');

        const already = Number(payment.refunded_amount || 0);
        const refundable = Number(payment.amount) - already;
        const amt = Number(amount || refundable);
        if (amt <= 0) throw new Error('Refund amount must be greater than zero');
        if (amt > refundable + 0.001) {
            throw new Error(`Refund exceeds refundable balance of ${money(refundable)}`);
        }

        let stripeRefundId = null;
        if (stripe && payment.stripe_payment_intent_id) {
            const r = await stripe.refunds.create({
                payment_intent: payment.stripe_payment_intent_id,
                amount: Math.round(amt * 100),
                reason: 'requested_by_customer',
                metadata: { admin_reason: (reason || '').slice(0, 400) },
            });
            stripeRefundId = r.id;
        }

        const ins = await pool.query(
            `INSERT INTO refunds (payment_id, lead_id, amount, reason, issued_by, stripe_refund_id)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [paymentId, payment.lead_id, amt, reason || null, adminId || null, stripeRefundId]
        );

        const newTotal = already + amt;
        await pool.query(
            `UPDATE payments
                SET refunded_amount=$2,
                    status = CASE WHEN $2 >= amount THEN 'refunded' ELSE 'partially_refunded' END
              WHERE id=$1`,
            [paymentId, newTotal]
        );

        // A refunded invoice is no longer settled.
        if (payment.invoice_id && newTotal >= Number(payment.amount)) {
            await pool.query(
                `UPDATE invoices SET status='refunded', updated_at=NOW() WHERE id=$1`,
                [payment.invoice_id]
            );
        }

        const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1', [payment.lead_id])).rows[0];
        if (lead) {
            await notify({
                lead, kind: 'refund_issued',
                subject: `Refund issued — ${money(amt)}`,
                bodyHtml: `<p style="margin:0 0 12px">We've issued a refund of <strong style="color:#fff">${money(amt)}</strong> to your original payment method.</p>
                           ${reason ? `<p style="margin:0 0 12px">Reason: ${reason}</p>` : ''}
                           <p style="margin:0">Card refunds usually appear within 5–10 business days. Bank refunds can take a little longer.</p>`,
                smsText: `Diamondback Coding: a refund of ${money(amt)} has been issued to your original payment method.`,
                channels: ['email', 'portal'],
                cta: { url: PORTAL_URL, label: 'View payment history' },
            });
        }

        return ins.rows[0];
    }

    // ======================================================================
    // LIFECYCLE STAGES
    // ======================================================================

    /**
     * Lead -> customer. Creates the CUSTOMER PORTAL account and nothing else:
     * no client_companies row, no CRM seats, no is_company_admin. Compare
     * /api/admin/client-accounts, which built CRM scaffolding and left
     * portal_kind at 'crm' — that is the bug this replaces.
     */
    async function onCustomerCreated({ leadId, temporaryPassword, sendCredentials = true }) {
        const lead = (await pool.query(
            'SELECT id,name,email,phone,client_password,portal_kind FROM leads WHERE id=$1', [leadId]
        )).rows[0];
        if (!lead) throw new Error('Lead not found');

        const password = temporaryPassword
            || `DB${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 90 + 10)}`;
        const hash = await bcrypt.hash(password, 10);

        await pool.query(
            `UPDATE leads
                SET is_customer = TRUE,
                    customer_status = 'active',
                    client_password = COALESCE(client_password, $2),
                    -- 'both' when they already hold CRM access; never downgrade.
                    portal_kind = CASE WHEN COALESCE(crm_access,FALSE) THEN 'both' ELSE 'customer' END,
                    client_account_created_at = COALESCE(client_account_created_at, NOW()),
                    updated_at = NOW()
              WHERE id = $1`,
            [leadId, hash]
        );

        const first = !lead.client_password;
        if (!(await claimStage(leadId, 'customer_created', `customer_created:lead:${leadId}`,
                               { entityType: 'lead', entityId: leadId }))) {
            return { created: false, alreadyExisted: true };
        }

        if (sendCredentials && first) {
            await notify({
                lead, kind: 'portal_credentials',
                subject: 'Your Diamondback Coding customer portal is ready',
                bodyHtml: `<p style="margin:0 0 16px">Your customer portal account is set up. You can now see your agreements, invoices, project timeline and messages in one place, and pay online.</p>
                    <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#0f0f0f;border-radius:8px;padding:16px;width:100%">
                      <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Email</td><td style="padding:10px 16px;color:#fff;font-size:14px">${lead.email}</td></tr>
                      <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Temporary password</td><td style="padding:10px 16px;color:#10b981;font-size:15px;font-family:monospace">${password}</td></tr>
                    </table>
                    <p style="margin:0">Please change this password after your first sign-in.</p>`,
                smsText: `Diamondback Coding: your customer portal is ready. Sign in at ${PORTAL_URL}`,
                channels: ['email', 'sms'],
                cta: { url: PORTAL_URL, label: 'Sign in to your portal' },
            });
        }

        return { created: true, temporaryPassword: first ? password : null };
    }

    /**
     * Grant CRM access on top of an existing customer account. This is the
     * ONLY place client_companies scaffolding gets built.
     */
    async function onCrmSubscriptionActivated({ leadId, companyName, seats = 1 }) {
        const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
        if (!lead) throw new Error('Lead not found');

        let portalId = lead.client_portal_id;
        if (!portalId) {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            for (let attempt = 0; attempt < 20 && !portalId; attempt++) {
                const cand = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
                const clash = await pool.query('SELECT 1 FROM client_companies WHERE client_portal_id=$1', [cand]);
                if (clash.rows.length === 0) portalId = cand;
            }
            if (!portalId) throw new Error('Could not allocate a portal ID');
        }

        await pool.query(
            `INSERT INTO client_companies (client_portal_id, company_name, admin_email, admin_name,
                                           total_active_seats, purchased_seats, monthly_total, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$5,0,NOW(),NOW())
             ON CONFLICT (client_portal_id) DO NOTHING`,
            [portalId, companyName || lead.company || `${lead.name}'s Company`, lead.email, lead.name, seats]
        );

        await pool.query(
            `UPDATE leads
                SET client_portal_id = $2,
                    is_company_admin = TRUE,
                    crm_access = TRUE,
                    crm_access_at = COALESCE(crm_access_at, NOW()),
                    -- additive: they remain a customer
                    portal_kind = 'both',
                    updated_at = NOW()
              WHERE id = $1`,
            [leadId, portalId]
        );

        if (await claimStage(leadId, 'crm_activated', `crm_activated:lead:${leadId}`)) {
            await notify({
                lead, kind: 'crm_subscription_active',
                subject: 'Your CodeNexus CRM access is active',
                bodyHtml: `<p style="margin:0 0 12px">Your CodeNexus CRM subscription is active. You can sign in with the same email and password you already use for your customer portal.</p>
                           <p style="margin:0 0 12px">Your CRM workspace ID is <strong style="color:#10b981;font-family:monospace">${portalId}</strong>.</p>
                           <p style="margin:0">Your customer portal stays exactly where it is — this is in addition to it, not instead of it.</p>`,
                smsText: `Diamondback Coding: your CodeNexus CRM access is now active.`,
                channels: ['email', 'portal'],
                cta: { url: 'https://diamondbackcoding.com/client_portal.html', label: 'Open CodeNexus CRM' },
            });
        }

        return { clientPortalId: portalId };
    }

    /** Admin publishes an SLA to the customer's portal. */
    async function onAgreementSent({ agreementId }) {
        const a = (await pool.query('SELECT * FROM sales_agreements WHERE id=$1', [agreementId])).rows[0];
        if (!a) throw new Error('Agreement not found');
        if (!a.lead_id) throw new Error('Agreement has no customer attached');

        await pool.query(
            `UPDATE sales_agreements SET status='sent', sent_at=COALESCE(sent_at,NOW()), updated_at=NOW() WHERE id=$1`,
            [agreementId]
        );

        if (!(await claimStage(a.lead_id, 'sla_sent', `sla_sent:agreement:${agreementId}`,
                               { entityType: 'agreement', entityId: agreementId }))) {
            return { sent: false };
        }

        const total = await agreementTotal(agreementId, a);
        await notify({
            leadId: a.lead_id, kind: 'sla_ready_to_sign',
            subject: 'Your service agreement is ready to sign',
            bodyHtml: `<p style="margin:0 0 12px">Your service agreement${a.agreement_number ? ` (${a.agreement_number})` : ''} is in your customer portal and ready for signature.</p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;background:#0f0f0f;border-radius:8px">
                  ${a.package_name ? `<tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Service</td><td style="padding:10px 16px;color:#fff;font-size:14px">${a.package_name}</td></tr>` : ''}
                  <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Total</td><td style="padding:10px 16px;color:#10b981;font-size:16px;font-weight:700">${money(total)}</td></tr>
                  ${a.est_completion_date ? `<tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Estimated completion</td><td style="padding:10px 16px;color:#fff;font-size:14px">${prettyDate(a.est_completion_date)}</td></tr>` : ''}
                </table>
                <p style="margin:0">Sign in to review the full terms and sign.</p>`,
            smsText: `Diamondback Coding: your service agreement is ready to sign in your portal. You also have a new message there.`,
            channels: ['email', 'sms', 'portal'],
            portalEmailPing: false,
            cta: { url: PORTAL_URL, label: 'Review and sign' },
        });

        return { sent: true };
    }

    async function agreementTotal(agreementId, agreement = null) {
        const r = await pool.query(
            'SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS c FROM agreement_items WHERE agreement_id=$1',
            [agreementId]
        );
        if (Number(r.rows[0].c) > 0) return Number(r.rows[0].t);
        const a = agreement || (await pool.query('SELECT price FROM sales_agreements WHERE id=$1', [agreementId])).rows[0];
        return Number((a && a.price) || 0);
    }

    /**
     * Customer signs. This is the busiest stage: signature record, admin
     * assignment, invoice due at estimated completion, project timeline, and
     * the notifications for each — all once-guarded together so a
     * double-click cannot produce two invoices.
     */
    async function onAgreementSigned({ agreementId, signerName, ip, userAgent }) {
        const a = (await pool.query('SELECT * FROM sales_agreements WHERE id=$1', [agreementId])).rows[0];
        if (!a) throw new Error('Agreement not found');

        if (!(await claimStage(a.lead_id, 'sla_signed', `sla_signed:agreement:${agreementId}`,
                               { entityType: 'agreement', entityId: agreementId }))) {
            return { signed: false, alreadySigned: true };
        }

        const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [a.lead_id])).rows[0];
        const name = signerName || a.customer_name || (lead && lead.name) || 'Customer';
        const svg = generateSignatureSVG(name);

        await pool.query(
            `INSERT INTO agreement_signatures
                (agreement_id, lead_id, signer_name, signer_email, typed_name, signature_svg,
                 ip_address, user_agent, consent_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (agreement_id) DO NOTHING`,
            [agreementId, a.lead_id, name, (lead && lead.email) || a.customer_email, name, svg,
             (ip || '').slice(0, 64), (userAgent || '').slice(0, 500),
             'By typing my name I agree to the terms of this agreement and consent to sign electronically.']
        );

        await pool.query(
            `UPDATE sales_agreements
                SET status='signed', signed_at=NOW(), signature_name=$2, updated_at=NOW()
              WHERE id=$1`,
            [agreementId, name]
        );

        // ---- assign an admin ------------------------------------------------
        // Least-loaded active admin, so assignment doesn't pile onto one person.
        let assignedAdmin = null;
        try {
            const pick = await pool.query(
                // admin_users has no is_active column in this schema, so every
                // admin is eligible. Least-loaded wins, ties broken by id so
                // assignment is deterministic.
                `SELECT au.id, au.username, au.email
                   FROM admin_users au
                   LEFT JOIN leads l ON l.assigned_admin_id = au.id
                  GROUP BY au.id, au.username, au.email
                  ORDER BY COUNT(l.id) ASC, au.id ASC
                  LIMIT 1`
            );
            assignedAdmin = pick.rows[0] || null;
        } catch (e) {
            console.warn('[LIFECYCLE] admin assignment lookup failed:', e.message);
        }
        if (assignedAdmin) {
            await pool.query(
                `UPDATE leads SET assigned_admin_id=$2, assigned_admin_at=NOW(), updated_at=NOW() WHERE id=$1`,
                [a.lead_id, assignedAdmin.id]
            );
        }

        // ---- project timeline -----------------------------------------------
        const projRes = await pool.query(
            `INSERT INTO client_projects
                (lead_id, project_name, description, start_date, end_date, est_completion_date,
                 status, agreement_id, assigned_admin_id, created_at, updated_at)
             VALUES ($1,$2,$3,CURRENT_DATE,$4,$4,'in_progress',$5,$6,NOW(),NOW())
             RETURNING *`,
            [a.lead_id,
             a.package_name || a.project || 'Project',
             a.intro || a.notes || null,
             a.est_completion_date || null,
             agreementId,
             assignedAdmin ? assignedAdmin.id : null]
        );
        const project = projRes.rows[0];

        // Seed milestones from the agreement's line items, so the customer sees
        // a timeline that matches what they just signed.
        const items = (await pool.query(
            'SELECT * FROM agreement_items WHERE agreement_id=$1 ORDER BY sort_order, id', [agreementId]
        )).rows;
        for (const [i, it] of items.entries()) {
            await pool.query(
                `INSERT INTO project_milestones (project_id, title, description, order_index, status)
                 VALUES ($1,$2,$3,$4,'pending')`,
                [project.id, it.description.slice(0, 500), it.detail || null, i]
            ).catch((e) => console.warn('[LIFECYCLE] milestone seed:', e.message));
        }

        await pool.query('UPDATE sales_agreements SET project_id=$2 WHERE id=$1', [agreementId, project.id]);

        // ---- invoice, due at estimated completion ---------------------------
        const total = await agreementTotal(agreementId, a);
        const dueDate = a.est_completion_date
            || dateOnly(new Date(Date.now() + (Number(a.net_days) || 14) * 86400000));

        const invoice = await createInvoice({
            leadId: a.lead_id,
            amount: total,
            taxRate: a.tax_rate || 0,
            description: `${a.package_name || 'Project'}${a.agreement_number ? ` — ${a.agreement_number}` : ''}`,
            dueDate,
            estimated: !!a.est_completion_date,
            agreementId,
            projectId: project.id,
            items: items.map((it) => ({
                description: it.description, quantity: it.quantity,
                unit_price: it.unit_price, amount: it.amount,
            })),
        });

        await pool.query(
            'UPDATE sales_agreements SET invoice_id=$2, invoiced_at=NOW() WHERE id=$1',
            [agreementId, invoice.id]
        );
        await pool.query('UPDATE client_projects SET invoice_id=$2 WHERE id=$1', [project.id, invoice.id]);

        // ---- notifications --------------------------------------------------
        await notify({
            lead, kind: 'sla_signed',
            subject: 'Your agreement is signed — here\'s what happens next',
            bodyHtml: `<p style="margin:0 0 12px">Thank you for signing${a.agreement_number ? ` agreement ${a.agreement_number}` : ''}. A signed copy is in your portal.</p>
                ${assignedAdmin ? `<p style="margin:0 0 12px"><strong style="color:#fff">${assignedAdmin.username || 'Your project lead'}</strong> is assigned to your project and will reach out soon.</p>` : ''}
                <p style="margin:0 0 12px">Your project timeline is now in your portal, and it updates as we hit each milestone.</p>
                <p style="margin:0">We've also created invoice <strong style="color:#fff">${invoice.invoice_number}</strong> for ${money(invoice.total_amount)}. It isn't due until <strong style="color:#10b981">${prettyDate(dueDate)}</strong>${a.est_completion_date ? ' — the estimated completion date. If we finish sooner, that date may move up and we\'ll tell you first.' : '.'}</p>`,
            smsText: `Diamondback Coding: your agreement is signed. Invoice ${invoice.invoice_number} (${money(invoice.total_amount)}) is in your portal, due ${prettyDate(dueDate)}.`,
            channels: ['email', 'sms', 'portal'],
            invoiceId: invoice.id,
            cta: { url: PORTAL_URL, label: 'View your project' },
        });

        await adminNotify({
            kind: 'sla_signed',
            title: `${lead.name} signed ${a.agreement_number || 'an agreement'}`,
            body: `${money(total)} · invoice ${invoice.invoice_number} due ${prettyDate(dueDate)}${assignedAdmin ? ` · assigned to ${assignedAdmin.username}` : ''}`,
            leadId: a.lead_id, entityType: 'agreement', entityId: agreementId,
            severity: 'success', onceKey: `sla_signed_admin:${agreementId}`,
        });

        return { signed: true, invoice, project, assignedAdmin, signatureSvg: svg };
    }

    /** A milestone is completed — tell the customer once. */
    async function onMilestoneCompleted({ milestoneId }) {
        const m = (await pool.query(
            `SELECT pm.*, cp.lead_id, cp.project_name
               FROM project_milestones pm
               JOIN client_projects cp ON cp.id = pm.project_id
              WHERE pm.id = $1`, [milestoneId]
        )).rows[0];
        if (!m) throw new Error('Milestone not found');

        if (!(await claimStage(m.lead_id, 'milestone_completed', `milestone_completed:${milestoneId}`,
                               { entityType: 'milestone', entityId: milestoneId }))) {
            return { notified: false };
        }

        await pool.query(
            `UPDATE project_milestones SET status='completed', completed_at=COALESCE(completed_at,NOW()), notified_at=NOW() WHERE id=$1`,
            [milestoneId]
        );

        const counts = await pool.query(
            `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='completed') AS done
               FROM project_milestones WHERE project_id=$1`, [m.project_id]
        );
        const { total, done } = counts.rows[0];

        await notify({
            leadId: m.lead_id, kind: 'milestone_completed',
            subject: `Milestone complete: ${m.title}`,
            bodyHtml: `<p style="margin:0 0 12px">We've completed <strong style="color:#fff">${m.title}</strong> on ${m.project_name}.</p>
                       <p style="margin:0 0 12px">That's ${done} of ${total} milestones done.</p>
                       <p style="margin:0">Your timeline in the portal has the latest detail.</p>`,
            smsText: `Diamondback Coding: milestone complete — ${m.title} (${done}/${total}).`,
            channels: ['email', 'portal'],
            cta: { url: PORTAL_URL, label: 'View timeline' },
        });

        return { notified: true, done: Number(done), total: Number(total) };
    }

    /**
     * Project complete. Firms up the invoice due date (the "subject to change"
     * promise), then sends the completion and invoice-due messages.
     */
    async function onProjectCompleted({ projectId, dueInDays = 7 }) {
        const p = (await pool.query('SELECT * FROM client_projects WHERE id=$1', [projectId])).rows[0];
        if (!p) throw new Error('Project not found');

        if (!(await claimStage(p.lead_id, 'project_completed', `project_completed:${projectId}`,
                               { entityType: 'project', entityId: projectId }))) {
            return { notified: false };
        }

        await pool.query(
            `UPDATE client_projects
                SET status='completed', completed_at=NOW(), completion_notified_at=NOW(), updated_at=NOW()
              WHERE id=$1`, [projectId]
        );
        await pool.query(
            `UPDATE project_milestones SET status='completed', completed_at=COALESCE(completed_at,NOW())
              WHERE project_id=$1 AND status<>'completed'`, [projectId]
        );

        let invoice = null;
        if (p.invoice_id) {
            // Finishing early moves the due date in; never push it out past the
            // original estimate, which the customer already planned around.
            const newDue = dateOnly(new Date(Date.now() + dueInDays * 86400000));
            const upd = await pool.query(
                `UPDATE invoices
                    SET due_date = LEAST($2::date, COALESCE(due_date, $2::date)),
                        due_date_estimated = FALSE,
                        updated_at = NOW()
                  WHERE id=$1 AND status NOT IN ('paid','refunded','void','cancelled')
                  RETURNING *`,
                [p.invoice_id, newDue]
            );
            invoice = upd.rows[0]
                || (await pool.query('SELECT * FROM invoices WHERE id=$1', [p.invoice_id])).rows[0];
        }

        const paid = invoice && invoice.status === 'paid';
        await notify({
            leadId: p.lead_id, kind: 'project_completed',
            subject: `${p.project_name} is complete`,
            bodyHtml: `<p style="margin:0 0 12px">Your project <strong style="color:#fff">${p.project_name}</strong> is complete. Every milestone is marked done in your portal.</p>
                ${invoice && !paid ? `<p style="margin:0 0 12px">Invoice <strong style="color:#fff">${invoice.invoice_number}</strong> for ${money(invoice.total_amount)} is now due <strong style="color:#10b981">${prettyDate(invoice.due_date)}</strong>. You can pay it in your portal.</p>` : ''}
                <p style="margin:0">Thank you for your business — reply to this email if anything needs a second look.</p>`,
            smsText: `Diamondback Coding: ${p.project_name} is complete.${invoice && !paid ? ` Invoice ${invoice.invoice_number} (${money(invoice.total_amount)}) is due ${prettyDate(invoice.due_date)} — pay in your portal.` : ''}`,
            channels: ['email', 'sms', 'portal'],
            invoiceId: invoice ? invoice.id : null,
            cta: { url: PORTAL_URL, label: invoice && !paid ? 'Pay your invoice' : 'View your project' },
        });

        // Separate invoice-due message, as specified.
        if (invoice && !paid) {
            await notify({
                leadId: p.lead_id, kind: 'invoice_due',
                subject: `Invoice ${invoice.invoice_number} is due ${prettyDate(invoice.due_date)}`,
                bodyHtml: `<p style="margin:0 0 12px">Invoice <strong style="color:#fff">${invoice.invoice_number}</strong> for <strong style="color:#10b981">${money(invoice.total_amount)}</strong> is due on ${prettyDate(invoice.due_date)}.</p>
                           <p style="margin:0">You can pay by card or bank transfer in your portal.</p>`,
                smsText: null,
                channels: ['email'],
                invoiceId: invoice.id,
                cta: { url: PORTAL_URL, label: 'Pay now' },
            });
        }

        return { notified: true, invoice };
    }

    /** Payment received — receipt by email, SMS, and into the portal. */
    async function onPaymentReceived({ paymentId }) {
        const p = (await pool.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
        if (!p) throw new Error('Payment not found');
        if (p.notified_at) return { notified: false, reason: 'already notified' };

        const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1', [p.lead_id])).rows[0];
        const invoice = p.invoice_id
            ? (await pool.query('SELECT * FROM invoices WHERE id=$1', [p.invoice_id])).rows[0]
            : null;

        const outstanding = await pool.query(
            `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS amt
               FROM invoices
              WHERE lead_id=$1 AND status NOT IN ('paid','void','cancelled','refunded','draft')`,
            [p.lead_id]
        );
        const owing = Number(outstanding.rows[0].n);

        await notify({
            lead, kind: 'invoice_paid',
            subject: invoice ? `Payment received — ${invoice.invoice_number}` : 'Payment received',
            bodyHtml: `<p style="margin:0 0 16px">We've received your payment. Thank you.</p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;background:#0f0f0f;border-radius:8px">
                  <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Amount</td><td style="padding:10px 16px;color:#10b981;font-size:17px;font-weight:700">${money(p.amount)}</td></tr>
                  <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Receipt</td><td style="padding:10px 16px;color:#fff;font-family:monospace;font-size:13px">${p.receipt_number}</td></tr>
                  ${invoice ? `<tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Invoice</td><td style="padding:10px 16px;color:#fff;font-size:14px">${invoice.invoice_number}</td></tr>` : ''}
                  ${p.method_last4 ? `<tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Method</td><td style="padding:10px 16px;color:#fff;font-size:14px">${p.method_brand || p.method} ending ${p.method_last4}</td></tr>` : ''}
                </table>
                <p style="margin:0">${owing === 0 ? 'You have no outstanding invoices.' : `You have ${owing} invoice${owing === 1 ? '' : 's'} still open — you can see them in your portal.`}</p>`,
            smsText: `Diamondback Coding: payment of ${money(p.amount)} received. Receipt ${p.receipt_number} is in your portal.${owing === 0 ? ' No outstanding invoices.' : ''}`,
            channels: ['email', 'sms', 'portal'],
            invoiceId: p.invoice_id,
            cta: { url: PORTAL_URL, label: 'View receipt' },
        });

        await pool.query('UPDATE payments SET notified_at=NOW() WHERE id=$1', [paymentId]);
        await claimStage(p.lead_id, 'payment_received', `payment_notified:${paymentId}`,
                         { entityType: 'payment', entityId: paymentId });

        return { notified: true, outstandingInvoices: owing };
    }

    // ======================================================================
    // Maintenance plans
    // ======================================================================

    /**
     * Charge one due maintenance plan. Autopay, so by default no invoice is
     * created — the customer gets a receipt, not a bill to act on. Set
     * generate_invoice on the plan to produce a document anyway.
     */
    async function chargeMaintenancePlan(plan) {
        const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [plan.lead_id])).rows[0];
        if (!lead) return { ok: false, error: 'lead missing' };

        const pm = plan.payment_method_id
            ? (await pool.query('SELECT * FROM payment_methods WHERE id=$1', [plan.payment_method_id])).rows[0]
            : (await pool.query(
                `SELECT * FROM payment_methods WHERE lead_id=$1 AND status='active'
                  ORDER BY is_default DESC, id DESC LIMIT 1`, [plan.lead_id])).rows[0];

        if (!pm) {
            await pool.query(
                `UPDATE maintenance_plans SET status='pending_payment_method', updated_at=NOW() WHERE id=$1`,
                [plan.id]
            );
            await adminNotify({
                kind: 'maintenance_no_method',
                title: `${lead.name}: no payment method for ${plan.label}`,
                body: 'The plan is paused until a card or bank account is added.',
                leadId: plan.lead_id, entityType: 'maintenance_plan', entityId: plan.id,
                severity: 'warning', onceKey: `no_method:${plan.id}:${dateOnly(new Date())}`,
            });
            return { ok: false, error: 'no payment method' };
        }

        let intent = null;
        try {
            intent = await stripe.paymentIntents.create({
                amount: Math.round(Number(plan.amount) * 100),
                currency: 'usd',
                customer: pm.stripe_customer_id || lead.stripe_customer_id,
                payment_method: pm.stripe_pm_id,
                // off_session + confirm is what makes this a true auto-charge:
                // no customer present, no 3DS prompt unless the bank forces one.
                off_session: true,
                confirm: true,
                description: `${plan.label} — ${prettyDate(new Date())}`,
                metadata: {
                    lead_id: String(plan.lead_id),
                    maintenance_plan_id: String(plan.id),
                    plan_type: plan.plan_type,
                },
            });
        } catch (e) {
            const failures = Number(plan.consecutive_failures || 0) + 1;
            await pool.query(
                `UPDATE maintenance_plans
                    SET consecutive_failures=$2,
                        status = CASE WHEN $2 >= 3 THEN 'past_due' ELSE status END,
                        updated_at=NOW()
                  WHERE id=$1`, [plan.id, failures]
            );
            await notify({
                lead, kind: 'maintenance_charge_failed',
                subject: `We couldn't process your ${plan.label} payment`,
                bodyHtml: `<p style="margin:0 0 12px">We tried to charge ${money(plan.amount)} for <strong style="color:#fff">${plan.label}</strong> and it didn't go through.</p>
                           <p style="margin:0 0 12px">${e.message}</p>
                           <p style="margin:0">Please update your payment method in your portal — we'll retry automatically.</p>`,
                smsText: `Diamondback Coding: your ${plan.label} payment of ${money(plan.amount)} didn't go through. Please update your payment method in your portal.`,
                channels: ['email', 'sms', 'portal'],
            });
            await adminNotify({
                kind: 'maintenance_charge_failed',
                title: `Charge failed: ${lead.name} — ${plan.label}`,
                body: `${money(plan.amount)} · attempt ${failures} · ${e.message}`,
                leadId: plan.lead_id, entityType: 'maintenance_plan', entityId: plan.id,
                severity: failures >= 3 ? 'error' : 'warning',
                onceKey: `charge_failed:${plan.id}:${dateOnly(new Date())}`,
            });
            return { ok: false, error: e.message };
        }

        let invoice = null;
        if (plan.generate_invoice) {
            invoice = await createInvoice({
                leadId: plan.lead_id, amount: plan.amount,
                description: plan.label, dueDate: dateOnly(new Date()),
                maintenancePlanId: plan.id, autoGenerated: true,
            }).catch((e) => { console.warn('[LIFECYCLE] maintenance invoice:', e.message); return null; });
        }

        const { payment } = await recordPayment({
            leadId: plan.lead_id,
            invoiceId: invoice ? invoice.id : null,
            maintenancePlanId: plan.id,
            amount: plan.amount,
            kind: 'maintenance',
            method: pm.type, methodLast4: pm.last4, methodBrand: pm.brand || pm.bank_name,
            description: plan.label,
            stripePaymentIntentId: intent.id,
            stripeChargeId: intent.latest_charge || null,
        });

        const next = nextBillingDate(plan.billing_day, new Date());
        await pool.query(
            `UPDATE maintenance_plans
                SET last_charge_date=CURRENT_DATE, next_charge_date=$2,
                    charges_completed=COALESCE(charges_completed,0)+1,
                    consecutive_failures=0, last_payment_id=$3,
                    status = CASE WHEN status='past_due' THEN 'active' ELSE status END,
                    updated_at=NOW()
              WHERE id=$1`,
            [plan.id, dateOnly(next), payment.id]
        );

        await notify({
            lead, kind: 'maintenance_charged',
            subject: `${plan.label} — payment received (${money(plan.amount)})`,
            bodyHtml: `<p style="margin:0 0 16px">Your ${plan.label} payment has been processed. Here's your receipt.</p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;background:#0f0f0f;border-radius:8px">
                  <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Amount</td><td style="padding:10px 16px;color:#10b981;font-size:17px;font-weight:700">${money(plan.amount)}</td></tr>
                  <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Receipt</td><td style="padding:10px 16px;color:#fff;font-family:monospace;font-size:13px">${payment.receipt_number}</td></tr>
                  <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Method</td><td style="padding:10px 16px;color:#fff;font-size:14px">${pm.brand || pm.bank_name || pm.type} ending ${pm.last4 || '----'}</td></tr>
                  <tr><td style="padding:10px 16px;color:#6b6b6b;font-size:13px">Next payment</td><td style="padding:10px 16px;color:#fff;font-size:14px">${prettyDate(next)}</td></tr>
                </table>
                <p style="margin:0">Your full payment history is in your portal. You can cancel anytime there — cancellation takes effect ${CANCELLATION_NOTICE_DAYS} days after you request it.</p>`,
            smsText: `Diamondback Coding: ${plan.label} payment of ${money(plan.amount)} processed. Receipt ${payment.receipt_number}. Next payment ${prettyDate(next)}.`,
            channels: ['email', 'sms', 'portal'],
            invoiceId: invoice ? invoice.id : null,
            cta: { url: PORTAL_URL, label: 'View payment history' },
        });

        await pool.query('UPDATE payments SET notified_at=NOW() WHERE id=$1', [payment.id]);
        return { ok: true, payment, invoice, nextChargeDate: next };
    }

    /**
     * Customer requests cancellation. 30-day notice: billing continues until
     * effective_at, they can reinstate until then, and the admin portal is told.
     */
    async function requestPlanCancellation({ planId, leadId, reason, requestedBy = 'customer' }) {
        const plan = (await pool.query(
            'SELECT * FROM maintenance_plans WHERE id=$1 AND lead_id=$2', [planId, leadId]
        )).rows[0];
        if (!plan) throw new Error('Plan not found');
        if (plan.status === 'cancelled') throw new Error('This plan is already cancelled');

        const existing = await pool.query(
            `SELECT * FROM plan_cancellations WHERE maintenance_plan_id=$1 AND status='pending'`, [planId]
        );
        if (existing.rows.length) {
            return { alreadyPending: true, cancellation: existing.rows[0] };
        }

        const effective = new Date(Date.now() + CANCELLATION_NOTICE_DAYS * 86400000);
        const ins = await pool.query(
            `INSERT INTO plan_cancellations
                (maintenance_plan_id, lead_id, effective_at, notice_days, requested_by, reason, status, confirmation_sent_at)
             VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW())
             RETURNING *`,
            [planId, leadId, effective, CANCELLATION_NOTICE_DAYS, requestedBy, reason || null]
        );
        const cancellation = ins.rows[0];

        await pool.query(
            `UPDATE maintenance_plans SET status='pending_cancellation', updated_at=NOW() WHERE id=$1`, [planId]
        );

        const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1', [leadId])).rows[0];
        await notify({
            lead, kind: 'cancellation_confirmed',
            subject: `Cancellation confirmed — ${plan.label}`,
            bodyHtml: `<p style="margin:0 0 12px">We've received your cancellation request for <strong style="color:#fff">${plan.label}</strong>.</p>
                <p style="margin:0 0 12px">Your plan has a ${CANCELLATION_NOTICE_DAYS}-day notice period, so it stays active until <strong style="color:#10b981">${prettyDate(effective)}</strong>. You'll keep full service until then.</p>
                <p style="margin:0">Changed your mind? You can reinstate the plan from your portal any time before that date.</p>`,
            smsText: `Diamondback Coding: cancellation confirmed for ${plan.label}. Service continues until ${prettyDate(effective)}. You can reinstate in your portal before then.`,
            channels: ['email', 'sms', 'portal'],
            cta: { url: PORTAL_URL, label: 'Manage your plan' },
        });

        await adminNotify({
            kind: 'plan_cancellation_requested',
            title: `${lead.name} is cancelling ${plan.label}`,
            body: `Cancels in ${CANCELLATION_NOTICE_DAYS} days, on ${prettyDate(effective)}. ${money(plan.amount)}/mo.${reason ? ` Reason: ${reason}` : ''}`,
            leadId, entityType: 'maintenance_plan', entityId: planId,
            severity: 'warning', onceKey: `cancel_requested:${cancellation.id}`,
        });

        await claimStage(leadId, 'cancellation_requested', `cancel_requested:${cancellation.id}`,
                         { entityType: 'maintenance_plan', entityId: planId });

        return { cancellation, effectiveAt: effective };
    }

    async function reinstatePlan({ planId, leadId }) {
        const c = (await pool.query(
            `SELECT * FROM plan_cancellations
              WHERE maintenance_plan_id=$1 AND lead_id=$2 AND status='pending'`, [planId, leadId]
        )).rows[0];
        if (!c) throw new Error('No pending cancellation to reinstate');

        await pool.query(
            `UPDATE plan_cancellations SET status='reinstated', reinstated_at=NOW() WHERE id=$1`, [c.id]
        );
        await pool.query(
            `UPDATE maintenance_plans SET status='active', updated_at=NOW() WHERE id=$1`, [planId]
        );

        const plan = (await pool.query('SELECT * FROM maintenance_plans WHERE id=$1', [planId])).rows[0];
        const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1', [leadId])).rows[0];

        await notify({
            lead, kind: 'cancellation_confirmed',
            subject: `${plan.label} is reinstated`,
            bodyHtml: `<p style="margin:0 0 12px">Good news — <strong style="color:#fff">${plan.label}</strong> is reinstated and will continue as normal.</p>
                       <p style="margin:0">Your next payment is ${prettyDate(plan.next_charge_date)}.</p>`,
            smsText: `Diamondback Coding: ${plan.label} is reinstated. Next payment ${prettyDate(plan.next_charge_date)}.`,
            channels: ['email', 'portal'],
            cta: { url: PORTAL_URL, label: 'View your plan' },
        });

        await adminNotify({
            kind: 'plan_reinstated',
            title: `${lead.name} reinstated ${plan.label}`,
            leadId, entityType: 'maintenance_plan', entityId: planId,
            severity: 'success', onceKey: `reinstated:${c.id}`,
        });

        return { reinstated: true };
    }

    // ======================================================================
    // Schedulers
    // ======================================================================

    /** Charge every maintenance plan due today. */
    async function runMaintenanceCharges() {
        const due = await pool.query(
            `SELECT * FROM maintenance_plans
              WHERE status IN ('active','pending_cancellation')
                AND next_charge_date IS NOT NULL
                AND next_charge_date <= CURRENT_DATE
              ORDER BY id`
        );
        const results = [];
        for (const plan of due.rows) {
            // A plan in notice period stops billing once the notice expires.
            const c = await pool.query(
                `SELECT effective_at FROM plan_cancellations
                  WHERE maintenance_plan_id=$1 AND status='pending'`, [plan.id]
            );
            if (c.rows.length && new Date(c.rows[0].effective_at) <= new Date()) {
                continue; // completePlanCancellations() handles it
            }
            try {
                results.push({ planId: plan.id, ...(await chargeMaintenancePlan(plan)) });
            } catch (e) {
                console.error(`[LIFECYCLE] charge plan ${plan.id} failed:`, e.message);
                results.push({ planId: plan.id, ok: false, error: e.message });
            }
        }
        if (results.length) console.log(`[LIFECYCLE] maintenance charges: ${results.length} processed`);
        return results;
    }

    /** "You have N days left to reinstate" emails during the notice period. */
    async function runCancellationReminders() {
        const MILESTONES = [21, 14, 7, 3, 1];
        const pending = await pool.query(
            `SELECT pc.*, mp.label, mp.amount, l.name, l.email, l.phone
               FROM plan_cancellations pc
               JOIN maintenance_plans mp ON mp.id = pc.maintenance_plan_id
               JOIN leads l ON l.id = pc.lead_id
              WHERE pc.status='pending'`
        );
        let sent = 0;
        for (const c of pending.rows) {
            const daysLeft = Math.ceil((new Date(c.effective_at) - Date.now()) / 86400000);
            if (daysLeft <= 0) continue;
            const hit = MILESTONES.find((m) => m === daysLeft);
            if (!hit) continue;
            if ((c.reminders_sent || []).includes(hit)) continue;

            await notify({
                lead: { id: c.lead_id, name: c.name, email: c.email, phone: c.phone },
                kind: 'cancellation_reminder',
                subject: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left to reinstate ${c.label}`,
                bodyHtml: `<p style="margin:0 0 12px"><strong style="color:#fff">${c.label}</strong> is scheduled to cancel on <strong style="color:#10b981">${prettyDate(c.effective_at)}</strong> — that's ${daysLeft} day${daysLeft === 1 ? '' : 's'} away.</p>
                           <p style="margin:0 0 12px">If you'd like to keep it, you can reinstate from your portal and nothing changes.</p>
                           <p style="margin:0">If not, no action is needed and it'll end on that date.</p>`,
                smsText: `Diamondback Coding: ${c.label} cancels in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Reinstate anytime in your portal.`,
                channels: daysLeft <= 3 ? ['email', 'sms', 'portal'] : ['email', 'portal'],
                cta: { url: PORTAL_URL, label: 'Reinstate my plan' },
            });

            await pool.query(
                `UPDATE plan_cancellations SET reminders_sent = array_append(reminders_sent, $2) WHERE id=$1`,
                [c.id, hit]
            );
            sent++;
        }
        if (sent) console.log(`[LIFECYCLE] cancellation reminders sent: ${sent}`);
        return { sent };
    }

    /** Finalize cancellations whose notice period has expired. */
    async function completePlanCancellations() {
        const due = await pool.query(
            `SELECT pc.*, mp.label, mp.amount, mp.stripe_subscription_id, l.name, l.email, l.phone
               FROM plan_cancellations pc
               JOIN maintenance_plans mp ON mp.id = pc.maintenance_plan_id
               JOIN leads l ON l.id = pc.lead_id
              WHERE pc.status='pending' AND pc.effective_at <= NOW()`
        );
        let done = 0;
        for (const c of due.rows) {
            if (c.stripe_subscription_id && stripe) {
                await stripe.subscriptions.cancel(c.stripe_subscription_id)
                    .catch((e) => console.warn('[LIFECYCLE] stripe sub cancel:', e.message));
            }
            await pool.query(
                `UPDATE maintenance_plans SET status='cancelled', next_charge_date=NULL, updated_at=NOW() WHERE id=$1`,
                [c.maintenance_plan_id]
            );
            await pool.query(
                `UPDATE plan_cancellations SET status='completed', completed_at=NOW(), cancelled_email_sent_at=NOW() WHERE id=$1`,
                [c.id]
            );

            await notify({
                lead: { id: c.lead_id, name: c.name, email: c.email, phone: c.phone },
                kind: 'cancellation_completed',
                subject: `${c.label} has been cancelled`,
                bodyHtml: `<p style="margin:0 0 12px"><strong style="color:#fff">${c.label}</strong> is now cancelled. You won't be billed again.</p>
                           <p style="margin:0 0 12px">Your portal account stays open, and your invoices, receipts and payment history remain available there.</p>
                           <p style="margin:0">If you'd like to restart this service later, just reply to this email.</p>`,
                smsText: `Diamondback Coding: ${c.label} is now cancelled. No further billing. Your portal and receipts stay available.`,
                channels: ['email', 'sms', 'portal'],
                cta: { url: PORTAL_URL, label: 'Open your portal' },
            });

            await adminNotify({
                kind: 'plan_cancelled',
                title: `${c.name}'s ${c.label} has cancelled`,
                body: `${money(c.amount)}/mo ended ${prettyDate(c.effective_at)}`,
                leadId: c.lead_id, entityType: 'maintenance_plan', entityId: c.maintenance_plan_id,
                severity: 'info', onceKey: `cancel_completed:${c.id}`,
            });
            done++;
        }
        if (done) console.log(`[LIFECYCLE] cancellations completed: ${done}`);
        return { completed: done };
    }

    /** All daily jobs. Call from a cron route or an interval. */
    async function runDailyJobs() {
        const out = {};
        try { out.charges = await runMaintenanceCharges(); } catch (e) { out.chargesError = e.message; }
        try { out.reminders = await runCancellationReminders(); } catch (e) { out.remindersError = e.message; }
        try { out.cancellations = await completePlanCancellations(); } catch (e) { out.cancellationsError = e.message; }
        // Dunning last: a maintenance charge earlier in this same run may have
        // just settled an invoice, and there's no sense dunning something that
        // was paid ninety seconds ago.
        try { out.dunning = await runDunning(); } catch (e) { out.dunningError = e.message; }
        return out;
    }

    // ======================================================================
    // Dunning — the 10-day past-due ladder
    // ======================================================================

    // What goes out on each day past due. Every day sends an email AND an
    // in-portal message; the portal message triggers its own "you have a
    // message" email, per the spec. SMS is reserved for the days that matter
    // so the customer isn't texted ten times about one invoice.
    const DUNNING_LADDER = {
        1:  { sms: false, tone: 'gentle' },
        2:  { sms: false, tone: 'gentle' },
        3:  { sms: true,  tone: 'gentle' },
        4:  { sms: false, tone: 'firm' },
        5:  { sms: false, tone: 'firm' },
        6:  { sms: false, tone: 'firm' },
        7:  { sms: true,  tone: 'firm' },
        8:  { sms: false, tone: 'final' },
        9:  { sms: false, tone: 'final' },
        10: { sms: true,  tone: 'final' },
    };
    const DUNNING_MAX_DAY = 10;

    function dunningCopy(tone, invoice, daysOverdue) {
        const amt = money(invoice.total_amount);
        const num = invoice.invoice_number;
        if (tone === 'gentle') {
            return {
                subject: `Invoice ${num} is past due`,
                html: `<p style="margin:0 0 12px">Invoice <strong style="color:#fff">${num}</strong> for <strong style="color:#10b981">${amt}</strong> was due on ${prettyDate(invoice.due_date)} and is now ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} past due.</p>
                       <p style="margin:0 0 12px">If you've already sent payment, thank you — you can ignore this.</p>
                       <p style="margin:0">Otherwise you can pay by card or bank transfer in your portal.</p>`,
                sms: `Diamondback Coding: invoice ${num} (${amt}) is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} past due. Pay in your portal: ${PORTAL_URL}`,
            };
        }
        if (tone === 'firm') {
            return {
                subject: `Payment needed — invoice ${num}, ${daysOverdue} days past due`,
                html: `<p style="margin:0 0 12px">Invoice <strong style="color:#fff">${num}</strong> for <strong style="color:#10b981">${amt}</strong> is now ${daysOverdue} days past due.</p>
                       <p style="margin:0 0 12px">Please arrange payment, or reply to this email so we can sort out anything that's in the way — if the timing is a problem, we'd rather hear it than keep sending reminders.</p>
                       <p style="margin:0">You can pay in your portal at any time.</p>`,
                sms: `Diamondback Coding: invoice ${num} (${amt}) is ${daysOverdue} days past due. Please pay or reply so we can help: ${PORTAL_URL}`,
            };
        }
        return {
            subject: `Final reminder — invoice ${num} is ${daysOverdue} days past due`,
            html: `<p style="margin:0 0 12px">Invoice <strong style="color:#fff">${num}</strong> for <strong style="color:#10b981">${amt}</strong> is ${daysOverdue} days past due.</p>
                   <p style="margin:0 0 12px">This is the last of our automatic reminders. After today, your account is flagged for manual review and we may pause work in progress.</p>
                   <p style="margin:0">If there's a problem with this invoice, please reply today and we'll work it out.</p>`,
            sms: `Diamondback Coding: FINAL reminder — invoice ${num} (${amt}) is ${daysOverdue} days past due. Please pay or reply today: ${PORTAL_URL}`,
        };
    }

    /**
     * Advance the past-due ladder for every open invoice.
     *
     * Runs once a day. For each invoice past its due date it works out how many
     * days overdue it is, and sends the ladder step for that day if it hasn't
     * already been sent — the unique index on
     * (invoice_id, day_number, channel) is what makes that safe, so running
     * this twice in a day cannot double-send, and a gap (server down for three
     * days) is caught up rather than skipped.
     *
     * Deliberately NOT part of lead scoring: everything goes through notify(),
     * which never touches lead_temperature or last_contact_date.
     */
    async function runDunning() {
        const overdue = await pool.query(
            `SELECT i.*, l.name, l.email, l.phone,
                    (CURRENT_DATE - i.due_date) AS days_overdue
               FROM invoices i
               JOIN leads l ON l.id = i.lead_id
              WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
                AND i.due_date IS NOT NULL
                AND i.due_date < CURRENT_DATE
                -- An estimated due date is a placeholder tied to project
                -- completion, not a real obligation. Never dun on one.
                AND COALESCE(i.due_date_estimated, FALSE) = FALSE
              ORDER BY i.due_date`
        );

        const out = { processed: 0, sent: 0, escalated: 0, skipped: 0 };

        for (const inv of overdue.rows) {
            const daysOverdue = Number(inv.days_overdue);
            out.processed++;

            if (daysOverdue > DUNNING_MAX_DAY) {
                // Past the ladder. Escalate once, then stop emailing.
                if (inv.dunning_status !== 'escalated') {
                    await pool.query(
                        `UPDATE invoices SET dunning_status='escalated', updated_at=NOW() WHERE id=$1`,
                        [inv.id]
                    );
                    await adminNotify({
                        kind: 'invoice_escalated',
                        title: `${inv.name}: invoice ${inv.invoice_number} is ${daysOverdue} days past due`,
                        body: `${money(inv.total_amount)} · automatic reminders finished after day ${DUNNING_MAX_DAY} · needs manual follow-up`,
                        leadId: inv.lead_id, entityType: 'invoice', entityId: inv.id,
                        severity: 'error', onceKey: `invoice_escalated:${inv.id}`,
                    });
                    out.escalated++;
                }
                continue;
            }

            const step = DUNNING_LADDER[daysOverdue];
            if (!step) { out.skipped++; continue; }

            // Has day N already gone out? The unique index makes this a cheap
            // exact check rather than a guess from last_reminder_at.
            const already = await pool.query(
                `SELECT 1 FROM invoice_dunning WHERE invoice_id=$1 AND day_number=$2 AND channel='email'`,
                [inv.id, daysOverdue]
            );
            if (already.rows.length) { out.skipped++; continue; }

            const copy = dunningCopy(step.tone, inv, daysOverdue);
            const lead = { id: inv.lead_id, name: inv.name, email: inv.email, phone: inv.phone };
            const channels = step.sms ? ['email', 'sms', 'portal'] : ['email', 'portal'];

            const result = await notify({
                lead, kind: 'dunning_reminder',
                subject: copy.subject,
                bodyHtml: copy.html,
                smsText: copy.sms,
                channels,
                invoiceId: inv.id,
                // The in-portal message gets its own short "you have a message"
                // email, which is what the spec asks for. It's a separate send
                // from the reminder itself.
                portalEmailPing: false,
                cta: { url: PORTAL_URL, label: 'Pay invoice' },
            });

            // Record each channel so day N can never repeat.
            for (const ch of channels) {
                const r = (result.results || {})[ch];
                await pool.query(
                    `INSERT INTO invoice_dunning (invoice_id, lead_id, day_number, days_overdue, channel, status, detail)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (invoice_id, day_number, channel) DO NOTHING`,
                    [inv.id, inv.lead_id, daysOverdue, daysOverdue, ch,
                     r && r.ok ? 'sent' : 'failed', r && r.error ? r.error : copy.subject]
                ).catch((e) => console.warn('[DUNNING] log failed:', e.message));
            }

            await pool.query(
                `UPDATE invoices
                    SET dunning_status='active',
                        dunning_day=$2,
                        dunning_started_at=COALESCE(dunning_started_at, NOW()),
                        last_reminder_at=NOW(),
                        reminder_count=COALESCE(reminder_count,0)+1,
                        updated_at=NOW()
                  WHERE id=$1`,
                [inv.id, daysOverdue]
            );

            // Tell the admin once, when the ladder starts.
            if (daysOverdue === 1) {
                await adminNotify({
                    kind: 'invoice_past_due',
                    title: `${inv.name}: invoice ${inv.invoice_number} is past due`,
                    body: `${money(inv.total_amount)} · due ${prettyDate(inv.due_date)} · reminders now running for ${DUNNING_MAX_DAY} days`,
                    leadId: inv.lead_id, entityType: 'invoice', entityId: inv.id,
                    severity: 'warning', onceKey: `invoice_past_due:${inv.id}`,
                });
            }

            out.sent++;
        }

        if (out.processed) {
            console.log(`[DUNNING] ${out.processed} overdue · ${out.sent} reminders sent · ${out.escalated} escalated · ${out.skipped} already current`);
        }
        return out;
    }

    /** Past-due dashboard data for the admin portal. */
    async function pastDueReport() {
        const rows = (await pool.query(
            `SELECT i.id, i.invoice_number, i.total_amount, i.due_date, i.status,
                    i.dunning_day, i.dunning_status, i.reminder_count, i.last_reminder_at,
                    (CURRENT_DATE - i.due_date) AS days_overdue,
                    l.id AS lead_id, l.name, l.email, l.phone
               FROM invoices i
               JOIN leads l ON l.id = i.lead_id
              WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
                AND i.due_date IS NOT NULL
                AND i.due_date < CURRENT_DATE
                AND COALESCE(i.due_date_estimated, FALSE) = FALSE
              ORDER BY i.due_date`
        )).rows;

        const buckets = { current: 0, days1_10: 0, escalated: 0 };
        let totalOwed = 0;
        for (const r of rows) {
            totalOwed += Number(r.total_amount || 0);
            const d = Number(r.days_overdue);
            if (d > DUNNING_MAX_DAY) buckets.escalated++;
            else buckets.days1_10++;
        }
        return { invoices: rows, count: rows.length, totalOwed, buckets, maxDay: DUNNING_MAX_DAY };
    }

    // ======================================================================
    // Payment methods — saved cards and ACH bank accounts
    // ======================================================================

    /**
     * Make sure the lead has a Stripe customer, so payment methods can attach.
     */
    async function ensureStripeCustomer(leadId) {
        const lead = (await pool.query(
            'SELECT id, name, email, stripe_customer_id FROM leads WHERE id=$1', [leadId]
        )).rows[0];
        if (!lead) throw new Error('Customer not found');
        if (lead.stripe_customer_id) return lead.stripe_customer_id;

        const cust = await stripe.customers.create({
            email: lead.email,
            name: lead.name,
            metadata: { lead_id: String(leadId) },
        });
        await pool.query('UPDATE leads SET stripe_customer_id=$2, updated_at=NOW() WHERE id=$1',
                         [leadId, cust.id]);
        return cust.id;
    }

    /**
     * Persist a Stripe payment method locally.
     *
     * Only Stripe's token plus display hints are stored — never a card number,
     * never an account or routing number. Those stay with Stripe.
     */
    async function savePaymentMethod({ leadId, stripeCustomerId, pm, makeDefault = true }) {
        const isCard = pm.type === 'card';
        const card = pm.card || {};
        const bank = pm.us_bank_account || {};

        if (makeDefault) {
            await pool.query('UPDATE payment_methods SET is_default=FALSE WHERE lead_id=$1', [leadId]);
        }

        const r = await pool.query(
            `INSERT INTO payment_methods
                (lead_id, stripe_customer_id, stripe_pm_id, type, brand, last4,
                 exp_month, exp_year, bank_name, is_default, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
             ON CONFLICT (stripe_pm_id) DO UPDATE
                SET status='active', is_default=EXCLUDED.is_default
             RETURNING *`,
            [leadId, stripeCustomerId, pm.id, pm.type,
             isCard ? card.brand : null,
             isCard ? card.last4 : bank.last4,
             isCard ? card.exp_month : null,
             isCard ? card.exp_year : null,
             isCard ? null : bank.bank_name,
             makeDefault]
        );

        // A plan that was waiting on a payment method can now run.
        await pool.query(
            `UPDATE maintenance_plans
                SET payment_method_id = COALESCE(payment_method_id, $2),
                    status = CASE
                        WHEN status = 'pending_payment_method' AND signed_at IS NOT NULL THEN 'active'
                        ELSE status END,
                    activated_at = COALESCE(activated_at,
                        CASE WHEN status = 'pending_payment_method' AND signed_at IS NOT NULL THEN NOW() END),
                    updated_at = NOW()
              WHERE lead_id = $1 AND status IN ('pending_payment_method','active','pending_cancellation')`,
            [leadId, r.rows[0].id]
        );

        return r.rows[0];
    }

    // ---- portal: start adding a payment method ---------------------------
    // Returns a SetupIntent client secret. The browser finishes the job with
    // Stripe.js, so no card or bank credentials ever reach this server.
    app.post('/api/portal/payment-methods/setup-intent', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const type = (req.body || {}).type === 'us_bank_account' ? 'us_bank_account' : 'card';
            const customerId = await ensureStripeCustomer(leadId);

            const params = {
                customer: customerId,
                payment_method_types: [type],
                usage: 'off_session',
                metadata: { lead_id: String(leadId) },
            };
            if (type === 'us_bank_account') {
                // Instant verification when the bank supports it, microdeposits
                // as the fallback. Stripe decides per bank.
                params.payment_method_options = {
                    us_bank_account: {
                        verification_method: 'automatic',
                        financial_connections: { permissions: ['payment_method'] },
                    },
                };
            }

            const intent = await stripe.setupIntents.create(params);
            res.json({
                success: true,
                clientSecret: intent.client_secret,
                setupIntentId: intent.id,
                type,
                publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
            });
        } catch (e) {
            console.error('[PORTAL SETUP INTENT]', e.message);
            res.status(500).json({ success: false, message: 'Could not start adding a payment method.' });
        }
    });

    // ---- portal: finish adding a payment method --------------------------
    // Called after Stripe.js confirms. A bank account may come back
    // `requires_action` pending microdeposits, which is a normal state, not an
    // error — it's saved but can't be charged until verified.
    app.post('/api/portal/payment-methods/confirm', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const { setupIntentId } = req.body || {};
            if (!setupIntentId) {
                return res.status(400).json({ success: false, message: 'Missing setup intent.' });
            }

            const intent = await stripe.setupIntents.retrieve(setupIntentId, {
                expand: ['payment_method'],
            });
            if (String(intent.metadata && intent.metadata.lead_id) !== String(leadId)) {
                return res.status(403).json({ success: false, message: 'This setup does not belong to your account.' });
            }

            const pm = intent.payment_method;
            if (!pm || typeof pm === 'string') {
                return res.status(400).json({ success: false, message: 'No payment method attached yet.' });
            }

            const saved = await savePaymentMethod({
                leadId,
                stripeCustomerId: typeof intent.customer === 'string' ? intent.customer : intent.customer.id,
                pm,
            });

            const pendingMicrodeposits =
                intent.status === 'requires_action' &&
                intent.next_action &&
                String(intent.next_action.type || '').includes('microdeposits');

            if (pendingMicrodeposits) {
                await pool.query(
                    `UPDATE payment_methods SET status='pending_verification' WHERE id=$1`, [saved.id]
                );
            }

            res.json({
                success: true,
                paymentMethod: {
                    id: saved.id, type: saved.type, brand: saved.brand,
                    last4: saved.last4, bankName: saved.bank_name,
                    status: pendingMicrodeposits ? 'pending_verification' : 'active',
                },
                pendingMicrodeposits,
                message: pendingMicrodeposits
                    ? 'Bank account added. We\'ve sent two small deposits to it — they usually arrive in 1–2 business days. Come back and enter the amounts to finish verifying.'
                    : 'Payment method saved.',
            });
        } catch (e) {
            console.error('[PORTAL PM CONFIRM]', e.message);
            res.status(500).json({ success: false, message: 'Could not save that payment method.' });
        }
    });

    // ---- portal: verify microdeposits ------------------------------------
    app.post('/api/portal/payment-methods/verify-microdeposits', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const { setupIntentId, amounts, descriptorCode } = req.body || {};
            if (!setupIntentId) {
                return res.status(400).json({ success: false, message: 'Missing setup intent.' });
            }

            const payload = {};
            if (Array.isArray(amounts) && amounts.length === 2) {
                // Stripe wants cents as integers.
                payload.amounts = amounts.map((a) => Math.round(Number(a)));
            } else if (descriptorCode) {
                payload.descriptor_code = String(descriptorCode).trim();
            } else {
                return res.status(400).json({
                    success: false,
                    message: 'Enter the two deposit amounts, or the 6-digit code from your statement.',
                });
            }

            const intent = await stripe.setupIntents.verifyMicrodeposits(setupIntentId, payload);
            if (String(intent.metadata && intent.metadata.lead_id) !== String(leadId)) {
                return res.status(403).json({ success: false, message: 'This setup does not belong to your account.' });
            }

            if (intent.status === 'succeeded') {
                const pmId = typeof intent.payment_method === 'string'
                    ? intent.payment_method : intent.payment_method.id;
                await pool.query(
                    `UPDATE payment_methods SET status='active' WHERE stripe_pm_id=$1`, [pmId]
                );
                // Anything that was blocked on verification can start now.
                await pool.query(
                    `UPDATE maintenance_plans
                        SET status='active', activated_at=COALESCE(activated_at,NOW()), updated_at=NOW()
                      WHERE lead_id=$1 AND status='pending_payment_method' AND signed_at IS NOT NULL`,
                    [leadId]
                );
                return res.json({ success: true, message: 'Bank account verified. You\'re all set.' });
            }

            res.json({
                success: false,
                status: intent.status,
                message: 'Those amounts didn\'t match. Please check your statement and try again.',
            });
        } catch (e) {
            console.error('[PORTAL MICRODEPOSITS]', e.message);
            res.status(400).json({
                success: false,
                message: e.message || 'Could not verify that bank account.',
            });
        }
    });

    // ---- portal: list / remove payment methods ---------------------------
    app.get('/api/portal/payment-methods', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const r = await pool.query(
                `SELECT id, type, brand, last4, exp_month, exp_year, bank_name, is_default, status, created_at
                   FROM payment_methods
                  WHERE lead_id=$1 AND status <> 'removed'
                  ORDER BY is_default DESC, id DESC`,
                [leadId]
            );
            res.json({ success: true, paymentMethods: r.rows });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not load your payment methods.' });
        }
    });

    app.delete('/api/portal/payment-methods/:id', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const pm = (await pool.query(
                'SELECT * FROM payment_methods WHERE id=$1 AND lead_id=$2', [req.params.id, leadId]
            )).rows[0];
            if (!pm) return res.status(404).json({ success: false, message: 'Payment method not found.' });

            // Refuse to strand an active autopay plan without a way to charge it.
            const relying = await pool.query(
                `SELECT COUNT(*)::int AS n FROM maintenance_plans
                  WHERE lead_id=$1 AND status IN ('active','pending_cancellation')`, [leadId]
            );
            const others = await pool.query(
                `SELECT COUNT(*)::int AS n FROM payment_methods
                  WHERE lead_id=$1 AND id<>$2 AND status='active'`, [leadId, pm.id]
            );
            if (relying.rows[0].n > 0 && others.rows[0].n === 0) {
                return res.status(409).json({
                    success: false,
                    message: 'This is the only payment method on an active plan. Add another one first, or cancel the plan.',
                });
            }

            if (pm.stripe_pm_id) {
                await stripe.paymentMethods.detach(pm.stripe_pm_id).catch((e) =>
                    console.warn('[PORTAL PM DETACH]', e.message));
            }
            await pool.query("UPDATE payment_methods SET status='removed', is_default=FALSE WHERE id=$1", [pm.id]);
            res.json({ success: true, message: 'Payment method removed.' });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not remove that payment method.' });
        }
    });

    // ---- admin: subscriptions (CRM ONLY) ---------------------------------
    // The admin portal's badge refresher calls /api/admin/subscriptions, which
    // was never defined — the call sat inside a try/catch with an `if (r.ok)`
    // guard, so it failed silently and the Subscriptions badge read 0 forever.
    //
    // Scoped to crm_subscriptions on purpose: the Subscriptions tab tracks
    // CodeNexus CRM subscribers, NOT customers and NOT maintenance plans.
    // Maintenance lives on its own tab so the two revenue streams never blur.
    app.get('/api/admin/subscriptions', authenticateToken, async (req, res) => {
        try {
            const { status } = req.query || {};
            const params = [];
            let where = '';
            if (status && status !== 'all') {
                params.push(status);
                where = `WHERE cs.status = $${params.length}`;
            }
            const r = await pool.query(
                `SELECT cs.*, l.name AS lead_name_ref, l.email AS lead_email_ref,
                        l.company, l.portal_kind, l.crm_access
                   FROM crm_subscriptions cs
                   LEFT JOIN leads l ON l.id = cs.lead_id
                   ${where}
                  ORDER BY cs.created_at DESC`,
                params
            );
            const subs = r.rows;
            const active = subs.filter((x) => x.status === 'active');
            res.json({
                success: true,
                subscriptions: subs,
                summary: {
                    total: subs.length,
                    active: active.length,
                    canceling: subs.filter((x) => x.cancel_at_period_end).length,
                    cancelled: subs.filter((x) => ['cancelled', 'canceled'].includes(x.status)).length,
                    mrr: active.reduce((sum, x) => sum + Number(x.monthly_total || 0), 0),
                },
            });
        } catch (e) {
            console.error('[ADMIN SUBSCRIPTIONS]', e.message);
            res.status(500).json({ success: false, message: 'Could not load subscriptions.' });
        }
    });

    // ---- admin: past-due dashboard ---------------------------------------
    app.get('/api/admin/past-due', authenticateToken, async (req, res) => {
        try {
            res.json({ success: true, ...(await pastDueReport()) });
        } catch (e) {
            console.error('[ADMIN PAST DUE]', e.message);
            res.status(500).json({ success: false, message: 'Could not load past-due invoices.' });
        }
    });

    // Run the ladder on demand, for testing or after fixing a mail problem.
    app.post('/api/admin/dunning/run', authenticateToken, async (req, res) => {
        try {
            res.json({ success: true, results: await runDunning() });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // ======================================================================
    // ROUTES
    // ======================================================================

    // ---- customer portal: payment history --------------------------------
    app.get('/api/portal/payments', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const payments = await pool.query(
                `SELECT p.id, p.amount, p.currency, p.method, p.method_last4, p.method_brand,
                        p.kind, p.description, p.status, p.refunded_amount, p.receipt_number,
                        p.paid_at, i.invoice_number,
                        COALESCE(json_agg(json_build_object('amount', r.amount, 'reason', r.reason, 'created_at', r.created_at)
                                 ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL), '[]') AS refunds
                   FROM payments p
                   LEFT JOIN invoices i ON i.id = p.invoice_id
                   LEFT JOIN refunds r ON r.payment_id = p.id
                  WHERE p.lead_id = $1
                  GROUP BY p.id, i.invoice_number
                  ORDER BY p.paid_at DESC`,
                [leadId]
            );
            const totals = await pool.query(
                `SELECT COALESCE(SUM(amount),0) AS paid, COALESCE(SUM(refunded_amount),0) AS refunded
                   FROM payments WHERE lead_id=$1 AND status<>'failed'`, [leadId]
            );
            res.json({
                success: true,
                payments: payments.rows,
                totals: {
                    paid: Number(totals.rows[0].paid),
                    refunded: Number(totals.rows[0].refunded),
                    net: Number(totals.rows[0].paid) - Number(totals.rows[0].refunded),
                },
            });
        } catch (e) {
            console.error('[PORTAL PAYMENTS]', e.message);
            res.status(500).json({ success: false, message: 'Could not load your payment history.' });
        }
    });

    // ---- customer portal: my maintenance plans ---------------------------
    app.get('/api/portal/maintenance-plans', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const r = await pool.query(
                `SELECT mp.*, pc.effective_at AS cancels_at, pc.id AS cancellation_id,
                        pm.brand, pm.last4, pm.type AS method_type, pm.bank_name
                   FROM maintenance_plans mp
                   LEFT JOIN plan_cancellations pc
                          ON pc.maintenance_plan_id = mp.id AND pc.status='pending'
                   LEFT JOIN payment_methods pm ON pm.id = mp.payment_method_id
                  WHERE mp.lead_id = $1 AND mp.status <> 'cancelled'
                  ORDER BY mp.created_at DESC`,
                [leadId]
            );
            res.json({
                success: true,
                plans: r.rows.map((p) => ({
                    ...p,
                    days_until_cancellation: p.cancels_at
                        ? Math.max(0, Math.ceil((new Date(p.cancels_at) - Date.now()) / 86400000))
                        : null,
                })),
                noticeDays: CANCELLATION_NOTICE_DAYS,
            });
        } catch (e) {
            console.error('[PORTAL PLANS]', e.message);
            res.status(500).json({ success: false, message: 'Could not load your plans.' });
        }
    });

    // ---- customer portal: cancel / reinstate ------------------------------
    app.post('/api/portal/maintenance-plans/:id/cancel', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const out = await requestPlanCancellation({
                planId: req.params.id, leadId, reason: (req.body || {}).reason,
            });
            if (out.alreadyPending) {
                return res.json({
                    success: true, alreadyPending: true,
                    message: `This plan is already scheduled to cancel on ${prettyDate(out.cancellation.effective_at)}.`,
                    effectiveAt: out.cancellation.effective_at,
                });
            }
            res.json({
                success: true,
                message: `Cancellation confirmed. Your plan stays active until ${prettyDate(out.effectiveAt)}.`,
                effectiveAt: out.effectiveAt, noticeDays: CANCELLATION_NOTICE_DAYS,
            });
        } catch (e) {
            console.error('[PORTAL CANCEL]', e.message);
            res.status(400).json({ success: false, message: e.message });
        }
    });

    app.post('/api/portal/maintenance-plans/:id/reinstate', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            await reinstatePlan({ planId: req.params.id, leadId });
            res.json({ success: true, message: 'Your plan is reinstated.' });
        } catch (e) {
            res.status(400).json({ success: false, message: e.message });
        }
    });

    // ---- customer portal: sign an agreement ------------------------------
    app.post('/api/portal/sales-agreements/:id/sign', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const { typedName, agree } = req.body || {};
            if (!agree) {
                return res.status(400).json({ success: false, message: 'Please check the box to agree to the terms.' });
            }
            if (!typedName || String(typedName).trim().length < 2) {
                return res.status(400).json({ success: false, message: 'Type your full name to sign.' });
            }

            const own = await pool.query(
                'SELECT id, lead_id, status FROM sales_agreements WHERE id=$1', [req.params.id]
            );
            const a = own.rows[0];
            if (!a || String(a.lead_id) !== String(leadId)) {
                return res.status(404).json({ success: false, message: 'Agreement not found.' });
            }
            if (a.status === 'signed') {
                return res.status(409).json({ success: false, message: 'This agreement is already signed.' });
            }

            const out = await onAgreementSigned({
                agreementId: a.id,
                signerName: String(typedName).trim(),
                ip: req.headers['x-forwarded-for'] || req.ip,
                userAgent: req.headers['user-agent'],
            });

            res.json({
                success: true,
                message: 'Signed. Your project timeline and invoice are in your portal.',
                invoice: out.invoice ? {
                    number: out.invoice.invoice_number,
                    total: out.invoice.total_amount,
                    dueDate: out.invoice.due_date,
                    dueDateEstimated: out.invoice.due_date_estimated,
                } : null,
                assignedAdmin: out.assignedAdmin ? out.assignedAdmin.username : null,
            });
        } catch (e) {
            console.error('[PORTAL SIGN]', e.message);
            res.status(500).json({ success: false, message: 'Could not record your signature. Please try again.' });
        }
    });

    // ---- admin: per-customer payment log ---------------------------------
    app.get('/api/admin/customers/:leadId/payments', authenticateToken, async (req, res) => {
        try {
            const { leadId } = req.params;
            const payments = await pool.query(
                `SELECT p.*, i.invoice_number,
                        COALESCE(json_agg(json_build_object(
                            'id', r.id, 'amount', r.amount, 'reason', r.reason,
                            'created_at', r.created_at, 'issued_by', r.issued_by
                        ) ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL), '[]') AS refunds
                   FROM payments p
                   LEFT JOIN invoices i ON i.id = p.invoice_id
                   LEFT JOIN refunds r ON r.payment_id = p.id
                  WHERE p.lead_id=$1
                  GROUP BY p.id, i.invoice_number
                  ORDER BY p.paid_at DESC`,
                [leadId]
            );
            const summary = await pool.query(
                `SELECT COALESCE(SUM(amount),0) AS gross,
                        COALESCE(SUM(refunded_amount),0) AS refunded,
                        COUNT(*) AS payment_count
                   FROM payments WHERE lead_id=$1 AND status<>'failed'`, [leadId]
            );
            const open = await pool.query(
                `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS amt
                   FROM invoices
                  WHERE lead_id=$1 AND status NOT IN ('paid','void','cancelled','refunded','draft')`,
                [leadId]
            );
            res.json({
                success: true,
                payments: payments.rows,
                summary: {
                    gross: Number(summary.rows[0].gross),
                    refunded: Number(summary.rows[0].refunded),
                    net: Number(summary.rows[0].gross) - Number(summary.rows[0].refunded),
                    paymentCount: Number(summary.rows[0].payment_count),
                    openInvoices: Number(open.rows[0].n),
                    openAmount: Number(open.rows[0].amt),
                },
            });
        } catch (e) {
            console.error('[ADMIN PAYMENTS]', e.message);
            res.status(500).json({ success: false, message: 'Could not load the payment log.' });
        }
    });

    // ---- admin: issue a refund -------------------------------------------
    app.post('/api/admin/payments/:id/refund', authenticateToken, async (req, res) => {
        try {
            const { amount, reason } = req.body || {};
            const refund = await issueRefund({
                paymentId: req.params.id, amount, reason,
                adminId: req.user && req.user.id,
            });
            res.json({ success: true, refund, message: `Refund of ${money(refund.amount)} issued.` });
        } catch (e) {
            console.error('[ADMIN REFUND]', e.message);
            res.status(400).json({ success: false, message: e.message });
        }
    });

    // ---- admin: maintenance plans ----------------------------------------
    app.get('/api/admin/maintenance-plans', authenticateToken, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT mp.*, l.name AS customer_name, l.email AS customer_email,
                        pc.effective_at AS cancels_at,
                        pm.brand, pm.last4, pm.type AS method_type,
                        (SELECT COALESCE(SUM(amount),0) FROM payments
                          WHERE maintenance_plan_id = mp.id AND status='succeeded') AS collected
                   FROM maintenance_plans mp
                   JOIN leads l ON l.id = mp.lead_id
                   LEFT JOIN plan_cancellations pc
                          ON pc.maintenance_plan_id = mp.id AND pc.status='pending'
                   LEFT JOIN payment_methods pm ON pm.id = mp.payment_method_id
                  ORDER BY
                    CASE mp.status WHEN 'past_due' THEN 0 WHEN 'pending_cancellation' THEN 1
                                   WHEN 'active' THEN 2 ELSE 3 END,
                    mp.next_charge_date NULLS LAST`
            );
            const plans = r.rows.map((p) => ({
                ...p,
                days_until_cancellation: p.cancels_at
                    ? Math.max(0, Math.ceil((new Date(p.cancels_at) - Date.now()) / 86400000))
                    : null,
            }));
            const mrr = plans
                .filter((p) => ['active', 'pending_cancellation'].includes(p.status))
                .reduce((s, p) => s + Number(p.amount || 0), 0);
            res.json({
                success: true, plans,
                summary: {
                    total: plans.length,
                    active: plans.filter((p) => p.status === 'active').length,
                    cancelling: plans.filter((p) => p.status === 'pending_cancellation').length,
                    pastDue: plans.filter((p) => p.status === 'past_due').length,
                    mrr,
                },
            });
        } catch (e) {
            console.error('[ADMIN PLANS]', e.message);
            res.status(500).json({ success: false, message: 'Could not load maintenance plans.' });
        }
    });

    app.post('/api/admin/maintenance-plans', authenticateToken, async (req, res) => {
        try {
            const {
                leadId, planType, label, description, amount,
                billingDay = 1, generateInvoice = false, sendAgreement = true,
            } = req.body || {};

            if (!leadId || !planType || !amount) {
                return res.status(400).json({ success: false, message: 'Customer, plan type and amount are required.' });
            }

            const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
            if (!lead) return res.status(404).json({ success: false, message: 'Customer not found.' });

            const defaultLabels = {
                monthly_maintenance: 'Monthly Maintenance',
                brevo_maintenance: 'Brevo Maintenance',
                database_maintenance: 'Database Maintenance',
            };

            const ins = await pool.query(
                `INSERT INTO maintenance_plans
                    (lead_id, plan_type, label, description, amount, billing_day,
                     generate_invoice, status, next_charge_date)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_signature',$8)
                 RETURNING *`,
                [leadId, planType, label || defaultLabels[planType] || 'Maintenance Plan',
                 description || null, amount, billingDay, generateInvoice,
                 dateOnly(nextBillingDate(billingDay))]
            );
            const plan = ins.rows[0];

            // The plan agreement they sign before autopay can start.
            let agreement = null;
            if (sendAgreement) {
                const num = `MA-${String(plan.id).padStart(5, '0')}`;
                const ag = await pool.query(
                    `INSERT INTO sales_agreements
                        (agreement_number, lead_id, customer_name, customer_email, service_type,
                         package_name, price, status, agreement_kind, intro, terms, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'sent','maintenance',$8,$9,NOW(),NOW())
                     RETURNING *`,
                    [num, leadId, lead.name, lead.email, planType, plan.label, amount,
                     `Recurring ${plan.label.toLowerCase()} at ${money(amount)} per month, billed automatically on day ${billingDay}.`,
                     `This plan renews monthly at ${money(amount)}. Payment is charged automatically to your saved payment method. ` +
                     `You may cancel at any time from your customer portal; cancellation takes effect ${CANCELLATION_NOTICE_DAYS} days after the request, ` +
                     `and service continues until that date.`]
                );
                agreement = ag.rows[0];
                await pool.query('UPDATE maintenance_plans SET agreement_id=$2 WHERE id=$1', [plan.id, agreement.id]);
                await onAgreementSent({ agreementId: agreement.id }).catch((e) =>
                    console.warn('[LIFECYCLE] maintenance agreement send:', e.message));
            }

            res.json({
                success: true, plan, agreement,
                message: sendAgreement
                    ? `${plan.label} created. ${lead.name} has been asked to sign and add a payment method.`
                    : `${plan.label} created.`,
            });
        } catch (e) {
            console.error('[ADMIN CREATE PLAN]', e.message);
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // ---- admin: notifications bell ---------------------------------------
    app.get('/api/admin/lifecycle-notifications', authenticateToken, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 100`
            );
            const unread = await pool.query(
                'SELECT COUNT(*) AS n FROM admin_notifications WHERE is_read=FALSE'
            );
            res.json({ success: true, notifications: r.rows, unreadCount: Number(unread.rows[0].n) });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not load notifications.' });
        }
    });

    app.post('/api/admin/lifecycle-notifications/read', authenticateToken, async (req, res) => {
        try {
            const { ids } = req.body || {};
            if (Array.isArray(ids) && ids.length) {
                await pool.query('UPDATE admin_notifications SET is_read=TRUE WHERE id = ANY($1::int[])', [ids]);
            } else {
                await pool.query('UPDATE admin_notifications SET is_read=TRUE WHERE is_read=FALSE');
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not update notifications.' });
        }
    });

    // ---- cron ------------------------------------------------------------
    // Render Cron Jobs (or any scheduler) hits this daily. Token-guarded
    // rather than admin-auth'd so a scheduler can call it without a session.
    app.post('/api/cron/lifecycle-daily', async (req, res) => {
        const token = req.headers['x-cron-token'] || (req.query || {}).token;
        if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
            return res.status(401).json({ success: false, message: 'Invalid cron token.' });
        }
        try {
            res.json({ success: true, results: await runDailyJobs() });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    console.log('[LIFECYCLE] Mounted: portal payments/plans/sign, admin payments/refunds/plans/notifications, cron');

    return {
        // stages
        onCustomerCreated,
        onCrmSubscriptionActivated,
        onAgreementSent,
        onAgreementSigned,
        onMilestoneCompleted,
        onProjectCompleted,
        onPaymentReceived,
        // money
        createInvoice,
        recordPayment,
        issueRefund,
        chargeMaintenancePlan,
        // cancellation
        requestPlanCancellation,
        reinstatePlan,
        // jobs
        runDunning,
        pastDueReport,
        ensureStripeCustomer,
        savePaymentMethod,
        DUNNING_LADDER,
        DUNNING_MAX_DAY,
        runMaintenanceCharges,
        runCancellationReminders,
        completePlanCancellations,
        runDailyJobs,
        // utilities
        notify,
        generateSignatureSVG,
        nextBillingDate,
        agreementTotal,
        TRANSACTIONAL_TYPES,
    };
};