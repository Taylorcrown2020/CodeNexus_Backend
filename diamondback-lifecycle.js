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
        'project_update',
        'service_request_received',
        'password_reset',
        'password_changed',
        'username_recovery',
        'contact_confirmation',
        'login_code',
    ];

    // ======================================================================
    // Small helpers
    // ======================================================================

    const money = (n) => `$${Number(n || 0).toFixed(2)}`;
    /** Human label for a saved payment method, for use in email copy. */
    const esc0 = (pm) => (!pm ? 'saved payment method'
        : pm.type === 'card'
            ? `${pm.brand || 'card'} ending ${pm.last4}`
            : `${pm.bank_name || 'bank account'} ending ${pm.last4}`);
    const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    /** 1st / 2nd / 3rd — autopay copy says "the 12th", never "day 12". */
    const ordinalDay = (n) => {
        const v = Number(n);
        if (!v || v < 1 || v > 31) return 'same day';
        const s = ['th', 'st', 'nd', 'rd'];
        const m = v % 100;
        return v + (s[(m - 20) % 10] || s[m] || s[0]);
    };

    // ======================================================================
    // Domain renewal pricing — the ONE place fee + tax are computed.
    //
    // maintenance_plans.amount stores the admin-entered DOMAIN COST ONLY, for
    // every plan_type. For plan_type='domain_renewal' the customer is never
    // shown, signed to, invoiced, or charged that bare number — the mandatory
    // maintenance fee and sales tax are added on top, every time, by calling
    // domainRenewalPricing()/planChargeTotal() rather than reading .amount
    // directly. That's what keeps the signed agreement, the invoice, and the
    // actual Stripe charge from ever drifting apart again.
    //
    // Every other plan_type is unaffected: planChargeTotal() just returns
    // plan.amount for them.
    // ======================================================================
    // ----------------------------------------------------------------------
    // Pricing now lives in diamondback-pricing.js — one function, priceFor(),
    // that every charge, invoice, agreement and receipt resolves through.
    //
    // The domain-renewal arithmetic that used to sit here is inside it, along
    // with sales tax and the credit-card processing fee. Keeping two copies of
    // this maths is how the signed agreement, the Stripe charge and the receipt
    // ended up able to disagree, so there is deliberately only one now.
    //
    // THE FEE IS CREDIT-ONLY. Surcharging a debit or prepaid card is prohibited
    // by federal law (Durbin Amendment), so it depends on the payment method,
    // which means the total is not knowable from the plan row alone. Pass the
    // method wherever you have it.
    // ----------------------------------------------------------------------
    const pricing = require('./diamondback-pricing.js');
    const DOMAIN_MAINTENANCE_FEE = pricing.DOMAIN_MAINTENANCE_FEE;

    /** Full breakdown for a plan on a given payment method. */
    function planPricing(plan, method = null, opts = {}) {
        return pricing.priceFor(plan, method, opts);
    }

    /**
     * The real amount to sign/invoice/charge/display for ANY plan.
     *
     * `method` is optional and defaults to no method, which means NO processing
     * fee — the safe direction to be wrong in. Every path that actually takes
     * money passes the real method; display paths that don't have one show the
     * fee-free figure, which is what a customer paying by bank would owe.
     */
    function planChargeTotal(plan, method = null) {
        return planPricing(plan, method).total;
    }

    /** The payment method a plan will actually be charged on. */
    async function methodForPlan(plan) {
        if (!plan) return null;
        const id = plan.payment_method_id;
        try {
            if (id) {
                const r = await pool.query('SELECT * FROM payment_methods WHERE id=$1', [id]);
                if (r.rows[0]) return r.rows[0];
            }
            const r = await pool.query(
                `SELECT pm.* FROM payment_methods pm
                   JOIN leads l ON l.default_payment_method_id = pm.id
                  WHERE l.id = $1 AND pm.status = 'active'`, [plan.lead_id]);
            return r.rows[0] || null;
        } catch (e) {
            console.warn('[PRICING] methodForPlan:', e.message);
            return null;
        }
    }

    // ---- interval wording, so nothing says "month" for an annual plan ----
    const intervalUnit    = (plan) => (plan && plan.interval_unit === 'year') ? 'year' : 'month';
    const intervalSuffix  = (plan) => intervalUnit(plan) === 'year' ? '/yr' : '/mo';
    const intervalAdverb  = (plan) => intervalUnit(plan) === 'year' ? 'annually' : 'monthly';
    const intervalEach    = (plan) => intervalUnit(plan) === 'year' ? 'each year' : 'each month';
    const intervalPer     = (plan) => intervalUnit(plan) === 'year' ? 'per year' : 'per month';

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
    /**
     * Next billing date for an ANNUAL plan (domain renewals).
     * Same clamping rule as monthly: a 29–31 day in a short month lands on the
     * last day of that month rather than skipping the year.
     */
    function nextAnnualDate(month, day, from = new Date()) {
        const m = Math.max(1, Math.min(12, Number(month) || 1));
        const y = from.getUTCFullYear();
        const make = (year) => {
            const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
            return new Date(Date.UTC(year, m - 1, Math.min(Number(day) || 1, last)));
        };
        const thisYear = make(y);
        return thisYear > from ? thisYear : make(y + 1);
    }

    /** Next charge date for any plan, monthly or annual. */
    function nextChargeFor(plan, from = new Date()) {
        return plan && plan.interval_unit === 'year'
            ? nextAnnualDate(plan.billing_month || 1, plan.billing_day || 1, from)
            : nextBillingDate(plan ? (plan.billing_day || 1) : 1, from);
    }

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

    /**
     * Turn a database error into something actionable.
     *
     * Postgres 42P01 (undefined_table) means a migration hasn't run. A bare 500
     * in the UI gives no clue about that — the browser just says "Request failed
     * (500)" and you're left guessing between auth, network and schema. This
     * names the cause instead.
     */
    function dbErrorMessage(e, what) {
        if (e && e.code === '42P01') {
            return `${what} needs a database migration that hasn't been applied yet. ` +
                   'Restart the service (migrations now run at boot), or run: npm run db:migrate';
        }
        if (e && e.code === '42703') {
            return `${what} needs a database column that hasn't been added yet. ` +
                   'Restart the service to apply pending migrations.';
        }
        return `Could not load ${what.toLowerCase()}.`;
    }

    // ======================================================================
    // notify() — the only send path in this module
    // ======================================================================

    /**
     * The email shell. Light theme: white card on a soft grey canvas, near-black
     * type, one black call-to-action. Table-based and inline-styled because
     * Outlook ignores most of everything else.
     *
     * Everything this module sends goes through here, so changing it changes
     * every email at once.
     */
    // Absolute URL — email clients can't resolve a relative path. Override with
    // LOGO_URL if the asset ever moves.
    // SITE_URL is declared further down this same scope; referencing it here
    // would be a temporal-dead-zone error if shell() were ever called during
    // init, so LOGO_URL stands on its own.
    const LOGO_URL = process.env.LOGO_URL
        || `${process.env.SITE_URL || 'https://diamondbackcoding.com'}/images/diamondback-logo-email.png`;

    function shell(title, bodyHtml, cta) {
        return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#f2f3f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${String(title).slice(0, 110)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f3f5;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

    <!-- logo -->
    <tr><td style="padding:0 4px 18px;">
      <a href="${process.env.SITE_URL || 'https://diamondbackcoding.com'}" style="text-decoration:none;">
        <img src="${LOGO_URL}" alt="Diamondback Coding" width="188" height="38"
             style="display:block;border:0;outline:none;text-decoration:none;
                    width:188px;max-width:188px;height:auto;">
      </a>
    </td></tr>

    <!-- card -->
    <tr><td style="background:#ffffff;border-radius:20px;padding:34px 34px 30px;">
      <h1 style="margin:0 0 18px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:23px;
                 line-height:1.28;font-weight:700;color:#0d0f12;letter-spacing:-.02em;">${title}</h1>
      <div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#3f4650;">
        ${bodyHtml}
      </div>
      ${cta ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;">
        <tr><td style="background:#0d0f12;border-radius:12px;">
          <a href="${cta.url}" style="display:inline-block;padding:14px 28px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;
             font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${cta.label}</a>
        </td></tr>
      </table>` : ''}
    </td></tr>

    <!-- footer -->
    <tr><td style="padding:22px 8px 0;font-family:'Segoe UI',Helvetica,Arial,sans-serif;
                   font-size:12px;line-height:1.7;color:#7c848f;">
      Diamondback Coding &middot; 3600 N Capital of Texas Hwy, Building B, Suite 350, Austin, TX 78746<br>
      <a href="mailto:contact@diamondbackcoding.com" style="color:#0d0f12;text-decoration:none;font-weight:600;">contact@diamondbackcoding.com</a>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
    }

    /**
     * A light key/value block for the body. Replaces the ad-hoc dark tables that
     * were inlined all over this file, so the palette lives in one place.
     */
    function rows(pairs) {
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="margin:0 0 16px;background:#f7f8f9;border-radius:12px;">` +
            pairs.filter(Boolean).map(([k, v], i, arr) => `
            <tr>
              <td style="padding:11px 16px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;color:#7c848f;
                         ${i < arr.length - 1 ? 'border-bottom:1px solid #eef0f3;' : ''}">${k}</td>
              <td align="right" style="padding:11px 16px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;
                         font-weight:600;color:#0d0f12;
                         ${i < arr.length - 1 ? 'border-bottom:1px solid #eef0f3;' : ''}">${v}</td>
            </tr>`).join('') + `</table>`;
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
        // 'due_now'       — maintenance, renewals, deposits: owed on issue.
        // 'on_completion' — a project balance: not outstanding until the work
        //                   is done, so it must not inflate the balance now.
        obligation = 'due_now', isDeposit = false,
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
                     billing_schedule_id, maintenance_plan_id, auto_generated, due_date_estimated, created_at,
                     obligation, is_deposit)
                 VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,'sent',$8,$9,$10,$11,$12,$13,$14,$15,NOW(),$16,$17)
                 RETURNING *`,
                [number, leadId, dueDate, subtotal, taxRate, taxAmount, total,
                 (description || '').slice(0, 255), null, agreementId, projectId,
                 scheduleId, maintenancePlanId, autoGenerated, estimated,
                 obligation, isDeposit]
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
        // The breakdown behind `amount`. Without these the receipt can only
        // show a total, and an undisclosed card surcharge on a receipt is both
        // a card-network violation and a chargeback waiting to happen.
        baseAmount = null, taxAmount = 0, processingFee = 0,
    }) {
        const receipt = `RCPT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;

        let ins;
        try {
            ins = await pool.query(
                `INSERT INTO payments
                    (lead_id, invoice_id, maintenance_plan_id, amount, method, method_last4, method_brand,
                     kind, description, status, stripe_payment_intent_id, stripe_charge_id, receipt_number,
                     base_amount, tax_amount, processing_fee, paid_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
                 ON CONFLICT (stripe_payment_intent_id) DO NOTHING
                 RETURNING *`,
                [leadId, invoiceId, maintenancePlanId, amount, method, methodLast4, methodBrand,
                 kind, description, status, stripePaymentIntentId, stripeChargeId, receipt,
                 baseAmount != null ? baseAmount : amount, taxAmount || 0, processingFee || 0]
            );
        } catch (e) {
            // Pre-012 database: record the payment without the breakdown rather
            // than losing the ledger row for money that has already moved.
            console.warn('[LIFECYCLE] payments breakdown columns missing — '
                       + 'run migrations/012_tax_and_processing_fee.sql:', e.message);
            ins = await pool.query(
                `INSERT INTO payments
                    (lead_id, invoice_id, maintenance_plan_id, amount, method, method_last4, method_brand,
                     kind, description, status, stripe_payment_intent_id, stripe_charge_id, receipt_number, paid_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
                 ON CONFLICT (stripe_payment_intent_id) DO NOTHING
                 RETURNING *`,
                [leadId, invoiceId, maintenancePlanId, amount, method, methodLast4, methodBrand,
                 kind, description, status, stripePaymentIntentId, stripeChargeId, receipt]
            );
        }

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
                bodyHtml: `<p style="margin:0 0 12px">We've issued a refund of <strong style="color:#0d0f12">${money(amt)}</strong> to your original payment method.</p>
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
                    <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#f7f8f9;border-radius:8px;padding:16px;width:100%">
                      <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Email</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${lead.email}</td></tr>
                      <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Temporary password</td><td style="padding:10px 16px;color:#15803d;font-size:15px;font-family:monospace">${password}</td></tr>
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
                           <p style="margin:0 0 12px">Your CRM workspace ID is <strong style="color:#15803d;font-family:monospace">${portalId}</strong>.</p>
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
                <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;background:#f7f8f9;border-radius:8px">
                  ${a.package_name ? `<tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Service</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${a.package_name}</td></tr>` : ''}
                  <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Total</td><td style="padding:10px 16px;color:#15803d;font-size:16px;font-weight:700">${money(total)}</td></tr>
                  ${a.est_completion_date ? `<tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Estimated completion</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${prettyDate(a.est_completion_date)}</td></tr>` : ''}
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
    async function onAgreementSigned({ agreementId, signerName, ip, userAgent,
                                      viewedInFull = false }) {
        const a = (await pool.query('SELECT * FROM sales_agreements WHERE id=$1', [agreementId])).rows[0];
        if (!a) throw new Error('Agreement not found');

        // The ONLY authoritative "already signed" test is the signature row.
        // The previous guard was claimStage(), which writes its lifecycle_events
        // row BEFORE any work happens: if anything downstream threw, the claim
        // survived, every retry returned early, and the agreement sat unsigned
        // forever while the customer was told it had gone through. The claim is
        // still taken (it keeps the audit trail and stops duplicate email), but
        // it no longer decides whether the agreement is signed, and it is
        // RELEASED if the signature does not actually land.
        const already = (await pool.query(
            `SELECT sa.signed_at, sa.status, (sig.id IS NOT NULL) AS has_sig
               FROM sales_agreements sa
               LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id
              WHERE sa.id = $1`, [agreementId]
        )).rows[0];

        if (already && (already.has_sig || already.signed_at)) {
            // Genuinely signed already. Reconcile the row in case a previous
            // run died between the signature and the status update, then report
            // the true kind so the caller words its response correctly.
            await pool.query(
                `UPDATE sales_agreements
                    SET status = CASE WHEN status IN ('sent','draft') THEN 'signed' ELSE status END,
                        signed_at = COALESCE(signed_at, NOW()), updated_at = NOW()
                  WHERE id = $1`, [agreementId]
            ).catch(() => {});
            return {
                signed: true, alreadySigned: true,
                kind: a.agreement_kind || 'sla',
            };
        }

        // Not signed. Clear any stale claim from a previous failed attempt so
        // the audit insert below can be taken cleanly.
        await pool.query(
            `DELETE FROM lifecycle_events WHERE once_key = $1`,
            [`sla_signed:agreement:${agreementId}`]
        ).catch(() => {});

        await claimStage(a.lead_id, 'sla_signed', `sla_signed:agreement:${agreementId}`,
                         { entityType: 'agreement', entityId: agreementId });

        const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [a.lead_id])).rows[0];
        const name = signerName || a.customer_name || (lead && lead.name) || 'Customer';
        const svg = generateSignatureSVG(name);

        // ------------------------------------------------------------------
        // Capture the document exactly as rendered, and hash it.
        //
        // This is the evidence that matters in a dispute: not "they clicked a
        // box" but "here is the text they were shown, here is its hash, and
        // here is the hash stored the moment they signed". Built from the same
        // module that renders the on-screen view and the PDF, so all three are
        // necessarily identical.
        //
        // Best-effort throughout. A failure here must never block a signature
        // the customer has already given.
        // ------------------------------------------------------------------
        let docSnapshot = null;
        let docHash = null;
        let autopayConsentText = null;
        const isAutopayAgreement = !!a.autopay
            || ['maintenance', 'subscription'].includes(a.agreement_kind);

        try {
            const documents = require('./diamondback-documents.js');
            const items = await pool.query(
                'SELECT * FROM agreement_items WHERE agreement_id=$1 ORDER BY sort_order, id',
                [agreementId]).then((r) => r.rows).catch(() => []);
            const stones = await pool.query(
                'SELECT * FROM agreement_milestones WHERE agreement_id=$1 ORDER BY sort_order, id',
                [agreementId]).then((r) => r.rows).catch(() => []);
            const linkedPlan = await pool.query(
                'SELECT * FROM maintenance_plans WHERE agreement_id=$1 ORDER BY id DESC LIMIT 1',
                [agreementId]).then((r) => r.rows[0] || null).catch(() => null);

            const built = documents.buildAgreementDocument({
                agreement: a,
                items,
                milestones: stones,
                plan: linkedPlan,
                noticeDays: CANCELLATION_NOTICE_DAYS,
            });
            docSnapshot = documents.renderAgreementText(built);
            docHash = documents.hashAgreement(built);
            autopayConsentText = built.autopayConsentText;
        } catch (docErr) {
            console.warn('[LIFECYCLE] document snapshot unavailable:', docErr.message);
        }

        // The columns land only if migration 011 has run. Detected rather than
        // assumed, because this database has a history of migrations that were
        // recorded as applied without their statements succeeding (see 010).
        let hasProofColumns = false;
        try {
            hasProofColumns = (await pool.query(
                `SELECT 1 FROM information_schema.columns
                  WHERE table_name='agreement_signatures' AND column_name='document_hash'`
            )).rows.length > 0;
        } catch { /* treat as absent */ }

        const baseConsent = isAutopayAgreement
            ? 'By typing my name I agree to the terms of this agreement, including the automatic '
              + 'payment authorization it contains, and consent to sign electronically.'
            : 'By typing my name I agree to the terms of this agreement and consent to sign electronically.';

        if (hasProofColumns) {
            await pool.query(
                `INSERT INTO agreement_signatures
                    (agreement_id, lead_id, signer_name, signer_email, typed_name, signature_svg,
                     ip_address, user_agent, consent_text,
                     document_hash, document_snapshot, viewed_in_full,
                     autopay_consent, autopay_consent_text)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 ON CONFLICT (agreement_id) DO NOTHING`,
                [agreementId, a.lead_id, name, (lead && lead.email) || a.customer_email, name, svg,
                 (ip || '').slice(0, 64), (userAgent || '').slice(0, 500), baseConsent,
                 docHash, docSnapshot, !!viewedInFull,
                 isAutopayAgreement, autopayConsentText]
            );
        } else {
            // Pre-011 shape. Signing still works; the proof is just not stored.
            console.warn('[LIFECYCLE] agreement_signatures lacks proof columns — '
                       + 'run migrations/011_autopay_receipts_and_outstanding.sql');
            await pool.query(
                `INSERT INTO agreement_signatures
                    (agreement_id, lead_id, signer_name, signer_email, typed_name, signature_svg,
                     ip_address, user_agent, consent_text)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (agreement_id) DO NOTHING`,
                [agreementId, a.lead_id, name, (lead && lead.email) || a.customer_email, name, svg,
                 (ip || '').slice(0, 64), (userAgent || '').slice(0, 500), baseConsent]
            );
        }

        await pool.query(
            `UPDATE sales_agreements
                SET status='signed', signed_at=NOW(), signature_name=$2, updated_at=NOW()
              WHERE id=$1`,
            [agreementId, name]
        );

        // ------------------------------------------------------------------
        // MAINTENANCE AGREEMENTS STOP HERE.
        //
        // A maintenance agreement is not a project SLA, and running the rest of
        // this function against one was wrong three ways: the plan's own
        // signed_at was never written (so the portal kept asking for a signature
        // even after signing, forever), a project timeline was created for work
        // that doesn't exist, and an invoice was raised for a plan that is
        // explicitly autopay — the customer would be billed twice, once by the
        // invoice and once by the monthly charge.
        //
        // Signing a maintenance agreement means one thing: the plan is signed.
        // It then activates if a payment method is already on file, or waits for
        // one.
        // ------------------------------------------------------------------
        // A reinstatement document does one thing: restart the plan it belongs
        // to. No project, no invoice, no admin assignment.
        if (a.agreement_kind === 'reinstatement') {
            await applyReinstatement(a);
            return { signed: true, kind: 'reinstatement', signatureSvg: svg };
        }

        // ------------------------------------------------------------------
        // A PRICE CHANGE AGREEMENT does exactly one thing: move the pending
        // price onto the plan. It creates nothing, cancels nothing, and starts
        // nothing — the plan has been running throughout on the old price.
        // ------------------------------------------------------------------
        if (a.agreement_kind === 'price_change') {
            const plan = (await pool.query(
                'SELECT * FROM maintenance_plans WHERE pending_agreement_id = $1 LIMIT 1',
                [agreementId])).rows[0];

            if (!plan) {
                // The plan may have been cancelled while the amendment sat
                // unsigned. Signing it then means nothing, and must not
                // resurrect anything.
                console.warn(`[LIFECYCLE] price change ${agreementId} signed but its plan is gone`);
                return { signed: true, kind: 'price_change', plan: null, signatureSvg: svg };
            }

            const oldAmount = Number(plan.amount || 0);
            const newAmount = plan.pending_amount != null
                ? Number(plan.pending_amount) : oldAmount;

            // Apply the amount AND the day, then clear the pending fields.
            // next_charge_date is recomputed from the new day so the next
            // charge lands where the customer just agreed it would, rather
            // than keeping the old date and moving only afterwards.
            const newDay = plan.pending_billing_day != null
                ? Number(plan.pending_billing_day) : null;
            await pool.query(
                `UPDATE maintenance_plans
                    SET amount = $2,
                        billing_day = COALESCE($3, billing_day),
                        pending_amount = NULL,
                        pending_agreement_id = NULL,
                        pending_billing_day = NULL,
                        pending_since = NULL,
                        updated_at = NOW()
                  WHERE id = $1`, [plan.id, newAmount, newDay]);

            if (newDay != null) {
                const reshaped = { ...plan, billing_day: newDay };
                await pool.query(
                    'UPDATE maintenance_plans SET next_charge_date = $2 WHERE id = $1',
                    [plan.id, dateOnly(nextChargeFor(reshaped, new Date()))]
                ).catch((e) => console.warn('[PRICE CHANGE] next charge not moved:', e.message));
            }

            // Keep the ORIGINAL agreement's headline price in step, so the
            // plan and the document the customer keeps do not disagree. Its
            // signature and its terms are untouched — only the figure moves,
            // and the amendment is the record of why.
            if (plan.agreement_id) {
                await pool.query(
                    `UPDATE sales_agreements
                        SET price = $2, autopay_amount = $2, updated_at = NOW()
                      WHERE id = $1`,
                    [plan.agreement_id, planChargeTotal({ ...plan, amount: newAmount })]
                ).catch((e) => console.warn('[PRICE CHANGE] original not updated:', e.message));
            }

            const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [plan.lead_id])).rows[0];
            const unit = intervalUnit(plan);
            const newTotal = planChargeTotal({ ...plan, amount: newAmount });
            if (lead) {
                await notify({
                    lead, kind: 'price_change_signed',
                    subject: `Your ${plan.label} price is now ${money(newTotal)}`,
                    bodyHtml:
                        `<p style="margin:0 0 12px">Thanks for signing. Your `
                        + `<strong style="color:#0d0f12">${plan.label}</strong> plan is now `
                        + `${money(newTotal)} per ${unit}, starting from your next charge on `
                        + `${prettyDate(plan.next_charge_date) || 'the usual date'}.</p>`
                        + `<p style="margin:0 0 12px">Nothing else about your plan has changed.</p>`,
                    cta: { url: PORTAL_URL, label: 'View your plan' },
                }).catch(() => {});
            }

            console.log(`[LIFECYCLE] price change ${a.agreement_number} signed — `
                      + `plan ${plan.id} moved from ${oldAmount} to ${newAmount}.`);

            return {
                signed: true, kind: 'price_change', plan,
                previousAmount: oldAmount, newAmount,
                message: `Signed. Your plan is now ${money(newTotal)} per ${unit}.`,
                signatureSvg: svg,
            };
        }

        if (a.agreement_kind === 'maintenance') {
            const plan = (await pool.query(
                `SELECT * FROM maintenance_plans WHERE agreement_id = $1 OR (lead_id = $2 AND agreement_id IS NULL)
                  ORDER BY (agreement_id = $1) DESC, id DESC LIMIT 1`,
                [agreementId, a.lead_id]
            )).rows[0];

            if (!plan) {
                console.warn(`[LIFECYCLE] maintenance agreement ${agreementId} signed but no plan found`);
                return { signed: true, kind: 'maintenance', plan: null, signatureSvg: svg };
            }

            // Any active saved method is enough to start billing.
            const pm = plan.payment_method_id
                ? (await pool.query(
                    `SELECT * FROM payment_methods WHERE id=$1 AND status='active'`, [plan.payment_method_id]
                  )).rows[0]
                : (await pool.query(
                    `SELECT * FROM payment_methods WHERE lead_id=$1 AND status='active'
                      ORDER BY is_default DESC, id DESC LIMIT 1`, [a.lead_id]
                  )).rows[0];

            const nextCharge = plan.next_charge_date || dateOnly(nextBillingDate(plan.billing_day || 1));

            const updated = (await pool.query(
                `UPDATE maintenance_plans
                    SET signed_at = COALESCE(signed_at, NOW()),
                        payment_method_id = COALESCE(payment_method_id, $3),
                        status = CASE WHEN $3::int IS NOT NULL THEN 'active' ELSE 'pending_payment_method' END,
                        activated_at = CASE WHEN $3::int IS NOT NULL THEN COALESCE(activated_at, NOW()) ELSE activated_at END,
                        next_charge_date = $4,
                        updated_at = NOW()
                  WHERE id = $1 AND lead_id = $2
                  RETURNING *`,
                [plan.id, a.lead_id, pm ? pm.id : null, nextCharge]
            )).rows[0];

            const ready = updated.status === 'active';

            // Bill the first period NOW rather than waiting for tonight's cron.
            // This is the point at which the plan is genuinely chargeable: the
            // document is signed and a method is on file.
            let firstCharge = null;
            if (ready && updated.next_charge_date
                && dateOnly(updated.next_charge_date) <= dateOnly(new Date())) {
                firstCharge = await chargeMaintenancePlan(updated)
                    .catch((e) => { console.warn('[LIFECYCLE] first charge:', e.message); return null; });
            }

            await notify({
                lead, kind: 'maintenance_agreement',
                subject: ready
                    ? `${plan.label} is active`
                    : `${plan.label} — one more step`,
                bodyHtml: ready
                    ? `<p style="margin:0 0 12px">Thanks for signing. Your <strong style="color:#0d0f12">${plan.label}</strong> plan is active.</p>
                       <p style="margin:0 0 12px">We'll charge ${money(planChargeTotal(plan))} to your ${esc0(pm)} ${intervalEach(plan)}, starting ${prettyDate(nextCharge)}. You'll get a receipt by email and SMS every time.</p>
                       <p style="margin:0">You can change the payment method or cancel any time from your portal — cancellation takes effect ${CANCELLATION_NOTICE_DAYS} days after you ask.</p>`
                    : `<p style="margin:0 0 12px">Thanks for signing your <strong style="color:#0d0f12">${plan.label}</strong> agreement.</p>
                       <p style="margin:0 0 12px">To start the plan, add a payment method in your portal under Plans. Once it's saved we'll bill ${money(planChargeTotal(plan))} ${intervalAdverb(plan)}, beginning ${prettyDate(nextCharge)}.</p>
                       <p style="margin:0">Nothing is charged until you add one.</p>`,
                smsText: ready
                    ? `Diamondback Coding: your ${plan.label} plan is active. First payment ${prettyDate(nextCharge)}.`
                    : `Diamondback Coding: ${plan.label} agreement signed. Add a payment method in your portal to start the plan.`,
                channels: ['email', 'sms', 'portal'],
                cta: { url: PORTAL_URL, label: ready ? 'View your plan' : 'Add a payment method' },
            });

            await adminNotify({
                kind: 'maintenance_signed',
                title: `${lead.name} signed ${plan.label}`,
                body: ready
                    ? `${money(planChargeTotal(plan))}${intervalSuffix(plan)} · active · first charge ${prettyDate(nextCharge)}`
                    : `${money(planChargeTotal(plan))}${intervalSuffix(plan)} · waiting on a payment method`,
                leadId: a.lead_id, entityType: 'maintenance_plan', entityId: plan.id,
                severity: ready ? 'success' : 'warning',
                onceKey: `maintenance_signed:${plan.id}`,
            });

            return {
                signed: true, kind: 'maintenance', plan: updated,
                active: ready, signatureSvg: svg,
            };
        }

        // ----------------------------------------------------------------------
        // From here on the signature is ALREADY COMMITTED. Everything below —
        // admin assignment, project, milestones, invoices, email — is follow-up
        // work. If any of it throws, the customer must NOT see "signing failed"
        // for something that succeeded: they retry, hit the once-guard, and are
        // told it's already signed while the screen still says Review & sign.
        // So the rest runs inside its own try and reports partial failure.
        // ----------------------------------------------------------------------
        const followUpErrors = [];

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

        const items = (await pool.query(
            'SELECT * FROM agreement_items WHERE agreement_id=$1 ORDER BY sort_order, id', [agreementId]
        )).rows;

        // The timeline comes from the milestones written on the agreement. If
        // none were given, fall back to the line items so an itemised agreement
        // still produces a usable timeline rather than an empty one.
        let seed = [];
        try {
            seed = (await pool.query(
                'SELECT title, description, due_date FROM agreement_milestones WHERE agreement_id=$1 ORDER BY sort_order, id',
                [agreementId]
            )).rows;
        } catch (e) {
            console.warn('[LIFECYCLE] agreement_milestones unavailable:', e.message);
        }
        if (!seed.length) {
            seed = items.map((it) => ({
                title: it.description, description: it.detail || null, due_date: null,
            }));
        }
        for (const [i, m] of seed.entries()) {
            await pool.query(
                `INSERT INTO project_milestones (project_id, title, description, order_index, status, due_date)
                 VALUES ($1,$2,$3,$4,'pending',$5)`,
                [project.id, String(m.title).slice(0, 500), m.description || null, i, m.due_date || null]
            ).catch(async (e) => {
                // due_date only exists after migration 008.
                await pool.query(
                    `INSERT INTO project_milestones (project_id, title, description, order_index, status)
                     VALUES ($1,$2,$3,$4,'pending')`,
                    [project.id, String(m.title).slice(0, 500), m.description || null, i]
                ).catch((e2) => console.warn('[LIFECYCLE] milestone seed:', e2.message));
            });
        }

        await pool.query('UPDATE sales_agreements SET project_id=$2 WHERE id=$1', [agreementId, project.id]);

        // ---- invoice, due at estimated completion ---------------------------
        const total = await agreementTotal(agreementId, a);
        const dueDate = a.est_completion_date
            || dateOnly(new Date(Date.now() + (Number(a.net_days) || 14) * 86400000));

        // A project balance is due at completion, not today — so it is NOT
        // outstanding yet. If the agreement requires a deposit, that deposit is
        // billed separately and IS outstanding, because the project doesn't
        // start until it's paid.
        const depositPct = Number(a.deposit_pct) || 0;
        const wantsDeposit = !!a.require_deposit && depositPct > 0;
        const depositAmount = wantsDeposit
            ? (Number(a.deposit) || +(total * depositPct / 100).toFixed(2))
            : 0;
        const balance = +(total - depositAmount).toFixed(2);

        let depositInvoice = null;
        if (wantsDeposit && depositAmount > 0) {
            depositInvoice = await createInvoice({
                leadId: a.lead_id,
                amount: depositAmount,
                taxRate: 0,
                description: `Deposit (${depositPct}%) — ${a.package_name || 'Project'}${a.agreement_number ? ` · ${a.agreement_number}` : ''}`,
                dueDate: dateOnly(new Date()),      // due on signing
                estimated: false,
                agreementId,
                projectId: project.id,
                obligation: 'due_now',
                isDeposit: true,
            });
            await pool.query(
                'UPDATE sales_agreements SET deposit_invoice_id=$2 WHERE id=$1',
                [agreementId, depositInvoice.id]
            );
        }

        const invoice = await createInvoice({
            leadId: a.lead_id,
            amount: balance,
            taxRate: a.tax_rate || 0,
            description: `${a.package_name || 'Project'}${a.agreement_number ? ` — ${a.agreement_number}` : ''}${wantsDeposit ? ' (balance)' : ''}`,
            dueDate,
            estimated: !!a.est_completion_date,
            agreementId,
            projectId: project.id,
            obligation: 'on_completion',
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
                ${assignedAdmin ? `<p style="margin:0 0 12px"><strong style="color:#0d0f12">${assignedAdmin.username || 'Your project lead'}</strong> is assigned to your project and will reach out soon.</p>` : ''}
                <p style="margin:0 0 12px">Your project timeline is now in your portal, and it updates as we hit each milestone.</p>
                ${depositInvoice ? `<p style="margin:0 0 12px">A deposit of <strong style="color:#15803d">${money(depositInvoice.total_amount)}</strong> (invoice ${depositInvoice.invoice_number}) is due now — work begins once it's paid. You can pay it in your portal.</p>` : ''}
                <p style="margin:0">${depositInvoice ? 'The remaining balance of' : "We've also created invoice"} <strong style="color:#0d0f12">${depositInvoice ? money(invoice.total_amount) : invoice.invoice_number}</strong>${depositInvoice ? ` is invoice ${invoice.invoice_number} and` : ` for ${money(invoice.total_amount)}. It`} isn't due until <strong style="color:#15803d">${prettyDate(dueDate)}</strong>${a.est_completion_date ? ' — the estimated completion date. If we finish sooner, that date may move up and we\'ll tell you first.' : '.'}</p>`,
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

        return {
            signed: true, invoice, depositInvoice, project, assignedAdmin,
            signatureSvg: svg,
            followUpErrors,
        };
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
            bodyHtml: `<p style="margin:0 0 12px">We've completed <strong style="color:#0d0f12">${m.title}</strong> on ${m.project_name}.</p>
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
                        -- The work is done, so the balance is now genuinely
                        -- owed. Until this moment it was 'on_completion' and
                        -- deliberately excluded from the outstanding total.
                        obligation = 'due_now',
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
            bodyHtml: `<p style="margin:0 0 12px">Your project <strong style="color:#0d0f12">${p.project_name}</strong> is complete. Every milestone is marked done in your portal.</p>
                ${invoice && !paid ? `<p style="margin:0 0 12px">Invoice <strong style="color:#0d0f12">${invoice.invoice_number}</strong> for ${money(invoice.total_amount)} is now due <strong style="color:#15803d">${prettyDate(invoice.due_date)}</strong>. You can pay it in your portal.</p>` : ''}
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
                bodyHtml: `<p style="margin:0 0 12px">Invoice <strong style="color:#0d0f12">${invoice.invoice_number}</strong> for <strong style="color:#15803d">${money(invoice.total_amount)}</strong> is due on ${prettyDate(invoice.due_date)}.</p>
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
               FROM invoices i
              WHERE i.lead_id=$1 AND i.${OPEN_STATUSES}
                AND COALESCE(i.obligation,'due_now') = 'due_now'
                ${signedGate('i')}`,
            [p.lead_id]
        );
        const owing = Number(outstanding.rows[0].n);

        await notify({
            lead, kind: 'invoice_paid',
            subject: invoice ? `Payment received — ${invoice.invoice_number}` : 'Payment received',
            bodyHtml: `<p style="margin:0 0 16px">We've received your payment. Thank you.</p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;background:#f7f8f9;border-radius:8px">
                  <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Amount</td><td style="padding:10px 16px;color:#15803d;font-size:17px;font-weight:700">${money(p.amount)}</td></tr>
                  <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Receipt</td><td style="padding:10px 16px;color:#0d0f12;font-family:monospace;font-size:13px">${p.receipt_number}</td></tr>
                  ${invoice ? `<tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Invoice</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${invoice.invoice_number}</td></tr>` : ''}
                  ${p.method_last4 ? `<tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Method</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${p.method_brand || p.method} ending ${p.method_last4}</td></tr>` : ''}
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
     * The payment method to charge for a customer.
     *
     * Account-level by design: leads.default_payment_method_id is the single
     * method used for invoices, maintenance, domain renewals and the CRM alike.
     * `override` exists only so pre-existing per-plan rows keep working.
     */
    async function resolvePaymentMethod(leadId, override) {
        if (override) {
            const r = await pool.query(
                `SELECT * FROM payment_methods WHERE id=$1 AND status='active'`, [override]);
            if (r.rows[0]) return r.rows[0];
        }
        const acct = await pool.query(
            `SELECT pm.* FROM leads l
               JOIN payment_methods pm ON pm.id = l.default_payment_method_id
              WHERE l.id = $1 AND pm.status = 'active'`, [leadId]);
        if (acct.rows[0]) return acct.rows[0];
        const any = await pool.query(
            `SELECT * FROM payment_methods WHERE lead_id=$1 AND status='active'
              ORDER BY is_default DESC, id DESC LIMIT 1`, [leadId]);
        return any.rows[0] || null;
    }

    /**
     * Make a method the account default, and point everything at it.
     *
     * Called whenever a method is added or chosen. Because it also clears the
     * per-plan overrides, a customer can never end up with one plan quietly
     * billing an old card.
     */
    async function setAccountPaymentMethod(leadId, paymentMethodId) {
        await pool.query('UPDATE payment_methods SET is_default = FALSE WHERE lead_id = $1', [leadId]);
        await pool.query('UPDATE payment_methods SET is_default = TRUE WHERE id = $1 AND lead_id = $2',
                         [paymentMethodId, leadId]);
        await pool.query('UPDATE leads SET default_payment_method_id = $2, updated_at = NOW() WHERE id = $1',
                         [leadId, paymentMethodId]);
        await pool.query(
            `UPDATE maintenance_plans
                SET payment_method_id = NULL,
                    status = CASE WHEN status = 'pending_payment_method' AND signed_at IS NOT NULL
                                  THEN 'active' ELSE status END,
                    activated_at = CASE WHEN status = 'pending_payment_method' AND signed_at IS NOT NULL
                                        THEN COALESCE(activated_at, NOW()) ELSE activated_at END,
                    consecutive_failures = 0,
                    updated_at = NOW()
              WHERE lead_id = $1 AND status <> 'cancelled'`,
            [leadId]
        );
        // ------------------------------------------------------------------
        // CATCH UP EVERYTHING THAT WAS MISSED WHILE THERE WAS NO CARD.
        //
        // Signing an agreement and then not adding a payment method used to be
        // free: the plan sat at pending_payment_method, the charge job skipped
        // it because there was nothing to charge, and every period that went by
        // was simply never billed. Add the card six months later and billing
        // started from that day — the six months were gone.
        //
        // Now adding a method settles the arrears. Every period whose date has
        // passed is charged, with its late fee, oldest first. That is what
        // makes "sign it and stall" stop being a way to get free service.
        // ------------------------------------------------------------------
        setImmediate(() => {
            catchUpAfterMethodAdded(leadId).catch((e) =>
                console.error('[CATCH-UP] failed for lead', leadId, '-', e.message));
        });

        return paymentMethodId;
    }

    /**
     * Charge every period that fell due while the account had no payment
     * method, plus a late fee for each one that is genuinely late.
     *
     * Runs detached from the request that added the card: the customer should
     * see "card saved" immediately, not wait on a run of charges. Failures are
     * logged and left to the daily job — a card that saves must never appear to
     * fail because a catch-up charge was declined.
     */
    async function catchUpAfterMethodAdded(leadId) {
        const arrears = require('./diamondback-arrears.js');

        const plans = (await pool.query(
            `SELECT * FROM maintenance_plans
              WHERE lead_id = $1
                AND status IN ('active','past_due','pending_payment_method')
                AND signed_at IS NOT NULL`, [leadId])).rows;

        for (const plan of plans) {
            const method = await methodForPlan(plan);
            if (!method) continue;

            const perPeriod = planChargeTotal(plan, method);
            if (perPeriod <= 0) continue;

            const owed = arrears.arrearsFor(plan, perPeriod);
            if (!owed.periodsMissed) continue;

            console.log(`[CATCH-UP] plan ${plan.id}: ${owed.periodsMissed} period(s) missed, `
                      + `${owed.total} owed plus ${owed.lateTotal} in late fees.`);

            // Record the late fees first so they are on the account even if a
            // charge is declined below.
            for (const period of owed.periods) {
                if (!period.isLate || period.lateFee <= 0) continue;
                await pool.query(
                    `INSERT INTO late_fees
                        (lead_id, maintenance_plan_id, base_amount, rate, amount,
                         due_date, period_key, notes)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT DO NOTHING`,
                    [leadId, plan.id, plan.amount, period.lateFeeRate, period.lateFee,
                     period.dueDate, `plan:${plan.id}:${period.dueDate}`,
                     `Late fee — ${plan.label} for ${period.dueDate} (no payment method on file)`]
                ).catch((e) => console.warn('[CATCH-UP] late fee not recorded:', e.message));
            }

            // Then charge the missed periods, oldest first. chargeMaintenancePlan
            // advances next_charge_date each time, so the loop walks forward
            // naturally and stops when nothing is due.
            let guard = 0;
            while (guard < owed.periodsMissed && guard < 24) {
                const fresh = (await pool.query(
                    'SELECT * FROM maintenance_plans WHERE id=$1', [plan.id])).rows[0];
                if (!fresh || !fresh.next_charge_date) break;
                if (new Date(fresh.next_charge_date) > new Date()) break;   // caught up
                const out = await chargeMaintenancePlan(fresh).catch((e) => {
                    console.warn(`[CATCH-UP] plan ${plan.id} charge failed:`, e.message);
                    return null;
                });
                // Stop on a decline — dunning takes over rather than hammering
                // a card that has already refused once.
                if (!out || out.ok === false) break;
                guard += 1;
            }
        }
    }

    /**
     * Charge one due maintenance plan. Autopay, so by default no invoice is
     * created — the customer gets a receipt, not a bill to act on. Set
     * generate_invoice on the plan to produce a document anyway.
     */
    /**
     * An invoice is only a real obligation when the document behind it has been
     * SIGNED. An unsigned SLA or an unsigned maintenance plan must never show a
     * balance, chase the customer, or block a cancellation.
     *
     * Invoices tied to nothing (ad-hoc admin invoices) are unaffected — there is
     * no document to sign, so they stand on their own.
     *
     * `a` is the alias the caller uses for the invoices table.
     */
    function signedGate(a = 'i') {
        return `
            AND (${a}.agreement_id IS NULL OR EXISTS (
                    SELECT 1 FROM sales_agreements sa_g
                     WHERE sa_g.id = ${a}.agreement_id
                       AND (sa_g.signed_at IS NOT NULL OR sa_g.status = 'signed')))
            AND (${a}.maintenance_plan_id IS NULL OR EXISTS (
                    SELECT 1 FROM maintenance_plans mp_g
                     WHERE mp_g.id = ${a}.maintenance_plan_id
                       AND mp_g.signed_at IS NOT NULL))`;
    }

    /** Invoices that are genuinely outstanding for a customer right now. */
    const OPEN_STATUSES = `status NOT IN ('paid','void','cancelled','refunded','draft')`;

    async function chargeMaintenancePlan(plan) {
        const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [plan.lead_id])).rows[0];
        if (!lead) return { ok: false, error: 'lead missing' };

        // One payment method per ACCOUNT, not per plan. Resolution order:
        // an explicit per-plan override (legacy rows only), then the account
        // default, then any active method. Adding one card therefore covers
        // every plan the customer has.
        //
        // RESOLVED BEFORE PRICING, not after: the processing fee applies only
        // to a credit card, so the amount is not knowable until we know what
        // we are charging. Getting this order wrong is how you surcharge a
        // debit card, which is a federal violation.
        const pm = await resolvePaymentMethod(plan.lead_id, plan.payment_method_id);

        // The one source of truth for the amount: base + domain maintenance fee
        // (renewals only) + sales tax + credit-card processing fee. Everything
        // below uses priced.total, never plan.amount, so the charge, the
        // receipt and the agreement cannot disagree.
        const priced = planPricing(plan, pm);
        const chargeAmount = priced.total;

        if (!pm) {
            // LOOPHOLE FIX: without this the plan just stopped billing and the
            // customer kept the service for nothing, forever, silently. The due
            // date is NOT advanced — the period stays owed — and the misses are
            // counted so the plan suspends rather than drifting on unpaid.
            const missed = Number(plan.consecutive_failures || 0) + 1;
            await pool.query(
                `UPDATE maintenance_plans
                    SET status = CASE WHEN $2 >= 3 THEN 'suspended' ELSE 'pending_payment_method' END,
                        consecutive_failures = $2,
                        suspended_at = CASE WHEN $2 >= 3 THEN COALESCE(suspended_at, NOW()) ELSE suspended_at END,
                        updated_at = NOW()
                  WHERE id=$1`,
                [plan.id, missed]
            );
            // No method means no surcharge, so this quote is the fee-free
            // figure — which is also exactly what they would owe if they add a
            // bank account or debit card.
            const owedNoMethod = planPricing(plan, null).total;
            await notify({
                lead, kind: 'maintenance_no_method',
                subject: `Action needed — ${plan.label} has no payment method`,
                bodyHtml: `<p style="margin:0 0 12px">We couldn't bill your <strong style="color:#0d0f12">${plan.label}</strong> plan because there's no payment method on file.</p>
                           <p style="margin:0 0 12px">This period (${money(owedNoMethod)}) is still owed. Add a method in your portal and we'll settle it straight away.</p>
                           <p style="margin:0">${missed >= 3 ? 'The plan is now suspended until a method is added.' : 'The plan pauses if we cannot bill it after three attempts.'}</p>`,
                smsText: `Diamondback Coding: ${plan.label} couldn't be billed — no payment method on file. Add one in your portal.`,
                channels: ['email', 'sms', 'portal'],
                cta: { url: PORTAL_URL, label: 'Add a payment method' },
            }).catch((e) => console.warn('[LIFECYCLE] no-method notify:', e.message));
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
                amount: Math.round(chargeAmount * 100),
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
            // LOOPHOLE FIX: 'past_due' alone left the plan running and being
            // retried indefinitely — unlimited free service after a card was
            // cancelled. Past due at 3, suspended at 6, and the unpaid period is
            // never written off: next_charge_date stays where it is.
            await pool.query(
                `UPDATE maintenance_plans
                    SET consecutive_failures=$2,
                        status = CASE WHEN $2 >= 6 THEN 'suspended'
                                      WHEN $2 >= 3 THEN 'past_due'
                                      ELSE status END,
                        suspended_at = CASE WHEN $2 >= 6 THEN COALESCE(suspended_at, NOW()) ELSE suspended_at END,
                        updated_at=NOW()
                  WHERE id=$1`, [plan.id, failures]
            );
            await notify({
                lead, kind: 'maintenance_charge_failed',
                subject: `We couldn't process your ${plan.label} payment`,
                bodyHtml: `<p style="margin:0 0 12px">We tried to charge ${money(chargeAmount)} for <strong style="color:#0d0f12">${plan.label}</strong> and it didn't go through.</p>
                           <p style="margin:0 0 12px">${e.message}</p>
                           <p style="margin:0">Please update your payment method in your portal — we'll retry automatically.</p>`,
                smsText: `Diamondback Coding: your ${plan.label} payment of ${money(chargeAmount)} didn't go through. Please update your payment method in your portal.`,
                channels: ['email', 'sms', 'portal'],
            });
            await adminNotify({
                kind: 'maintenance_charge_failed',
                title: `Charge failed: ${lead.name} — ${plan.label}`,
                body: `${money(chargeAmount)} · attempt ${failures} · ${e.message}`,
                leadId: plan.lead_id, entityType: 'maintenance_plan', entityId: plan.id,
                severity: failures >= 3 ? 'error' : 'warning',
                onceKey: `charge_failed:${plan.id}:${dateOnly(new Date())}`,
            });
            return { ok: false, error: e.message };
        }

        let invoice = null;
        if (plan.generate_invoice) {
            invoice = await createInvoice({
                leadId: plan.lead_id, amount: chargeAmount,
                // `priced`, NOT `pricing` — `pricing` is the imported module
                // and is always truthy, so the old check silently produced
                // "$0.00" for every component of a renewal.
                description: priced.lines.length > 1
                    ? `${plan.label} (${priced.lines.map((l) => `${l.label} ${money(l.amount)}`).join(' + ')})`
                    : plan.label,
                dueDate: dateOnly(new Date()),
                maintenancePlanId: plan.id, autoGenerated: true,
            }).catch((e) => { console.warn('[LIFECYCLE] maintenance invoice:', e.message); return null; });
        }

        const { payment } = await recordPayment({
            leadId: plan.lead_id,
            invoiceId: invoice ? invoice.id : null,
            maintenancePlanId: plan.id,
            amount: chargeAmount,
            kind: 'maintenance',
            method: pm.type, methodLast4: pm.last4, methodBrand: pm.brand || pm.bank_name,
            description: plan.label,
            stripePaymentIntentId: intent.id,
            stripeChargeId: intent.latest_charge || null,
            // What the receipt itemises. The domain maintenance fee rides with
            // the base, because it is part of the service, not a surcharge.
            baseAmount: priced.subtotal,
            taxAmount: priced.tax,
            processingFee: priced.fee,
        });

        const next = nextChargeFor(plan, new Date());
        await pool.query(
            `UPDATE maintenance_plans
                SET last_charge_date=CURRENT_DATE, next_charge_date=$2,
                    charges_completed=COALESCE(charges_completed,0)+1,
                    consecutive_failures=0, last_payment_id=$3,
                    status = CASE WHEN status='past_due' THEN 'active' ELSE status END,
                    -- CLOSE THE PERIOD THAT WAS JUST PAID, and open the next.
                    -- These two columns are what the outstanding balance reads.
                    -- settlePlanPeriod() existed for this and was never wired
                    -- up, so a plan charged successfully still showed the month
                    -- as unpaid on the customer's dashboard — forever, and it
                    -- would have accrued a late fee on money already taken.
                    current_period_start = $2,
                    current_period_paid_at = NULL,
                    past_due_since = NULL,
                    updated_at=NOW()
              WHERE id=$1`,
            [plan.id, dateOnly(next), payment.id]
        ).catch(async (e) => {
            // Pre-011/013 database: fall back to the columns that do exist
            // rather than losing the charge bookkeeping entirely.
            console.warn('[LIFECYCLE] period columns unavailable:', e.message);
            await pool.query(
                `UPDATE maintenance_plans
                    SET last_charge_date=CURRENT_DATE, next_charge_date=$2,
                        charges_completed=COALESCE(charges_completed,0)+1,
                        consecutive_failures=0, last_payment_id=$3,
                        status = CASE WHEN status='past_due' THEN 'active' ELSE status END,
                        updated_at=NOW()
                  WHERE id=$1`,
                [plan.id, dateOnly(next), payment.id]);
        });

        // Any late fee raised against the period we just collected is settled
        // with it — a fee for being late on money that has now been taken is
        // not a fee anyone should be chasing.
        await pool.query(
            `UPDATE late_fees SET status='paid', paid_at=NOW(), payment_id=$2, updated_at=NOW()
              WHERE maintenance_plan_id=$1 AND status='outstanding'
                AND due_date <= CURRENT_DATE`,
            [plan.id, payment.id]
        ).catch(() => { /* pre-013 */ });

        // One row per component — plan, domain maintenance fee, sales tax, and
        // the credit card processing fee. Colour is --muted at 6:1, not the old
        // #7c848f, which was 3.8:1 and washed out in the light email theme.
        const breakdownRows = priced.lines.length > 1
            ? priced.lines.map((l) =>
                `<tr><td style="padding:4px 16px;color:#5c646f;font-size:12px">&nbsp;&nbsp;${l.label}</td>` +
                `<td style="padding:4px 16px;color:#5c646f;font-size:12px">${money(l.amount)}</td></tr>`).join('')
            : '';
        await notify({
            lead, kind: 'maintenance_charged',
            subject: `${plan.label} — payment received (${money(chargeAmount)})`,
            bodyHtml: `<p style="margin:0 0 16px">Your ${plan.label} payment has been processed. Here's your receipt.</p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;background:#f7f8f9;border-radius:8px">
                  <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Amount</td><td style="padding:10px 16px;color:#15803d;font-size:17px;font-weight:700">${money(chargeAmount)}</td></tr>
                  ${breakdownRows}
                  <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Receipt</td><td style="padding:10px 16px;color:#0d0f12;font-family:monospace;font-size:13px">${payment.receipt_number}</td></tr>
                  <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Method</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${pm.brand || pm.bank_name || pm.type} ending ${pm.last4 || '----'}</td></tr>
                  <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Next payment</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${prettyDate(next)}</td></tr>
                </table>
                <p style="margin:0">Your full payment history is in your portal. You can cancel anytime there — cancellation takes effect ${CANCELLATION_NOTICE_DAYS} days after you request it.</p>`,
            smsText: `Diamondback Coding: ${plan.label} payment of ${money(chargeAmount)} processed. Receipt ${payment.receipt_number}. Next payment ${prettyDate(next)}.`,
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
    async function requestPlanCancellation({ planId, leadId, reason, requestedBy = 'customer', settlementInvoiceId = null }) {
        const plan = (await pool.query(
            'SELECT * FROM maintenance_plans WHERE id=$1 AND lead_id=$2', [planId, leadId]
        )).rows[0];
        if (!plan) throw new Error('Plan not found');
        if (plan.status === 'cancelled') throw new Error('This plan is already cancelled');

        // ------------------------------------------------------------------
        // SIGNED, BUT NEVER PAID FOR — UNWIND IT RATHER THAN CANCEL IT.
        //
        // A plan that has been signed but has never had a payment method and
        // has never been charged has not started. Cancelling it as though it
        // were live would raise a settlement invoice for a service that never
        // ran, and would leave a "cancelled" plan in the history of a customer
        // who simply changed their mind before starting.
        //
        // So it goes back to exactly where it was before signing: the plan to
        // pending_signature, the agreement to 'sent' and unsigned, the
        // signature removed. The agreement is still there, still available to
        // sign whenever they are ready. Nothing is owed, because nothing was
        // ever provided.
        //
        // This only applies with NO METHOD and NO CHARGES. The moment either
        // exists the plan has started and the normal settlement rules apply —
        // which is what stops it becoming a way to walk away from an
        // agreement you have already had service under.
        // ------------------------------------------------------------------
        const everCharged = Number(plan.charges_completed || 0) > 0 || !!plan.last_charge_date;
        const hasMethod = !!(await methodForPlan(plan));

        if (plan.signed_at && !everCharged && !hasMethod) {
            await pool.query(
                `UPDATE maintenance_plans
                    SET status = 'pending_signature',
                        signed_at = NULL,
                        activated_at = NULL,
                        current_period_paid_at = NULL,
                        past_due_since = NULL,
                        updated_at = NOW()
                  WHERE id = $1`, [plan.id]);

            if (plan.agreement_id) {
                await pool.query(
                    `UPDATE sales_agreements
                        SET status = 'sent', signed_at = NULL, signature_name = NULL, updated_at = NOW()
                      WHERE id = $1`, [plan.agreement_id]).catch(() => {});
                await pool.query('DELETE FROM agreement_signatures WHERE agreement_id = $1',
                                 [plan.agreement_id]).catch(() => {});
                // Release the once-guard so it can be signed again.
                await pool.query('DELETE FROM lifecycle_events WHERE once_key = $1',
                                 [`sla_signed:agreement:${plan.agreement_id}`]).catch(() => {});
            }

            // Any late fee raised against a plan that never started is void.
            await pool.query(
                `UPDATE late_fees
                    SET status='waived', waived_at=NOW(), waived_by='system',
                        waive_reason='Plan unwound before it started — no payment method was ever added',
                        updated_at=NOW()
                  WHERE maintenance_plan_id=$1 AND status='outstanding'`, [plan.id]).catch(() => {});

            console.log(`[LIFECYCLE] plan ${plan.id} unwound — signed but never paid for. `
                      + 'Agreement is unsigned and pending again.');

            return {
                unwound: true,
                planId: plan.id,
                agreementId: plan.agreement_id || null,
                message: 'That plan never started, so nothing is owed. Your agreement is back to '
                       + 'unsigned and is still there whenever you want it — adding a payment '
                       + 'method is what starts a plan.',
            };
        }

        // Nothing cancels while money is owed. The notice period is served, not
        // waived, so the periods inside it are payable — and a missed charge
        // can't be walked away from by cancelling.
        const quote = await cancellationSettlement({ kind: 'maintenance', id: planId, leadId });
        if (quote.mustSettle && requestedBy === 'customer') {
            let settled = false;
            if (settlementInvoiceId) {
                const inv = (await pool.query(
                    `SELECT status FROM invoices WHERE id=$1 AND lead_id=$2`, [settlementInvoiceId, leadId]
                )).rows[0];
                settled = !!inv && inv.status === 'paid';
            }
            if (!settled) {
                const err = new Error(
                    `${money(quote.total)} is outstanding on this plan, including the ${CANCELLATION_NOTICE_DAYS}-day notice period. It has to be paid before the plan can be cancelled.`);
                err.code = 'SETTLEMENT_REQUIRED';
                err.quote = quote;
                throw err;
            }
        }

        const existing = await pool.query(
            `SELECT * FROM plan_cancellations WHERE maintenance_plan_id=$1 AND status='pending'`, [planId]
        );
        if (existing.rows.length) {
            return { alreadyPending: true, cancellation: existing.rows[0] };
        }

        const effective = new Date(Date.now() + CANCELLATION_NOTICE_DAYS * 86400000);
        const ins = await pool.query(
            `INSERT INTO plan_cancellations
                (maintenance_plan_id, lead_id, effective_at, notice_days, requested_by, reason, status,
                 confirmation_sent_at, settlement_amount, settlement_invoice_id, settled_at)
             VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW(),$7,$8,$9)
             RETURNING *`,
            [planId, leadId, effective, CANCELLATION_NOTICE_DAYS, requestedBy, reason || null,
             quote.total, settlementInvoiceId,
             quote.mustSettle ? new Date() : null]
        );
        const cancellation = ins.rows[0];

        await pool.query(
            `UPDATE maintenance_plans SET status='pending_cancellation', updated_at=NOW() WHERE id=$1`, [planId]
        );

        const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1', [leadId])).rows[0];
        await notify({
            lead, kind: 'cancellation_confirmed',
            subject: `Cancellation confirmed — ${plan.label}`,
            bodyHtml: `<p style="margin:0 0 12px">We've received your cancellation request for <strong style="color:#0d0f12">${plan.label}</strong>.</p>
                <p style="margin:0 0 12px">Your plan has a ${CANCELLATION_NOTICE_DAYS}-day notice period, so it stays active until <strong style="color:#15803d">${prettyDate(effective)}</strong>. You'll keep full service until then.</p>
                <p style="margin:0">Changed your mind? You can reinstate the plan from your portal any time before that date.</p>`,
            smsText: `Diamondback Coding: cancellation confirmed for ${plan.label}. Service continues until ${prettyDate(effective)}. You can reinstate in your portal before then.`,
            channels: ['email', 'sms', 'portal'],
            cta: { url: PORTAL_URL, label: 'Manage your plan' },
        });

        await adminNotify({
            kind: 'plan_cancellation_requested',
            title: `${lead.name} is cancelling ${plan.label}`,
            body: `Cancels in ${CANCELLATION_NOTICE_DAYS} days, on ${prettyDate(effective)}. ${money(planChargeTotal(plan))}${intervalSuffix(plan)}.${reason ? ` Reason: ${reason}` : ''}`,
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
            bodyHtml: `<p style="margin:0 0 12px">Good news — <strong style="color:#0d0f12">${plan.label}</strong> is reinstated and will continue as normal.</p>
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

    /**
     * Chase plans that were never signed, and expire the ones that stay unsigned.
     *
     * An unsigned plan cannot be billed (runMaintenanceCharges requires
     * signed_at), so without this it would sit there forever: no signature, no
     * payment, no cancellation, and no visibility. That is the "free
     * maintenance" gap — closed by making an unsigned plan a thing that chases
     * itself and then dies, rather than a thing that quietly persists.
     *
     * Days 3, 7 and 14: reminders. Day `UNSIGNED_EXPIRY_DAYS`: expired, with the
     * admin told so service can be stopped.
     */
    const UNSIGNED_REMINDER_DAYS = [3, 7, 14];
    const UNSIGNED_EXPIRY_DAYS = 21;

    async function chaseUnsignedPlans() {
        const out = { reminded: 0, expired: 0 };

        const pending = (await pool.query(
            `SELECT mp.*, l.name, l.email, l.phone,
                    (CURRENT_DATE - mp.created_at::date) AS age_days,
                    sa.agreement_number
               FROM maintenance_plans mp
               JOIN leads l ON l.id = mp.lead_id
               LEFT JOIN sales_agreements sa ON sa.id = mp.agreement_id
              WHERE mp.signed_at IS NULL
                AND mp.status IN ('pending_signature','pending_payment_method')`
        )).rows;

        for (const plan of pending) {
            const age = Number(plan.age_days || 0);
            const lead = { id: plan.lead_id, name: plan.name, email: plan.email, phone: plan.phone };

            if (age >= UNSIGNED_EXPIRY_DAYS) {
                await pool.query(
                    `UPDATE maintenance_plans
                        SET status='cancelled', cancelled_at=COALESCE(cancelled_at, NOW()), updated_at=NOW()
                      WHERE id=$1`, [plan.id]
                ).catch(async () => {
                    await pool.query(
                        `UPDATE maintenance_plans SET status='cancelled', updated_at=NOW() WHERE id=$1`,
                        [plan.id]).catch(() => {});
                });
                // Any invoice raised for a plan that never started is void.
                await pool.query(
                    `UPDATE invoices SET status='void', updated_at=NOW()
                      WHERE maintenance_plan_id=$1
                        AND status NOT IN ('paid','void','cancelled','refunded')`,
                    [plan.id]
                ).catch(() => {});

                await notify({
                    lead, kind: 'maintenance_expired',
                    subject: `${plan.label} — not started`,
                    bodyHtml: `<p style="margin:0 0 12px">Your <strong style="color:#0d0f12">${plan.label}</strong> agreement wasn't signed, so the plan hasn't started and nothing has been charged.</p>
                               <p style="margin:0">If you'd still like it, just let us know and we'll send a fresh agreement.</p>`,
                    channels: ['email', 'portal'],
                }).catch(() => {});

                await adminNotify({
                    kind: 'maintenance_expired',
                    title: `STOP SERVICE: ${plan.name} never signed ${plan.label}`,
                    body: `Unsigned for ${age} days — plan expired and its invoices voided. If service was switched on for them, turn it off.`,
                    leadId: plan.lead_id, entityType: 'maintenance_plan', entityId: plan.id,
                    severity: 'warning', onceKey: `plan_expired:${plan.id}`,
                });
                out.expired += 1;
                continue;
            }

            if (!UNSIGNED_REMINDER_DAYS.includes(age)) continue;

            const left = UNSIGNED_EXPIRY_DAYS - age;
            await notify({
                lead, kind: 'maintenance_unsigned_reminder',
                subject: `Reminder: ${plan.label} is waiting for your signature`,
                bodyHtml: `<p style="margin:0 0 12px">Your <strong style="color:#0d0f12">${plan.label}</strong> agreement is still waiting to be signed, so the plan hasn't started.</p>
                           <p style="margin:0 0 12px">Nothing has been charged and nothing will be until you sign.</p>
                           <p style="margin:0">If we don't hear from you within ${left} day${left === 1 ? '' : 's'} we'll close it off, and you can always ask for a new one.</p>`,
                smsText: `Diamondback Coding: ${plan.label} is still waiting for your signature. Nothing is charged until you sign.`,
                channels: ['email', 'sms', 'portal'],
                cta: { url: PORTAL_URL, label: 'Review & sign' },
            }).catch(() => {});

            await adminNotify({
                kind: 'maintenance_unsigned',
                title: `${plan.name} hasn't signed ${plan.label}`,
                body: `Unsigned for ${age} days. Expires in ${left}. Nothing billable until signed — check whether service is already switched on.`,
                leadId: plan.lead_id, entityType: 'maintenance_plan', entityId: plan.id,
                severity: 'warning', onceKey: `plan_unsigned:${plan.id}:${age}`,
            });
            out.reminded += 1;
        }

        return out;
    }

    /** Charge every maintenance plan due today. */
    async function runMaintenanceCharges() {
        // signed_at is required, in both directions: an unsigned plan is never
        // charged (no taking money against an unsigned document), and a signed
        // plan whose period is due is never skipped (which is what let people
        // sit on an active plan that quietly never billed).
        const due = await pool.query(
            `SELECT * FROM maintenance_plans
              WHERE status IN ('active','pending_cancellation')
                AND signed_at IS NOT NULL
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
                bodyHtml: `<p style="margin:0 0 12px"><strong style="color:#0d0f12">${c.label}</strong> is scheduled to cancel on <strong style="color:#15803d">${prettyDate(c.effective_at)}</strong> — that's ${daysLeft} day${daysLeft === 1 ? '' : 's'} away.</p>
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
        // ------------------------------------------------------------------
        // CRM subscriptions first. Their notice has expired, so CRM access is
        // revoked — but ONLY the CRM. portal_kind drops from 'both' back to
        // 'customer' and crm_access to FALSE, which leaves their customer portal,
        // invoices and receipts completely intact. Cancelling the CRM must never
        // cost someone their customer account.
        // ------------------------------------------------------------------
        try {
            const crmDue = await pool.query(
                `SELECT pc.*, cs.package_name, cs.monthly_total, cs.stripe_subscription_id,
                        l.name, l.email, l.phone
                   FROM plan_cancellations pc
                   JOIN crm_subscriptions cs ON cs.id = pc.subscription_id
                   JOIN leads l ON l.id = pc.lead_id
                  WHERE pc.status='pending' AND pc.subscription_id IS NOT NULL
                    AND pc.effective_at <= NOW()`
            );
            for (const c of crmDue.rows) {
                if (c.stripe_subscription_id && stripe) {
                    await stripe.subscriptions.cancel(c.stripe_subscription_id)
                        .catch((e) => console.warn('[CRM CANCEL COMPLETE] Stripe:', e.message));
                }
                await pool.query(
                    `UPDATE crm_subscriptions SET status='cancelled', cancelled_at=NOW(), updated_at=NOW() WHERE id=$1`,
                    [c.subscription_id]
                );
                await pool.query(
                    `UPDATE leads
                        SET crm_access = FALSE,
                            portal_kind = CASE WHEN portal_kind = 'both' THEN 'customer' ELSE portal_kind END,
                            updated_at = NOW()
                      WHERE id = $1`,
                    [c.lead_id]
                );
                await pool.query(
                    `UPDATE plan_cancellations SET status='completed', completed_at=NOW(), cancelled_email_sent_at=NOW() WHERE id=$1`,
                    [c.id]
                );
                await notify({
                    lead: { id: c.lead_id, name: c.name, email: c.email, phone: c.phone },
                    kind: 'cancellation_completed',
                    subject: 'Your CodeNexus CRM subscription has ended',
                    bodyHtml: `<p style="margin:0 0 12px">Your <strong style="color:#0d0f12">${c.package_name || 'CodeNexus CRM'}</strong> subscription has ended and you won't be billed again.</p>
                               <p style="margin:0 0 12px">Your customer portal is unchanged — your invoices, receipts, agreements and messages are all still there.</p>
                               <p style="margin:0">If you'd like the CRM back later, just reply to this email.</p>`,
                    smsText: 'Diamondback Coding: your CodeNexus CRM subscription has ended. Your customer portal and records are unaffected.',
                    channels: ['email', 'portal'],
                    cta: { url: PORTAL_URL, label: 'Open your portal' },
                });
                await adminNotify({
                    kind: 'crm_cancelled',
                    title: `${c.name}'s CRM subscription has ended`,
                    body: `${money(c.monthly_total)}/mo · CRM access revoked, customer portal retained`,
                    leadId: c.lead_id, entityType: 'crm_subscription', entityId: c.subscription_id,
                    severity: 'info', onceKey: `crm_cancel_completed:${c.id}`,
                });
            }
            if (crmDue.rows.length) console.log(`[LIFECYCLE] CRM cancellations completed: ${crmDue.rows.length}`);
        } catch (e) {
            console.error('[LIFECYCLE] CRM cancellation completion failed:', e.message);
        }

        const due = await pool.query(
            `SELECT pc.*, mp.label, mp.amount, mp.stripe_subscription_id, l.name, l.email, l.phone
               FROM plan_cancellations pc
               JOIN maintenance_plans mp ON mp.id = pc.maintenance_plan_id
               JOIN leads l ON l.id = pc.lead_id
              WHERE pc.status='pending' AND pc.maintenance_plan_id IS NOT NULL
                AND pc.effective_at <= NOW()`
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
                bodyHtml: `<p style="margin:0 0 12px"><strong style="color:#0d0f12">${c.label}</strong> is now cancelled. You won't be billed again.</p>
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
        // Chase (and eventually expire) plans that were never signed. An
        // unsigned plan can't be billed, so without this it would sit there
        // indefinitely — service switched on, nothing owed, nobody told.
        try { out.unsigned = await chaseUnsignedPlans(); } catch (e) { out.unsignedError = e.message; }
        // Dunning last: a maintenance charge earlier in this same run may have
        // just settled an invoice, and there's no sense dunning something that
        // was paid ninety seconds ago.
        try { out.dunning = await runDunning(); } catch (e) { out.dunningError = e.message; }
        // Late fees last: a charge earlier in this run may have settled the
        // very thing that would otherwise have been assessed as late.
        try { out.lateFees = (await lateFees.assessLateFees({})).length; }
        catch (e) { out.lateFeesError = e.message; }
        out.ranAt = new Date().toISOString();
        return out;
    }

    // ======================================================================
    // THE SCHEDULER
    //
    // AUTOPAY DOES NOT RUN BY ITSELF WITHOUT THIS.
    //
    // Everything above — charging plans, dunning, completing cancellations,
    // late fees — only happens when runDailyJobs() is called. Until now the
    // only caller was POST /api/cron/lifecycle-daily, which requires an
    // external scheduler AND a CRON_TOKEN environment variable. If either was
    // missing, no recurring charge was ever taken and nothing said so.
    //
    // An external cron is still the better answer on a multi-instance deploy,
    // because it runs exactly once. But "no cron configured" must not silently
    // mean "no billing", so this runs in-process as a fallback.
    //
    // The advisory lock is what makes that safe: if the app is running on two
    // instances, only one of them wins the lock and does the work. Without it,
    // two instances would both charge the same plan on the same day.
    // ======================================================================
    const BILLING_LOCK_KEY = 8472913;          // arbitrary, but must be stable
    let _lastDailyRun = null;

    async function runDailyJobsOnce(source = 'timer') {
        // One run per calendar day, whatever wakes it up.
        const today = new Date().toISOString().slice(0, 10);
        if (_lastDailyRun === today) return { skipped: 'already ran today' };

        let client;
        try {
            client = await pool.connect();
            // Non-blocking: if another instance holds it, we simply don't run.
            const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [BILLING_LOCK_KEY]);
            if (!got.rows[0].ok) {
                console.log('[LIFECYCLE] daily jobs already running elsewhere — skipping.');
                return { skipped: 'locked by another instance' };
            }
            try {
                _lastDailyRun = today;
                console.log(`[LIFECYCLE] running daily jobs (${source})…`);
                const out = await runDailyJobs();
                const charged = Array.isArray(out.charges) ? out.charges.length : 0;
                console.log(`[LIFECYCLE] daily jobs done — ${charged} charge(s) processed, `
                          + `${out.lateFees || 0} late fee(s), ${(out.dunning || []).length || 0} dunning.`);
                return out;
            } finally {
                await client.query('SELECT pg_advisory_unlock($1)', [BILLING_LOCK_KEY]).catch(() => {});
            }
        } catch (e) {
            console.error('[LIFECYCLE] daily jobs failed:', e.message);
            _lastDailyRun = null;      // let it retry on the next tick
            return { error: e.message };
        } finally {
            if (client) client.release();
        }
    }

    // Set BILLING_SCHEDULER=off if you run an external cron and would rather
    // this stayed out of the way.
    if (String(process.env.BILLING_SCHEDULER || 'on').toLowerCase() !== 'off') {
        // First run shortly after boot, so a restart cannot mean a missed day,
        // then hourly. runDailyJobsOnce() dedupes to one run per day.
        setTimeout(() => { runDailyJobsOnce('startup'); }, 90 * 1000);
        setInterval(() => { runDailyJobsOnce('hourly tick'); }, 60 * 60 * 1000);
        console.log('[LIFECYCLE] Billing scheduler ON — daily jobs run in-process '
                  + '(hourly tick, once per day, advisory-locked). '
                  + 'Set BILLING_SCHEDULER=off if an external cron handles this.');
    } else {
        console.log('[LIFECYCLE] Billing scheduler OFF — an external cron must POST '
                  + '/api/cron/lifecycle-daily or NOTHING WILL BE CHARGED.');
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
                html: `<p style="margin:0 0 12px">Invoice <strong style="color:#0d0f12">${num}</strong> for <strong style="color:#15803d">${amt}</strong> was due on ${prettyDate(invoice.due_date)} and is now ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} past due.</p>
                       <p style="margin:0 0 12px">If you've already sent payment, thank you — you can ignore this.</p>
                       <p style="margin:0">Otherwise you can pay by card or bank transfer in your portal.</p>`,
                sms: `Diamondback Coding: invoice ${num} (${amt}) is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} past due. Pay in your portal: ${PORTAL_URL}`,
            };
        }
        if (tone === 'firm') {
            return {
                subject: `Payment needed — invoice ${num}, ${daysOverdue} days past due`,
                html: `<p style="margin:0 0 12px">Invoice <strong style="color:#0d0f12">${num}</strong> for <strong style="color:#15803d">${amt}</strong> is now ${daysOverdue} days past due.</p>
                       <p style="margin:0 0 12px">Please arrange payment, or reply to this email so we can sort out anything that's in the way — if the timing is a problem, we'd rather hear it than keep sending reminders.</p>
                       <p style="margin:0">You can pay in your portal at any time.</p>`,
                sms: `Diamondback Coding: invoice ${num} (${amt}) is ${daysOverdue} days past due. Please pay or reply so we can help: ${PORTAL_URL}`,
            };
        }
        return {
            subject: `Final reminder — invoice ${num} is ${daysOverdue} days past due`,
            html: `<p style="margin:0 0 12px">Invoice <strong style="color:#0d0f12">${num}</strong> for <strong style="color:#15803d">${amt}</strong> is ${daysOverdue} days past due.</p>
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
              WHERE i.${OPEN_STATUSES}
                AND i.due_date IS NOT NULL
                AND i.due_date < CURRENT_DATE
                -- An estimated due date is a placeholder tied to project
                -- completion, not a real obligation. Never dun on one.
                AND COALESCE(i.due_date_estimated, FALSE) = FALSE
                AND COALESCE(i.obligation,'due_now') = 'due_now'
                -- Never chase money against an unsigned document.
                ${signedGate('i')}
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
              WHERE i.${OPEN_STATUSES}
                AND i.due_date IS NOT NULL
                AND i.due_date < CURRENT_DATE
                AND COALESCE(i.due_date_estimated, FALSE) = FALSE
                AND COALESCE(i.obligation,'due_now') = 'due_now'
                ${signedGate('i')}
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

        // card.funding is 'credit' | 'debit' | 'prepaid' | 'unknown'. It is the
        // ONLY thing that makes credit-only surcharging possible, and
        // surcharging a debit card is a federal violation — so if Stripe
        // doesn't tell us, we store 'unknown' and the pricing engine declines
        // to charge the fee rather than guessing.
        const funding = isCard ? String(card.funding || 'unknown').toLowerCase() : 'unknown';

        let r;
        try {
            r = await pool.query(
                `INSERT INTO payment_methods
                    (lead_id, stripe_customer_id, stripe_pm_id, type, brand, last4,
                     exp_month, exp_year, bank_name, is_default, status,
                     funding, funding_checked_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,NOW())
                 ON CONFLICT (stripe_pm_id) DO UPDATE
                    SET status='active', is_default=EXCLUDED.is_default,
                        funding=EXCLUDED.funding, funding_checked_at=NOW()
                 RETURNING *`,
                [leadId, stripeCustomerId, pm.id, pm.type,
                 isCard ? card.brand : null,
                 isCard ? card.last4 : bank.last4,
                 isCard ? card.exp_month : null,
                 isCard ? card.exp_year : null,
                 isCard ? null : bank.bank_name,
                 makeDefault, funding]
            );
        } catch (e) {
            // Pre-012 database: save without the funding columns rather than
            // refusing to store the customer's card.
            console.warn('[PRICING] payment_methods.funding unavailable — '
                       + 'run migrations/012_tax_and_processing_fee.sql:', e.message);
            r = await pool.query(
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
        }

        // One method per account: adding one makes it the default for
        // everything and releases any plan that was waiting for a card.
        if (makeDefault) await setAccountPaymentMethod(leadId, r.rows[0].id);

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

            // An account with anything recurring must ALWAYS have a method on
            // file. Removing the last one is refused outright — the customer
            // adds the replacement first, so there is never a window where a
            // renewal has nothing to charge.
            const relying = await pool.query(
                `SELECT COUNT(*)::int AS n FROM maintenance_plans
                  WHERE lead_id=$1 AND status IN ('active','pending_cancellation','past_due')`, [leadId]
            );
            let crmCount = { rows: [{ n: 0 }] };
            try {
                crmCount = await pool.query(
                    `SELECT COUNT(*)::int AS n FROM crm_subscriptions
                      WHERE lead_id=$1 AND COALESCE(status,'active') NOT IN ('cancelled','canceled','expired')`,
                    [leadId]);
            } catch (_) {}
            const others = await pool.query(
                `SELECT COUNT(*)::int AS n FROM payment_methods
                  WHERE lead_id=$1 AND id<>$2 AND status='active'`, [leadId, pm.id]
            );
            const recurring = relying.rows[0].n + crmCount.rows[0].n;
            if (recurring > 0 && others.rows[0].n === 0) {
                return res.status(409).json({
                    success: false,
                    code: 'LAST_METHOD',
                    message: 'This is the only payment method on your account, and you have a recurring plan. Add a new one first — we\'ll switch everything over, then you can remove this.',
                });
            }

            if (pm.stripe_pm_id) {
                await stripe.paymentMethods.detach(pm.stripe_pm_id).catch((e) =>
                    console.warn('[PORTAL PM DETACH]', e.message));
            }
            await pool.query("UPDATE payment_methods SET status='removed', is_default=FALSE WHERE id=$1", [pm.id]);
            // Hand the account default to whatever is left, so nothing is
            // pointing at a removed method.
            const next = (await pool.query(
                `SELECT id FROM payment_methods WHERE lead_id=$1 AND status='active'
                  ORDER BY is_default DESC, id DESC LIMIT 1`, [leadId])).rows[0];
            if (next) await setAccountPaymentMethod(leadId, next.id);
            else await pool.query('UPDATE leads SET default_payment_method_id = NULL WHERE id = $1', [leadId]);
            res.json({ success: true, message: 'Payment method removed.' });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not remove that payment method.' });
        }
    });

    // ======================================================================
    // Sales agreements (SLAs) — admin CRUD
    // ======================================================================
    // The admin portal's Sales Agreements tab called /api/sales-agreements and
    // /api/sales-agreement-clients, and NEITHER existed anywhere on the server.
    // The list was always empty, saving silently failed, and the "Assign to
    // client or lead" dropdown had nothing in it — which is why there was no way
    // to attach a customer to an SLA.

    /**
     * People an agreement can be assigned to.
     *
     * Customers first (they're who you usually write an SLA for), then leads who
     * haven't converted yet — you may well want an agreement drafted before the
     * conversion. has_portal tells the UI whether they can actually receive and
     * sign it in the portal.
     */
    app.get('/api/sales-agreement-clients', authenticateToken, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT id, name, email, phone, company,
                        COALESCE(is_customer, FALSE) AS is_customer,
                        (client_password IS NOT NULL) AS has_portal,
                        portal_kind
                   FROM leads
                  WHERE name IS NOT NULL OR email IS NOT NULL
                  ORDER BY COALESCE(is_customer, FALSE) DESC, name ASC`
            );
            res.json({ success: true, clients: r.rows });
        } catch (e) {
            console.error('[SA CLIENTS]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'The client list') });
        }
    });

    app.get('/api/sales-agreements', authenticateToken, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT sa.*,
                        l.name  AS lead_name,
                        l.email AS lead_email,
                        (l.client_password IS NOT NULL) AS lead_has_portal,
                        COALESCE(l.is_customer, FALSE)  AS lead_is_customer,
                        sig.signed_at AS signature_at,
                        sig.signer_name,
                        (SELECT COALESCE(SUM(amount),0) FROM agreement_items ai WHERE ai.agreement_id = sa.id) AS items_total,
                        (SELECT COUNT(*)::int FROM agreement_items ai WHERE ai.agreement_id = sa.id) AS item_count
                   FROM sales_agreements sa
                   LEFT JOIN leads l ON l.id = sa.lead_id
                   LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id
                  ORDER BY sa.created_at DESC`
            );
            res.json({ success: true, agreements: r.rows, salesAgreements: r.rows });
        } catch (e) {
            console.error('[SA LIST]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Sales agreements') });
        }
    });

    app.get('/api/sales-agreements/:id', authenticateToken, async (req, res) => {
        try {
            const a = (await pool.query(
                `SELECT sa.*, l.name AS lead_name, l.email AS lead_email
                   FROM sales_agreements sa LEFT JOIN leads l ON l.id = sa.lead_id
                  WHERE sa.id = $1`, [req.params.id]
            )).rows[0];
            if (!a) return res.status(404).json({ success: false, message: 'Agreement not found.' });
            const items = (await pool.query(
                'SELECT * FROM agreement_items WHERE agreement_id=$1 ORDER BY sort_order, id',
                [req.params.id]
            )).rows;
            const sig = (await pool.query(
                'SELECT signer_name, signed_at, signature_svg FROM agreement_signatures WHERE agreement_id=$1',
                [req.params.id]
            )).rows[0] || null;
            // Absent before migration 008, so a missing table must not 500 the
            // whole agreement.
            let milestones = [];
            try {
                milestones = (await pool.query(
                    'SELECT * FROM agreement_milestones WHERE agreement_id=$1 ORDER BY sort_order, id',
                    [req.params.id]
                )).rows;
            } catch (e) {
                console.warn('[SA GET] agreement_milestones unavailable:', e.message);
            }
            res.json({ success: true, agreement: a, items, milestones, signature: sig });
        } catch (e) {
            console.error('[SA GET]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'That agreement') });
        }
    });

    /**
     * Create an SLA. Accepts the exact field names the admin modal already
     * sends (snake_case), plus optional `items` for line items and
     * `est_completion_date`.
     *
     * `sendToPortal` (default true when a lead with a portal is assigned)
     * publishes it immediately: the agreement appears in their customer portal
     * and they get the ready-to-sign email + SMS. That's the automated hand-off
     * — signing then triggers invoice, timeline and admin assignment.
     */
    app.post('/api/sales-agreements', authenticateToken, async (req, res) => {
        const b = req.body || {};
        try {
            if (!b.service_type) {
                return res.status(400).json({ success: false, message: 'Choose a service type.' });
            }

            // Maintenance and domain plans are created in the Maintenance tab,
            // which builds the plan AND its agreement together. Creating a bare
            // agreement here would produce a document with no plan behind it —
            // nothing to bill, nothing to cancel.
            const MAINTENANCE_TYPES = ['monthly_maintenance', 'brevo_maintenance',
                                       'database_maintenance', 'domain_renewal', 'hosting'];
            if (b.agreement_kind === 'maintenance' || MAINTENANCE_TYPES.includes(b.service_type)) {
                return res.status(400).json({
                    success: false,
                    code: 'USE_MAINTENANCE_TAB',
                    message: 'Recurring plans are set up in the Maintenance tab — that creates the plan and its agreement together. Agreements made here would have no plan behind them.',
                });
            }

            const leadId = b.lead_id ? Number(b.lead_id) : null;
            let lead = null;
            if (leadId) {
                lead = (await pool.query(
                    'SELECT id, name, email, client_password, is_customer FROM leads WHERE id=$1', [leadId]
                )).rows[0];
                if (!lead) return res.status(404).json({ success: false, message: 'That client no longer exists.' });
            }

            // Agreement number: SA-00001, continuing from the highest existing.
            const numRes = await pool.query(
                `SELECT COALESCE(MAX(NULLIF(regexp_replace(agreement_number,'\\D','','g'),'')::bigint),0)+1 AS n
                   FROM sales_agreements WHERE agreement_number LIKE 'SA-%'`
            );
            const agreementNumber = `SA-${String(numRes.rows[0].n).padStart(5, '0')}`;

            const items = Array.isArray(b.items) ? b.items : [];
            const itemsTotal = items.reduce(
                (t, it) => t + (it.amount != null ? Number(it.amount)
                                                  : (Number(it.quantity) || 1) * (Number(it.unit_price) || 0)), 0);
            // Zero is a legitimate price — a goodwill fix, a bundled item, a
            // free first month. `itemsTotal > 0` would have quietly fallen back
            // to the flat price whenever the items summed to nothing.
            const price = items.length ? itemsTotal : (Number(b.price) || 0);

            const ins = await pool.query(
                `INSERT INTO sales_agreements
                    (agreement_number, lead_id, customer_name, customer_email, service_type,
                     package_name, project, vehicle, price, deposit_pct, require_deposit,
                     deposit, start_date, est_completion_date, status, terms, notes, intro,
                     tax_rate, net_days, agreement_kind, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'sla',NOW(),NOW())
                 RETURNING *`,
                [agreementNumber, leadId,
                 b.customer_name || (lead && lead.name) || null,
                 b.customer_email || (lead && lead.email) || null,
                 b.service_type, b.package_name || null, b.project || b.vehicle || null,
                 price,
                 Number(b.deposit_pct) || 0,
                 !!b.require_deposit,
                 b.require_deposit ? +(price * (Number(b.deposit_pct) || 0) / 100).toFixed(2) : 0,
                 b.start_date || null,
                 b.est_completion_date || null,
                 b.status || 'draft',
                 b.terms || null, b.notes || null, b.intro || null,
                 Number(b.tax_rate) || 0,
                 Number(b.net_days) || 14]
            );
            const agreement = ins.rows[0];

            // Milestones defined up front. Signing turns these into the
            // customer's project timeline — there is no separate step.
            const milestones = Array.isArray(b.milestones) ? b.milestones : [];
            for (const [i, m] of milestones.entries()) {
                if (!m || !String(m.title || '').trim()) continue;
                await pool.query(
                    `INSERT INTO agreement_milestones (agreement_id, sort_order, title, description, due_date)
                     VALUES ($1,$2,$3,$4,$5)`,
                    [agreement.id, i, String(m.title).slice(0, 300),
                     m.description || null, m.due_date || null]
                ).catch((e) => console.warn('[SA] milestone insert:', e.message));
            }

            for (const [i, it] of items.entries()) {
                await pool.query(
                    `INSERT INTO agreement_items
                        (agreement_id, sort_order, description, detail, quantity, unit_price, amount, is_optional)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [agreement.id, i, (it.description || 'Item').slice(0, 500), it.detail || null,
                     Number(it.quantity) || 1, Number(it.unit_price) || 0,
                     it.amount != null ? Number(it.amount)
                                       : (Number(it.quantity) || 1) * (Number(it.unit_price) || 0),
                     !!it.is_optional]
                ).catch((e) => console.warn('[SA] item insert:', e.message));
            }

            // Publish to the portal unless explicitly told not to. Only possible
            // if they actually have a portal account to receive it in.
            const wantSend = b.sendToPortal !== false && b.status !== 'draft';
            let sent = false;
            let sendError = null;
            if (wantSend && lead && lead.client_password) {
                try {
                    await onAgreementSent({ agreementId: agreement.id });
                    sent = true;
                } catch (e) {
                    sendError = e.message;
                    console.error('[SA] send failed:', e.message);
                }
            }

            res.json({
                success: true,
                agreement,
                automation: { emailed: sent, invoice: false, invoiceCount: 0 },
                sent,
                sendError,
                message: sent
                    ? `${agreementNumber} created and sent to ${lead.name}'s portal to sign.`
                    : (lead && !lead.client_password
                        ? `${agreementNumber} created. ${lead.name} has no portal account yet — create one and then send it.`
                        : `${agreementNumber} created as a draft.`),
            });
        } catch (e) {
            console.error('[SA CREATE]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Sales agreements') });
        }
    });

    app.patch('/api/sales-agreements/:id', authenticateToken, async (req, res) => {
        const b = req.body || {};
        try {
            const existing = (await pool.query(
                'SELECT * FROM sales_agreements WHERE id=$1', [req.params.id]
            )).rows[0];
            if (!existing) return res.status(404).json({ success: false, message: 'Agreement not found.' });

            // A maintenance agreement is generated FROM a plan and must only be
            // changed there. Editing it here rewrote the document while the plan
            // kept the old price and schedule, so the two disagreed and neither
            // the customer portal nor the Maintenance tab reflected the change.
            if (existing.agreement_kind === 'maintenance') {
                return res.status(409).json({
                    success: false,
                    code: 'MAINTENANCE_AGREEMENT',
                    message: 'This agreement belongs to a maintenance plan. Edit it from the Maintenance tab — changing it here would leave the plan and the document out of step.',
                });
            }

            // A signed agreement is a record of what was agreed. Editing its
            // terms or price after signature would rewrite that, so only the
            // status may move once it's signed.
            // Same reasoning as delete: signed_at survives a status change, so
            // check it rather than trusting the status string alone.
            const isSigned = existing.status === 'signed' || !!existing.signed_at;
            if (isSigned && Object.keys(b).some((k) => k !== 'status')) {
                return res.status(409).json({
                    success: false,
                    message: 'This agreement is signed and can no longer be edited. Create a new one for any changes.',
                });
            }

            const allowed = ['lead_id','customer_name','customer_email','service_type','package_name',
                             'project','vehicle','price','deposit','deposit_pct','require_deposit',
                             'start_date','est_completion_date','status','terms','notes','intro',
                             'tax_rate','net_days'];
            const sets = [];
            const vals = [];
            for (const k of allowed) {
                if (b[k] !== undefined) { vals.push(b[k] === '' ? null : b[k]); sets.push(`${k} = $${vals.length}`); }
            }
            if (!sets.length) return res.json({ success: true, agreement: existing, message: 'Nothing to change.' });

            vals.push(req.params.id);
            const upd = await pool.query(
                `UPDATE sales_agreements SET ${sets.join(', ')}, updated_at = NOW()
                  WHERE id = ${vals.length} RETURNING *`,
                vals
            );

            // Milestones and line items were accepted from the editor and then
            // thrown away here — the UI sends both on every save, so editing an
            // agreement to add milestones did nothing and reported success.
            // Replace-in-full matches what the editor shows: it is the whole
            // list, not a delta.
            if (Array.isArray(b.milestones)) {
                await pool.query('DELETE FROM agreement_milestones WHERE agreement_id=$1', [req.params.id])
                    .catch((e) => console.warn('[SA UPDATE] clear milestones:', e.message));
                for (const [i, m] of b.milestones.entries()) {
                    if (!m || !String(m.title || '').trim()) continue;
                    await pool.query(
                        `INSERT INTO agreement_milestones (agreement_id, sort_order, title, description, due_date)
                         VALUES ($1,$2,$3,$4,$5)`,
                        [req.params.id, i, String(m.title).slice(0, 300),
                         m.description || null, m.due_date || null]
                    ).catch((e) => console.warn('[SA UPDATE] milestone insert:', e.message));
                }
            }

            if (Array.isArray(b.items)) {
                await pool.query('DELETE FROM agreement_items WHERE agreement_id=$1', [req.params.id])
                    .catch((e) => console.warn('[SA UPDATE] clear items:', e.message));
                let itemsTotal = 0;
                for (const [i, it] of b.items.entries()) {
                    if (!it || !String(it.description || '').trim()) continue;
                    const amount = it.amount != null
                        ? Number(it.amount)
                        : (Number(it.quantity) || 1) * (Number(it.unit_price) || 0);
                    itemsTotal += amount;
                    await pool.query(
                        `INSERT INTO agreement_items
                            (agreement_id, sort_order, description, detail, quantity, unit_price, amount, is_optional)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                        [req.params.id, i, String(it.description).slice(0, 500), it.detail || null,
                         Number(it.quantity) || 1, Number(it.unit_price) || 0, amount, !!it.is_optional]
                    ).catch((e) => console.warn('[SA UPDATE] item insert:', e.message));
                }
                // Keep the headline price in step with the items, exactly as
                // create does — otherwise the document and its total disagree.
                if (b.items.length && b.price === undefined) {
                    await pool.query('UPDATE sales_agreements SET price=$2 WHERE id=$1',
                                     [req.params.id, itemsTotal.toFixed(2)]);
                }
            }

            const fresh = (await pool.query(
                'SELECT * FROM sales_agreements WHERE id=$1', [req.params.id])).rows[0];
            res.json({ success: true, agreement: fresh || upd.rows[0], message: 'Agreement updated.' });
        } catch (e) {
            console.error('[SA UPDATE]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'That agreement') });
        }
    });

    app.delete('/api/sales-agreements/:id', authenticateToken, async (req, res) => {
        try {
            // Guard on whether it was ACTUALLY SIGNED, not on the status
            // string. Status moves on after signing ('completed', 'active', …),
            // so a `status === 'signed'` check lets a signed agreement be
            // deleted the moment its status advances — taking the signature
            // record, and the evidence behind an invoice, with it.
            // Which of the columns we'd like to read actually exist? On a
            // database where sales_agreements pre-dates migration 001 several
            // are missing, and naming one in a SELECT makes the whole statement
            // fail — which is exactly why deleting an SLA used to 500 every
            // time, with nothing wrong in the logic below.
            const cols = new Set((await pool.query(
                `SELECT column_name FROM information_schema.columns
                  WHERE table_name = 'sales_agreements'`
            )).rows.map((r) => r.column_name));

            const pick = (c, fallback) => (cols.has(c) ? `sa.${c}` : `${fallback} AS ${c}`);
            const a = (await pool.query(
                `SELECT ${pick('status', 'NULL::text')},
                        ${pick('agreement_number', 'NULL::text')},
                        ${pick('signed_at', 'NULL::timestamp')},
                        ${pick('invoice_id', 'NULL::int')},
                        (sig.id IS NOT NULL) AS has_signature
                   FROM sales_agreements sa
                   LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id
                  WHERE sa.id = $1`, [req.params.id]
            )).rows[0];

            if (!cols.has('signed_at')) {
                console.warn('[SA DELETE] sales_agreements.signed_at is MISSING from this database — ' +
                             'run migrations/010_missing_columns_and_signing_repair.sql. ' +
                             'Proceeding with the delete anyway.');
            }
            if (!a) return res.status(404).json({ success: false, message: 'Agreement not found.' });
            // It's your data, so a signed agreement CAN be deleted — but only
            // when you say so explicitly. The default still refuses, because
            // deleting one destroys the signature, the project timeline and the
            // evidence behind its invoices.
            const force = String((req.query || {}).force || (req.body || {}).force || '') === 'true';
            if ((a.has_signature || a.signed_at || a.status === 'signed') && !force) {
                return res.status(409).json({
                    success: false,
                    code: 'SIGNED_AGREEMENT',
                    canForce: true,
                    message: 'This agreement is signed. Deleting it also removes the signature, its project timeline and the link to its invoices. Confirm again to delete it anyway, or cancel it instead to keep the record.',
                });
            }
            // Detach the things that merely REFERENCE this agreement first.
            // invoices.agreement_id and client_projects.agreement_id have no
            // ON DELETE rule, so Postgres refuses the delete with a foreign-key
            // error and the agreement appears undeletable forever.
            await pool.query('UPDATE invoices SET agreement_id = NULL WHERE agreement_id = $1', [req.params.id])
                .catch((e) => console.warn('[SA DELETE] detach invoices:', e.message));
            await pool.query('UPDATE client_projects SET agreement_id = NULL WHERE agreement_id = $1', [req.params.id])
                .catch((e) => console.warn('[SA DELETE] detach projects:', e.message));
            await pool.query('UPDATE maintenance_plans SET agreement_id = NULL WHERE agreement_id = $1', [req.params.id])
                .catch((e) => console.warn('[SA DELETE] detach plans:', e.message));
            await pool.query('DELETE FROM agreement_items WHERE agreement_id = $1', [req.params.id])
                .catch(() => {});
            // A forced delete takes the signature with it — leaving it behind
            // would make the agreement look signed if the id were ever reused.
            await pool.query('DELETE FROM agreement_signatures WHERE agreement_id = $1', [req.params.id])
                .catch(() => {});
            await pool.query('DELETE FROM agreement_milestones WHERE agreement_id = $1', [req.params.id])
                .catch(() => {});
            // plan_cancellations.reinstatement_agreement_id has no FK, so it is
            // never cascaded and would dangle.
            await pool.query('UPDATE plan_cancellations SET reinstatement_agreement_id = NULL WHERE reinstatement_agreement_id = $1', [req.params.id])
                .catch(() => {});
            // The once-guard rows. Left behind, they make a future agreement
            // that reuses this id silently unsignable.
            await pool.query(
                `DELETE FROM lifecycle_events
                  WHERE once_key IN ($1, $2) OR (entity_type='agreement' AND entity_id=$3)`,
                [`sla_signed:agreement:${req.params.id}`, `sla_sent:agreement:${req.params.id}`,
                 Number(req.params.id)]
            ).catch(() => {});

            const del = await pool.query('DELETE FROM sales_agreements WHERE id=$1', [req.params.id]);
            if (!del.rowCount) {
                // Nothing was removed — report that rather than claiming success.
                return res.status(409).json({
                    success: false,
                    message: 'That agreement could not be removed. Reload the page and try again — if it persists, something still references it.',
                });
            }
            res.json({ success: true, message: `${a.agreement_number || 'Agreement'} deleted.` });
        } catch (e) {
            console.error('[SA DELETE]', e.code, e.message);
            res.status(500).json({
                success: false,
                message: e.code === '23503'
                    ? 'Something still references this agreement, so it can\'t be deleted. Cancel it instead — the record is kept either way.'
                    : 'Could not delete that agreement: ' + e.message,
            });
        }
    });

    /** Publish an existing agreement to the customer's portal. */
    app.post('/api/sales-agreements/:id/send', authenticateToken, async (req, res) => {
        try {
            const a = (await pool.query(
                `SELECT sa.*, l.name, l.client_password
                   FROM sales_agreements sa LEFT JOIN leads l ON l.id = sa.lead_id
                  WHERE sa.id=$1`, [req.params.id]
            )).rows[0];
            if (!a) return res.status(404).json({ success: false, message: 'Agreement not found.' });
            if (!a.lead_id) {
                return res.status(400).json({ success: false, message: 'Assign this agreement to a client first.' });
            }
            if (!a.client_password) {
                return res.status(400).json({
                    success: false,
                    message: `${a.name || 'This client'} has no customer portal account yet. Create one from the Client Portal tab, then send.`,
                });
            }
            const out = await onAgreementSent({ agreementId: a.id });
            res.json({
                success: true,
                alreadySent: out.sent === false,
                message: out.sent === false
                    ? 'This agreement was already sent — they can still sign it in their portal.'
                    : `Sent to ${a.name}'s portal. They've been emailed and texted that it's ready to sign.`,
            });
        } catch (e) {
            console.error('[SA SEND]', e.code, e.message);
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // ======================================================================
    // Project timeline updates + service request notifications
    // ======================================================================

    /**
     * Post an update to a customer's project.
     *
     * One call does everything the spec asks for: writes the update, emails the
     * customer, drops a message in their portal, and sends the "you have a
     * message" email. Milestone completion runs through onMilestoneCompleted
     * instead, which has its own once-guard.
     */
    async function postProjectUpdate({ projectId, title, body, status, percent, adminId, notify: doNotify = true }) {
        const proj = (await pool.query(
            `SELECT cp.*, l.name, l.email, l.phone
               FROM client_projects cp JOIN leads l ON l.id = cp.lead_id
              WHERE cp.id = $1`, [projectId]
        )).rows[0];
        if (!proj) throw new Error('Project not found');

        const sets = ['updated_at = NOW()'];
        const vals = [projectId];
        if (status) { vals.push(status); sets.push(`status = $${vals.length}`); }
        if (percent != null) { vals.push(Math.max(0, Math.min(100, Number(percent)))); sets.push(`progress = $${vals.length}`); }
        if (status === 'completed') sets.push('completed_at = COALESCE(completed_at, NOW())');
        await pool.query(`UPDATE client_projects SET ${sets.join(', ')} WHERE id = $1`, vals)
            .catch((e) => console.warn('[PROJECT UPDATE] status/progress:', e.message));

        const upd = (await pool.query(
            `INSERT INTO project_updates (project_id, lead_id, title, body, status, progress, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [projectId, proj.lead_id, (title || 'Project update').slice(0, 200), body || null,
             status || null, percent != null ? Number(percent) : null, adminId || null]
        )).rows[0];

        if (doNotify) {
            const lead = { id: proj.lead_id, name: proj.name, email: proj.email, phone: proj.phone };
            // The portal message and the update email are one notify() call; the
            // separate "you have messages" ping is what the spec asks for on top.
            await notify({
                lead, kind: 'project_update',
                subject: `Update on ${proj.project_name}: ${title || 'progress'}`,
                bodyHtml: `<p style="margin:0 0 12px">There's a new update on your project <strong style="color:#0d0f12">${proj.project_name}</strong>.</p>
                    <div style="background:#f7f8f9;border-radius:8px;padding:14px 16px;margin:0 0 14px">
                      <div style="color:#0d0f12;font-weight:700;font-size:15px;margin-bottom:6px">${title || 'Progress update'}</div>
                      ${body ? `<div style="color:#3f4650;font-size:14px;line-height:1.6">${body}</div>` : ''}
                      ${percent != null ? `<div style="margin-top:10px;color:#15803d;font-size:13px;font-weight:700">${Number(percent)}% complete</div>` : ''}
                    </div>
                    <p style="margin:0">The full timeline is in your portal.</p>`,
                smsText: `Diamondback Coding: update on ${proj.project_name} — ${title || 'progress update'}. Details in your portal.`,
                channels: ['email', 'sms', 'portal'],
                cta: { url: PORTAL_URL, label: 'View your timeline' },
            });
            await sendPortalMessagePing(lead);
            await pool.query('UPDATE project_updates SET notified_at = NOW() WHERE id = $1', [upd.id])
                .catch(() => {});
        }

        return { update: upd, project: proj };
    }

    /**
     * The short "you have a message waiting" email.
     *
     * Deliberately content-free: the substance lives in the portal, this only
     * says to go look. Sent as its own kind so it can be muted independently of
     * the update itself.
     */
    async function sendPortalMessagePing(lead) {
        if (!lead || !lead.email) return;
        try {
            await notify({
                lead, kind: 'portal_message_waiting',
                subject: 'You have a new message in your portal',
                bodyHtml: `<p style="margin:0 0 12px">There's a new message waiting for you in your customer portal.</p>
                           <p style="margin:0">Sign in to read it and reply.</p>`,
                channels: ['email'],
                cta: { url: PORTAL_URL, label: 'Open your portal' },
            });
        } catch (e) {
            console.warn('[PING] portal message email failed:', e.message);
        }
    }

    // ---- admin: projects needing updates ---------------------------------
    // Every signed customer project, newest activity first. This is the feed the
    // admin Project Timeline tab renders.
    app.get('/api/admin/projects', authenticateToken, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT cp.*, l.name AS customer_name, l.email AS customer_email,
                        sa.agreement_number,
                        (SELECT COUNT(*)::int FROM project_milestones pm WHERE pm.project_id = cp.id) AS total_milestones,
                        (SELECT COUNT(*)::int FROM project_milestones pm WHERE pm.project_id = cp.id AND pm.status='completed') AS done_milestones,
                        (SELECT MAX(created_at) FROM project_updates pu WHERE pu.project_id = cp.id) AS last_update_at,
                        (SELECT COUNT(*)::int FROM project_updates pu WHERE pu.project_id = cp.id) AS update_count
                   FROM client_projects cp
                   JOIN leads l ON l.id = cp.lead_id
                   LEFT JOIN sales_agreements sa ON sa.id = cp.agreement_id
                  ORDER BY CASE WHEN cp.status = 'completed' THEN 1 ELSE 0 END,
                           COALESCE((SELECT MAX(created_at) FROM project_updates pu WHERE pu.project_id = cp.id),
                                    cp.created_at) DESC`
            );
            res.json({ success: true, projects: r.rows });
        } catch (e) {
            console.error('[ADMIN PROJECTS]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Projects') });
        }
    });

    app.get('/api/admin/projects/:id', authenticateToken, async (req, res) => {
        try {
            const proj = (await pool.query(
                `SELECT cp.*, l.name AS customer_name, l.email AS customer_email
                   FROM client_projects cp JOIN leads l ON l.id = cp.lead_id WHERE cp.id=$1`,
                [req.params.id]
            )).rows[0];
            if (!proj) return res.status(404).json({ success: false, message: 'Project not found.' });
            const milestones = (await pool.query(
                'SELECT * FROM project_milestones WHERE project_id=$1 ORDER BY order_index, id', [req.params.id]
            )).rows;
            const updates = (await pool.query(
                'SELECT * FROM project_updates WHERE project_id=$1 ORDER BY created_at DESC', [req.params.id]
            )).rows;
            res.json({ success: true, project: proj, milestones, updates });
        } catch (e) {
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'That project') });
        }
    });

    app.post('/api/admin/projects/:id/update', authenticateToken, async (req, res) => {
        try {
            const { title, body, status, percent, notify: doNotify } = req.body || {};
            if (!title && !body && !status && percent == null) {
                return res.status(400).json({ success: false, message: 'Write an update, or change the status or progress.' });
            }
            const out = await postProjectUpdate({
                projectId: req.params.id, title, body, status, percent,
                adminId: req.user && req.user.id,
                notify: doNotify !== false,
            });
            res.json({
                success: true, update: out.update,
                message: doNotify === false
                    ? 'Update saved (customer not notified).'
                    : `Update posted. ${out.project.name} has been emailed and messaged.`,
            });
        } catch (e) {
            console.error('[PROJECT UPDATE]', e.message);
            res.status(500).json({ success: false, message: e.message });
        }
    });

    app.post('/api/admin/milestones/:id/complete', authenticateToken, async (req, res) => {
        try {
            const out = await onMilestoneCompleted({ milestoneId: req.params.id });
            res.json({
                success: true, ...out,
                message: out.notified
                    ? `Milestone marked complete — the customer has been notified (${out.done}/${out.total}).`
                    : 'That milestone was already completed.',
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // ---- customer portal: my project timeline ----------------------------
    app.get('/api/portal/timeline', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const projects = (await pool.query(
                `SELECT cp.*, sa.agreement_number
                   FROM client_projects cp
                   LEFT JOIN sales_agreements sa ON sa.id = cp.agreement_id
                  WHERE cp.lead_id = $1
                  ORDER BY CASE WHEN cp.status='completed' THEN 1 ELSE 0 END, cp.created_at DESC`,
                [leadId]
            )).rows;

            for (const p of projects) {
                p.milestones = (await pool.query(
                    'SELECT id, title, description, status, order_index, completed_at FROM project_milestones WHERE project_id=$1 ORDER BY order_index, id',
                    [p.id]
                )).rows;
                p.updates = (await pool.query(
                    'SELECT id, title, body, status, progress, created_at FROM project_updates WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',
                    [p.id]
                )).rows;
                const done = p.milestones.filter((m) => m.status === 'completed').length;
                p.progress_pct = p.progress != null ? Number(p.progress)
                    : (p.milestones.length ? Math.round((done / p.milestones.length) * 100) : 0);
                p.milestones_done = done;
            }
            res.json({ success: true, projects });
        } catch (e) {
            console.error('[PORTAL TIMELINE]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Your project timeline') });
        }
    });

    // ---- service requests: notify everyone who needs to know -------------
    /**
     * Called after a customer submits a service request. Confirmation email to
     * the customer, a message in their portal, the "you have messages" ping, and
     * an SMS to Diamondback so a request can't sit unseen.
     */
    async function onServiceRequestCreated({ requestId }) {
        const rq = (await pool.query(
            `SELECT sr.*, l.name, l.email, l.phone
               FROM service_requests sr JOIN leads l ON l.id = sr.lead_id
              WHERE sr.id = $1`, [requestId]
        )).rows[0];
        if (!rq) throw new Error('Service request not found');

        if (!(await claimStage(rq.lead_id, 'service_request', `service_request:${requestId}`,
                               { entityType: 'service_request', entityId: requestId }))) {
            return { notified: false };
        }

        const lead = { id: rq.lead_id, name: rq.name, email: rq.email, phone: rq.phone };
        const what = rq.service_type || 'Service request';
        const proj = rq.project || rq.vehicle || null;

        await notify({
            lead, kind: 'service_request_received',
            subject: `We've got your request: ${what}`,
            bodyHtml: `<p style="margin:0 0 12px">Thanks — we've received your service request and it's in the queue.</p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 14px;width:100%;background:#f7f8f9;border-radius:8px">
                  <tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Request</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${what}</td></tr>
                  ${proj ? `<tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Project</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${proj}</td></tr>` : ''}
                  ${rq.preferred_date ? `<tr><td style="padding:10px 16px;color:#7c848f;font-size:13px">Preferred date</td><td style="padding:10px 16px;color:#0d0f12;font-size:14px">${prettyDate(rq.preferred_date)}</td></tr>` : ''}
                </table>
                ${rq.details ? `<p style="margin:0 0 12px;color:#3f4650">"${rq.details}"</p>` : ''}
                <p style="margin:0">We'll be in touch shortly. You can follow it in your portal.</p>`,
            smsText: `Diamondback Coding: we've received your ${what} request. We'll be in touch shortly.`,
            channels: ['email', 'sms', 'portal'],
            cta: { url: PORTAL_URL, label: 'View your request' },
        });
        await sendPortalMessagePing(lead);

        // SMS to the business. Uses ALERT_SMS_TO, falling back to the notify
        // number, so a request can't sit unnoticed.
        const alertTo = process.env.ALERT_SMS_TO || process.env.NOTIFY_PHONE;
        if (alertTo) {
            try {
                const key = typeof getBrevoKey === 'function' ? await getBrevoKey() : PLATFORM_BREVO_KEY;
                if (key) {
                    await sendSmsViaBrevo(key, PLATFORM_SENDER_NAME.slice(0, 11), alertTo,
                        `New service request from ${rq.name}: ${what}${proj ? ` (${proj})` : ''}. Check the admin portal.`);
                }
            } catch (e) {
                console.warn('[SERVICE REQUEST] business SMS failed:', e.message);
            }
        } else {
            console.warn('[SERVICE REQUEST] ALERT_SMS_TO not set — no SMS sent to Diamondback.');
        }

        await adminNotify({
            kind: 'service_request',
            title: `New service request from ${rq.name}`,
            body: `${what}${proj ? ` · ${proj}` : ''}${rq.preferred_date ? ` · preferred ${prettyDate(rq.preferred_date)}` : ''}`,
            leadId: rq.lead_id, entityType: 'service_request', entityId: requestId,
            severity: 'info', onceKey: `service_request:${requestId}`,
        });

        return { notified: true };
    }

    // ======================================================================
    // Account recovery — forgot password / forgot username
    // ======================================================================
    // Serves BOTH audiences: 'customer' (customer_portal.html) and 'crm'
    // (client_portal.html). Same table, same rules, different landing page.

    const crypto = require('crypto');
    const RESET_TTL_MIN = Number(process.env.RESET_TTL_MINUTES || 60);
    const SITE_URL = process.env.SITE_URL || 'https://diamondbackcoding.com';

    const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

    function resetLink(audience, token) {
        const page = audience === 'crm' ? 'reset_password.html' : 'reset_password.html';
        return `${SITE_URL}/${page}?token=${token}&for=${audience}`;
    }

    /**
     * Issue a recovery token.
     *
     * Always resolves the same way to the caller whether or not the address
     * exists — otherwise this route becomes a way to enumerate which of your
     * customers have accounts.
     */
    async function issueRecovery({ email, audience = 'customer', purpose = 'password_reset', ip, userAgent }) {
        const addr = String(email || '').trim().toLowerCase();
        if (!addr) return { ok: true };

        // Throttle: 5 requests per address per hour. Stops the route being used
        // to spam someone's inbox.
        const recent = await pool.query(
            `SELECT COUNT(*)::int AS n FROM auth_tokens
              WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [addr]
        );
        if (recent.rows[0].n >= 5) {
            console.warn(`[RECOVERY] throttled ${addr}`);
            return { ok: true, throttled: true };
        }

        const lead = (await pool.query(
            `SELECT id, name, email, client_password, portal_kind, crm_access
               FROM leads WHERE LOWER(email) = $1 LIMIT 1`, [addr]
        )).rows[0];

        // No account, or no portal password set: log and return quietly.
        if (!lead || !lead.client_password) {
            console.log(`[RECOVERY] no ${audience} account for ${addr}`);
            return { ok: true };
        }

        // Wrong door: an address with no CRM entitlement asking for a CRM reset
        // gets pointed at the portal it does have, rather than silence.
        const hasCrm = lead.crm_access === true || ['crm', 'both'].includes(String(lead.portal_kind || ''));
        if (audience === 'crm' && !hasCrm) {
            await notify({
                lead, kind: 'password_reset',
                subject: 'About your CodeNexus CRM sign-in',
                bodyHtml: `<p style="margin:0 0 12px">Someone asked to reset a CodeNexus CRM password for this address.</p>
                    <p style="margin:0 0 12px">Your account is a <strong style="color:#0d0f12">customer portal</strong> account, not a CRM subscription — so there's no CRM password to reset.</p>
                    <p style="margin:0">You can reset your customer portal password from the link below.</p>`,
                channels: ['email'],
                cta: { url: `${SITE_URL}/customer_portal.html`, label: 'Go to your customer portal' },
            });
            return { ok: true };
        }

        if (purpose === 'username_recovery') {
            // The username IS the email here, so "forgot username" is really
            // "remind me which address I signed up with". Sending it to that
            // same address is the only safe answer.
            await notify({
                lead, kind: 'username_recovery',
                subject: 'Your Diamondback Coding sign-in details',
                bodyHtml: `<p style="margin:0 0 14px">You asked which email you use to sign in. It's this one:</p>
                    <div style="background:#f7f8f9;border-radius:8px;padding:14px 16px;margin:0 0 14px">
                      <div style="color:#15803d;font-size:16px;font-weight:700;font-family:monospace">${lead.email}</div>
                    </div>
                    <p style="margin:0 0 12px">Sign in with that address and your password.</p>
                    <p style="margin:0">Forgotten the password too? Use the "Forgot password" link on the sign-in page.</p>`,
                channels: ['email'],
                cta: { url: audience === 'crm' ? `${SITE_URL}/client_portal.html` : `${SITE_URL}/customer_portal.html`,
                       label: 'Go to sign in' },
            });
            await pool.query(
                `INSERT INTO auth_tokens (lead_id, audience, purpose, token_hash, email, expires_at, requested_ip, user_agent)
                 VALUES ($1,$2,'username_recovery',$3,$4,NOW(),$5,$6)`,
                [lead.id, audience, hashToken('username:' + Date.now() + Math.random()), addr,
                 (ip || '').slice(0, 64), (userAgent || '').slice(0, 400)]
            ).catch(() => {});
            return { ok: true };
        }

        // Invalidate any outstanding reset for this account, so an old link in
        // an old email can't still be used after a new one is requested.
        await pool.query(
            `UPDATE auth_tokens SET used_at = NOW()
              WHERE lead_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
            [lead.id]
        );

        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
            `INSERT INTO auth_tokens (lead_id, audience, purpose, token_hash, email, expires_at, requested_ip, user_agent)
             VALUES ($1,$2,'password_reset',$3,$4, NOW() + ($5 || ' minutes')::interval, $6,$7)`,
            [lead.id, audience, hashToken(token), addr, String(RESET_TTL_MIN),
             (ip || '').slice(0, 64), (userAgent || '').slice(0, 400)]
        );

        const link = resetLink(audience, token);
        await notify({
            lead, kind: 'password_reset',
            subject: 'Reset your Diamondback Coding password',
            bodyHtml: `<p style="margin:0 0 12px">Use the button below to choose a new password. The link works once and expires in ${RESET_TTL_MIN} minutes.</p>
                <p style="margin:0 0 12px">If you didn't ask for this, you can ignore this email — your password hasn't changed.</p>
                <p style="margin:0;color:#7c848f;font-size:12px;word-break:break-all">Or paste this into your browser:<br>${link}</p>`,
            channels: ['email'],
            cta: { url: link, label: 'Choose a new password' },
        });

        return { ok: true, sent: true };
    }

    /** Validate a token without spending it, so the page can render or refuse. */
    async function checkRecoveryToken(token) {
        if (!token) return { valid: false, reason: 'missing' };
        const r = await pool.query(
            `SELECT t.*, l.email AS lead_email, l.name
               FROM auth_tokens t LEFT JOIN leads l ON l.id = t.lead_id
              WHERE t.token_hash = $1 AND t.purpose = 'password_reset'`,
            [hashToken(token)]
        );
        const row = r.rows[0];
        if (!row) return { valid: false, reason: 'unknown' };
        if (row.used_at) return { valid: false, reason: 'used' };
        if (new Date(row.expires_at) <= new Date()) return { valid: false, reason: 'expired' };
        return { valid: true, row };
    }

    /**
     * Change the password from inside the portal, while signed in.
     *
     * Requires the CURRENT password: a signed-in session on a shared or stolen
     * device must not be enough to lock the real owner out of their account.
     * The username is the email address, so that half is handled by
     * PATCH /api/portal/profile.
     */
    app.post('/api/portal/change-password', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const { currentPassword, newPassword } = req.body || {};

            if (!currentPassword || !newPassword) {
                return res.status(400).json({
                    success: false,
                    message: 'Enter your current password and the new one you\'d like.',
                });
            }
            if (String(newPassword).length < 8) {
                return res.status(400).json({
                    success: false,
                    message: 'Your new password needs to be at least 8 characters.',
                });
            }

            const lead = (await pool.query(
                'SELECT id, name, email, phone, client_password FROM leads WHERE id=$1', [leadId]
            )).rows[0];
            if (!lead || !lead.client_password) {
                return res.status(404).json({ success: false, message: 'Account not found.' });
            }

            const ok = await bcrypt.compare(String(currentPassword), lead.client_password);
            if (!ok) {
                // 400, deliberately NOT 401/403: the portal's fetch helper treats
                // those as an expired session and signs the customer straight
                // out. Mistyping your own password must not log you out.
                return res.status(400).json({
                    success: false,
                    message: 'That current password doesn\'t match. Try again, or use "Forgot password" from the sign-in screen.',
                });
            }
            if (await bcrypt.compare(String(newPassword), lead.client_password)) {
                return res.status(400).json({
                    success: false,
                    message: 'That\'s the password you already have — pick a different one.',
                });
            }

            await pool.query(
                'UPDATE leads SET client_password=$2, updated_at=NOW() WHERE id=$1',
                [leadId, await bcrypt.hash(String(newPassword), 10)]
            );

            // Any outstanding reset links are now stale — spend them, so an old
            // emailed link can't undo a change the customer just made.
            await pool.query(
                `UPDATE auth_tokens SET used_at = NOW()
                  WHERE lead_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
                [leadId]
            ).catch(() => {});

            // Tell them out-of-band. If this wasn't them, the email is how they
            // find out.
            await notify({
                lead, kind: 'password_changed',
                subject: 'Your password was changed',
                bodyHtml: `<p style="margin:0 0 12px">Your Diamondback Coding portal password was just changed.</p>
                           <p style="margin:0">If that was you, nothing else is needed. If it wasn't, reply to this email straight away and we'll lock the account.</p>`,
                channels: ['email'],
                cta: { url: PORTAL_URL, label: 'Open your portal' },
            }).catch((e) => console.warn('[CHANGE PASSWORD] notify:', e.message));

            res.json({ success: true, message: 'Password updated.' });
        } catch (e) {
            console.error('[CHANGE PASSWORD]', e.message);
            res.status(500).json({ success: false, message: 'Could not change your password. Please try again.' });
        }
    });

    app.post('/api/auth/forgot-password', async (req, res) => {
        try {
            const { email, audience } = req.body || {};
            await issueRecovery({
                email,
                audience: audience === 'crm' ? 'crm' : 'customer',
                purpose: 'password_reset',
                ip: req.headers['x-forwarded-for'] || req.ip,
                userAgent: req.headers['user-agent'],
            });
        } catch (e) {
            console.error('[FORGOT PASSWORD]', e.message);
        }
        // Deliberately identical whatever happened above — see issueRecovery.
        res.json({
            success: true,
            message: 'If that email is on an account, a reset link is on its way. Check your inbox and spam folder.',
        });
    });

    app.post('/api/auth/forgot-username', async (req, res) => {
        try {
            const { email, audience } = req.body || {};
            await issueRecovery({
                email,
                audience: audience === 'crm' ? 'crm' : 'customer',
                purpose: 'username_recovery',
                ip: req.headers['x-forwarded-for'] || req.ip,
                userAgent: req.headers['user-agent'],
            });
        } catch (e) {
            console.error('[FORGOT USERNAME]', e.message);
        }
        res.json({
            success: true,
            message: 'If that email is on an account, we\'ve sent your sign-in details to it.',
        });
    });

    app.get('/api/auth/reset-token', async (req, res) => {
        try {
            const out = await checkRecoveryToken((req.query || {}).token);
            if (!out.valid) {
                const why = {
                    missing: 'No reset link was supplied.',
                    unknown: 'That reset link isn\'t valid. Request a new one.',
                    used: 'That link has already been used. Request a new one.',
                    expired: 'That link has expired. Request a new one.',
                }[out.reason] || 'That reset link isn\'t valid.';
                return res.status(400).json({ success: false, reason: out.reason, message: why });
            }
            // Enough to personalise the page, nothing more.
            res.json({
                success: true,
                audience: out.row.audience,
                email: out.row.lead_email,
                name: out.row.name,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not check that link.' });
        }
    });

    app.post('/api/auth/reset-password', async (req, res) => {
        try {
            const { token, password } = req.body || {};
            if (!password || String(password).length < 8) {
                return res.status(400).json({ success: false, message: 'Choose a password of at least 8 characters.' });
            }
            const out = await checkRecoveryToken(token);
            if (!out.valid) {
                return res.status(400).json({
                    success: false,
                    message: out.reason === 'expired' ? 'That link has expired. Request a new one.'
                           : out.reason === 'used' ? 'That link has already been used. Request a new one.'
                           : 'That reset link isn\'t valid. Request a new one.',
                });
            }

            const hash = await bcrypt.hash(String(password), 10);
            await pool.query('UPDATE leads SET client_password = $2, updated_at = NOW() WHERE id = $1',
                             [out.row.lead_id, hash]);
            // Spend the token, and any sibling still outstanding.
            await pool.query(
                `UPDATE auth_tokens SET used_at = NOW()
                  WHERE lead_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
                [out.row.lead_id]
            );

            const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1',
                                           [out.row.lead_id])).rows[0];
            // Tell them it changed. If it wasn't them, this is how they find out.
            await notify({
                lead, kind: 'password_changed',
                subject: 'Your password was changed',
                bodyHtml: `<p style="margin:0 0 12px">Your Diamondback Coding password was just changed.</p>
                           <p style="margin:0">If that wasn't you, reply to this email straight away and we'll secure the account.</p>`,
                channels: ['email'],
            }).catch(() => {});

            res.json({
                success: true,
                audience: out.row.audience,
                message: 'Password updated. You can sign in now.',
            });
        } catch (e) {
            console.error('[RESET PASSWORD]', e.message);
            res.status(500).json({ success: false, message: 'Could not reset the password. Please try again.' });
        }
    });

    // ======================================================================
    // Contact form confirmation
    // ======================================================================
    /**
     * Confirms a contact-form submission to the person who sent it.
     *
     * Transactional, so it goes through notify() and cannot feed the hot/cold
     * scoring the follow-up queue owns — the queue still treats them as a new
     * hot lead exactly as before.
     */
    async function onContactFormSubmitted({ leadId, projectType, messageText }) {
        const lead = (await pool.query(
            'SELECT id, name, email, phone, company FROM leads WHERE id=$1', [leadId]
        )).rows[0];
        if (!lead || !lead.email) return { sent: false };

        if (!(await claimStage(leadId, 'contact_form', `contact_form:${leadId}`,
                               { entityType: 'lead', entityId: leadId }))) {
            return { sent: false, alreadySent: true };
        }

        const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
        await notify({
            lead, kind: 'contact_confirmation',
            subject: 'We got your message',
            bodyHtml: `<p style="margin:0 0 14px">Thanks ${first} — your message reached us and we'll come back to you within one business day.</p>
                ${rows([
                    projectType ? ['What you asked about', String(projectType).replace(/_/g, ' ')] : null,
                    lead.company ? ['Company', lead.company] : null,
                    ['Sent to', 'contact@diamondbackcoding.com'],
                ])}
                ${messageText ? `<p style="margin:0 0 14px;padding:14px 16px;background:#f7f8f9;border-radius:12px;font-style:italic;">"${String(messageText).slice(0, 400)}"</p>` : ''}
                <p style="margin:0">If it's urgent, just reply to this email — it comes straight to us.</p>`,
            smsText: null,
            channels: ['email'],
        });

        await adminNotify({
            kind: 'contact_form',
            title: `New enquiry from ${lead.name || lead.email}`,
            body: `${projectType ? String(projectType).replace(/_/g, ' ') : 'General enquiry'}${lead.company ? ` · ${lead.company}` : ''}`,
            leadId, entityType: 'lead', entityId: leadId,
            severity: 'info', onceKey: `contact_form_admin:${leadId}`,
        });

        return { sent: true };
    }

    // ======================================================================
    // Customer profile — the customer edits their own details
    // ======================================================================
    app.get('/api/portal/profile', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const r = await pool.query(
                `SELECT id, name, email, phone, company, address, city, state, zip
                   FROM leads WHERE id = $1`, [leadId]
            );
            if (!r.rows.length) return res.status(404).json({ success: false, message: 'Account not found.' });
            res.json({ success: true, profile: r.rows[0] });
        } catch (e) {
            // address/city/state/zip may not exist on older schemas — fall back.
            try {
                const leadId = await resolveLeadId(req.user.id, req.user.email);
                const r = await pool.query(
                    'SELECT id, name, email, phone, company FROM leads WHERE id = $1', [leadId]);
                return res.json({ success: true, profile: r.rows[0] });
            } catch (e2) {
                console.error('[PORTAL PROFILE]', e2.message);
                res.status(500).json({ success: false, message: 'Could not load your details.' });
            }
        }
    });

    app.patch('/api/portal/profile', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const b = req.body || {};

            const name = String(b.name || '').trim();
            if (!name || name.length < 2) {
                return res.status(400).json({ success: false, message: 'Enter the name you\'d like us to use.' });
            }

            // Changing the sign-in email changes how they log in, so it has to be
            // unique across accounts or two people end up fighting over one login.
            let email = b.email != null ? String(b.email).trim().toLowerCase() : null;
            if (email) {
                if (email.indexOf('@') === -1) {
                    return res.status(400).json({ success: false, message: 'That email address doesn\'t look right.' });
                }
                const clash = await pool.query(
                    'SELECT id FROM leads WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1', [email, leadId]);
                if (clash.rows.length) {
                    return res.status(409).json({
                        success: false,
                        message: 'That email is already used by another account. Contact us and we\'ll sort it out.',
                    });
                }
            }

            const sets = ['updated_at = NOW()'];
            const vals = [leadId];
            const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
            put('name', name);
            if (email) put('email', email);
            if (b.phone !== undefined) put('phone', String(b.phone || '').trim() || null);
            if (b.company !== undefined) put('company', String(b.company || '').trim() || null);

            for (const col of ['address', 'city', 'state', 'zip']) {
                if (b[col] === undefined) continue;
                try {
                    await pool.query(`UPDATE leads SET ${col} = $2 WHERE id = $1`,
                                     [leadId, String(b[col] || '').trim() || null]);
                } catch (_) { /* column not on this schema; skip it */ }
            }

            const upd = await pool.query(
                `UPDATE leads SET ${sets.join(', ')} WHERE id = $1
                 RETURNING id, name, email, phone, company`, vals
            );

            // Visible to staff immediately — this is the same row the admin
            // portal reads, so there is nothing to sync.
            await adminNotify({
                kind: 'profile_updated',
                title: `${upd.rows[0].name} updated their details`,
                body: `${upd.rows[0].email}${upd.rows[0].phone ? ` · ${upd.rows[0].phone}` : ''}`,
                leadId, entityType: 'lead', entityId: leadId, severity: 'info',
            });

            res.json({
                success: true, profile: upd.rows[0],
                emailChanged: !!(email && email !== String(req.user.email || '').toLowerCase()),
                message: 'Your details are updated.',
            });
        } catch (e) {
            console.error('[PORTAL PROFILE SAVE]', e.code, e.message);
            res.status(500).json({ success: false, message: 'Could not save your details.' });
        }
    });

    // ======================================================================
    // Sign-in verification codes
    // ======================================================================
    const CODE_TTL_MIN = Number(process.env.LOGIN_CODE_TTL_MINUTES || 10);
    const TRUST_DAYS = Number(process.env.LOGIN_TRUST_DAYS || 60);

    /**
     * Issue a 6-digit sign-in code.
     *
     * Called after the password checks out. The code is stored hashed with the
     * same auth_tokens table the reset flow uses.
     */
    async function issueLoginCode({ leadId, email, audience = 'customer', ip, userAgent }) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        await pool.query(
            `UPDATE auth_tokens SET used_at = NOW()
              WHERE lead_id = $1 AND purpose = 'login_code' AND used_at IS NULL`, [leadId]);
        await pool.query(
            `INSERT INTO auth_tokens (lead_id, audience, purpose, token_hash, email, expires_at, requested_ip, user_agent)
             VALUES ($1,$2,'login_code',$3,$4, NOW() + ($5 || ' minutes')::interval, $6,$7)`,
            [leadId, audience, hashToken(`${leadId}:${code}`), email, String(CODE_TTL_MIN),
             (ip || '').slice(0, 64), (userAgent || '').slice(0, 400)]
        );

        const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1', [leadId])).rows[0];
        await notify({
            lead, kind: 'login_code',
            subject: `${code} is your sign-in code`,
            bodyHtml: `<p style="margin:0 0 18px">Enter this code to finish signing in. It expires in ${CODE_TTL_MIN} minutes.</p>
                <div style="margin:0 0 18px;padding:20px;background:#f7f8f9;border-radius:12px;text-align:center;">
                  <div style="font-family:'Courier New',monospace;font-size:34px;font-weight:700;
                              letter-spacing:.18em;color:#0d0f12;">${code}</div>
                </div>
                <p style="margin:0">If you didn't try to sign in, ignore this email and consider changing your password.</p>`,
            channels: ['email'],
        });
        return { sent: true };
    }

    /** Verify a code and, if asked, issue a trust token that skips it next time. */
    async function verifyLoginCode({ leadId, code }) {
        const r = await pool.query(
            `SELECT * FROM auth_tokens
              WHERE lead_id = $1 AND purpose = 'login_code' AND token_hash = $2`,
            [leadId, hashToken(`${leadId}:${String(code || '').trim()}`)]
        );
        const row = r.rows[0];
        if (!row) return { ok: false, message: 'That code isn\'t right. Check the email and try again.' };
        if (row.used_at) return { ok: false, message: 'That code has already been used. Request a new one.' };
        if (new Date(row.expires_at) <= new Date()) {
            return { ok: false, message: 'That code has expired. Request a new one.' };
        }
        await pool.query('UPDATE auth_tokens SET used_at = NOW() WHERE id = $1', [row.id]);
        return { ok: true };
    }

    async function issueTrustToken({ leadId, audience, ip, userAgent }) {
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
            `INSERT INTO auth_tokens (lead_id, audience, purpose, token_hash, expires_at, requested_ip, user_agent)
             VALUES ($1,$2,'device_trust',$3, NOW() + ($4 || ' days')::interval, $5,$6)`,
            [leadId, audience, hashToken(token), String(TRUST_DAYS),
             (ip || '').slice(0, 64), (userAgent || '').slice(0, 400)]
        );
        return { token, days: TRUST_DAYS };
    }

    /** Is this device still trusted? Returns false for anything expired or spent. */
    async function isDeviceTrusted(leadId, token) {
        if (!token) return false;
        const r = await pool.query(
            `SELECT id FROM auth_tokens
              WHERE lead_id = $1 AND purpose = 'device_trust' AND token_hash = $2
                AND used_at IS NULL AND expires_at > NOW()`,
            [leadId, hashToken(token)]
        );
        return r.rows.length > 0;
    }

    app.post('/api/auth/login-code/send', async (req, res) => {
        try {
            const { leadId, email, audience } = req.body || {};
            if (!leadId) return res.status(400).json({ success: false, message: 'Missing account.' });
            await issueLoginCode({
                leadId, email, audience: audience === 'crm' ? 'crm' : 'customer',
                ip: req.headers['x-forwarded-for'] || req.ip,
                userAgent: req.headers['user-agent'],
            });
            res.json({ success: true, message: 'We\'ve emailed you a new code.', expiresInMinutes: CODE_TTL_MIN });
        } catch (e) {
            console.error('[LOGIN CODE]', e.message);
            res.status(500).json({ success: false, message: 'Could not send a code just now.' });
        }
    });

    // ======================================================================
    // Cancellation settlement
    // ======================================================================
    /**
     * What must be settled before a plan can be cancelled.
     *
     * Two parts, both owed because the notice period is served, not waived:
     *   - anything already unpaid on the plan (a failed charge, an open invoice)
     *   - the charges that fall due inside the 30-day notice window
     *
     * Returns the figure and a plain-language breakdown, so the customer is told
     * what they're paying for rather than just a total.
     */
    async function cancellationSettlement({ kind, id, leadId }) {
        const lines = [];
        let effective;

        if (kind === 'maintenance') {
            const plan = (await pool.query(
                'SELECT * FROM maintenance_plans WHERE id=$1 AND lead_id=$2', [id, leadId]
            )).rows[0];
            if (!plan) throw new Error('Plan not found');

            // ------------------------------------------------------------
            // ------------------------------------------------------------
            // TWO DIFFERENT RULES. ANNUAL IS NOT MONTHLY WITH A BIGGER NUMBER.
            //
            // MONTHLY — 30 days' notice. A charge falling inside that window is
            //   billed, and it buys the month it covers, so the end date moves
            //   out to the end of that month.
            //
            // ANNUAL — NO NOTICE PERIOD AT ALL. Cancelling settles the year in
            //   full and they keep the whole year they just paid for, ending
            //   the day before the following renewal. Applying a 30-day notice
            //   to a twelve-month term makes no sense in either direction: it
            //   would either take a year's money and give back four weeks, or
            //   let someone walk away from an annual commitment with a month's
            //   notice.
            //
            // A BILLING BOUNDARY IS NOT THE LAST DAY OF SERVICE. A period that
            // runs 18 Oct -> 18 Oct gives service through 17 Oct. Ending ON the
            // renewal date would put the cancellation and a charge on the same
            // day, and whether they get charged again would come down to which
            // job ran first. So boundary dates are always pulled back one day.
            // ------------------------------------------------------------
            const dayBefore = (d) => {
                const x = new Date(d);
                x.setDate(x.getDate() - 1);
                return x;
            };

            const isAnnualPlan = intervalUnit(plan) === 'year';
            const nextCharge = plan.next_charge_date ? new Date(plan.next_charge_date) : null;
            const periodIsPaid = !!plan.current_period_paid_at
                || (!!plan.last_charge_date && nextCharge && nextCharge > new Date());

            if (isAnnualPlan) {
                // ---- ANNUAL ---------------------------------------------
                const settleMethodA = await methodForPlan(plan);

                if (periodIsPaid && nextCharge && !isNaN(nextCharge)) {
                    // Already paid for this year. Nothing further is owed and
                    // they keep it to the day before renewal.
                    effective = dayBefore(nextCharge);
                } else if (nextCharge && !isNaN(nextCharge)) {
                    // Not paid. Settle the year in full now; that buys them
                    // through to the day before the FOLLOWING renewal.
                    lines.push({
                        kind: 'annual_settlement',
                        label: `${plan.label} — ${prettyDate(nextCharge)} (full year)`,
                        amount: planChargeTotal(plan, settleMethodA),
                        date: dateOnly(nextCharge),
                    });
                    const followingRenewal = nextChargeFor(plan, nextCharge);
                    effective = followingRenewal ? dayBefore(followingRenewal) : dayBefore(nextCharge);
                } else {
                    // No renewal date on record — end it today rather than
                    // inventing a year of service nobody can point at.
                    effective = new Date();
                }
            } else {
                // ---- MONTHLY --------------------------------------------
                effective = new Date(Date.now() + CANCELLATION_NOTICE_DAYS * 86400000);

                if (periodIsPaid && nextCharge && !isNaN(nextCharge)) {
                    const lastPaidDay = dayBefore(nextCharge);
                    if (lastPaidDay > effective) effective = lastPaidDay;
                }

                // Charges falling STRICTLY BEFORE the end date are billed, and
                // each one pushes the end date to the end of the month it buys.
                // Terminates: once a charge extends the end date to its own
                // period end, the cursor sits on it and the condition fails.
                const settleMethod = await methodForPlan(plan);
                let cursor = nextCharge;
                let guard = 0;
                while (cursor && cursor < effective && guard < 24) {
                    lines.push({
                        kind: 'notice_period',
                        label: `${plan.label} — ${prettyDate(cursor)}`,
                        amount: planChargeTotal(plan, settleMethod),
                        date: dateOnly(cursor),
                    });
                    const periodEnd = nextChargeFor(plan, cursor);
                    if (periodEnd) {
                        const lastDay = dayBefore(periodEnd);
                        if (lastDay > effective) effective = lastDay;
                    }
                    cursor = periodEnd;
                    guard += 1;
                }
            }
        } else if (kind === 'crm') {
            const sub = (await pool.query(
                'SELECT * FROM crm_subscriptions WHERE id=$1 AND lead_id=$2', [id, leadId]
            )).rows[0];
            if (!sub) throw new Error('Subscription not found');

            // A CRM subscription ends at the later of the notice and the period
            // already paid for, so nothing extra is owed for the notice window
            // when the paid period already covers it.
            const notice = new Date(Date.now() + CANCELLATION_NOTICE_DAYS * 86400000);
            const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
            effective = periodEnd && periodEnd > notice ? periodEnd : notice;

            // invoices.subscription_id arrives with migration 009. Guarded so a
            // database that hasn't run it yet still cancels rather than 500s.
            let openInv = [];
            try {
                openInv = (await pool.query(
                    `SELECT id, invoice_number, total_amount
                       FROM invoices
                      WHERE lead_id = $1 AND subscription_id = $2
                        AND status NOT IN ('paid','void','cancelled','refunded','draft')`,
                    [leadId, sub.id]
                )).rows;
            } catch (e) {
                console.warn('[SETTLEMENT] invoices.subscription_id unavailable:', e.message);
            }
            for (const i of openInv) {
                lines.push({
                    kind: 'unpaid_invoice', invoiceId: i.id,
                    label: `Unpaid invoice ${i.invoice_number}`,
                    amount: Number(i.total_amount),
                });
            }

            if (String(sub.status) === 'past_due') {
                lines.push({
                    kind: 'missed_charge',
                    label: 'Missed CodeNexus CRM payment',
                    amount: Number(sub.monthly_total || 0),
                });
            }

            // Billing periods that start inside the notice window.
            if (periodEnd && periodEnd < notice) {
                let cursor = new Date(periodEnd);
                let guard = 0;
                while (cursor < notice && guard < 12) {
                    lines.push({
                        kind: 'notice_period',
                        label: `CodeNexus CRM — ${prettyDate(cursor)}`,
                        amount: Number(sub.monthly_total || 0),
                        date: dateOnly(cursor),
                    });
                    cursor = new Date(cursor.getTime());
                    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
                    guard += 1;
                }
            }
        } else {
            throw new Error('Unknown plan type');
        }

        const total = +lines.reduce((t, l) => t + Number(l.amount || 0), 0).toFixed(2);
        return { total, lines, effectiveAt: effective, mustSettle: total > 0.009 };
    }

    /** What the customer owes to cancel, before they commit to anything. */
    app.get('/api/portal/plans/:kind/:id/cancellation-quote', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const q = await cancellationSettlement({ kind: req.params.kind, id: req.params.id, leadId });
            res.json({
                success: true,
                total: q.total,
                lines: q.lines,
                mustSettle: q.mustSettle,
                effectiveAt: q.effectiveAt,
                noticeDays: CANCELLATION_NOTICE_DAYS,
                message: q.mustSettle
                    ? `Cancelling settles the ${CANCELLATION_NOTICE_DAYS}-day notice period. ${money(q.total)} is payable now.`
                    : `Nothing is outstanding. Your plan will end on ${prettyDate(q.effectiveAt)}.`,
            });
        } catch (e) {
            console.error('[CANCEL QUOTE]', e.message);
            res.status(400).json({ success: false, message: e.message });
        }
    });

    /**
     * Raise the settlement invoice so it can be paid inline in the portal, with
     * the same card flow as any other invoice. Cancellation isn't recorded until
     * that invoice is paid.
     */
    async function raiseSettlementInvoice({ leadId, kind, id, quote, label }) {
        // "<Plan> Cancellation", so the invoice, the receipt, the PDF title and
        // the download filename all say what this money was actually for.
        // "Cancellation settlement — Monthly Maintenance" read as jargon and
        // sorted under C; this reads as the thing it is.
        const settlementTitle = `${label} Cancellation`;
        const inv = await createInvoice({
            leadId,
            amount: quote.total,
            description: settlementTitle,
            dueDate: dateOnly(new Date()),
            maintenancePlanId: kind === 'maintenance' ? Number(id) : null,
            obligation: 'due_now',
            items: quote.lines.map((l) => ({
                description: l.label, quantity: 1, unit_price: l.amount, amount: l.amount,
            })),
        });
        return inv;
    }

    /**
     * Build the reinstatement agreement a customer must sign to restart a plan.
     *
     * Reinstating is a fresh commitment to the same recurring charge, so it gets
     * a real signed document rather than a button — and because it's a normal
     * sales_agreements row it lands in Docs, is downloadable, and shows on the
     * customer's account in the admin portal like everything else.
     */
    async function createReinstatementAgreement({ leadId, kind, id }) {
        const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
        if (!lead) throw new Error('Customer not found');

        let label, amount, planId = null, subId = null, cadence = 'monthly';
        if (kind === 'maintenance') {
            const plan = (await pool.query(
                'SELECT * FROM maintenance_plans WHERE id=$1 AND lead_id=$2', [id, leadId]
            )).rows[0];
            if (!plan) throw new Error('Plan not found');
            label = plan.label; amount = planChargeTotal(plan); planId = plan.id;
            cadence = plan.interval_unit === 'year' ? 'annually' : 'monthly';
        } else {
            const sub = (await pool.query(
                'SELECT * FROM crm_subscriptions WHERE id=$1 AND lead_id=$2', [id, leadId]
            )).rows[0];
            if (!sub) throw new Error('Subscription not found');
            label = sub.package_name ? `CodeNexus CRM — ${sub.package_name}` : 'CodeNexus CRM';
            amount = Number(sub.monthly_total || 0); subId = sub.id;
        }

        // One live reinstatement document per plan — a second click shouldn't
        // produce a second thing to sign.
        const existing = (await pool.query(
            `SELECT * FROM sales_agreements
              WHERE lead_id=$1 AND agreement_kind='reinstatement'
                AND ($2::int IS NULL OR maintenance_plan_id = $2)
                AND ($3::int IS NULL OR subscription_id = $3)
                AND status <> 'signed'
              ORDER BY created_at DESC LIMIT 1`,
            [leadId, planId, subId]
        )).rows[0];
        if (existing) return { agreement: existing, reused: true };

        const numRes = await pool.query(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(agreement_number,'\\D','','g'),'')::bigint),0)+1 AS n
               FROM sales_agreements WHERE agreement_number LIKE 'RI-%'`
        );
        const number = `RI-${String(numRes.rows[0].n).padStart(5, '0')}`;

        const ins = await pool.query(
            `INSERT INTO sales_agreements
                (agreement_number, lead_id, customer_name, customer_email, service_type,
                 package_name, price, status, agreement_kind, intro, terms,
                 maintenance_plan_id, subscription_id, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'reinstatement',$5,$6,'sent','reinstatement',$7,$8,$9,$10,NOW(),NOW())
             RETURNING *`,
            [number, leadId, lead.name, lead.email, `Reinstatement — ${label}`, amount,
             `Reinstating ${label} at ${money(amount)} ${cadence}, cancelling the cancellation currently in progress.`,
             `By signing you reinstate ${label} at ${money(amount)} ${cadence}. The cancellation currently scheduled is withdrawn and billing continues as before, charged automatically to the payment method on your account. ` +
             `You may cancel again at any time with ${CANCELLATION_NOTICE_DAYS} days' notice, subject to settling anything outstanding at that point.`,
             planId, subId]
        );

        await onAgreementSent({ agreementId: ins.rows[0].id })
            .catch((e) => console.warn('[REINSTATE] send failed:', e.message));

        return { agreement: ins.rows[0], reused: false };
    }

    /**
     * Reinstatement, step one: hand back the document to sign.
     * The plan is NOT restarted here — signing that document is what does it.
     */
    app.post('/api/portal/plans/:kind/:id/reinstate-request', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const out = await createReinstatementAgreement({
                leadId, kind: req.params.kind === 'crm' ? 'crm' : 'maintenance', id: req.params.id,
            });
            res.json({
                success: true,
                agreementId: out.agreement.id,
                agreementNumber: out.agreement.agreement_number,
                message: out.reused
                    ? 'Your reinstatement document is already waiting in Docs — sign it to restart the plan.'
                    : 'Sign the reinstatement document to restart your plan. It\'s in your Docs section too.',
            });
        } catch (e) {
            console.error('[REINSTATE REQUEST]', e.message);
            res.status(400).json({ success: false, message: e.message });
        }
    });

    /** Signing a reinstatement document restarts the plan it belongs to. */
    async function applyReinstatement(agreement) {
        const leadId = agreement.lead_id;
        // LOOPHOLE FIX: reinstating cleared the cancellation regardless of what
        // was still owed on it, so cancel -> reinstate -> cancel was a free ride
        // through every notice period. Anything unpaid on the plan is carried
        // forward as still due; the plan comes back only as far as its payment
        // state allows.
        if (agreement.maintenance_plan_id) {
            const owed = (await pool.query(
                `SELECT COALESCE(SUM(total_amount),0) AS amt
                   FROM invoices
                  WHERE maintenance_plan_id = $1
                    AND status NOT IN ('paid','void','cancelled','refunded','draft')`,
                [agreement.maintenance_plan_id]
            )).rows[0];
            if (Number(owed.amt) > 0) {
                await adminNotify({
                    kind: 'reinstated_with_balance',
                    title: 'Plan reinstated with an unpaid balance',
                    body: `${money(owed.amt)} still outstanding on plan #${agreement.maintenance_plan_id}.`,
                    leadId, entityType: 'maintenance_plan', entityId: agreement.maintenance_plan_id,
                    severity: 'warning',
                    onceKey: `reinstate_balance:${agreement.id}`,
                });
            }
        }
        if (agreement.maintenance_plan_id) {
            await pool.query(
                `UPDATE plan_cancellations SET status='reinstated', reinstated_at=NOW(),
                        reinstatement_agreement_id=$2
                  WHERE maintenance_plan_id=$1 AND status='pending'`,
                [agreement.maintenance_plan_id, agreement.id]
            );
            await pool.query(
                `UPDATE maintenance_plans mp
                    SET status = CASE
                            WHEN COALESCE(mp.payment_method_id, l.default_payment_method_id) IS NOT NULL
                                 THEN 'active' ELSE 'pending_payment_method' END,
                        consecutive_failures = 0,
                        updated_at = NOW()
                   FROM leads l
                  WHERE mp.id=$1 AND l.id = mp.lead_id
                    AND mp.status IN ('pending_cancellation','cancelled','suspended')`,
                [agreement.maintenance_plan_id]
            );
        } else if (agreement.subscription_id) {
            const sub = (await pool.query(
                'SELECT * FROM crm_subscriptions WHERE id=$1', [agreement.subscription_id]
            )).rows[0];
            if (sub && sub.stripe_subscription_id && stripe) {
                await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: false })
                    .catch((e) => console.warn('[REINSTATE] stripe:', e.message));
            }
            await pool.query(
                'UPDATE crm_subscriptions SET cancel_at_period_end=FALSE, updated_at=NOW() WHERE id=$1',
                [agreement.subscription_id]
            );
            await pool.query(
                `UPDATE plan_cancellations SET status='reinstated', reinstated_at=NOW(),
                        reinstatement_agreement_id=$2
                  WHERE subscription_id=$1 AND status='pending'`,
                [agreement.subscription_id, agreement.id]
            );
        }

        const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1', [leadId])).rows[0];
        await notify({
            lead, kind: 'cancellation_confirmed',
            subject: `${agreement.package_name || 'Your plan'} is reinstated`,
            bodyHtml: `<p style="margin:0 0 12px">Thanks for signing. <strong style="color:#0d0f12">${agreement.package_name || 'Your plan'}</strong> is reinstated and the cancellation has been withdrawn.</p>
                       <p style="margin:0">Billing continues as before. A copy of the signed document is in your Docs.</p>`,
            smsText: `Diamondback Coding: your plan is reinstated and the cancellation is withdrawn.`,
            channels: ['email', 'portal'],
            cta: { url: PORTAL_URL, label: 'View your plans' },
        });

        await adminNotify({
            kind: 'plan_reinstated',
            title: `${lead.name} reinstated ${agreement.package_name || 'a plan'}`,
            body: `Signed ${agreement.agreement_number} — cancellation withdrawn`,
            leadId, entityType: 'agreement', entityId: agreement.id,
            severity: 'success', onceKey: `reinstated_signed:${agreement.id}`,
        });

        return { reinstated: true };
    }

    // ---- admin: every document on a customer's account -------------------
    app.get('/api/admin/customers/:leadId/documents', authenticateToken, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT sa.id, sa.agreement_number, sa.agreement_kind, sa.package_name,
                        sa.service_type, sa.price, sa.status, sa.signed_at, sa.created_at,
                        sa.maintenance_plan_id, sa.subscription_id, sa.invoice_id,
                        sig.signer_name,
                        mp.label AS plan_label, mp.status AS plan_status,
                        cs.package_name AS subscription_name
                   FROM sales_agreements sa
                   LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id
                   LEFT JOIN maintenance_plans mp ON mp.id = sa.maintenance_plan_id
                   LEFT JOIN crm_subscriptions cs ON cs.id = sa.subscription_id
                  WHERE sa.lead_id = $1
                  ORDER BY sa.created_at DESC`,
                [req.params.leadId]
            );
            const docs = r.rows.map((d) => ({
                ...d,
                is_signed: !!(d.signed_at || d.status === 'signed' || d.signer_name),
                attached_to: d.plan_label
                    ? `Plan: ${d.plan_label}`
                    : (d.subscription_name ? `Subscription: ${d.subscription_name}`
                    : (d.agreement_kind === 'sla' ? 'Project' : 'Account')),
            }));
            res.json({
                success: true, documents: docs,
                counts: {
                    total: docs.length,
                    signed: docs.filter((d) => d.is_signed).length,
                    awaiting: docs.filter((d) => !d.is_signed && d.status !== 'cancelled').length,
                },
            });
        } catch (e) {
            console.error('[CUSTOMER DOCS]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'This customer\'s documents') });
        }
    });

    // ---- admin: why can't this customer see their documents? -------------
    // Answers the "admin shows it, the portal doesn't" question directly, by
    // reporting exactly what is attached to the customer's lead id and what is
    // attached to nobody.
    app.get('/api/admin/customers/:leadId/diagnose', authenticateToken, async (req, res) => {
        try {
            const leadId = req.params.leadId;
            const lead = (await pool.query(
                `SELECT id, name, email, is_customer, portal_kind, crm_access,
                        (client_password IS NOT NULL) AS has_portal
                   FROM leads WHERE id = $1`, [leadId]
            )).rows[0];
            if (!lead) return res.status(404).json({ success: false, message: 'Customer not found.' });

            // Duplicate rows on the same email are the usual reason a document
            // "disappears": it hangs off one row, the portal signs in as another.
            const dupes = (await pool.query(
                `SELECT id, name, (client_password IS NOT NULL) AS has_portal, is_customer, created_at
                   FROM leads WHERE LOWER(email) = LOWER($1) ORDER BY id`, [lead.email]
            )).rows;

            const agreements = (await pool.query(
                `SELECT sa.id, sa.agreement_number, sa.status, sa.agreement_kind, sa.lead_id,
                        sa.signed_at, (sig.id IS NOT NULL) AS has_signature
                   FROM sales_agreements sa
                   LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id
                  WHERE sa.lead_id = $1 ORDER BY sa.created_at DESC`, [leadId]
            )).rows;

            const orphans = (await pool.query(
                `SELECT id, agreement_number, customer_email, status, created_at
                   FROM sales_agreements
                  WHERE lead_id IS NULL
                     OR (customer_email IS NOT NULL AND LOWER(customer_email) = LOWER($1) AND lead_id <> $2)
                  ORDER BY created_at DESC`, [lead.email, leadId]
            )).rows;

            const plans = (await pool.query(
                `SELECT id, label, plan_type, status, signed_at, agreement_id,
                        billing_start_date, next_charge_date, interval_unit
                   FROM maintenance_plans WHERE lead_id = $1 ORDER BY created_at DESC`, [leadId]
            )).rows;

            const invoices = (await pool.query(
                `SELECT id, invoice_number, status, total_amount, due_date, obligation, is_deposit
                   FROM invoices WHERE lead_id = $1 ORDER BY created_at DESC`, [leadId]
            )).rows;

            const problems = [];
            if (!lead.has_portal) problems.push('This customer has no portal password — they cannot sign in at all.');
            if (dupes.length > 1) {
                problems.push(`There are ${dupes.length} lead rows with this email (ids ${dupes.map((d) => d.id).join(', ')}). ` +
                    'The portal signs in as one of them, so anything attached to another row is invisible to the customer.');
            }
            if (orphans.length) {
                problems.push(`${orphans.length} agreement(s) for this email are attached to no customer, or to a different one — ` +
                    'those will never appear in this customer\'s portal.');
            }
            for (const a of agreements) {
                if (a.has_signature && !a.signed_at) {
                    problems.push(`Agreement ${a.agreement_number} has a signature but its row was never marked signed — run migration 006.`);
                }
            }
            for (const p of plans) {
                if (p.signed_at && p.status === 'pending_signature') {
                    problems.push(`Plan "${p.label}" is signed but still reads pending_signature — run migration 006.`);
                }
            }

            res.json({
                success: true, lead, duplicateLeads: dupes,
                agreements, orphanAgreements: orphans, plans, invoices,
                problems,
                summary: problems.length
                    ? `${problems.length} issue(s) found.`
                    : 'Nothing wrong found — the customer portal should show exactly what is listed here.',
            });
        } catch (e) {
            console.error('[DIAGNOSE]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'The diagnosis') });
        }
    });

    // ---- admin: schema diagnostics ---------------------------------------
    // Answers "why is this tab 500ing?" without needing database access. Reports
    // which tables the new features require, which are present, and whether the
    // migrations were recorded as applied.
    app.get('/api/admin/schema-check', authenticateToken, async (req, res) => {
        const REQUIRED = {
            'Notifications':     ['admin_notifications', 'lifecycle_events'],
            'Maintenance plans': ['maintenance_plans', 'plan_cancellations', 'payment_methods'],
            'Past due':          ['invoice_dunning', 'billing_notifications'],
            'Payments/refunds':  ['payments', 'refunds'],
            'Customer portal':   ['client_messages', 'sales_agreements', 'service_requests'],
            'Agreements':        ['agreement_items', 'agreement_signatures', 'agreement_templates'],
        };
        try {
            const present = new Set(
                (await pool.query(
                    `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
                )).rows.map((r) => r.table_name)
            );

            const features = {};
            const allMissing = [];
            for (const [feature, tables] of Object.entries(REQUIRED)) {
                const missing = tables.filter((t) => !present.has(t));
                features[feature] = { ok: missing.length === 0, missing };
                allMissing.push(...missing);
            }

            let migrations = [];
            let migrationsTracked = present.has('schema_migrations');
            if (migrationsTracked) {
                migrations = (await pool.query(
                    'SELECT filename, applied_at, statements, failures FROM schema_migrations ORDER BY filename'
                )).rows;
            }

            res.json({
                success: true,
                ok: allMissing.length === 0,
                features,
                missingCount: allMissing.length,
                missing: [...new Set(allMissing)],
                migrationsTracked,
                migrations,
                advice: allMissing.length === 0
                    ? 'Schema is complete. If a tab still fails, the error is not a missing table — check the service logs.'
                    : (migrationsTracked
                        ? 'Migrations ran but some tables are still missing. Check the service logs for [DB] Migration failure lines.'
                        : 'Migrations have never been applied on this database. Restart the service — they now run automatically at boot.'),
            });
        } catch (e) {
            console.error('[SCHEMA CHECK]', e.code, e.message);
            res.status(500).json({ success: false, message: e.message, code: e.code });
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
            console.error('[ADMIN SUBSCRIPTIONS]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Subscriptions') });
        }
    });

    // ---- admin: past-due dashboard ---------------------------------------
    app.get('/api/admin/past-due', authenticateToken, async (req, res) => {
        try {
            res.json({ success: true, ...(await pastDueReport()) });
        } catch (e) {
            console.error('[ADMIN PAST DUE]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Past-due invoices') });
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
    /**
     * SELF-REPAIR: create the missing ledger rows for this customer, now.
     *
     * Three different code paths could mark an invoice `status='paid'`, and
     * only one of them ever wrote to `payments`. Every invoice paid through the
     * Stripe Checkout webhook — and every invoice paid before that was fixed —
     * shows as paid with no receipt anywhere, because Receipts, Payment history
     * and the receipt PDF route all read from `payments`.
     *
     * Fixing the write paths only helps payments made from now on. The rows
     * already in the database stay broken until something repairs them, and a
     * repair that requires shelling into the server to run a script is a repair
     * that does not happen. So it happens here, when the customer opens the
     * page that would otherwise be wrong.
     *
     * Cheap: one indexed query that returns nothing in the normal case, and it
     * never writes twice — a payment is matched by invoice_id OR by the Stripe
     * reference, so an existing row in either shape blocks the insert.
     */
    async function repairMissingReceipts(leadId) {
        try {
            const cols = await pool.query(
                `SELECT column_name FROM information_schema.columns WHERE table_name='payments'`);
            const have = new Set(cols.rows.map((c) => c.column_name));
            if (!have.has('receipt_number')) return 0;   // pre-011 database
            const extended = have.has('base_amount') && have.has('tax_amount')
                          && have.has('processing_fee');

            const gaps = await pool.query(
                `SELECT i.id, i.invoice_number, i.total_amount, i.subtotal, i.tax_amount,
                        i.paid_at, i.payment_method, i.payment_reference,
                        i.short_description, i.maintenance_plan_id, i.lead_id, i.created_at
                   FROM invoices i
                   LEFT JOIN payments byinv ON byinv.invoice_id = i.id
                   LEFT JOIN payments bypi  ON i.payment_reference IS NOT NULL
                                           AND bypi.stripe_payment_intent_id = i.payment_reference
                  WHERE i.lead_id = $1
                    AND i.status = 'paid'
                    AND byinv.id IS NULL
                    AND bypi.id IS NULL`,
                [leadId]);

            // Always report the picture, so the Render logs answer "why is my
            // receipt missing" without anyone shelling in to run a script.
            const audit = await pool.query(
                `SELECT
                    (SELECT COUNT(*)::int FROM invoices WHERE lead_id=$1) AS invoices_total,
                    (SELECT COUNT(*)::int FROM invoices WHERE lead_id=$1 AND status='paid') AS invoices_paid,
                    (SELECT COUNT(*)::int FROM payments WHERE lead_id=$1) AS payments_total`,
                [leadId]);
            const a = audit.rows[0];
            console.log(`[RECEIPTS] lead ${leadId}: ${a.invoices_paid} paid invoice(s), `
                      + `${a.payments_total} payment(s) on file, ${gaps.rows.length} gap(s) to repair.`);

            if (!gaps.rows.length) {
                // No gaps, but fewer payments than paid invoices means rows
                // exist under a DIFFERENT lead_id and this customer cannot see
                // them — a different bug with a different fix, worth naming.
                if (a.payments_total < a.invoices_paid) {
                    const mismatched = await pool.query(
                        `SELECT p.id, p.lead_id AS pay_lead, i.lead_id AS inv_lead, i.invoice_number
                           FROM payments p JOIN invoices i ON i.id = p.invoice_id
                          WHERE i.lead_id = $1 AND COALESCE(p.lead_id,-1) <> COALESCE(i.lead_id,-1)`,
                        [leadId]);
                    mismatched.rows.forEach((x) => console.warn(
                        `[RECEIPTS] payment ${x.id} on ${x.invoice_number} is attached to lead `
                        + `${x.pay_lead} but the invoice belongs to lead ${x.inv_lead} — `
                        + `the customer cannot see it.`));
                }
                return 0;
            }

            let made = 0;
            for (const inv of gaps.rows) {
                // paid_at is the truth about when. Falling back to created_at
                // rather than NOW() keeps an old payment showing its real date
                // instead of today's.
                const paidAt = inv.paid_at || inv.created_at || new Date();
                const total = Number(inv.total_amount || 0);
                const tax = Number(inv.tax_amount || 0);
                const fee = Number(inv.processing_fee || 0);
                const base = inv.subtotal != null ? Number(inv.subtotal)
                                                  : Math.max(0, total - tax - fee);
                // Derived from the invoice id, so the number is stable forever
                // and a repeat run cannot mint a second one.
                const receiptNo = `RCPT-INV${String(inv.id).padStart(6, '0')}`;
                const method = /bank|ach/i.test(inv.payment_method || '') ? 'us_bank_account' : 'card';
                const kind = inv.maintenance_plan_id ? 'maintenance' : 'invoice';

                // What the customer sees in Receipts. The invoice's own
                // short_description ("Monthly Maintenance Cancellation") is far
                // more use than "Invoice INV-699016", so prefer it and keep the
                // number as the fallback.
                const desc = (inv.short_description && inv.short_description.trim())
                    || `Invoice ${inv.invoice_number}`;

                const sql = extended
                    ? `INSERT INTO payments
                        (lead_id, invoice_id, maintenance_plan_id, amount, method, kind, description,
                         status, stripe_payment_intent_id, receipt_number,
                         base_amount, tax_amount, processing_fee, paid_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9,$10,$11,$12,$13)`
                    : `INSERT INTO payments
                        (lead_id, invoice_id, maintenance_plan_id, amount, method, kind, description,
                         status, stripe_payment_intent_id, receipt_number, paid_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9,$10)`;
                const args = extended
                    ? [inv.lead_id, inv.id, inv.maintenance_plan_id || null, total, method, kind,
                       desc, inv.payment_reference || null, receiptNo,
                       base, tax, fee, paidAt]
                    : [inv.lead_id, inv.id, inv.maintenance_plan_id || null, total, method, kind,
                       desc, inv.payment_reference || null, receiptNo,
                       paidAt];

                await pool.query(sql, args);
                made += 1;
                console.log(`[RECEIPTS] Repaired missing receipt for invoice ${inv.invoice_number} `
                          + `(${receiptNo}, ${money(total)}, paid ${paidAt}).`);
            }
            return made;
        } catch (e) {
            // Never let a repair break the page it is repairing.
            console.warn('[RECEIPTS] repair skipped:', e.message);
            return 0;
        }
    }

    app.get('/api/portal/payments', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            // Fill any gaps BEFORE reading, so the customer sees the repaired
            // list on this request rather than having to reload.
            const repaired = await repairMissingReceipts(leadId);
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
                repaired,
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

    // ======================================================================
    // Unified plans — maintenance plans AND the CRM subscription
    // ======================================================================
    // The Plans tab shows both, because from the customer's side they're the
    // same kind of thing: a recurring charge they may want to re-card or cancel.
    // Maintenance lives in maintenance_plans; the CRM subscription lives in
    // crm_subscriptions and is billed by Stripe directly.

    /** Everything recurring for one customer, in one shape the UI can render. */
    async function listAllPlans(leadId) {
        // The method shown is the ACCOUNT default, with a per-plan override only
        // for legacy rows. Joining solely on mp.payment_method_id would show
        // "No payment method" on every plan now that overrides are cleared.
        const maint = (await pool.query(
            `SELECT mp.*, pc.effective_at AS cancels_at, pc.id AS cancellation_id,
                    pm.brand, pm.last4, pm.type AS method_type, pm.bank_name, pm.id AS pm_id
               FROM maintenance_plans mp
               LEFT JOIN plan_cancellations pc
                      ON pc.maintenance_plan_id = mp.id AND pc.status = 'pending'
               LEFT JOIN leads l ON l.id = mp.lead_id
               LEFT JOIN payment_methods pm
                      ON pm.id = COALESCE(mp.payment_method_id, l.default_payment_method_id)
                     AND pm.status = 'active'
              WHERE mp.lead_id = $1 AND mp.status <> 'cancelled'
              ORDER BY mp.created_at DESC`,
            [leadId]
        )).rows;

        let crm = [];
        try {
            crm = (await pool.query(
                `SELECT cs.*, pc.effective_at AS cancels_at
                   FROM crm_subscriptions cs
                   LEFT JOIN plan_cancellations pc
                          ON pc.subscription_id = cs.id AND pc.status = 'pending'
                  WHERE cs.lead_id = $1
                    AND COALESCE(cs.status,'active') NOT IN ('cancelled','canceled','expired')
                  ORDER BY cs.created_at DESC`,
                [leadId]
            )).rows;
        } catch (e) {
            console.warn('[PLANS] crm_subscriptions unavailable:', e.message);
        }

        const days = (d) => (d ? Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400000)) : null);

        // Price every plan against the method it will ACTUALLY be charged on,
        // so the Billing screen can show the same figure as the dashboard. The
        // credit-card surcharge depends on the card type, so this cannot be
        // derived from the plan row alone.
        const acctMethod = (await pool.query(
            `SELECT pm.* FROM payment_methods pm
               JOIN leads l ON l.default_payment_method_id = pm.id
              WHERE l.id = $1 AND pm.status = 'active'`, [leadId]
        ).catch(() => ({ rows: [] }))).rows[0] || null;

        for (const p of maint) {
            let method = acctMethod;
            if (p.payment_method_id) {
                const own = (await pool.query(
                    `SELECT * FROM payment_methods WHERE id = $1 AND status = 'active'`,
                    [p.payment_method_id]).catch(() => ({ rows: [] }))).rows[0];
                if (own) method = own;
            }
            try { p.__price = pricing.priceFor(p, method); }
            catch (e) { console.warn('[PLANS] pricing skipped:', e.message); }
        }

        const plans = maint.map((p) => ({
            kind: 'maintenance',
            id: p.id,
            label: p.label,
            description: p.description,
            plan_type: p.plan_type,
            amount: Number(p.amount),
            // The true amount signed/invoiced/charged: base + domain
            // maintenance fee (renewals) + sales tax. Priced WITHOUT a payment
            // method, so it excludes the credit-card surcharge.
            charge_total: planChargeTotal(p),
            // WHAT THEY WILL ACTUALLY BE CHARGED, on the method they actually
            // have. charge_total alone was being displayed on the Billing
            // screen, so a customer paying by credit card saw a figure ~3%
            // below what left their account — the dashboard showed the real
            // number and Billing did not, which is worse than either being
            // wrong on its own.
            billed_total: p.__price ? p.__price.total : planChargeTotal(p),
            price_breakdown: p.__price ? p.__price.lines : null,
            tax_amount: p.__price ? p.__price.tax : 0,
            processing_fee: p.__price ? p.__price.fee : 0,
            processing_fee_applies: p.__price ? p.__price.feeApplies : false,
            fee_note: p.__price ? pricing.feeExplanation(p.__price) : null,
            // Full breakdown — base, domain fee, tax, and the credit-card
            // processing fee. Priced WITHOUT a method, so this is the fee-free
            // figure; the portal shows the credit total separately from the
            // per-method quote, because we cannot know here how they will pay.
            fee_breakdown: planPricing(p, null),
            billing_day: p.billing_day,
            interval_unit: p.interval_unit || 'month',
            billing_start_date: p.billing_start_date,
            item_reference: p.item_reference,
            status: p.status,
            next_charge_date: p.next_charge_date,
            // The portal decides "First payment" vs "Next payment" from these,
            // not from status — a plan that has been paid, cancelled,
            // reinstated and cancelled again is not on its first payment, but
            // its status alone cannot say so.
            charges_completed: Number(p.charges_completed || 0),
            last_charge_date: p.last_charge_date || null,
            // A price/schedule change waiting on the customer's signature. The
            // plan keeps billing the CURRENT amount until then, so both figures
            // have to be visible or the customer cannot tell which is which.
            pending_amount: p.pending_amount != null ? Number(p.pending_amount) : null,
            pending_billing_day: p.pending_billing_day != null ? Number(p.pending_billing_day) : null,
            pending_agreement_id: p.pending_agreement_id || null,
            pending_total: p.pending_amount != null
                ? planChargeTotal({ ...p, amount: Number(p.pending_amount) }) : null,
            cancels_at: p.cancels_at,
            days_until_cancellation: days(p.cancels_at),
            payment_method: p.pm_id ? {
                id: p.pm_id, type: p.method_type, brand: p.brand,
                last4: p.last4, bank_name: p.bank_name,
            } : null,
            can_change_payment_method: true,
            can_cancel: ['active', 'past_due', 'pending_payment_method', 'pending_signature'].includes(p.status),
            signed_at: p.signed_at,
            agreement_id: p.agreement_id,
        })).concat(crm.map((c) => ({
            kind: 'crm',
            id: c.id,
            label: c.package_name ? ('CodeNexus CRM \u2014 ' + c.package_name) : 'CodeNexus CRM',
            description: c.user_count
                ? `${c.user_count} user${Number(c.user_count) === 1 ? '' : 's'} at ${money(c.price_per_user)} each`
                : null,
            amount: Number(c.monthly_total || 0),
            status: c.cancel_at_period_end ? 'pending_cancellation' : (c.status || 'active'),
            next_charge_date: c.current_period_end,
            cancels_at: c.cancels_at || (c.cancel_at_period_end ? c.current_period_end : null),
            days_until_cancellation: days(c.cancels_at || (c.cancel_at_period_end ? c.current_period_end : null)),
            payment_method: null,   // filled from Stripe below
            can_change_payment_method: !!c.stripe_subscription_id,
            can_cancel: true,
            stripe_subscription_id: c.stripe_subscription_id,
            user_count: c.user_count,
        })));

        // The CRM subscription's card lives on the Stripe subscription, not in
        // payment_methods, so read it from Stripe for display. Best effort: a
        // Stripe hiccup must not blank the whole Plans tab.
        for (const p of plans) {
            if (p.kind !== 'crm' || !p.stripe_subscription_id || !stripe) continue;
            try {
                const sub = await stripe.subscriptions.retrieve(p.stripe_subscription_id, {
                    expand: ['default_payment_method'],
                });
                const pm = sub.default_payment_method;
                if (pm && typeof pm === 'object') {
                    p.payment_method = {
                        stripe_pm_id: pm.id,
                        type: pm.type,
                        brand: pm.card ? pm.card.brand : (pm.us_bank_account ? 'bank' : null),
                        last4: pm.card ? pm.card.last4 : (pm.us_bank_account ? pm.us_bank_account.last4 : null),
                        bank_name: pm.us_bank_account ? pm.us_bank_account.bank_name : null,
                    };
                }
            } catch (e) {
                console.warn('[PLANS] Stripe sub ' + p.stripe_subscription_id + ':', e.message);
            }
        }

        // Fall back to the account method for any plan Stripe didn't report one
        // for, so the UI never claims a plan has no method when the account does.
        if (plans.some((p) => !p.payment_method)) {
            const acct = await resolvePaymentMethod(leadId, null);
            if (acct) {
                for (const p of plans) {
                    if (!p.payment_method) {
                        p.payment_method = {
                            id: acct.id, type: acct.type, brand: acct.brand,
                            last4: acct.last4, bank_name: acct.bank_name,
                            stripe_pm_id: acct.stripe_pm_id,
                        };
                    }
                }
            }
        }

        return plans;
    }

    /**
     * Close the period a successful charge just paid for, and open the next.
     *
     * This is the write half of the outstanding rule in
     * diamondback-document-routes.js: that module decides a monthly plan is
     * outstanding when current_period_paid_at IS NULL, and this is what sets
     * it. Called after every successful recurring charge.
     *
     * Guarded on the columns existing so a database where 011 hasn't run yet
     * keeps charging normally rather than throwing on every renewal.
     */
    async function settlePlanPeriod(planId, nextPeriodStart, paidAt = new Date()) {
        try {
            const has = await pool.query(
                `SELECT 1 FROM information_schema.columns
                  WHERE table_name='maintenance_plans' AND column_name='current_period_paid_at'`);
            if (!has.rows.length) return;
            await pool.query(
                `UPDATE maintenance_plans
                    SET current_period_paid_at = $2, updated_at = NOW()
                  WHERE id = $1`, [planId, paidAt]);
            if (nextPeriodStart) {
                await pool.query(
                    `UPDATE maintenance_plans
                        SET current_period_start = $2, current_period_paid_at = NULL, updated_at = NOW()
                      WHERE id = $1`, [planId, nextPeriodStart]);
            }
        } catch (e) {
            // Never let bookkeeping fail a charge that already succeeded.
            console.warn('[LIFECYCLE] settlePlanPeriod:', e.message);
        }
    }

    app.get('/api/portal/plans', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const plans = await listAllPlans(leadId);
            const methods = (await pool.query(
                `SELECT id, type, brand, last4, exp_month, exp_year, bank_name, is_default, status, stripe_pm_id
                   FROM payment_methods
                  WHERE lead_id = $1 AND status = 'active'
                  ORDER BY is_default DESC, id DESC`,
                [leadId]
            )).rows;
            res.json({ success: true, plans, paymentMethods: methods, noticeDays: CANCELLATION_NOTICE_DAYS });
        } catch (e) {
            console.error('[PORTAL PLANS ALL]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Your plans') });
        }
    });

    /**
     * Change the payment method on any plan — maintenance or CRM.
     *
     * Accepts either a saved method (paymentMethodId) or another plan to copy
     * from (sameAsPlanKind + sameAsPlanId) — the "use the same card as my other
     * plan" case. Copying resolves to the same underlying Stripe payment method
     * so there's one card on file, not a duplicate that drifts out of sync.
     */
    app.post('/api/portal/plans/:kind/:id/payment-method', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const { kind, id } = req.params;
            const { paymentMethodId, sameAsPlanKind, sameAsPlanId } = req.body || {};

            let pm = null;
            if (sameAsPlanKind && sameAsPlanId) {
                const all = await listAllPlans(leadId);
                const src = all.find((p) => p.kind === sameAsPlanKind && String(p.id) === String(sameAsPlanId));
                if (!src || !src.payment_method) {
                    return res.status(400).json({
                        success: false,
                        message: "That plan doesn't have a payment method saved yet.",
                    });
                }
                if (src.payment_method.id) {
                    pm = (await pool.query(
                        'SELECT * FROM payment_methods WHERE id=$1 AND lead_id=$2',
                        [src.payment_method.id, leadId]
                    )).rows[0];
                }
                if (!pm && src.payment_method.stripe_pm_id) {
                    pm = (await pool.query(
                        'SELECT * FROM payment_methods WHERE stripe_pm_id=$1 AND lead_id=$2',
                        [src.payment_method.stripe_pm_id, leadId]
                    )).rows[0] || {
                        id: null, stripe_pm_id: src.payment_method.stripe_pm_id,
                        type: src.payment_method.type, brand: src.payment_method.brand,
                        last4: src.payment_method.last4, bank_name: src.payment_method.bank_name,
                    };
                }
            } else if (paymentMethodId) {
                pm = (await pool.query(
                    `SELECT * FROM payment_methods WHERE id=$1 AND lead_id=$2 AND status='active'`,
                    [paymentMethodId, leadId]
                )).rows[0];
            }

            if (!pm) {
                return res.status(400).json({
                    success: false,
                    message: 'Choose a saved payment method, or add a new one first.',
                });
            }

            if (kind === 'maintenance') {
                if (!pm.id) {
                    return res.status(400).json({
                        success: false,
                        message: 'That card isn\u2019t saved to your account yet. Add it under Payments first.',
                    });
                }
                const owns = await pool.query(
                    'SELECT id FROM maintenance_plans WHERE id=$1 AND lead_id=$2', [id, leadId]);
                if (!owns.rows.length) {
                    return res.status(404).json({ success: false, message: 'Plan not found.' });
                }
                // Sets the ACCOUNT default and clears every per-plan override,
                // so one card covers all plans. Choosing a method on one plan
                // deliberately moves them all — that's the single-method model,
                // not a bug.
                await setAccountPaymentMethod(leadId, pm.id);
            } else if (kind === 'crm') {
                const sub = (await pool.query(
                    'SELECT * FROM crm_subscriptions WHERE id=$1 AND lead_id=$2', [id, leadId]
                )).rows[0];
                if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found.' });
                if (!sub.stripe_subscription_id) {
                    return res.status(400).json({
                        success: false,
                        message: "This subscription isn't linked to Stripe yet \u2014 contact us and we'll update it for you.",
                    });
                }
                if (!stripe) {
                    return res.status(503).json({ success: false, message: 'Payments are temporarily unavailable.' });
                }
                // Stripe rejects a default payment method that isn't attached to
                // the subscription's customer, so attach first.
                const customerId = sub.stripe_customer_id || await ensureStripeCustomer(leadId);
                try {
                    await stripe.paymentMethods.attach(pm.stripe_pm_id, { customer: customerId });
                } catch (e) {
                    if (!/already been attached/i.test(e.message)) throw e;
                }
                await stripe.subscriptions.update(sub.stripe_subscription_id, {
                    default_payment_method: pm.stripe_pm_id,
                });
                await pool.query(
                    'UPDATE crm_subscriptions SET stripe_customer_id=$2, updated_at=NOW() WHERE id=$1',
                    [sub.id, customerId]
                );
                // Keep the account default in step, so the CRM and every
                // maintenance plan bill the same card.
                if (pm.id) await setAccountPaymentMethod(leadId, pm.id);
            } else {
                return res.status(400).json({ success: false, message: 'Unknown plan type.' });
            }

            const label = pm.type === 'card'
                ? `${pm.brand || 'card'} ending ${pm.last4}`
                : `${pm.bank_name || 'bank account'} ending ${pm.last4}`;
            res.json({
                success: true,
                message: `Payment method updated to your ${label}. It's now used for everything on your account.`,
            });
        } catch (e) {
            console.error('[PORTAL PM CHANGE]', e.message);
            res.status(500).json({ success: false, message: e.message || 'Could not update the payment method.' });
        }
    });

    /**
     * Cancel a CRM subscription, with the same 30-day notice as maintenance.
     *
     * Stripe gets cancel_at_period_end rather than an immediate cancel, so they
     * keep the service they've already paid for. CRM access is revoked only when
     * the cancellation actually completes.
     */
    app.post('/api/portal/plans/crm/:id/cancel', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const sub = (await pool.query(
                'SELECT * FROM crm_subscriptions WHERE id=$1 AND lead_id=$2', [req.params.id, leadId]
            )).rows[0];
            if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found.' });

            const existing = (await pool.query(
                `SELECT * FROM plan_cancellations WHERE subscription_id=$1 AND status='pending'`, [sub.id]
            )).rows[0];
            if (existing) {
                return res.json({
                    success: true, alreadyPending: true, effectiveAt: existing.effective_at,
                    message: `This subscription is already scheduled to end on ${prettyDate(existing.effective_at)}.`,
                });
            }

            // Same rule as maintenance: nothing outstanding can be walked away
            // from by cancelling.
            const quote = await cancellationSettlement({ kind: 'crm', id: sub.id, leadId });
            if (quote.mustSettle) {
                const paidId = (req.body || {}).settlementInvoiceId;
                let settled = false;
                if (paidId) {
                    const chk = (await pool.query(
                        'SELECT status FROM invoices WHERE id=$1 AND lead_id=$2', [paidId, leadId])).rows[0];
                    settled = !!chk && chk.status === 'paid';
                }
                if (!settled) {
                    const sInv = await raiseSettlementInvoice({
                        leadId, kind: 'crm', id: sub.id, quote,
                        label: sub.package_name ? `CodeNexus CRM (${sub.package_name})` : 'CodeNexus CRM',
                    });
                    return res.status(402).json({
                        success: false,
                        code: 'SETTLEMENT_REQUIRED',
                        message: `${money(quote.total)} is outstanding on this subscription. It has to be paid before it can be cancelled.`,
                        settlement: {
                            invoiceId: sInv.id, invoiceNumber: sInv.invoice_number,
                            total: Number(sInv.total_amount), lines: quote.lines,
                            effectiveAt: quote.effectiveAt,
                        },
                    });
                }
            }

            // End at the LATER of the 30-day notice and the period already paid
            // for — never cut short service that's been invoiced.
            const notice = new Date(Date.now() + CANCELLATION_NOTICE_DAYS * 86400000);
            const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
            const effective = periodEnd && periodEnd > notice ? periodEnd : notice;

            if (sub.stripe_subscription_id && stripe) {
                await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true })
                    .catch((e) => console.warn('[CRM CANCEL] Stripe:', e.message));
            }

            const ins = await pool.query(
                `INSERT INTO plan_cancellations
                    (subscription_id, lead_id, effective_at, notice_days, requested_by, reason, status, confirmation_sent_at)
                 VALUES ($1,$2,$3,$4,'customer',$5,'pending',NOW()) RETURNING *`,
                [sub.id, leadId, effective, CANCELLATION_NOTICE_DAYS, (req.body || {}).reason || null]
            );
            await pool.query(
                'UPDATE crm_subscriptions SET cancel_at_period_end=TRUE, updated_at=NOW() WHERE id=$1', [sub.id]
            );

            const lead = (await pool.query('SELECT id,name,email,phone FROM leads WHERE id=$1', [leadId])).rows[0];
            await notify({
                lead, kind: 'cancellation_confirmed',
                subject: 'Your CodeNexus CRM subscription is scheduled to end',
                bodyHtml: `<p style="margin:0 0 12px">We've received your cancellation request for <strong style="color:#0d0f12">${sub.package_name || 'CodeNexus CRM'}</strong>.</p>
                    <p style="margin:0 0 12px">You keep full CRM access until <strong style="color:#15803d">${prettyDate(effective)}</strong>, and you won't be billed after that.</p>
                    <p style="margin:0 0 12px">Your customer portal is unaffected \u2014 invoices, receipts and messages stay exactly where they are.</p>
                    <p style="margin:0">Changed your mind? You can reinstate from your portal any time before that date.</p>`,
                smsText: `Diamondback Coding: your CodeNexus CRM subscription ends ${prettyDate(effective)}. Your customer portal is unaffected. Reinstate anytime before then.`,
                channels: ['email', 'sms', 'portal'],
                cta: { url: PORTAL_URL, label: 'Manage your plans' },
            });

            await adminNotify({
                kind: 'crm_cancellation_requested',
                title: `${lead.name} is cancelling their CRM subscription`,
                body: `${money(sub.monthly_total)}/mo \u00b7 ends ${prettyDate(effective)}`,
                leadId, entityType: 'crm_subscription', entityId: sub.id,
                severity: 'warning', onceKey: `crm_cancel_requested:${ins.rows[0].id}`,
            });

            res.json({
                success: true, effectiveAt: effective,
                message: `Cancellation confirmed. You keep CRM access until ${prettyDate(effective)}.`,
            });
        } catch (e) {
            console.error('[CRM CANCEL]', e.message);
            res.status(500).json({ success: false, message: e.message });
        }
    });

    app.post('/api/portal/plans/crm/:id/reinstate', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const sub = (await pool.query(
                'SELECT * FROM crm_subscriptions WHERE id=$1 AND lead_id=$2', [req.params.id, leadId]
            )).rows[0];
            if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found.' });

            // Same as maintenance: signed document first, restart on signature.
            const doc = await createReinstatementAgreement({ leadId, kind: 'crm', id: sub.id });
            return res.json({
                success: true,
                requiresSignature: true,
                agreementId: doc.agreement.id,
                agreementNumber: doc.agreement.agreement_number,
                message: 'Almost there — sign the reinstatement document to restart your subscription. It\'s in your Docs.',
            });
                    } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // ---- customer portal: cancel / reinstate ------------------------------
    app.post('/api/portal/maintenance-plans/:id/cancel', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const out = await requestPlanCancellation({
                planId: req.params.id, leadId,
                reason: (req.body || {}).reason,
                settlementInvoiceId: (req.body || {}).settlementInvoiceId || null,
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
            // Money owed isn't something the customer can act on from an error
            // message — so raise the invoice and hand it back, letting them pay
            // inline and finish cancelling in one go.
            if (e.code === 'SETTLEMENT_REQUIRED') {
                try {
                    const leadId = await resolveLeadId(req.user.id, req.user.email);
                    const plan = (await pool.query(
                        'SELECT label FROM maintenance_plans WHERE id=$1', [req.params.id])).rows[0];
                    const inv = await raiseSettlementInvoice({
                        leadId, kind: 'maintenance', id: req.params.id,
                        quote: e.quote, label: (plan && plan.label) || 'plan',
                    });
                    return res.status(402).json({
                        success: false,
                        code: 'SETTLEMENT_REQUIRED',
                        message: e.message,
                        settlement: {
                            invoiceId: inv.id,
                            invoiceNumber: inv.invoice_number,
                            total: Number(inv.total_amount),
                            lines: e.quote.lines,
                            effectiveAt: e.quote.effectiveAt,
                        },
                    });
                } catch (e2) {
                    console.error('[PORTAL CANCEL] settlement invoice failed:', e2.message);
                    return res.status(400).json({ success: false, message: e.message });
                }
            }
            console.error('[PORTAL CANCEL]', e.message);
            res.status(400).json({ success: false, message: e.message });
        }
    });

    app.post('/api/portal/maintenance-plans/:id/reinstate', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            // Reinstating is a fresh commitment to a recurring charge, so it
            // needs a signature. This issues the document; signing it is what
            // actually restarts the plan (see applyReinstatement).
            const out = await createReinstatementAgreement({ leadId, kind: 'maintenance', id: req.params.id });
            res.json({
                success: true,
                requiresSignature: true,
                agreementId: out.agreement.id,
                agreementNumber: out.agreement.agreement_number,
                message: 'Almost there — sign the reinstatement document to restart your plan. It\'s in your Docs.',
            });
        } catch (e) {
            res.status(400).json({ success: false, message: e.message });
        }
    });

    // ---- customer portal: sign an agreement ------------------------------
    app.post('/api/portal/sales-agreements/:id/sign', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            // autopayConsent is a SEPARATE checkbox from `agree` on any
            // recurring agreement. Bundling them would mean one tick standing
            // for two different consents, which is exactly the arrangement a
            // card network treats as no consent at all.
            const { typedName, agree, autopayConsent, viewedInFull, documentHash } = req.body || {};
            if (!agree) {
                return res.status(400).json({ success: false, message: 'Please check the box to agree to the terms.' });
            }
            if (!typedName || String(typedName).trim().length < 2) {
                return res.status(400).json({ success: false, message: 'Type your full name to sign.' });
            }

            const own = await pool.query(
                `SELECT id, lead_id, status, agreement_kind,
                        COALESCE(autopay, FALSE) AS autopay
                   FROM sales_agreements WHERE id=$1`, [req.params.id]
            );
            const a = own.rows[0];
            if (!a || String(a.lead_id) !== String(leadId)) {
                return res.status(404).json({ success: false, message: 'Agreement not found.' });
            }
            if (a.status === 'signed') {
                return res.status(409).json({ success: false, message: 'This agreement is already signed.' });
            }

            // A recurring agreement cannot be signed without explicit autopay
            // consent. Refusing here rather than inferring it is the difference
            // between an authorization you can produce and one you can't.
            const needsAutopayConsent = !!a.autopay
                || ['maintenance', 'subscription'].includes(a.agreement_kind);
            if (needsAutopayConsent && !autopayConsent) {
                return res.status(400).json({
                    success: false,
                    needsAutopayConsent: true,
                    message: 'Please tick the box authorizing automatic payment before signing.',
                });
            }

            let out;
            try {
                out = await onAgreementSigned({
                    agreementId: a.id,
                    signerName: String(typedName).trim(),
                    ip: req.headers['x-forwarded-for'] || req.ip,
                    userAgent: req.headers['user-agent'],
                    viewedInFull: !!viewedInFull,
                });
            } catch (signErr) {
                // The signature may already be recorded even though a later step
                // threw. Check before reporting failure — telling the customer
                // "signing failed" for something that DID sign is exactly how
                // they end up staring at "Review & sign" on a signed agreement.
                console.error('[PORTAL SIGN] follow-up failed:', signErr.message);
                const nowSigned = (await pool.query(
                    `SELECT sa.signed_at, (sig.id IS NOT NULL) AS has_sig
                       FROM sales_agreements sa
                       LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id
                      WHERE sa.id = $1`, [a.id]
                )).rows[0];

                if (nowSigned && (nowSigned.signed_at || nowSigned.has_sig)) {
                    // Make sure the row itself reads signed, whatever failed after.
                    await pool.query(
                        `UPDATE sales_agreements
                            SET status = 'signed', signed_at = COALESCE(signed_at, NOW()), updated_at = NOW()
                          WHERE id = $1`, [a.id]
                    ).catch(() => {});
                    return res.json({
                        success: true,
                        partial: true,
                        kind: 'sla',
                        message: 'Signed. A couple of follow-up steps are still finishing — we\'ve been notified and nothing else is needed from you.',
                        invoice: null,
                        assignedAdmin: null,
                    });
                }
                throw signErr;
            }

            // An agreement that was already signed (typically by an earlier
            // attempt that failed AFTER the signature) is a success, not a new
            // signing. Say so plainly and let the UI refresh — the old code fell
            // through to the SLA branch and claimed a timeline and invoice that
            // were never created.
            if (out.alreadySigned) {
                return res.json({
                    success: true,
                    alreadySigned: true,
                    kind: out.kind || 'sla',
                    message: 'This agreement is already signed — your copy is in Docs.',
                    invoice: null, assignedAdmin: null,
                });
            }

            // Tell the UI which kind this was, so it can route the customer to
            // the right place and word the confirmation correctly. A maintenance
            // agreement produces no project and no invoice.
            if (out.kind === 'reinstatement') {
                return res.json({
                    success: true, kind: 'reinstatement',
                    message: 'Signed — your plan is reinstated and the cancellation is withdrawn.',
                    invoice: null, assignedAdmin: null,
                });
            }
            const isMaintenance = out.kind === 'maintenance';

            // A signed agreement with no payment method is a plan that has not
            // started. Say so plainly and send them straight to adding one,
            // rather than leaving it as something to find under Plans later —
            // that gap is exactly how an agreement gets signed and never paid.
            const needsMethod = isMaintenance && !out.active;

            res.json({
                success: true,
                kind: isMaintenance ? 'maintenance' : 'sla',
                planActive: isMaintenance ? !!out.active : undefined,
                // The portal opens the Add-a-method sheet on this.
                needsPaymentMethod: needsMethod,
                firstChargeDate: out.plan ? out.plan.next_charge_date : null,
                message: isMaintenance
                    ? (out.active
                        ? 'Signed — your plan is active. You can see it under Plans.'
                        : 'Signed. Add a payment method now to start the plan — it is not running until you do.')
                    : 'Signed. Your project timeline and invoice are in your portal.',
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
                   FROM invoices i
                  WHERE i.lead_id=$1 AND i.${OPEN_STATUSES}
                    AND COALESCE(i.obligation,'due_now') = 'due_now'
                    ${signedGate('i')}`,
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
            console.error('[ADMIN PAYMENTS]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'The payment log') });
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
    // ----------------------------------------------------------------------
    // Late fees + the admin account screen.
    //
    // Mounted here rather than in server.js because both need notify(), which
    // is defined in this module's closure. Passing it out is cleaner than
    // exporting it globally.
    // ----------------------------------------------------------------------
    const lateFees = require('./diamondback-late-fees.js')({ pool });
    require('./diamondback-admin-accounts.js')({
        app, pool, authenticateToken, lateFees, notify, PORTAL_URL,
    });

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
                // Where the plan is in its life. status alone does not answer
                // "what stage are they on" — 'active but never charged' and
                // 'active and paid up' are the same status, different stages.
                stage: (() => {
                    if (p.status === 'cancelled') return 'Cancelled';
                    if (p.cancels_at) return 'Cancelling';
                    if (!p.signed_at) return 'Awaiting signature';
                    if (!p.last4) return 'No payment method';
                    if (!p.current_period_paid_at
                        && lateFees.isPastDue(p.next_charge_date)) return 'Past due';
                    if (!Number(p.charges_completed || 0)) return 'Ready — not yet charged';
                    if (!p.current_period_paid_at) return 'This period unpaid';
                    return 'Paid up';
                })(),
                period_paid: !!p.current_period_paid_at,
                past_due: !p.current_period_paid_at && lateFees.isPastDue(p.next_charge_date),
                days_late: p.current_period_paid_at ? 0 : lateFees.daysLate(p.next_charge_date),
                // The true amount signed/invoiced/charged — see
                // domainRenewalPricing(). Equal to p.amount except for
                // domain_renewal plans, which add the mandatory fee + tax.
                charge_total: planChargeTotal(p),
                // Full breakdown — base, domain fee, tax, and the credit-card
            // processing fee. Priced WITHOUT a method, so this is the fee-free
            // figure; the portal shows the credit total separately from the
            // per-method quote, because we cannot know here how they will pay.
            fee_breakdown: planPricing(p, null),
                days_until_cancellation: p.cancels_at
                    ? Math.max(0, Math.ceil((new Date(p.cancels_at) - Date.now()) / 86400000))
                    : null,
            }));
            const mrr = plans
                .filter((p) => ['active', 'pending_cancellation'].includes(p.status))
                .reduce((s, p) => s + Number(p.charge_total || 0), 0);
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
            console.error('[ADMIN PLANS]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Maintenance plans') });
        }
    });

    app.post('/api/admin/maintenance-plans', authenticateToken, async (req, res) => {
        try {
            const {
                leadId, planType, label, description, amount,
                billingDay = 1, generateInvoice = false, sendAgreement = true,
                // Annual plans (domain renewals): interval 'year' plus the month
                // it renews in. Monthly plans ignore billingMonth entirely.
                interval, billingMonth, itemReference, renewalDate,
                // The day billing actually begins. Everything after it recurs on
                // the same day of the month (or the same date each year).
                billingStartDate,
            } = req.body || {};

            // amount may legitimately be 0 (a free period, a bundled service),
            // so test for "missing", not "falsy".
            if (!leadId || !planType || amount == null || amount === '') {
                return res.status(400).json({ success: false, message: 'Customer, plan type and amount are required.' });
            }
            if (Number(amount) < 0) {
                return res.status(400).json({ success: false, message: 'Amount cannot be negative.' });
            }

            // A domain renewal is annual unless told otherwise — nobody renews a
            // domain monthly, and defaulting the other way would bill 12x.
            const unit = (interval === 'year' || planType === 'domain_renewal') ? 'year' : 'month';
            let day = Number(billingDay) || 1;
            let month = billingMonth != null ? Number(billingMonth) : null;
            // `renewalDate` is the friendlier way to say it: give the date the
            // domain renews and we derive the month and day.
            if (unit === 'year' && renewalDate) {
                const d = new Date(renewalDate);
                if (!isNaN(d)) { month = d.getUTCMonth() + 1; day = d.getUTCDate(); }
            }
            if (unit === 'year' && !month && !billingStartDate) {
                return res.status(400).json({
                    success: false,
                    message: 'For an annual plan, give the renewal date (or the month it renews).',
                });
            }

            const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
            if (!lead) return res.status(404).json({ success: false, message: 'Customer not found.' });

            const defaultLabels = {
                monthly_maintenance: 'Monthly Maintenance',
                brevo_maintenance: 'Brevo Maintenance',
                database_maintenance: 'Database Maintenance',
                domain_renewal: itemReference ? `Domain Renewal — ${itemReference}` : 'Domain Renewal',
                hosting: 'Hosting',
            };

            // If an explicit future renewal date was given, that IS the first
            // charge. Deriving it from month/day instead would pick the NEXT
            // occurrence — so a domain renewing 4 Sep 2027, set up in Aug 2026,
            // would be charged on 4 Sep 2026: a full year early.
            // An explicit start date wins over everything: it IS the first
            // charge, and it sets the recurring day. Without this, "starts on
            // the 3rd" quietly became "starts on the next 1st".
            let firstCharge;
            const startExplicit = billingStartDate ? new Date(billingStartDate) : null;
            if (startExplicit && !isNaN(startExplicit)) {
                firstCharge = startExplicit;
                day = startExplicit.getUTCDate();
                if (unit === 'year') month = startExplicit.getUTCMonth() + 1;
            } else if (unit === 'year') {
                const explicit = renewalDate ? new Date(renewalDate) : null;
                firstCharge = (explicit && !isNaN(explicit) && explicit > new Date())
                    ? explicit
                    : nextAnnualDate(month, day);
            } else {
                firstCharge = nextBillingDate(day);
            }

            const ins = await pool.query(
                `INSERT INTO maintenance_plans
                    (lead_id, plan_type, label, description, amount, billing_day,
                     generate_invoice, status, next_charge_date,
                     interval_unit, billing_month, item_reference, billing_start_date)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_signature',$8,$9,$10,$11,$8)
                 RETURNING *`,
                [leadId, planType, label || defaultLabels[planType] || 'Maintenance Plan',
                 description || null, amount, day, generateInvoice,
                 dateOnly(firstCharge), unit, unit === 'year' ? month : null,
                 itemReference || null]
            );
            const plan = ins.rows[0];

            // FIRST PERIOD IS BILLED IMMEDIATELY. next_charge_date is set to the
            // start date (today unless one was given), so the plan is due the
            // moment it becomes chargeable. It only actually charges once the
            // agreement is signed AND a method is on file — money is never taken
            // against an unsigned document — after which the next date moves one
            // full interval on from the day billing really started.
            //
            // A FUTURE date is respected as given, from either source:
            //   * an explicit billing start date — "starts on the 1st" must not
            //     bill today;
            //   * an annual renewal date — a domain renewing next September is
            //     charged next September, not the day it's set up. Billing an
            //     annual plan "immediately" would take a full year's fee a year
            //     early, which is the opposite of what this is meant to fix.
            // Everything else (the normal monthly plan, created to start now)
            // bills its first period straight away.
            const today = dateOnly(new Date());
            const startsInFuture =
                (startExplicit && !isNaN(startExplicit) && dateOnly(startExplicit) > today)
                || (dateOnly(firstCharge) && dateOnly(firstCharge) > today && unit === 'year');
            if (!startsInFuture) {
                await pool.query(
                    `UPDATE maintenance_plans
                        SET next_charge_date = CURRENT_DATE, billing_start_date = CURRENT_DATE
                      WHERE id = $1`, [plan.id]
                );
                plan.next_charge_date = dateOnly(new Date());
                plan.billing_start_date = dateOnly(new Date());
            }

            // What this plan costs, priced ONCE here so the signed number and
            // the eventual charge cannot drift.
            //
            // `amount` is the base only. For a domain renewal the mandatory
            // maintenance fee is added on top; sales tax applies to every plan;
            // and a 3% processing fee applies ON TOP OF THAT if — and only if —
            // they pay by credit card.
            //
            // A NEW plan gets the new pricing immediately: its customer is
            // about to agree to it in the document itself, so there is no
            // notice period to serve. (Existing plans are a different matter —
            // see migration 012 section 5.)
            //
            // TWO TOTALS, NOT ONE. Because the fee depends on the card type,
            // there is no single number to sign for. `totalToSign` is the
            // fee-free figure — what they owe on a bank account or debit card,
            // and the floor of what they can ever be charged. The credit
            // total is stated alongside it in the agreement.
            const planShape = { amount, plan_type: planType, lead_id: leadId,
                                tax_rate: null, processing_fee_pct: null,
                                pricing_effective_from: new Date() };
            const quote       = planPricing(planShape, null, { forceNewPricing: true });
            const creditQuote = planPricing(planShape, { type: 'card', funding: 'credit' },
                                            { forceNewPricing: true });
            const totalToSign = quote.total;
            plan.charge_total = totalToSign;

            // Freeze the rates onto the plan, so a later change to the default
            // rate cannot silently re-price something already signed.
            await pool.query(
                `UPDATE maintenance_plans
                    SET tax_rate = $2, processing_fee_pct = $3,
                        pricing_effective_from = COALESCE(pricing_effective_from, CURRENT_DATE),
                        updated_at = NOW()
                  WHERE id = $1`,
                [plan.id, quote.taxRate, creditQuote.feePct]
            ).catch((e) => console.warn('[PRICING] plan rates not stored — run migration 012:', e.message));

            // The plan agreement they sign before autopay can start.
            let agreement = null;
            if (sendAgreement) {
                const num = `MA-${String(plan.id).padStart(5, '0')}`;
                // maintenanceFee is the mandatory domain fee. quote.fee is the
                // CREDIT CARD processing fee and is deliberately zero here —
                // this quote has no payment method, and the card surcharge is
                // stated as its own conditional sentence below rather than
                // folded into a single number the customer might not owe.
                const breakdown = quote.maintenanceFee > 0
                    ? ` (domain ${money(quote.base)} + ${money(quote.maintenanceFee)} mandatory domain maintenance fee + ${(quote.taxRate * 100).toFixed(3).replace(/\.?0+$/, '')}% tax ${money(quote.tax)})`
                    : ` (${money(quote.base)} plus ${(quote.taxRate * 100).toFixed(3).replace(/\.?0+$/, '')}% sales tax ${money(quote.tax)})`;
                // autopay_* are written here, at creation, so the SIGNED
                // document carries its own record of what was authorized. A
                // later edit to maintenance_plans then cannot silently restate
                // what the customer agreed to — which is the whole point of
                // storing it on the agreement rather than reading the plan.
                const ag = await pool.query(
                    `INSERT INTO sales_agreements
                        (agreement_number, lead_id, customer_name, customer_email, service_type,
                         package_name, price, status, agreement_kind, intro, terms,
                         autopay, autopay_interval, autopay_amount, autopay_day,
                         billing_start_date, tax_rate, processing_fee_pct,
                         created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'sent','maintenance',$8,$9,
                             TRUE,$10,$7,$11,$12,$13,$14,NOW(),NOW())
                     RETURNING *`,
                    [num, leadId, lead.name, lead.email, planType, plan.label, totalToSign,
                     unit === 'year'
                        ? `${plan.label} at ${money(totalToSign)} per year${breakdown}, charged automatically each ${prettyDate(firstCharge).replace(/,.*$/, '')}.`
                        : `Recurring ${plan.label.toLowerCase()} at ${money(totalToSign)} per month, billed automatically on day ${day}.`,
                     // The customer-facing authorization. Worded as consent
                     // being GRANTED by signing, not as a description of what
                     // happens to them — that distinction is what a bank looks
                     // for when a recurring charge is disputed. The full
                     // clause set is rendered by diamondback-documents.js;
                     // this is the plan-specific part that varies per plan.
                     `AUTOMATIC PAYMENT AUTHORIZATION. By signing this agreement you enroll in automatic payment ` +
                     `and authorize ${'Diamondback Coding'} to charge ${money(totalToSign)}${breakdown} to the payment method saved on ` +
                     `your account ${unit === 'year'
                            ? `once each year, beginning ${prettyDate(firstCharge)}`
                            : `on the ${ordinalDay(day)} of each month, beginning ${prettyDate(firstCharge)}`}, ` +
                     `without further authorization or notice from you. This authorization covers card and, where you provide ` +
                     `bank details, ACH debits, and continues for each billing period until you cancel it.\n\n` +
                     `You are responsible for keeping a valid payment method on file. A declined charge may be retried and any ` +
                     `unpaid amount is subject to late charges.\n\n` +
                     `TO STOP AUTOMATIC PAYMENTS: cancel the plan from your customer portal at any time, or email ` +
                     `contact@diamondbackcoding.com. Cancellation takes effect ${CANCELLATION_NOTICE_DAYS} days after we receive ` +
                     `your request; charges falling due within that notice period remain payable and service continues until ` +
                     `the cancellation date.\n\n` +
                     `CREDIT CARD PROCESSING FEE. The amount above applies when you pay by bank account (ACH) or debit card. ` +
                     `If you pay by CREDIT card, a ${(creditQuote.feePct * 100).toFixed(2).replace(/\.?0+$/, '')}% processing fee of ` +
                     `${money(creditQuote.fee)} is added, making the total ${money(creditQuote.total)} ${unit === 'year' ? 'per year' : 'per month'}. ` +
                     `This fee is not charged on debit cards, prepaid cards or bank payments, and is never more than our cost of ` +
                     `accepting the card. You can switch payment method at any time in your portal to avoid it.\n\n` +
                     `If the amount or schedule ever changes we will tell you in writing at least ten (10) days beforehand, and ` +
                     `a change in price requires a new signed agreement from you.`,
                     unit, day, dateOnly(firstCharge), quote.taxRate, creditQuote.feePct]
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

    /**
     * Edit a maintenance plan. THE ONLY PLACE A PLAN OR ITS AGREEMENT CAN BE
     * EDITED — the Sales Agreements tab refuses maintenance agreements
     * (see PATCH /api/sales-agreements/:id), because editing the document there
     * left the plan holding the old price and schedule.
     *
     * The plan and its agreement are written together here, so they cannot
     * disagree.
     *
     * Changing the PRICE of a signed plan is a new commitment, not an edit: the
     * customer agreed to a figure. It therefore needs a fresh signature, and the
     * caller must say so explicitly with confirmResign.
     */
    app.patch('/api/admin/maintenance-plans/:id', authenticateToken, async (req, res) => {
        try {
            const b = req.body || {};
            const plan = (await pool.query(
                'SELECT * FROM maintenance_plans WHERE id=$1', [req.params.id])).rows[0];
            if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });

            const priceChanged = b.amount != null && b.amount !== ''
                && Number(b.amount) !== Number(plan.amount);
            if (Number(b.amount) < 0) {
                return res.status(400).json({ success: false, message: 'Amount cannot be negative.' });
            }

            const isSigned = !!plan.signed_at;

            // ------------------------------------------------------------
            // DECLARED HERE, BEFORE THE 409 BELOW USES THEM.
            //
            // These were declared further down while the 409 message already
            // referenced dayChanged, so every save on a signed plan died with
            // "Cannot access 'dayChanged' before initialization" — a temporal
            // dead zone error, thrown before any response was sent. From the
            // admin portal that looked like the Save button doing nothing.
            //
            // A change to the billing DAY changes the automatic payment
            // authorization as much as a change to the amount does: "we will
            // charge you on the 12th" is part of what the customer consented
            // to. Both go through the amendment; neither applies until signed.
            // ------------------------------------------------------------
            const dayChanged = b.billing_day !== undefined && b.billing_day !== ''
                && Number(b.billing_day) !== Number(plan.billing_day);
            const amendPrice = (priceChanged || dayChanged) && isSigned;

            if ((priceChanged || dayChanged) && isSigned && !b.confirmResign) {
                return res.status(409).json({
                    success: false,
                    code: 'PRICE_NEEDS_RESIGN',
                    needsResign: true,
                    message: `${plan.label} is signed at ${money(planChargeTotal(plan))}`
                           + `${dayChanged ? `, charged on day ${plan.billing_day}` : ''}. `
                           + `This is sent as a separate PRICE CHANGE AGREEMENT — the plan `
                           + `and the original agreement stay exactly as they are, and billing `
                           + `continues at ${money(planChargeTotal(plan))} until the customer signs it. `
                           + `The new price takes effect from their next charge after signing. Confirm to send it.`,
                });
            }

            const sets = ['updated_at = NOW()'];
            const vals = [req.params.id];
            // NOTE THE $$: `${col} = $${vals.length}` produces "amount = $2".
            // Without the second $ it produced "amount = 2" — a literal, not a
            // placeholder — so every edit either set the column to the
            // parameter's INDEX or failed on a type mismatch. This is why
            // changing a plan's amount did nothing. The identical helper at
            // line ~3940 has it right; this one was a character short.
            const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

            if (b.label !== undefined && String(b.label).trim()) put('label', String(b.label).trim().slice(0, 200));
            if (b.description !== undefined) put('description', String(b.description || '').trim() || null);
            // A price change on a SIGNED plan does not touch `amount`. The plan
            // keeps billing what the customer agreed to until they sign the
            // amendment; the proposed figure waits in `pending_amount`.
            // On an unsigned plan there is nothing to amend, so it applies now.
            if (b.amount !== undefined && b.amount !== '' && !amendPrice) {
                put('amount', Number(b.amount));
            }
            if (b.item_reference !== undefined) put('item_reference', String(b.item_reference || '').trim() || null);

            // Moving the billing day moves the NEXT charge, never a past one.
            if (b.billing_day !== undefined && b.billing_day !== '' && !amendPrice) {
                const day = Math.min(28, Math.max(1, Number(b.billing_day) || 1));
                put('billing_day', day);
            }
            if (b.next_charge_date !== undefined && b.next_charge_date) {
                put('next_charge_date', dateOnly(b.next_charge_date));
            }

            // DELIBERATELY NOT unsigning the plan any more.
            //
            // The old behaviour blanked signed_at and set 'pending_signature',
            // which stopped runMaintenanceCharges dead — so a price change cost
            // a month's revenue and left the customer's service in limbo. The
            // plan is signed; what is unsigned is the AMENDMENT, and that is
            // tracked separately below.

            const upd = (await pool.query(
                `UPDATE maintenance_plans SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals
            )).rows[0];

            // Keep the document in step with the plan. This is the whole reason
            // edits are confined to this tab.
            if (plan.agreement_id) {
                const unit = intervalUnit(upd);
                const updTotal = planChargeTotal(upd);

                if (amendPrice) {
                    // THE ORIGINAL AGREEMENT IS NOT TOUCHED. It stays signed at
                    // the old price, because that is what the customer actually
                    // agreed to and it is the only evidence of it. Only the
                    // name/description follow an edit; the price does not.
                    await pool.query(
                        `UPDATE sales_agreements SET package_name = $2, updated_at = NOW()
                          WHERE id = $1`, [plan.agreement_id, upd.label]).catch(() => {});
                } else {
                    await pool.query(
                        `UPDATE sales_agreements
                            SET package_name = $2, price = $3, intro = $4, updated_at = NOW()
                          WHERE id = $1`,
                        [plan.agreement_id, upd.label, updTotal,
                         `${upd.label} at ${money(updTotal)} per ${unit}, charged automatically.`]
                    );
                }
            }

            // ------------------------------------------------------------
            // RAISE THE PRICE CHANGE AGREEMENT
            //
            // A separate, differently-named document that changes one thing:
            // the price. The plan carries on billing the old amount until it
            // is signed, so nothing breaks and no revenue is lost while the
            // customer takes their time.
            // ------------------------------------------------------------
            let amendment = null;
            if (amendPrice) {
                const newAmount = Number(b.amount);
                const proposed = planChargeTotal({ ...upd, amount: newAmount });
                const current = planChargeTotal(plan);
                const unit = intervalUnit(upd);
                const effectiveFrom = upd.next_charge_date || plan.next_charge_date || null;
                const direction = proposed > current ? 'increase' : 'decrease';

                try {
                    // PC-00001, continuing from the highest existing. Same
                    // shape as SA- and RI- elsewhere in this file, so the
                    // prefix alone tells you what kind of document it is.
                    const pcNum = await pool.query(
                        `SELECT COALESCE(MAX(NULLIF(regexp_replace(agreement_number,'\\D','','g'),'')::bigint),0)+1 AS n
                           FROM sales_agreements WHERE agreement_number LIKE 'PC-%'`);
                    const num = `PC-${String(pcNum.rows[0].n).padStart(5, '0')}`;

                    // The customer's details live on LEADS, not on the plan —
                    // maintenance_plans has no customer_name/customer_email, so
                    // reading them from `plan` produced undefined and the
                    // amendment came out with a blank client.
                    const lead = (await pool.query(
                        'SELECT * FROM leads WHERE id = $1', [plan.lead_id])).rows[0] || {};

                    // BUILD THE INSERT FROM COLUMNS THAT ACTUALLY EXIST.
                    //
                    // previous_price, amends_agreement_id and
                    // price_effective_from arrive with migration 014; the
                    // autopay_* columns with 011. Naming them unconditionally
                    // meant one un-run migration made the whole save fail with
                    // nothing saved and no useful message — which is what you
                    // hit. Now the amendment is still created, minus whatever
                    // the database cannot store yet, and the response says so.
                    const agCols = new Set((await pool.query(
                        `SELECT column_name FROM information_schema.columns
                          WHERE table_name='sales_agreements'`)).rows.map((r) => r.column_name));

                    const cols = [];
                    const vals = [];
                    const add = (col, val) => {
                        if (!agCols.has(col)) return false;
                        cols.push(col); vals.push(val); return true;
                    };

                    add('agreement_number', num);
                    add('lead_id', plan.lead_id);
                    add('customer_name', lead.name || null);
                    add('customer_email', lead.email || null);
                    add('service_type', upd.plan_type);
                    add('package_name', `${upd.label} — price change`);
                    add('price', proposed);
                    add('status', 'sent');
                    add('agreement_kind', 'price_change');
                    add('intro', `A change to the price of your existing ${upd.label} plan. `
                               + 'Everything else about the plan stays exactly the same.');

                    const missing = [];
                    if (!add('previous_price', current)) missing.push('previous_price');
                    if (!add('amends_agreement_id', plan.agreement_id)) missing.push('amends_agreement_id');
                    if (!add('price_effective_from', dateOnly(effectiveFrom))) missing.push('price_effective_from');
                    add('autopay', true);
                    add('autopay_interval', unit === 'year' ? 'year' : 'month');
                    add('autopay_amount', proposed);
                    add('autopay_day', upd.billing_day || null);

                    add('terms',
                        `PRICE CHANGE. Your ${upd.label} plan currently costs ${money(current)} per `
                      + `${unit}. From ${prettyDate(effectiveFrom) || 'your next charge'} it will be `
                      + `${money(proposed)} per ${unit} — ${direction === 'increase' ? 'an increase' : 'a decrease'} `
                      + `of ${money(Math.abs(proposed - current))} per ${unit}.\n\n`
                      + `NOTHING ELSE CHANGES. This is not a new plan and not a replacement `
                      + `agreement. Your existing plan, its start date, what it covers, its `
                      + `cancellation terms and your automatic payment authorization all continue `
                      + `unchanged. Only the amount changes.\n\n`
                      + `YOU KEEP PAYING THE OLD PRICE UNTIL YOU SIGN. We will continue to charge `
                      + `${money(current)} per ${unit} until this is signed. If you do not sign it, `
                      + `your plan simply carries on at ${money(current)} per ${unit} — you are not `
                      + `cancelled and nothing is interrupted.\n\n`
                      + `By signing you authorize the automatic payment amount to change to `
                      + `${money(proposed)} per ${unit} from ${prettyDate(effectiveFrom) || 'your next charge'}, `
                      + `on the same payment method${dayChanged
                            ? ` and on the ${Math.min(28, Math.max(1, Number(b.billing_day) || 1))}`
                              + ` of each ${unit} instead of the ${plan.billing_day}`
                            : ' and the same schedule as now'}.`);

                    if (missing.length) {
                        console.warn('[PRICE CHANGE] sales_agreements is missing '
                                   + missing.join(', ') + ' — run migration 014. '
                                   + 'The amendment was still created.');
                    }

                    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
                    const ag = (await pool.query(
                        `INSERT INTO sales_agreements (${cols.join(', ')}, created_at, updated_at)
                         VALUES (${ph}, NOW(), NOW()) RETURNING *`, vals)).rows[0];

                    // Park the proposal on the plan. `amount` is untouched.
                    // Guarded the same way: without 014 there is nowhere to
                    // park it, and the admin needs telling rather than a
                    // silent failure.
                    const mpCols = new Set((await pool.query(
                        `SELECT column_name FROM information_schema.columns
                          WHERE table_name='maintenance_plans'`)).rows.map((r) => r.column_name));

                    if (mpCols.has('pending_amount') && mpCols.has('pending_agreement_id')) {
                        const dayCol = mpCols.has('pending_billing_day');
                        await pool.query(
                            `UPDATE maintenance_plans
                                SET pending_amount = $2, pending_agreement_id = $3,
                                    ${dayCol ? 'pending_billing_day = $4,' : ''}
                                    ${mpCols.has('pending_since') ? 'pending_since = NOW(),' : ''}
                                    updated_at = NOW()
                              WHERE id = $1`,
                            dayCol
                                ? [plan.id, newAmount, ag.id,
                                   dayChanged ? Math.min(28, Math.max(1, Number(b.billing_day) || 1)) : null]
                                : [plan.id, newAmount, ag.id]);
                    } else {
                        // No 014. The document exists but nothing will apply it
                        // when signed, so refuse rather than leave a dead
                        // agreement the customer can sign to no effect.
                        await pool.query('DELETE FROM sales_agreements WHERE id=$1', [ag.id]).catch(() => {});
                        return res.status(500).json({
                            success: false,
                            message: 'Cannot send a price change yet: this database has not had '
                                   + 'migration 014 applied, so there is nowhere to hold the new '
                                   + 'price until the customer signs. Run '
                                   + 'migrations/014_price_change_amendments.sql and try again. '
                                   + 'Nothing was changed.',
                        });
                    }

                    amendment = ag;

                    if (lead && lead.email) {
                        await notify({
                            lead, kind: 'price_change_agreement',
                            subject: `A change to your ${upd.label} price`,
                            bodyHtml:
                                `<p style="margin:0 0 12px">We've sent you a short document covering a `
                                + `change to what your <strong style="color:#0d0f12">${upd.label}</strong> plan costs.</p>`
                                + `<p style="margin:0 0 12px">From ${money(current)} to `
                                + `<strong style="color:#0d0f12">${money(proposed)}</strong> per ${unit}, `
                                + `starting ${prettyDate(effectiveFrom) || 'your next charge'}.</p>`
                                + `<p style="margin:0 0 12px">Nothing else about your plan changes, and you'll `
                                + `keep paying ${money(current)} until you sign it.</p>`,
                            cta: { url: PORTAL_URL, label: 'Review the change' },
                        }).catch((e) => console.warn('[PRICE CHANGE] notify:', e.message));
                    }
                } catch (e) {
                    console.error('[PRICE CHANGE] could not raise the amendment:', e.code, e.message);
                    const col = /column "?([\w.]+)"? does not exist/i.exec(e.message || '');
                    return res.status(500).json({
                        success: false,
                        message: col
                            ? `Cannot send the price change: the database is missing "${col[1]}". `
                            + 'Run migrations/011, 012, 013 and 014 against this database, then try '
                            + 'again. Nothing was changed.'
                            : 'Could not create the price change agreement: ' + e.message
                            + '. Nothing was changed.',
                    });
                }
            }

            if (priceChanged && isSigned) {
                const lead = (await pool.query(
                    'SELECT id,name,email,phone FROM leads WHERE id=$1', [plan.lead_id])).rows[0];
                await notify({
                    lead, kind: 'maintenance_agreement',
                    subject: `${upd.label} — updated, please review and sign`,
                    bodyHtml: `<p style="margin:0 0 12px">We've updated your <strong style="color:#0d0f12">${upd.label}</strong> plan to ${money(planChargeTotal(upd))} per ${intervalUnit(upd)}.</p>
                               <p style="margin:0 0 12px">Because the price has changed, the updated agreement is waiting for your signature in your portal.</p>
                               <p style="margin:0">Billing is paused until you sign, and nothing is charged in the meantime.</p>`,
                    smsText: `Diamondback Coding: your ${upd.label} plan was updated to ${money(planChargeTotal(upd))}. Please sign the updated agreement in your portal.`,
                    channels: ['email', 'sms', 'portal'],
                    cta: { url: PORTAL_URL, label: 'Review & sign' },
                }).catch((e) => console.warn('[PLAN EDIT] notify:', e.message));
            }

            upd.charge_total = planChargeTotal(upd);
            res.json({
                success: true, plan: upd,
                resignRequired: !!(priceChanged && isSigned),
                message: (priceChanged && isSigned)
                    ? `${upd.label} updated. The customer has been asked to sign the new price; billing is paused until they do.`
                    : `${upd.label} updated.`,
            });
        } catch (e) {
            console.error('[PLAN EDIT]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'That plan') });
        }
    });

    // ======================================================================
    // Schema repair — run the column fix from the admin portal
    // ======================================================================
    //
    // The repair normally arrives as migrations/010. That needs the file to be
    // in the repo's migrations folder, or psql access to the Render database —
    // and while neither is true, signing cannot work, because it writes to
    // columns that don't exist.
    //
    // So the repair also lives here, as a button. It is the SAME work as
    // migration 010 sections 1-4: add the missing columns, reconcile agreements
    // against their signatures, release stuck signing claims. Idempotent, and
    // safe to run when nothing is wrong (it reports 0 changes).
    //
    // It does NOT do section 6 (parking unsigned-document invoices as draft) —
    // that one rewrites money records, so it stays in the migration where it can
    // be read and reviewed before running.

    const REPAIR_COLUMNS = [
        ['agreement_number', 'VARCHAR(40)'],
        ['lead_id',          'INTEGER'],
        ['customer_name',    'VARCHAR(255)'],
        ['customer_email',   'VARCHAR(255)'],
        ['service_type',     'VARCHAR(60)'],
        ['package_name',     'VARCHAR(160)'],
        ['vehicle',          'VARCHAR(200)'],
        ['price',            'NUMERIC(10,2) DEFAULT 0'],
        ['deposit',          'NUMERIC(10,2) DEFAULT 0'],
        ['start_date',       'DATE'],
        ['status',           "VARCHAR(40) DEFAULT 'draft'"],
        ['terms',            'TEXT'],
        ['notes',            'TEXT'],
        ['signed_at',        'TIMESTAMP'],
        ['signature_name',   'VARCHAR(255)'],
        ['created_at',       'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
        ['updated_at',       'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ];

    async function repairSchema() {
        const report = { added: [], reconciled: 0, claimsReleased: 0, plansRepaired: 0, errors: [] };

        const have = new Set((await pool.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'sales_agreements'`
        )).rows.map((r) => r.column_name));

        for (const [col, ddl] of REPAIR_COLUMNS) {
            if (have.has(col)) continue;
            try {
                // Identifiers are from the fixed list above, never user input.
                await pool.query(`ALTER TABLE sales_agreements ADD COLUMN ${col} ${ddl}`);
                report.added.push(col);
                console.log(`[REPAIR] ADDED sales_agreements.${col}`);
            } catch (e) {
                report.errors.push(`${col}: ${e.message}`);
            }
        }

        // Reconcile agreements against their signatures (migration 006's work).
        try {
            const r = await pool.query(
                `UPDATE sales_agreements sa
                    SET status = CASE WHEN sa.status IN ('sent','draft') OR sa.status IS NULL
                                      THEN 'signed' ELSE sa.status END,
                        signed_at = COALESCE(sa.signed_at, sig.signed_at),
                        signature_name = COALESCE(sa.signature_name, sig.signer_name),
                        updated_at = NOW()
                   FROM agreement_signatures sig
                  WHERE sig.agreement_id = sa.id
                    AND (sa.signed_at IS NULL OR sa.status IN ('sent','draft') OR sa.status IS NULL)`
            );
            report.reconciled = r.rowCount;
        } catch (e) { report.errors.push(`reconcile: ${e.message}`); }

        try {
            const r = await pool.query(
                `UPDATE maintenance_plans mp
                    SET signed_at = COALESCE(mp.signed_at, sig.signed_at), updated_at = NOW()
                   FROM sales_agreements sa
                   JOIN agreement_signatures sig ON sig.agreement_id = sa.id
                  WHERE mp.agreement_id = sa.id AND mp.signed_at IS NULL`
            );
            report.plansRepaired = r.rowCount;
        } catch (e) { report.errors.push(`plans: ${e.message}`); }

        // Release signing claims latched by attempts that died on the missing
        // column — these are what make an agreement permanently unsignable.
        try {
            const r = await pool.query(
                `DELETE FROM lifecycle_events le
                  WHERE le.stage = 'sla_signed'
                    AND EXISTS (
                         SELECT 1 FROM sales_agreements sa
                          WHERE le.once_key = 'sla_signed:agreement:' || sa.id::text
                            AND sa.signed_at IS NULL
                            AND NOT EXISTS (SELECT 1 FROM agreement_signatures sig
                                             WHERE sig.agreement_id = sa.id))`
            );
            report.claimsReleased = r.rowCount;
        } catch (e) { report.errors.push(`claims: ${e.message}`); }

        // Guard columns for the billing loophole fixes.
        for (const [tbl, col, ddl] of [
            ['maintenance_plans', 'suspended_at', 'TIMESTAMP'],
            ['maintenance_plans', 'consecutive_failures', 'INTEGER DEFAULT 0'],
        ]) {
            try {
                await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
            } catch (e) { /* already there */ }
        }

        return report;
    }

    /** What's missing right now? Read-only. */
    app.get('/api/admin/schema/repair-status', authenticateToken, async (req, res) => {
        try {
            const have = new Set((await pool.query(
                `SELECT column_name FROM information_schema.columns
                  WHERE table_name = 'sales_agreements'`
            )).rows.map((r) => r.column_name));
            const missing = REPAIR_COLUMNS.map(([c]) => c).filter((c) => !have.has(c));
            res.json({
                success: true,
                healthy: missing.length === 0,
                missing,
                message: missing.length === 0
                    ? 'sales_agreements has every required column.'
                    : `${missing.length} column(s) missing from sales_agreements — signing and SLA deletion will fail until this is repaired.`,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    /** Apply the repair. Idempotent. */
    app.post('/api/admin/schema/repair', authenticateToken, async (req, res) => {
        try {
            const report = await repairSchema();
            const ok = report.errors.length === 0;
            res.json({
                success: ok,
                report,
                message: ok
                    ? (report.added.length
                        ? `Repaired. Added ${report.added.length} column(s): ${report.added.join(', ')}. ` +
                          `${report.reconciled} agreement(s) reconciled, ${report.claimsReleased} stuck signing claim(s) released.`
                        : 'Nothing needed repairing — the schema is already correct.')
                    : `Repaired with ${report.errors.length} problem(s): ${report.errors.join('; ')}`,
            });
        } catch (e) {
            console.error('[REPAIR]', e.message);
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
            console.error('[ADMIN NOTIFICATIONS]', e.code, e.message);
            res.status(500).json({ success: false, message: dbErrorMessage(e, 'Notifications') });
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
            // force=1 re-runs even if the in-process timer already ran today —
            // useful when you want to see it work right now.
            const force = (req.query || {}).force === '1' || (req.body || {}).force === true;
            if (force) _lastDailyRun = null;
            res.json({ success: true, results: await runDailyJobsOnce('cron') });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    /**
     * Is billing actually running? Answers the question "will my customers be
     * charged" without anyone reading logs.
     */
    app.get('/api/admin/billing-health', authenticateToken, async (req, res) => {
        try {
            const due = await pool.query(
                `SELECT COUNT(*)::int AS n FROM maintenance_plans
                  WHERE status IN ('active','pending_cancellation')
                    AND signed_at IS NOT NULL AND next_charge_date IS NOT NULL
                    AND next_charge_date <= CURRENT_DATE`);
            const blocked = await pool.query(
                `SELECT mp.id, mp.label, l.name, l.email,
                        CASE WHEN mp.signed_at IS NULL THEN 'not signed'
                             WHEN COALESCE(mp.payment_method_id, l.default_payment_method_id) IS NULL
                                  THEN 'no payment method'
                             ELSE 'other' END AS reason
                   FROM maintenance_plans mp JOIN leads l ON l.id = mp.lead_id
                  WHERE mp.status IN ('active','pending_signature','pending_payment_method')
                    AND (mp.signed_at IS NULL
                         OR COALESCE(mp.payment_method_id, l.default_payment_method_id) IS NULL)`);
            res.json({
                success: true,
                schedulerEnabled: String(process.env.BILLING_SCHEDULER || 'on').toLowerCase() !== 'off',
                externalCronConfigured: !!process.env.CRON_TOKEN,
                stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
                lastRun: _lastDailyRun,
                dueToday: due.rows[0].n,
                blocked: blocked.rows,
                note: 'dueToday is how many plans are ready to charge right now. '
                    + 'blocked lists plans that will NOT charge, and why.',
            });
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
        listAllPlans,
        cancellationSettlement,
        createReinstatementAgreement,
        applyReinstatement,
        resolvePaymentMethod,
        setAccountPaymentMethod,
        nextAnnualDate,
        nextChargeFor,
        postProjectUpdate,
        issueRecovery,
        onContactFormSubmitted,
        issueLoginCode,
        verifyLoginCode,
        issueTrustToken,
        isDeviceTrusted,
        checkRecoveryToken,
        onServiceRequestCreated,
        sendPortalMessagePing,
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