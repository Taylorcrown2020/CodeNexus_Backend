// ============================================================================
// diamondback-portal.js — Diamondback Coding
//
// Customer portal backend: messaging, service requests, sales agreements,
// in-portal Stripe card payment, public scheduling and consultations.
// Ported from the Crown Ceramic Coating server.
//
// WHY THIS IS A MODULE, NOT INLINED INTO server.js
//   server.js already serves the CodeNexus CRM at /api/client/*. That is a
//   DIFFERENT audience from the people this portal serves. Keeping the portal
//   in its own file under /api/portal/* keeps the two from bleeding together.
//
// MOUNT IT — add these two lines to server.js, after `stripe`, `pool` and the
// auth middlewares are defined, and BEFORE the 404 handler:
//
//     const initPortal = require('./diamondback-portal.js');
//     initPortal({ app, pool, stripe, transporter, authenticateToken,
//                  resolveLeadId, JWT_SECRET, jwt, PLATFORM_BREVO_KEY,
//                  PLATFORM_SENDER_EMAIL, PLATFORM_SENDER_NAME, sendViaBrevo });
//
// SECURITY — authenticatePortal (defined below) requires a token of
// type 'portal'. Your existing authenticateClient requires type 'client' and
// unlocks the whole CRM. They must stay distinct: a customer must never hold
// a token that /api/client/leads will accept, and vice versa.
// ============================================================================

module.exports = function initPortal({
    app,
    pool,
    stripe,
    transporter,
    authenticateToken,          // admin/staff auth, from server.js
    resolveLeadId,              // from server.js
    JWT_SECRET,
    jwt,
    PLATFORM_BREVO_KEY,
    PLATFORM_SENDER_EMAIL,
    PLATFORM_SENDER_NAME,
    sendViaBrevo,               // from server.js
    // Late-bound from the lifecycle module. server.js initialises this module
    // BEFORE the lifecycle one, so it's passed as a wrapper that resolves at
    // call time rather than a direct reference that would still be undefined.
    onServiceRequestCreated,
    // Sign-in codes, late-bound from the lifecycle module the same way.
    issueLoginCode, verifyLoginCode, issueTrustToken, isDeviceTrusted,
    SCHEDULING_URL = process.env.SCHEDULING_URL || 'https://diamondbackcoding.com/schedule.html',
}) {

    // ---- portal-scoped auth -------------------------------------------------
    // Distinct token type from the CRM's 'client'. See the note in the header.
    function authenticatePortal(req, res, next) {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, message: 'Access denied. Please log in.' });
        }
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.type !== 'portal') {
                return res.status(403).json({ success: false, message: 'Invalid access token.' });
            }
            req.user = decoded;
            next();
        } catch (err) {
            return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
        }
    }

    // ---- background email ---------------------------------------------------
    // Prefers Brevo (the configured sender); falls back to the nodemailer
    // transporter only when no Brevo key is present.
    function portalMailAsync(opts) {
        try {
            opts = Object.assign({}, opts);
            if (!opts.from) {
                opts.from = process.env.EMAIL_FROM
                    || 'Diamondback Coding <contact@diamondbackcoding.com>';
            }
            if (!opts.replyTo) opts.replyTo = process.env.EMAIL_REPLY_TO || 'contact@diamondbackcoding.com';

            if (PLATFORM_BREVO_KEY && typeof sendViaBrevo === 'function') {
                sendViaBrevo(PLATFORM_BREVO_KEY, PLATFORM_SENDER_EMAIL, PLATFORM_SENDER_NAME,
                             opts.to, opts.subject, opts.html)
                    .catch(err => console.warn('[PORTAL MAIL] Brevo send failed:', err && err.message));
            } else if (transporter) {
                Promise.resolve(transporter.sendMail(opts))
                    .catch(err => console.warn('[PORTAL MAIL] send failed:', err && err.message));
            } else {
                console.warn('[PORTAL MAIL] No send path available (no BREVO_API_KEY, no transporter).');
            }
        } catch (err) {
            console.warn('[PORTAL MAIL] error:', err && err.message);
        }
    }


    // ---- portal login -------------------------------------------------------
    // Separate from /api/client/login. Only leads flagged portal_kind='customer'
    // (or 'both') can sign in here, so a CRM subscriber cannot land in this
    // portal and a customer cannot reach the CRM API.
    app.post('/api/portal/login', async (req, res) => {
        try {
            const { email, password } = req.body || {};
            if (!email || !password) {
                return res.status(400).json({ success: false, message: 'Enter your email and password.' });
            }
            await ensurePortalSchema();

            const row = (await pool.query(
                `SELECT id, name, email, phone, client_password, portal_kind
                   FROM leads
                  WHERE LOWER(email) = LOWER($1)
                    AND client_password IS NOT NULL
                    AND COALESCE(portal_kind, 'customer') IN ('customer', 'both')
                  LIMIT 1`,
                [email]
            )).rows[0];

            if (!row) {
                return res.status(401).json({ success: false, message: 'That email and password do not match an account.' });
            }

            const bcrypt = require('bcryptjs');
            const ok = await bcrypt.compare(password, row.client_password);
            if (!ok) {
                return res.status(401).json({ success: false, message: 'That email and password do not match an account.' });
            }

            // ------------------------------------------------------------------
            // Password is correct. Unless this device is already trusted, stop
            // here and email a 6-digit code — no session token is issued until
            // the code is verified, so a stolen password alone is not enough.
            // ------------------------------------------------------------------
            const trusted = typeof isDeviceTrusted === 'function'
                ? await isDeviceTrusted(row.id, (req.body || {}).deviceToken).catch(() => false)
                : true;

            if (!trusted && typeof issueLoginCode === 'function') {
                await issueLoginCode({
                    leadId: row.id, email: row.email, audience: 'customer',
                    ip: req.headers['x-forwarded-for'] || req.ip,
                    userAgent: req.headers['user-agent'],
                }).catch((e) => console.error('[PORTAL LOGIN] code send failed:', e.message));

                return res.json({
                    success: true,
                    codeRequired: true,
                    leadId: row.id,
                    email: row.email,
                    message: 'We\'ve emailed you a 6-digit code. Enter it to finish signing in.',
                });
            }

            const token = jwt.sign(
                { id: row.id, email: row.email, type: 'portal' },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            await pool.query('UPDATE leads SET portal_last_login = NOW() WHERE id = $1', [row.id]).catch(() => {});

            res.json({
                success: true,
                token,
                client: { id: row.id, name: row.name, email: row.email, phone: row.phone }
            });
        } catch (e) {
            console.error('[PORTAL LOGIN] error:', e.message);
            res.status(500).json({ success: false, message: 'Could not sign you in. Try again.' });
        }
    });

    /**
     * Second step of sign-in: verify the emailed code, then issue the session.
     * `remember` returns a device token that skips the code on this device until
     * it expires.
     */
    app.post('/api/portal/login/verify', async (req, res) => {
        try {
            const { leadId, code, remember } = req.body || {};
            if (!leadId || !code) {
                return res.status(400).json({ success: false, message: 'Enter the code we emailed you.' });
            }
            if (typeof verifyLoginCode !== 'function') {
                return res.status(500).json({ success: false, message: 'Sign-in codes are not available.' });
            }
            const out = await verifyLoginCode({ leadId, code });
            if (!out.ok) return res.status(400).json({ success: false, message: out.message });

            const row = (await pool.query(
                `SELECT id, name, email, phone FROM leads WHERE id = $1`, [leadId]
            )).rows[0];
            if (!row) return res.status(404).json({ success: false, message: 'Account not found.' });

            const token = jwt.sign(
                { id: row.id, email: row.email, type: 'portal' },
                JWT_SECRET, { expiresIn: '30d' }
            );
            await pool.query('UPDATE leads SET portal_last_login = NOW() WHERE id = $1', [row.id]).catch(() => {});

            let device = null;
            if (remember && typeof issueTrustToken === 'function') {
                device = await issueTrustToken({
                    leadId: row.id, audience: 'customer',
                    ip: req.headers['x-forwarded-for'] || req.ip,
                    userAgent: req.headers['user-agent'],
                }).catch(() => null);
            }

            res.json({
                success: true, token,
                client: { id: row.id, name: row.name, email: row.email, phone: row.phone },
                deviceToken: device ? device.token : null,
                trustedForDays: device ? device.days : null,
            });
        } catch (e) {
            console.error('[PORTAL LOGIN VERIFY]', e.message);
            res.status(500).json({ success: false, message: 'Could not verify that code.' });
        }
    });

    const CARD_FEE_PERCENT = parseFloat(process.env.STRIPE_FEE_PERCENT || '0.029');
    const CARD_FEE_FIXED   = parseFloat(process.env.STRIPE_FEE_FIXED   || '0.30');
    const DEFAULT_TAX_RATE = parseFloat(process.env.SALES_TAX_RATE     || '8.25'); // % (TX default)

    // Build the checkout breakdown for an invoice.
    // invoice.total_amount already includes the invoice's own tax. We surface
    // subtotal + sales tax for transparency, then gross-up a card processing fee
    // so the business receives the full invoice total after Stripe's cut.
    function buildCheckoutBreakdown(invoice) {
        const subtotal = Number(invoice.subtotal || 0);
        const discount = Number(invoice.discount_amount || 0);
        let taxAmount  = Number(invoice.tax_amount || 0);
        let base       = Number(invoice.total_amount || 0);

        // Normalize the stored tax rate to a percentage for display
        // (some invoices stored it as a fraction, e.g. 0.0825 instead of 8.25).
        let taxRatePct = Number(invoice.tax_rate || 0);
        if (taxRatePct > 0 && taxRatePct < 1) taxRatePct = taxRatePct * 100;
        if (!taxRatePct) taxRatePct = DEFAULT_TAX_RATE;

        // If the invoice was created without tax but a tax rate is configured, apply it.
        if (taxAmount === 0 && DEFAULT_TAX_RATE > 0 && subtotal > 0 && base <= subtotal + 0.001) {
            taxAmount = +(subtotal * (DEFAULT_TAX_RATE / 100)).toFixed(2);
            base = +(subtotal + taxAmount - discount).toFixed(2);
        }

        // Does the invoice total already include a card processing fee?
        // Sales-agreement invoices bake subtotal + tax + fee into total_amount, so we must
        // NOT gross-up a second fee on top — charge the invoice total exactly as it stands.
        const itemsBeforeFee = +(subtotal + taxAmount - discount).toFixed(2);
        const feeAlreadyIncluded = base > itemsBeforeFee + 0.01;

        let processingFee, grand;
        if (feeAlreadyIncluded) {
            processingFee = +(base - itemsBeforeFee).toFixed(2);
            grand = +base.toFixed(2);
        } else {
            // Gross-up a card processing fee so the merchant nets the full invoice total.
            grand = +(((base + CARD_FEE_FIXED) / (1 - CARD_FEE_PERCENT))).toFixed(2);
            processingFee = +(grand - base).toFixed(2);
        }

        return {
            subtotal: +subtotal.toFixed(2),
            tax: +taxAmount.toFixed(2),
            taxRate: +taxRatePct.toFixed(2),
            discount: +discount.toFixed(2),
            invoiceTotal: +base.toFixed(2),
            processingFee,
            total: grand,
            amountCents: Math.round(grand * 100)
        };
    }

    // Mark an invoice paid + convert lead → active customer + refresh lifetime value.
    // Hoisted (function declaration) so the Stripe webhook can call it.
    async function markInvoicePaidById(invoiceId, reference) {
        const upd = await pool.query(
            `UPDATE invoices
                SET status = 'paid', paid_at = CURRENT_TIMESTAMP,
                    payment_method = 'Card (Stripe)', payment_reference = $1
              WHERE id = $2 RETURNING *`,
            [reference, invoiceId]
        );
        if (upd.rows.length === 0) return null;
        const inv = upd.rows[0];

        // ------------------------------------------------------------------
        // A paid invoice is the trigger for real-world work. Two cases:
        //
        //   maintenance — the first payment STARTS the plan. The plan becomes
        //     active and the next charge is set one full interval from the day
        //     they actually paid, which is the day service begins.
        //
        //   project — when a project agreement is fully paid, that is the
        //     "clear to deploy" signal.
        //
        // Both raise an admin notification, because both need someone to
        // actually do something.
        // ------------------------------------------------------------------
        try {
            if (inv.maintenance_plan_id) {
                const plan = (await pool.query(
                    'SELECT * FROM maintenance_plans WHERE id=$1', [inv.maintenance_plan_id])).rows[0];

                if (plan && plan.signed_at) {
                    const firstStart = !plan.activated_at;
                    // Next charge = one interval from the day they paid.
                    const paidOn = new Date();
                    const next = new Date(paidOn);
                    if (plan.interval_unit === 'year') next.setFullYear(next.getFullYear() + 1);
                    else next.setMonth(next.getMonth() + 1);

                    await pool.query(
                        `UPDATE maintenance_plans
                            SET status = CASE WHEN status IN ('cancelled') THEN status ELSE 'active' END,
                                activated_at = COALESCE(activated_at, NOW()),
                                billing_start_date = COALESCE(billing_start_date, CURRENT_DATE),
                                last_charge_date = CURRENT_DATE,
                                next_charge_date = $2,
                                consecutive_failures = 0,
                                updated_at = NOW()
                          WHERE id = $1`,
                        [plan.id, next.toISOString().slice(0, 10)]
                    );

                    await pool.query(
                        `INSERT INTO admin_notifications
                            (kind, title, body, lead_id, entity_type, entity_id, severity, once_key)
                         VALUES ($1,$2,$3,$4,'maintenance_plan',$5,$6,$7)
                         ON CONFLICT (once_key) DO NOTHING`,
                        [firstStart ? 'maintenance_started' : 'maintenance_paid',
                         firstStart
                            ? `START SERVICE: ${plan.label} is paid and active`
                            : `${plan.label} — payment received`,
                         `${Number(inv.total_amount || 0).toFixed(2)} paid${firstStart
                            ? '. This is the first payment — service starts now.' : '.'} Next charge ${next.toISOString().slice(0, 10)}.`,
                         inv.lead_id, plan.id,
                         firstStart ? 'success' : 'info',
                         `plan_paid:${plan.id}:${inv.id}`]
                    ).catch(() => {});
                }
            }

            if (inv.agreement_id) {
                // Anything still outstanding on this agreement?
                const rest = (await pool.query(
                    `SELECT COUNT(*)::int AS n FROM invoices
                      WHERE agreement_id = $1
                        AND status NOT IN ('paid','void','cancelled','refunded','draft')`,
                    [inv.agreement_id])).rows[0];
                const ag = (await pool.query(
                    'SELECT agreement_number, package_name, project_id FROM sales_agreements WHERE id=$1',
                    [inv.agreement_id])).rows[0];

                await pool.query(
                    `INSERT INTO admin_notifications
                        (kind, title, body, lead_id, entity_type, entity_id, severity, once_key)
                     VALUES ($1,$2,$3,$4,'agreement',$5,$6,$7)
                     ON CONFLICT (once_key) DO NOTHING`,
                    [rest.n === 0 ? 'project_paid_in_full' : 'project_payment',
                     rest.n === 0
                        ? `PAID IN FULL — clear to deploy: ${(ag && (ag.package_name || ag.agreement_number)) || 'project'}`
                        : `Payment received on ${(ag && ag.agreement_number) || 'an agreement'}`,
                     rest.n === 0
                        ? `${Number(inv.total_amount || 0).toFixed(2)} paid, nothing outstanding. Ready to deploy / hand over.`
                        : `${Number(inv.total_amount || 0).toFixed(2)} paid · ${rest.n} invoice(s) still open.`,
                     inv.lead_id, inv.agreement_id,
                     rest.n === 0 ? 'success' : 'info',
                     `agreement_paid:${inv.agreement_id}:${inv.id}`]
                ).catch(() => {});
            }
        } catch (e) {
            console.warn('[MARK PAID] post-payment hooks:', e.message);
        }

        if (inv.lead_id) {
            await pool.query(
                `UPDATE leads
                    SET is_customer = TRUE, customer_status = 'active', status = 'closed',
                        updated_at = CURRENT_TIMESTAMP
                  WHERE id = $1`, [inv.lead_id]);
            const ltv = await pool.query(
                `SELECT COALESCE(SUM(total_amount),0) AS total FROM invoices WHERE lead_id = $1 AND status = 'paid'`,
                [inv.lead_id]);
            await pool.query(
                `UPDATE leads SET lifetime_value = $1, last_payment_date = CURRENT_TIMESTAMP WHERE id = $2`,
                [ltv.rows[0].total, inv.lead_id]).catch(() => {});
            // Payment receipt email (defensive)
            try {
                const who = (await pool.query('SELECT name, email FROM leads WHERE id=$1', [inv.lead_id])).rows[0];
                const amt = inv.total_amount != null ? ('$' + Number(inv.total_amount).toFixed(2)) : null;
                if (who && who.email && global.__diamondbackMail) global.__diamondbackMail.paymentReceipt(who.name, who.email, amt, inv.invoice_number);
            } catch (_) {}
        }
        return inv;
    }
    // Expose mark-paid for handlers registered earlier in the file (the Stripe webhook
    // is mounted near the top, before this definition). Assigning here at module load
    // guarantees it's available by the time any webhook/request fires.
    global.markInvoicePaidById = markInvoicePaidById;

    // Ensure portal-specific tables/columns exist (safe to call repeatedly).
    async function ensurePortalSchema() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS service_requests (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                service_type VARCHAR(120),
                vehicle VARCHAR(200),
                preferred_date DATE,
                details TEXT,
                status VARCHAR(40) DEFAULT 'new',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
        // Reply support for service requests (admin -> customer). Safe/idempotent.
        await pool.query(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='service_requests' AND column_name='admin_response')
            THEN ALTER TABLE service_requests ADD COLUMN admin_response TEXT; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='service_requests' AND column_name='responded_at')
            THEN ALTER TABLE service_requests ADD COLUMN responded_at TIMESTAMP; END IF;
        END $$;`).catch(() => {});
        await pool.query(`
            CREATE TABLE IF NOT EXISTS appointments (
                id SERIAL PRIMARY KEY,
                lead_email VARCHAR(255),
                lead_name VARCHAR(255),
                scheduled_time TIMESTAMP,
                event_type VARCHAR(80) DEFAULT 'consultation',
                status VARCHAR(40) DEFAULT 'scheduled',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sales_agreements (
                id SERIAL PRIMARY KEY,
                agreement_number VARCHAR(40) UNIQUE,
                lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
                customer_name VARCHAR(255),
                customer_email VARCHAR(255),
                service_type VARCHAR(60),
                package_name VARCHAR(160),
                vehicle VARCHAR(200),
                price NUMERIC(10,2) DEFAULT 0,
                deposit NUMERIC(10,2) DEFAULT 0,
                start_date DATE,
                status VARCHAR(40) DEFAULT 'draft',
                terms TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
        await pool.query(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_agreements' AND column_name='invoice_id')
            THEN ALTER TABLE sales_agreements ADD COLUMN invoice_id INTEGER; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_agreements' AND column_name='balance_invoice_id')
            THEN ALTER TABLE sales_agreements ADD COLUMN balance_invoice_id INTEGER; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_agreements' AND column_name='require_deposit')
            THEN ALTER TABLE sales_agreements ADD COLUMN require_deposit BOOLEAN DEFAULT FALSE; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_agreements' AND column_name='deposit_pct')
            THEN ALTER TABLE sales_agreements ADD COLUMN deposit_pct NUMERIC(5,2) DEFAULT 0; END IF;
        END $$;`).catch(() => {});
        await pool.query(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='stripe_payment_intent_id')
            THEN ALTER TABLE invoices ADD COLUMN stripe_payment_intent_id VARCHAR(255); END IF;
        END $$;`).catch(() => {});

        // Shared messaging between admin <-> client. One row per message; both the
        // admin portal and the client portal read/write the SAME table so they see
        // the exact same conversation. request_id optionally links a message to a
        // service request; kind='marketing' marks promotional broadcasts.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS client_messages (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                request_id INTEGER,
                sender VARCHAR(10) NOT NULL,
                kind VARCHAR(20) DEFAULT 'message',
                subject VARCHAR(200),
                body TEXT NOT NULL,
                read_by_admin BOOLEAN DEFAULT FALSE,
                read_by_client BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_messages_lead ON client_messages(lead_id)`).catch(() => {});
    }
    ensurePortalSchema().then(() => console.log('[PORTAL] Schema ensured (service_requests, appointments, invoices.stripe_payment_intent_id)'))
                        .catch(e => console.error('[PORTAL] Schema ensure failed:', e.message));

    // Public: expose Stripe publishable key so the portal can mount Stripe Elements.
    app.get('/api/config/stripe', (req, res) => {
        // STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are DIFFERENT variables.
        // The admin portal never loads Stripe.js — it only charges server-side
        // with the secret key — so Stripe can look "set up" everywhere while the
        // publishable key, which the browser needs to render a card field, is
        // missing. Reporting both states separately makes that obvious instead
        // of the customer portal just saying "not configured".
        const pk = process.env.STRIPE_PUBLISHABLE_KEY || '';
        const hasSecret = !!process.env.STRIPE_SECRET_KEY;
        if (!pk) {
            console.warn('[STRIPE] STRIPE_PUBLISHABLE_KEY is not set — the customer portal cannot show a card form.' +
                (hasSecret ? ' STRIPE_SECRET_KEY IS set, so server-side charges still work.' : ''));
        }
        res.json({
            success: true,
            publishableKey: pk,
            configured: !!pk,
            secretConfigured: hasSecret,
            message: pk ? null
                : (hasSecret
                    ? 'Card payments are not available yet: STRIPE_PUBLISHABLE_KEY is not set on the server. Your secret key is set, so this is the one that is missing — add it in Render and restart.'
                    : 'Stripe is not configured on the server. Set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY in Render, then restart.'),
        });
    });

    // Client: get the checkout breakdown for an invoice (subtotal, tax, fee, total).
    app.get('/api/portal/invoices/:id/checkout', authenticatePortal, async (req, res) => {
        try {
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            const r = await pool.query('SELECT * FROM invoices WHERE id = $1 AND lead_id = $2', [req.params.id, clientId]);
            if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found.' });
            const invoice = r.rows[0];
            if (invoice.status === 'paid') return res.status(400).json({ success: false, message: 'This invoice is already paid.' });
            res.json({ success: true, invoice, breakdown: buildCheckoutBreakdown(invoice) });
        } catch (e) {
            console.error('[CLIENT] checkout breakdown error:', e.message);
            res.status(500).json({ success: false, message: 'Could not load checkout.' });
        }
    });

    // Client: create (or reuse) a PaymentIntent for an invoice. Returns client_secret.
    /**
     * Is this invoice actually payable? Nothing may be paid against a document
     * that hasn't been signed — checked server-side, because the dashboard flag
     * is only a display hint and a crafted request would bypass it.
     */
    async function invoicePayableError(invoiceId) {
        const agSigned = await agreementSignedSql('sa');
        const planSigned = await planSignedSql('mp');
        const r = await pool.query(
            `SELECT i.id, i.agreement_id, i.maintenance_plan_id,
                    (i.agreement_id IS NULL OR EXISTS (
                        SELECT 1 FROM sales_agreements sa
                         WHERE sa.id = i.agreement_id AND ${agSigned})) AS agreement_ok,
                    (i.maintenance_plan_id IS NULL OR EXISTS (
                        SELECT 1 FROM maintenance_plans mp
                         WHERE mp.id = i.maintenance_plan_id AND ${planSigned})) AS plan_ok
               FROM invoices i WHERE i.id = $1`, [invoiceId]
        ).catch((e) => { console.warn('[PAYABLE CHECK]', e.message); return null; });
        const row = r && r.rows[0];
        if (!row) return null;                     // let the caller 404 normally
        if (!row.agreement_ok || !row.plan_ok) {
            return 'This needs to be signed before it can be paid. Open it under Docs, sign it, and the payment will unlock.';
        }
        return null;
    }

    app.post('/api/portal/invoices/:id/payment-intent', authenticatePortal, async (req, res) => {
        try {
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            const r = await pool.query(
                `SELECT i.*, l.name AS lead_name, l.email AS lead_email
                   FROM invoices i LEFT JOIN leads l ON i.lead_id = l.id
                  WHERE i.id = $1 AND i.lead_id = $2`, [req.params.id, clientId]);
            if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found.' });
            const invoice = r.rows[0];
            if (invoice.status === 'paid') return res.status(400).json({ success: false, message: 'This invoice is already paid.' });

            const breakdown = buildCheckoutBreakdown(invoice);

            // Reuse an existing open PaymentIntent if present and still updatable.
            let intent;
            if (invoice.stripe_payment_intent_id) {
                try {
                    const existing = await stripe.paymentIntents.retrieve(invoice.stripe_payment_intent_id);
                    if (existing && ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existing.status)) {
                        intent = await stripe.paymentIntents.update(existing.id, { amount: breakdown.amountCents });
                    }
                } catch (_) { /* fall through and create new */ }
            }
            if (!intent) {
                intent = await stripe.paymentIntents.create({
                    amount: breakdown.amountCents,
                    currency: 'usd',
                    description: `Invoice ${invoice.invoice_number} — Diamondback Coding`,
                    receipt_email: invoice.lead_email || undefined,
                    metadata: {
                        invoice_id: String(invoice.id),
                        invoice_number: invoice.invoice_number || '',
                        lead_id: String(invoice.lead_id || ''),
                        invoice_total: String(breakdown.invoiceTotal),
                        processing_fee: String(breakdown.processingFee)
                    },
                    automatic_payment_methods: { enabled: true }
                });
                await pool.query('UPDATE invoices SET stripe_payment_intent_id = $1 WHERE id = $2', [intent.id, invoice.id]);
            }

            res.json({ success: true, clientSecret: intent.client_secret, breakdown,
                       publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
        } catch (e) {
            console.error('[CLIENT] payment-intent error:', e.message);
            res.status(500).json({ success: false, message: 'Could not start payment. ' + e.message });
        }
    });

    // Client: confirm a just-completed card payment and mark the invoice paid immediately.
    // This does NOT depend on the Stripe webhook — it verifies the PaymentIntent directly
    // with Stripe, so the invoice flips to "paid" in both portals the moment payment succeeds.
    app.post('/api/portal/invoices/:id/confirm-paid', authenticatePortal, async (req, res) => {
        try {
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            {
                const blocked = await invoicePayableError(req.params.id);
                if (blocked) return res.status(409).json({ success: false, message: blocked });
            }
            const r = await pool.query('SELECT * FROM invoices WHERE id = $1 AND lead_id = $2', [req.params.id, clientId]);
            if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found.' });
            const invoice = r.rows[0];
            if (invoice.status === 'paid') return res.json({ success: true, invoice, alreadyPaid: true });

            const piId = (req.body && req.body.payment_intent_id) || invoice.stripe_payment_intent_id;
            if (!piId) return res.status(400).json({ success: false, message: 'No payment to confirm.' });

            // Verify with Stripe that the payment actually went through (can't be spoofed by the client).
            const pi = await stripe.paymentIntents.retrieve(piId);
            if (!pi || (pi.status !== 'succeeded' && pi.status !== 'processing')) {
                return res.status(402).json({ success: false, message: 'Payment not completed yet.', status: pi && pi.status });
            }
            // Defense: make sure this PaymentIntent is actually for this invoice.
            if (pi.metadata && pi.metadata.invoice_id && String(pi.metadata.invoice_id) !== String(invoice.id)) {
                return res.status(400).json({ success: false, message: 'Payment does not match this invoice.' });
            }
            const updated = await markInvoicePaidById(invoice.id, pi.id);
            res.json({ success: true, invoice: updated || invoice });
        } catch (e) {
            console.error('[CLIENT] confirm-paid error:', e.message);
            res.status(500).json({ success: false, message: 'Could not confirm payment.' });
        }
    });

    // Client: submit a service request (synced to admin).
    app.post('/api/portal/service-requests', authenticatePortal, async (req, res) => {
        try {
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            const { service_type, vehicle, preferred_date, details } = req.body || {};
            if (!service_type) return res.status(400).json({ success: false, message: 'Service type is required.' });
            const r = await pool.query(
                `INSERT INTO service_requests (lead_id, service_type, vehicle, preferred_date, details, status)
                 VALUES ($1, $2, $3, $4, $5, 'new') RETURNING *`,
                [clientId, service_type, req.body.project || vehicle || null, preferred_date || null, details || null]);
            const created = r.rows[0];

            // Confirmation email + portal message + "you have messages" ping to
            // the customer, and an SMS to Diamondback so a request can't sit
            // unseen. Fire-and-forget: the request is already saved, so a mail
            // or SMS outage must not turn a successful submission into an error.
            //
            // (This replaces a global.__diamondbackMail hook that was never
            // defined anywhere, so no confirmation was ever actually sent.)
            if (typeof onServiceRequestCreated === 'function') {
                onServiceRequestCreated({ requestId: created.id })
                    .catch((e) => console.error('[SERVICE REQUEST] notify failed:', e.message));
            } else {
                console.warn('[SERVICE REQUEST] no notifier wired — customer was not confirmed.');
            }

            res.json({ success: true, request: created });
        } catch (e) {
            console.error('[CLIENT] service-request create error:', e.message);
            res.status(500).json({ success: false, message: 'Could not submit request.' });
        }
    });

    // Client: list own service requests.
    app.get('/api/portal/service-requests', authenticatePortal, async (req, res) => {
        try {
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            const r = await pool.query('SELECT * FROM service_requests WHERE lead_id = $1 ORDER BY created_at DESC', [clientId]);
            res.json({ success: true, requests: r.rows });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not load requests.' });
        }
    });

    // Admin: list all service requests (with customer info).
    app.get('/api/admin/service-requests', authenticateToken, async (req, res) => {
        try {
            const r = await pool.query(`
                SELECT sr.*, l.name AS customer_name, l.email AS customer_email, l.phone AS customer_phone
                  FROM service_requests sr LEFT JOIN leads l ON sr.lead_id = l.id
                 ORDER BY sr.created_at DESC`);
            res.json({ success: true, requests: r.rows });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not load service requests.' });
        }
    });

    // Admin: update a service request status.
    app.patch('/api/admin/service-requests/:id', authenticateToken, async (req, res) => {
        try {
            const { status } = req.body || {};
            const r = await pool.query(
                'UPDATE service_requests SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
                [status, req.params.id]);
            res.json({ success: true, request: r.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not update request.' });
        }
    });

    // Admin: reply to a service request — stores the response, emails the customer,
    // and surfaces it in the client portal. (Fixes "can't reply to a service request".)
    app.post('/api/admin/service-requests/:id/respond', authenticateToken, async (req, res) => {
        try {
            await ensurePortalSchema();
            const { response } = req.body || {};
            if (!response || !response.trim()) {
                return res.status(400).json({ success: false, message: 'A response message is required.' });
            }

            // Load the request + the customer it belongs to.
            const reqRow = (await pool.query(`
                SELECT sr.*, l.name AS customer_name, l.email AS customer_email
                  FROM service_requests sr
                  LEFT JOIN leads l ON sr.lead_id = l.id
                 WHERE sr.id = $1`, [req.params.id])).rows[0];
            if (!reqRow) {
                return res.status(404).json({ success: false, message: 'Service request not found.' });
            }

            // Store the response and move the request to "in-progress" if it was still new.
            const updated = (await pool.query(`
                UPDATE service_requests
                   SET admin_response = $1,
                       responded_at = CURRENT_TIMESTAMP,
                       status = CASE WHEN status = 'new' THEN 'in-progress' ELSE status END,
                       updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2
                 RETURNING *`, [response.trim(), req.params.id])).rows[0];

            // Thread the reply into the shared inbox so the client sees it in-portal.
            if (reqRow.lead_id) {
                await pool.query(
                    `INSERT INTO client_messages (lead_id, request_id, sender, kind, body, read_by_admin, read_by_client)
                     VALUES ($1, $2, 'admin', 'message', $3, TRUE, FALSE)`,
                    [reqRow.lead_id, req.params.id, response.trim()]
                ).catch(e => console.warn('[MSG] thread insert (respond) failed:', e.message));
            }

            // Notification-only email — the message itself lives in the portal.
            if (reqRow.customer_email) {
                portalMailAsync(buildPortalMessageEmail(reqRow.customer_name, reqRow.customer_email));
            }

            res.json({ success: true, request: updated });
        } catch (e) {
            console.error('[SERVICE-REQUEST] respond error:', e.message);
            res.status(500).json({ success: false, message: 'Could not send reply: ' + e.message });
        }
    });

    // ──────────────────────────────────────────────────────────────────────────
    // SHARED MESSAGING  (admin portal <-> client portal, one source of truth)
    // Replies are NOT emailed; the customer just gets a "you have a new message"
    // notification with a link to the portal.
    // ──────────────────────────────────────────────────────────────────────────

    // Build the notification-only email (no message content included).
    function buildPortalMessageEmail(name, email, opts = {}) {
        const portalUrl = `${BASE_URL}/client_portal.html`;
        const heading = opts.marketing ? 'A new offer is waiting in your portal' : 'You have a new message';
        const line = opts.marketing
            ? 'Diamondback Coding just posted a new offer to your client portal.'
            : 'Diamondback Coding sent you a new message in your client portal.';
        return {
            to: email,
            subject: opts.marketing
                ? (opts.subject ? `${opts.subject} — Diamondback Coding` : 'A new offer from Diamondback Coding')
                : 'You have a new message — Diamondback Coding',
            html: `
                <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#222;">
                  <h2 style="border-bottom:2px solid #c9a14a;padding-bottom:10px;color:#1a1a1a;">Diamondback Coding</h2>
                  <p>Hi ${name || 'there'},</p>
                  <p style="font-size:16px;font-weight:600;">${heading}.</p>
                  <p>${line} Sign in to read it and reply.</p>
                  <p style="text-align:center;margin:26px 0;">
                    <a href="${portalUrl}" style="display:inline-block;background:#c9a14a;color:#1a1a1a;text-decoration:none;font-weight:700;font-size:14px;padding:13px 28px;border-radius:8px;">View message in your portal →</a>
                  </p>
                  <p style="color:#777;font-size:13px;">Or go to: <a href="${portalUrl}">${portalUrl}</a></p>
                  <p style="color:#777;font-size:13px;">Questions? Reply to this email or call (940) 217-8680.</p>
                  <p>— Diamondback Coding</p>
                </div>`
        };
    }
    global.buildPortalMessageEmail = buildPortalMessageEmail;

    // ── CLIENT SIDE ──
    // Client: fetch their whole conversation (and mark admin→client messages read).
    app.get('/api/portal/messages', authenticatePortal, async (req, res) => {
        try {
            await ensurePortalSchema();
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            const r = await pool.query(
                'SELECT id, request_id, sender, kind, subject, body, created_at FROM client_messages WHERE lead_id = $1 ORDER BY created_at ASC',
                [clientId]);
            await pool.query('UPDATE client_messages SET read_by_client = TRUE WHERE lead_id = $1 AND sender = $2', [clientId, 'admin']);
            res.json({ success: true, messages: r.rows });
        } catch (e) {
            console.error('[CLIENT] messages load error:', e.message);
            res.status(500).json({ success: false, message: 'Could not load messages.' });
        }
    });

    // Client: unread count (admin→client messages not yet read).
    app.get('/api/portal/messages/unread-count', authenticatePortal, async (req, res) => {
        try {
            await ensurePortalSchema();
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            const r = await pool.query(
                "SELECT COUNT(*)::int AS c FROM client_messages WHERE lead_id = $1 AND sender = 'admin' AND read_by_client = FALSE",
                [clientId]);
            res.json({ success: true, count: r.rows[0].c });
        } catch (e) {
            res.json({ success: true, count: 0 });
        }
    });

    // Client: send a message to the shop.
    app.post('/api/portal/messages', authenticatePortal, async (req, res) => {
        try {
            await ensurePortalSchema();
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            const { body, request_id } = req.body || {};
            if (!body || !body.trim()) return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
            const row = (await pool.query(
                `INSERT INTO client_messages (lead_id, request_id, sender, kind, body, read_by_admin, read_by_client)
                 VALUES ($1, $2, 'client', 'message', $3, FALSE, TRUE) RETURNING id, request_id, sender, kind, subject, body, created_at`,
                [clientId, request_id || null, body.trim()])).rows[0];
            res.json({ success: true, message: row });
        } catch (e) {
            console.error('[CLIENT] message send error:', e.message);
            res.status(500).json({ success: false, message: 'Could not send message.' });
        }
    });

    // ── ADMIN SIDE ──
    // Admin: list conversations (one per client), newest activity first.
    app.get('/api/admin/conversations', authenticateToken, async (req, res) => {
        try {
            await ensurePortalSchema();
            const r = await pool.query(`
                SELECT l.id AS lead_id, l.name, l.email, l.phone,
                       -- Lets the admin messenger filter Leads vs Customers.
                       COALESCE(l.is_customer, FALSE) AS is_customer,
                       CASE WHEN COALESCE(l.is_customer, FALSE) THEN 'customer' ELSE 'lead' END AS kind,
                       l.status,
                       (l.client_password IS NOT NULL) AS has_portal,
                       m.last_body, m.last_at, m.last_sender,
                       COALESCE(u.unread, 0) AS unread,
                       COALESCE(rq.req_count, 0) AS request_count
                  FROM leads l
                  -- LEFT JOIN, not JOIN: the inner join meant only people who
                  -- already had a thread appeared, so you could never START a
                  -- conversation with a new lead from the messenger. The WHERE
                  -- below keeps the default list to real conversations, and
                  -- ?include=all opens it up to anyone contactable.
                  LEFT JOIN (
                        SELECT DISTINCT lead_id FROM client_messages
                        UNION
                        SELECT DISTINCT lead_id FROM service_requests WHERE lead_id IS NOT NULL
                       ) act ON act.lead_id = l.id
                  LEFT JOIN LATERAL (
                        SELECT body AS last_body, created_at AS last_at, sender AS last_sender
                          FROM client_messages cm WHERE cm.lead_id = l.id
                         ORDER BY created_at DESC LIMIT 1
                       ) m ON TRUE
                  LEFT JOIN (
                        SELECT lead_id, COUNT(*)::int AS unread FROM client_messages
                         WHERE sender = 'client' AND read_by_admin = FALSE GROUP BY lead_id
                       ) u ON u.lead_id = l.id
                  LEFT JOIN (
                        SELECT lead_id, COUNT(*)::int AS req_count FROM service_requests GROUP BY lead_id
                       ) rq ON rq.lead_id = l.id
                 WHERE act.lead_id IS NOT NULL
                    OR ($1::boolean AND (l.email IS NOT NULL OR l.phone IS NOT NULL))
                 ORDER BY COALESCE(m.last_at, '1970-01-01') DESC, l.name ASC`,
                [String((req.query || {}).include || '') === 'all']
            );
            res.json({ success: true, conversations: r.rows });
        } catch (e) {
            console.error('[ADMIN] conversations error:', e.message);
            res.status(500).json({ success: false, message: 'Could not load conversations.' });
        }
    });

    // Admin: total unread (client→admin) for the topbar badge.
    app.get('/api/admin/messages/unread-count', authenticateToken, async (req, res) => {
        try {
            await ensurePortalSchema();
            const r = await pool.query("SELECT COUNT(*)::int AS c FROM client_messages WHERE sender = 'client' AND read_by_admin = FALSE");
            res.json({ success: true, count: r.rows[0].c });
        } catch (e) {
            res.json({ success: true, count: 0 });
        }
    });

    // Admin: full thread for one client + that client's service requests (context).
    // Marks client→admin messages as read.
    app.get('/api/admin/conversations/:leadId/messages', authenticateToken, async (req, res) => {
        try {
            await ensurePortalSchema();
            const leadId = req.params.leadId;
            const client = (await pool.query('SELECT id, name, email, phone FROM leads WHERE id = $1', [leadId])).rows[0];
            const messages = (await pool.query(
                'SELECT id, request_id, sender, kind, subject, body, created_at FROM client_messages WHERE lead_id = $1 ORDER BY created_at ASC',
                [leadId])).rows;
            const requests = (await pool.query(
                'SELECT id, service_type, vehicle, preferred_date, details, status, created_at FROM service_requests WHERE lead_id = $1 ORDER BY created_at DESC',
                [leadId])).rows;
            await pool.query('UPDATE client_messages SET read_by_admin = TRUE WHERE lead_id = $1 AND sender = $2', [leadId, 'client']);
            res.json({ success: true, client, messages, requests });
        } catch (e) {
            console.error('[ADMIN] thread error:', e.message);
            res.status(500).json({ success: false, message: 'Could not load conversation.' });
        }
    });

    // Admin: send a message to a client. Notifies by email (link only, no content).
    app.post('/api/admin/conversations/:leadId/messages', authenticateToken, async (req, res) => {
        try {
            await ensurePortalSchema();
            const leadId = req.params.leadId;
            const { body, request_id } = req.body || {};
            if (!body || !body.trim()) return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
            const client = (await pool.query('SELECT id, name, email FROM leads WHERE id = $1', [leadId])).rows[0];
            if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });
            const row = (await pool.query(
                `INSERT INTO client_messages (lead_id, request_id, sender, kind, body, read_by_admin, read_by_client)
                 VALUES ($1, $2, 'admin', 'message', $3, TRUE, FALSE) RETURNING id, request_id, sender, kind, subject, body, created_at`,
                [leadId, request_id || null, body.trim()])).rows[0];
            if (client.email) portalMailAsync(buildPortalMessageEmail(client.name, client.email));
            res.json({ success: true, message: row });
        } catch (e) {
            console.error('[ADMIN] message send error:', e.message);
            res.status(500).json({ success: false, message: 'Could not send message.' });
        }
    });

    // Admin: marketing broadcast — posts a promotional message into each selected
    // client's portal inbox and emails them a notification with a link.
    app.post('/api/admin/marketing/broadcast', authenticateToken, async (req, res) => {
        try {
            await ensurePortalSchema();
            let { leadIds, subject, body, audience } = req.body || {};
            if (!body || !body.trim()) return res.status(400).json({ success: false, message: 'Message body is required.' });

            // Resolve recipients: explicit ids, or audience='all'/'customers' (portal accounts).
            let recipients;
            if (Array.isArray(leadIds) && leadIds.length) {
                recipients = (await pool.query('SELECT id, name, email FROM leads WHERE id = ANY($1::int[])', [leadIds])).rows;
            } else if (audience === 'all' || audience === 'customers') {
                const sql = audience === 'customers'
                    ? "SELECT id, name, email FROM leads WHERE client_password IS NOT NULL AND COALESCE(is_customer, FALSE) = TRUE"
                    : "SELECT id, name, email FROM leads WHERE client_password IS NOT NULL";
                recipients = (await pool.query(sql)).rows;
            } else {
                return res.status(400).json({ success: false, message: 'Choose recipients (leadIds or audience).' });
            }
            if (!recipients.length) return res.json({ success: true, sent: 0, message: 'No matching portal clients.' });

            let sent = 0;
            for (const r of recipients) {
                try {
                    await pool.query(
                        `INSERT INTO client_messages (lead_id, sender, kind, subject, body, read_by_admin, read_by_client)
                         VALUES ($1, 'admin', 'marketing', $2, $3, TRUE, FALSE)`,
                        [r.id, (subject || '').trim() || null, body.trim()]);
                    if (r.email) portalMailAsync(buildPortalMessageEmail(r.name, r.email, { marketing: true, subject: (subject || '').trim() }));
                    sent++;
                } catch (e) { console.warn('[MARKETING] insert failed for lead', r.id, e.message); }
            }
            res.json({ success: true, sent });
        } catch (e) {
            console.error('[ADMIN] marketing broadcast error:', e.message);
            res.status(500).json({ success: false, message: 'Could not send broadcast.' });
        }
    });

    // Admin: notifications feed — recent activity ONLY (separate from Messages).
    // New leads, new service requests, payments received. (Client messages are
    // intentionally excluded here; those live in the Messages inbox/envelope.)
    app.get('/api/admin/notifications', authenticateToken, async (req, res) => {
        try {
            await ensurePortalSchema();
            const out = [];
            // New service requests (still 'new')
            try {
                const r = await pool.query(`
                    SELECT sr.id, sr.service_type, sr.created_at, l.name
                      FROM service_requests sr LEFT JOIN leads l ON sr.lead_id = l.id
                     WHERE sr.status = 'new'
                     ORDER BY sr.created_at DESC LIMIT 15`);
                r.rows.forEach(x => out.push({
                    type: 'request', icon: 'request', section: 'serviceRequests',
                    title: `New service request${x.name ? ' from ' + x.name : ''}`,
                    detail: x.service_type || '', time: x.created_at
                }));
            } catch (e) {}
            // New leads (last 14 days)
            try {
                const r = await pool.query(`
                    SELECT id, name, email, created_at FROM leads
                     WHERE COALESCE(is_customer,FALSE) = FALSE
                       AND created_at > NOW() - INTERVAL '14 days'
                     ORDER BY created_at DESC LIMIT 15`);
                r.rows.forEach(x => out.push({
                    type: 'lead', icon: 'lead', section: 'leads',
                    title: `New lead: ${x.name || x.email || 'Unknown'}`,
                    detail: x.email || '', time: x.created_at
                }));
            } catch (e) {}
            // Payments received (last 14 days)
            try {
                const r = await pool.query(`
                    SELECT id, invoice_number, total_amount, paid_at FROM invoices
                     WHERE status = 'paid' AND paid_at > NOW() - INTERVAL '14 days'
                     ORDER BY paid_at DESC LIMIT 15`);
                r.rows.forEach(x => out.push({
                    type: 'payment', icon: 'payment', section: 'invoices',
                    title: `Payment received`,
                    detail: `${x.invoice_number || ('Invoice #' + x.id)} · $${Number(x.total_amount || 0).toFixed(2)}`,
                    time: x.paid_at
                }));
            } catch (e) {}
            // Inbound SMS replies (unread)
            try {
                const r = await pool.query(`
                    SELECT ml.id, ml.content, ml.sent_at, l.name
                      FROM message_log ml LEFT JOIN leads l ON ml.lead_id = l.id
                     WHERE ml.channel = 'sms' AND ml.direction = 'inbound' AND ml.read_at IS NULL
                     ORDER BY ml.sent_at DESC LIMIT 15`);
                r.rows.forEach(x => out.push({
                    type: 'lead', icon: 'lead', section: 'followups',
                    title: `New text reply${x.name ? ' from ' + x.name : ''}`,
                    detail: (x.content || '').slice(0, 80), time: x.sent_at
                }));
            } catch (e) {}
            // Lifecycle notifications — SLA signed, maintenance signed and
            // started, paid in full, charge failed. adminNotify() has been
            // writing these all along; nothing ever read them, so they never
            // reached the bell.
            try {
                const r = await pool.query(`
                    SELECT an.id, an.kind, an.title, an.body, an.severity,
                           an.is_read, an.created_at, an.entity_type, an.entity_id,
                           l.name AS lead_name
                      FROM admin_notifications an
                      LEFT JOIN leads l ON l.id = an.lead_id
                     WHERE an.created_at > NOW() - INTERVAL '30 days'
                     ORDER BY an.created_at DESC LIMIT 40`);
                r.rows.forEach(x => out.push({
                    id: x.id,
                    type: 'lifecycle',
                    icon: x.severity === 'success' ? 'payment'
                        : x.severity === 'error' || x.severity === 'warning' ? 'request' : 'lead',
                    // Signed agreements and paid projects are things you act on,
                    // so send the bell to the section where you'd act.
                    section: x.entity_type === 'maintenance_plan' ? 'maintenance'
                           : x.entity_type === 'agreement' ? 'salesAgreements'
                           : 'invoices',
                    title: x.title,
                    detail: [x.lead_name, x.body].filter(Boolean).join(' · '),
                    severity: x.severity,
                    unread: x.is_read === false,
                    time: x.created_at
                }));
            } catch (e) {
                console.warn('[ADMIN] lifecycle notifications unavailable:', e.message);
            }

            out.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

            // THE RESPONSE. Its absence meant every poll hung until the browser
            // timed out and retried, forever.
            res.json({
                success: true,
                notifications: out,
                unreadCount: out.filter(x => x.unread).length,
            });
        } catch (e) {
            console.error('[ADMIN] notifications error:', e.message);
            res.json({ success: true, notifications: [] });
        }
    });

    // Public: book a consultation from the website contact form.
    // Creates/links a lead and an appointment so it appears on the admin Schedule tab.
    app.post('/api/public/consultations', async (req, res) => {
        try {
            await ensurePortalSchema();
            const { name, email, phone, scheduledTime, service, message } = req.body || {};
            if (!name || !email || !scheduledTime) {
                return res.status(400).json({ success: false, message: 'Name, email and a preferred time are required.' });
            }
            const dateErr = bookingDateError(scheduledTime);
            if (dateErr) return res.status(400).json({ success: false, message: dateErr });
            // Find or create the lead.
            let leadRow = (await pool.query('SELECT id FROM leads WHERE LOWER(email) = LOWER($1) LIMIT 1', [email])).rows[0];
            const noteText = `Consultation requested via website${service ? ' for ' + service : ''}${message ? ' — ' + message : ''}`;
            if (!leadRow) {
                leadRow = (await pool.query(
                    `INSERT INTO leads (name, email, phone, status, lead_temperature, source, notes, created_at, updated_at)
                     VALUES ($1, $2, $3, 'new', 'hot', 'website-consultation', $4, NOW(), NOW()) RETURNING id`,
                    [name, email, phone || null, noteText])).rows[0];
            } else {
                await pool.query(
                    `UPDATE leads SET lead_temperature = 'hot', last_contact_date = NULL, updated_at = NOW(),
                            notes = COALESCE(notes || E'\\n\\n', '') || $2 WHERE id = $1`,
                    [leadRow.id, noteText]).catch(() => {});
            }
            // Create the appointment (shows on admin Schedule tab via /api/appointments).
            const apt = (await pool.query(
                `INSERT INTO appointments (lead_email, lead_name, scheduled_time, event_type, status, notes, created_at)
                 VALUES ($1, $2, $3, 'consultation', 'scheduled', $4, NOW()) RETURNING *`,
                [email, name, scheduledTime, noteText])).rows[0];

            // Confirmation email goes out in the background so booking returns instantly.
            {
                const when = new Date(scheduledTime).toLocaleString('en-US', { timeZone: 'America/Chicago' });
                portalMailAsync({
                    to: email,
                    subject: 'Your Diamondback Coding consultation request',
                    html: `<p>Hi ${name},</p><p>Thanks for requesting a consultation${service ? ' for <strong>' + service + '</strong>' : ''}. We have you down for <strong>${when} (CST)</strong> and will confirm shortly.</p><p>— Diamondback Coding</p>`
                });
            }

            res.json({ success: true, appointment: apt });
        } catch (e) {
            console.error('[CONSULT] error:', e.message);
            res.status(500).json({ success: false, message: 'Could not book consultation.' });
        }
    });

    // ── Diamondback public-booking business rules (America/Chicago) ────────────────
    //   Open Mon–Sat 6:00 AM–7:00 PM CST. Closed Sundays. No same-day booking.
    //   Returns an error string if the requested date is invalid, else null.
    function bookingDateError(whenISO) {
        const d = new Date(whenISO);
        if (isNaN(d.getTime())) return 'Please choose a valid date.';
        const ymd = (dt) => new Intl.DateTimeFormat('en-CA',
            { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
        const todayCT = ymd(new Date());
        const pickCT = ymd(d);
        if (pickCT <= todayCT) return 'We can\u2019t book the same day — please choose a future date.';
        const weekday = new Intl.DateTimeFormat('en-US',
            { timeZone: 'America/Chicago', weekday: 'short' }).format(d);
        if (weekday === 'Sun') return 'We\u2019re closed on Sundays — please choose another day.';
        return null;
    }

    // Public: list bookable DATES for the website scheduler (schedule.html).
    // Skips Sundays (closed) and today (no same-day). Returns open days only.
    app.get('/api/public/availability', async (req, res) => {
        try {
            const days = Math.min(Math.max(parseInt(req.query.days || '60', 10) || 60, 1), 120);
            const todayCT = new Intl.DateTimeFormat('en-CA',
                { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
            const start = new Date(todayCT + 'T12:00:00Z'); // noon UTC keeps the calendar date stable
            const available = [];
            for (let i = 1; i <= days; i++) { // start at 1 → never offer same-day
                const d = new Date(start);
                d.setUTCDate(d.getUTCDate() + i);
                if (d.getUTCDay() === 0) continue; // Sunday → closed
                available.push({ date: d.toISOString().slice(0, 10) });
            }
            res.json({
                success: true,
                hours: 'Mon\u2013Sat 6:00 AM\u20137:00 PM CST \u00b7 Closed Sunday',
                available
            });
        } catch (e) {
            console.error('[AVAILABILITY] error:', e.message);
            res.status(500).json({ success: false, message: 'Could not load availability.' });
        }
    });

    // Public: create a booking from the website scheduler (schedule.html).
    // Writes to the SAME appointments table the admin Schedule tab reads, so it
    // syncs straight into the admin calendar. Enforces no-Sunday / no-same-day.
    app.post('/api/public/schedule', async (req, res) => {
        try {
            await ensurePortalSchema();
            const { name, email, phone, date, eventType, service, vehicle, message } = req.body || {};
            if (!name || !email || !date) {
                return res.status(400).json({ success: false, message: 'Name, email and a date are required.' });
            }
            // Default the time to 9:00 AM CST on the chosen date.
            const scheduledTime = new Date(date + 'T09:00:00-06:00').toISOString();
            const dateErr = bookingDateError(scheduledTime);
            if (dateErr) return res.status(400).json({ success: false, message: dateErr });

            const note = `Website booking: ${eventType === 'service' ? 'Service appointment' : 'Free consultation'}`
                + `${service ? ' — ' + service : ''}${vehicle ? ' (' + vehicle + ')' : ''}${message ? ' — ' + message : ''}`;

            let leadRow = (await pool.query('SELECT id FROM leads WHERE LOWER(email) = LOWER($1) LIMIT 1', [email])).rows[0];
            if (!leadRow) {
                leadRow = (await pool.query(
                    `INSERT INTO leads (name, email, phone, status, lead_temperature, source, notes, created_at, updated_at)
                     VALUES ($1, $2, $3, 'new', 'hot', 'website-schedule', $4, NOW(), NOW()) RETURNING id`,
                    [name, email, phone || null, note])).rows[0];
            } else {
                await pool.query(
                    `UPDATE leads SET lead_temperature = 'hot', updated_at = NOW(),
                            notes = COALESCE(notes || E'\\n\\n', '') || $2 WHERE id = $1`,
                    [leadRow.id, note]).catch(() => {});
            }

            const apt = (await pool.query(
                `INSERT INTO appointments (lead_email, lead_name, scheduled_time, event_type, status, notes, created_at)
                 VALUES ($1, $2, $3, $4, 'scheduled', $5, NOW()) RETURNING *`,
                [email, name, scheduledTime, eventType === 'service' ? 'service' : 'consultation', note])).rows[0];

            const when = new Date(scheduledTime).toLocaleDateString('en-US',
                { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' });

            portalMailAsync({
                to: email,
                subject: 'Your Diamondback Coding appointment request',
                html: `<p>Hi ${name},</p><p>Thanks for booking with Diamondback Coding. We have your `
                    + `${eventType === 'service' ? 'service appointment' : 'consultation'} request for <strong>${when}</strong> `
                    + `and will confirm shortly.</p><p>— Diamondback Coding</p>`
            });

            res.json({ success: true, when, appointment: apt });
        } catch (e) {
            console.error('[SCHEDULE] error:', e.message);
            res.status(500).json({ success: false, message: 'Could not book your appointment.' });
        }
    });
    // ---- portal dashboard, agreement PDF ------------------------------------
    // ------------------------------------------------------------------
    // These three were CALLED but never defined anywhere — not in this file,
    // not in server.js, not passed into initPortal. Every "Download Agreement"
    // therefore threw a ReferenceError and returned a 500. Defining them here,
    // next to their only caller.
    // ------------------------------------------------------------------
    const PDFDocument = require('pdfkit');

    /** Collect a PDFKit document into a Buffer. */
    function diamondbackPdfToBuffer(doc) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            doc.end();
        });
    }

    function diamondbackMoney(n) {
        return '$' + Number(n || 0).toLocaleString('en-US',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function diamondbackServiceLabel(key) {
        const map = {
            web_development: 'Web Development',
            web_design: 'Web Design',
            crm_implementation: 'CRM Implementation',
            seo: 'SEO & Digital Marketing',
            maintenance: 'Maintenance',
            monthly_maintenance: 'Monthly Maintenance',
            brevo_maintenance: 'Brevo Maintenance',
            database_maintenance: 'Database Maintenance',
            hosting: 'Hosting',
            consulting: 'Consulting',
        };
        if (!key) return '—';
        return map[key] || String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }

    async function agreementPDFBuffer(a) {
        const doc = new PDFDocument({ margin: 50, size: 'LETTER', info: { Title: 'Sales Agreement ' + (a.agreement_number || ''), Author: 'Diamondback Coding' } });
        doc.rect(0, 0, doc.page.width, 90).fill('#0a0a0a');
        doc.fillColor('#D4A574').fontSize(20).font('Helvetica-Bold').text('DIAMONDBACK CODING', 50, 30);
        doc.fillColor('#f4f1ea').fontSize(9).font('Helvetica').text('Web Development \u2022 CRM Implementation \u2022 Digital Marketing \u2014 Dallas\u2013Fort Worth, TX', 50, 56);
        doc.fillColor('#000000'); doc.y = 120;
        doc.fontSize(22).font('Helvetica-Bold').text('Sales Agreement', { align: 'center' });
        doc.moveDown(0.2);
        doc.fontSize(10).font('Helvetica').fillColor('#666666').text(a.agreement_number || '', { align: 'center' });
        doc.fillColor('#000000'); doc.moveDown(1.2);
        const _total = parseFloat(a.price) || 0;
        const _reqDep = !!a.require_deposit && (parseFloat(a.deposit_pct) || 0) > 0;
        const _pct = parseFloat(a.deposit_pct) || 0;
        const _dep = _reqDep ? (parseFloat(a.deposit) || Math.round(_total * _pct) / 100) : 0;
        const _bal = Math.round((_total - _dep) * 100) / 100;
        const rows = [
            ['Customer', a.customer_name || '—'],
            ['Email', a.customer_email || '—'],
            ['Service', diamondbackServiceLabel(a.service_type)],
            ['Package', a.package_name || '—'],
            ['Project', a.project || a.vehicle || '\u2014'],
            ['Start date', a.start_date ? new Date(a.start_date).toLocaleDateString('en-US') : 'To be scheduled'],
            ['Total price', diamondbackMoney(_total)]
        ];
        if (_reqDep) {
            rows.push(['Down payment', `${_pct}%  —  ${diamondbackMoney(_dep)} (due at signing)`]);
            rows.push(['Balance on completion', diamondbackMoney(_bal)]);
        }
        doc.fontSize(11);
        rows.forEach(([k, v]) => {
            doc.font('Helvetica-Bold').fillColor('#444444').text(k + ': ', { continued: true });
            doc.font('Helvetica').fillColor('#111111').text(String(v));
            doc.moveDown(0.3);
        });
        doc.moveDown(0.6);
        // Payment terms (computed)
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text('Payment Terms');
        doc.moveDown(0.2);
        const _payClause = _reqDep
            ? `A down payment of ${_pct}% (${diamondbackMoney(_dep)}) is due upon signing this agreement to reserve your service. The remaining balance of ${diamondbackMoney(_bal)} is due upon completion of the service.`
            : `The full amount of ${diamondbackMoney(_total)} is due upon completion of the service.`;
        doc.font('Helvetica').fontSize(10).fillColor('#333333').text(_payClause, { align: 'left' });
        doc.moveDown(0.3);
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666666').text('Prices shown are before tax. Applicable sales tax (8.25%) and a card processing fee are added to each invoice.', { align: 'left' });
        doc.moveDown(0.8);
        if (a.terms) {
            doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text('Scope / Terms');
            doc.moveDown(0.2);
            doc.font('Helvetica').fontSize(10).fillColor('#333333').text(String(a.terms), { align: 'left' });
            doc.moveDown(0.8);
        }
        doc.font('Helvetica').fontSize(9).fillColor('#888888').text('Final pricing may vary with vehicle size and paint condition as discussed at consultation. Thank you for choosing Diamondback Coding.', { align: 'left' });
        doc.moveDown(2);
        doc.fillColor('#000000').fontSize(10).text('Authorized signature: ______________________________      Date: ______________');
        return diamondbackPdfToBuffer(doc);
    }

    // Cache of which columns exist. Cleared by _resetSchemaCache() after a
    // migration runs, so a repaired database is picked up without a restart.
    let _colCache = null;

    async function columnsOf(table) {
        if (!_colCache) _colCache = {};
        if (_colCache[table]) return _colCache[table];
        try {
            const r = await pool.query(
                `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
                [table]
            );
            _colCache[table] = new Set(r.rows.map((x) => x.column_name));
        } catch (e) {
            _colCache[table] = new Set();
        }
        return _colCache[table];
    }
    function _resetSchemaCache() { _colCache = null; }

    /**
     * SQL that is TRUE when the agreement aliased `a` is signed.
     *
     * agreement_signatures is the authority and always exists. signed_at and
     * status are ORed in only if this database actually has them.
     */
    async function agreementSignedSql(a = 'sa') {
        const cols = await columnsOf('sales_agreements');
        const parts = [`EXISTS (SELECT 1 FROM agreement_signatures sg WHERE sg.agreement_id = ${a}.id)`];
        if (cols.has('signed_at')) parts.push(`${a}.signed_at IS NOT NULL`);
        if (cols.has('status'))    parts.push(`${a}.status = 'signed'`);
        return `(${parts.join(' OR ')})`;
    }

    /** Same for a maintenance plan aliased `p`. */
    async function planSignedSql(p = 'mp') {
        const cols = await columnsOf('maintenance_plans');
        if (cols.has('signed_at')) return `${p}.signed_at IS NOT NULL`;
        // No signed_at on plans: fall back to the plan's agreement signature.
        return `EXISTS (SELECT 1 FROM agreement_signatures sg2
                         WHERE sg2.agreement_id = ${p}.agreement_id)`;
    }

    app.get('/api/portal/dashboard', authenticatePortal, async (req, res) => {
        try {
            const clientId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;

            console.log('[DASHBOARD] Loading dashboard for client:', clientId);

            // Get invoices.
            //
            // `payable` is computed here rather than in the UI so there is ONE
            // definition of it. An invoice is payable only when the document
            // behind it is signed:
            //   * tied to an agreement  -> that agreement must be signed
            //   * tied to a maintenance plan -> that plan must be signed
            //   * tied to neither (an ad-hoc invoice) -> payable, nothing to sign
            //
            // Unpayable invoices are still returned so the customer can see
            // what's coming, but flagged so the UI shows "Awaiting signature"
            // instead of a Pay button, and excluded from the due-now count.
            const agSigned   = await agreementSignedSql('sa');
            const planSigned = await planSignedSql('mp');
            const invCols    = await columnsOf('invoices');
            // obligation only exists after migration 007.
            const obligation = invCols.has('obligation')
                ? `COALESCE(i.obligation,'due_now')` : `'due_now'`;

            const unsignedAgreement =
                `i.agreement_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM sales_agreements sa WHERE sa.id = i.agreement_id AND ${agSigned})`;
            const unsignedPlan =
                `i.maintenance_plan_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM maintenance_plans mp WHERE mp.id = i.maintenance_plan_id AND ${planSigned})`;

            let invoicesResult;
            try {
                invoicesResult = await pool.query(
                    `SELECT i.*,
                            CASE
                              WHEN i.status IN ('paid','void','cancelled','refunded','draft') THEN FALSE
                              WHEN ${unsignedAgreement} THEN FALSE
                              WHEN ${unsignedPlan} THEN FALSE
                              WHEN ${obligation} <> 'due_now' THEN FALSE
                              ELSE TRUE
                            END AS payable,
                            CASE
                              WHEN ${unsignedAgreement} THEN 'awaiting_signature'
                              WHEN ${unsignedPlan} THEN 'awaiting_signature'
                              WHEN ${obligation} = 'on_completion' THEN 'due_on_completion'
                              ELSE NULL
                            END AS hold_reason
                       FROM invoices i
                      WHERE i.lead_id = $1
                      ORDER BY i.created_at DESC`,
                    [clientId]
                );
            } catch (e) {
                // Never let the payable flag take the whole dashboard down. The
                // customer seeing their invoices matters more than the gate —
                // and the gate is enforced server-side on payment anyway.
                console.warn('[DASHBOARD] payable flag unavailable, falling back:', e.message);
                _resetSchemaCache();
                invoicesResult = await pool.query(
                    'SELECT * FROM invoices WHERE lead_id = $1 ORDER BY created_at DESC',
                    [clientId]
                );
            }

            // Get projects
            let projects = [];
            try {
                const projectsResult = await pool.query(`
                    SELECT cp.*,
                           (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id) as total_milestones,
                           (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id AND status = 'completed') as completed_milestones
                    FROM client_projects cp
                    WHERE cp.lead_id = $1
                    ORDER BY cp.created_at DESC
                `, [clientId]);
                projects = projectsResult.rows;
            } catch (e) {
                console.log('[WARNING] Project tables may not exist yet');
            }

            // Get support tickets
            let tickets = [];
            try {
                const ticketsResult = await pool.query(
                    'SELECT * FROM support_tickets WHERE lead_id = $1 ORDER BY created_at DESC',
                    [clientId]
                );
                tickets = ticketsResult.rows;
            } catch (e) {
                console.log('[WARNING] Support ticket tables may not exist yet');
            }

            // Get recent activity
            let activity = [];
            try {
                const activityResult = await pool.query(`
                    SELECT 'invoice' as type, id, created_at,
                           'Invoice #' || invoice_number || ' created' as description,
                           '' as details
                    FROM invoices WHERE lead_id = $1
                    ORDER BY created_at DESC LIMIT 10
                `, [clientId]);
                activity = activityResult.rows;
            } catch (e) {
                console.log('[WARNING] Could not load activity');
            }

            // Sales agreements for this customer (shown in the portal's "Sales Agreements" view).
            let salesAgreements = [];
            // Surfaced in the response so the portal can say "we couldn't load
            // your agreements" instead of "you have none" — those are very
            // different messages to show a customer.
            let saError = null;
            try {
                // Join the signature in, so the customer portal uses the SAME
                // definition of "signed" as the admin portal. Reading only
                // sales_agreements.status meant a row whose status update
                // didn't land showed "signed" to staff and "Review & sign" to
                // the customer — the same agreement, two answers.
                const saRes = await pool.query(
                    `SELECT sa.*,
                            COALESCE(sa.signed_at, sig.signed_at) AS signed_at,
                            CASE WHEN sig.id IS NOT NULL AND sa.status IN ('sent','draft')
                                 THEN 'signed' ELSE sa.status END AS status,
                            sig.signer_name
                       FROM sales_agreements sa
                       LEFT JOIN agreement_signatures sig ON sig.agreement_id = sa.id
                      WHERE sa.lead_id = $1
                      ORDER BY sa.created_at DESC`,
                    [clientId]
                );
                salesAgreements = saRes.rows;
            } catch (e) {
                // The JOIN needs agreement_signatures (migration 003). If that
                // table is absent the join throws, and the old catch swallowed
                // it and returned an EMPTY list — so every agreement silently
                // vanished from the customer's portal. Fall back to the plain
                // query rather than showing the customer nothing.
                console.warn('[PORTAL] agreement signature join failed, falling back:', e.message);
                try {
                    const plain = await pool.query(
                        'SELECT * FROM sales_agreements WHERE lead_id = $1 ORDER BY created_at DESC',
                        [clientId]
                    );
                    salesAgreements = plain.rows;
                } catch (e2) {
                    console.error('[PORTAL] sales_agreements unreadable:', e2.message);
                    saError = e2.message;
                }
            }

            res.json({
                success: true,
                dashboard: {
                    invoices: invoicesResult.rows,
                    projects,
                    salesAgreements,
                    salesAgreementsError: saError,
                    tickets,
                    activity
                }
            });

        } catch (error) {
            console.error('[ERROR] Dashboard error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to load dashboard'
            });
        }
    });

            app.get('/api/portal/sales-agreements/:id/pdf', authenticatePortal, async (req, res) => {
                try {
                    await ensurePortalSchema();
                    const leadId = await resolveLeadId(req.user.id, req.user.email);
                    const r = await pool.query('SELECT * FROM sales_agreements WHERE id = $1', [req.params.id]);
                    const a = r.rows[0];
                    if (!a || String(a.lead_id) !== String(leadId)) {
                        return res.status(404).json({ success: false, message: 'Agreement not found.' });
                    }
                    const pdf = await agreementPDFBuffer(a);
                    res.setHeader('Content-Type', 'application/pdf');
                    res.setHeader('Content-Disposition', `attachment; filename="Sales-Agreement-${a.agreement_number || a.id}.pdf"`);
                    res.send(pdf);
                } catch (e) {
                    console.error('[CLIENT SA PDF] error:', e.message);
                    res.status(500).json({ success: false, message: 'Could not generate the agreement PDF.' });
                }
            });


    // Milestones for one of the customer's projects.
    app.get('/api/portal/projects/:projectId/milestones', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email) || req.user.id;
            const owns = await pool.query(
                'SELECT id FROM client_projects WHERE id = $1 AND lead_id = $2',
                [req.params.projectId, leadId]
            );
            if (!owns.rows.length) {
                return res.status(404).json({ success: false, message: 'Project not found.' });
            }
            const r = await pool.query(
                'SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY COALESCE(due_date, created_at) ASC',
                [req.params.projectId]
            );
            res.json({ success: true, milestones: r.rows });
        } catch (e) {
            console.error('[PORTAL MILESTONES] error:', e.message);
            res.status(500).json({ success: false, message: 'Could not load milestones.' });
        }
    });

    console.log('[PORTAL] Diamondback customer portal routes mounted at /api/portal/*');
};