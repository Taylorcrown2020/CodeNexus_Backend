// ============================================================================
// diamondback-document-routes.js — Diamondback Coding
//
// Serves everything built by diamondback-documents.js, and owns the
// outstanding-balance rule the home screen uses.
//
// ROUTES
//   GET  /api/portal/sales-agreements/:id/document   full agreement, as HTML
//   GET  /api/portal/sales-agreements/:id/pdf        agreement PDF        (override)
//   GET  /api/admin/sales-agreements/:id/document    same, staff-side
//   GET  /api/admin/sales-agreements/:id/pdf         same, staff-side
//   GET  /api/portal/payments/:id/receipt            receipt PDF
//   GET  /api/portal/invoices/:id/receipt            receipt for a paid invoice
//   GET  /api/admin/payments/:id/receipt             receipt PDF, staff-side
//   GET  /api/portal/outstanding                     the home-screen figure
//
// MOUNT ORDER MATTERS. Express serves the FIRST matching route, so this module
// must be initialised BEFORE diamondback-portal.js for the /pdf override to
// take effect. See the note in server.js at the mount site.
// ============================================================================

const docs = require('./diamondback-documents.js');
// The outstanding figure has to be the REAL amount — base + tax + any credit
// card surcharge — or the home screen quotes one number and the card is charged
// another. Same engine the charge path uses.
const pricingEngine = require('./diamondback-pricing.js');
// Every unpaid period, not just the latest one. See the module header: a
// customer who missed six months owed six months and was shown one.
const arrears = require('./diamondback-arrears.js');

const {
    COMPANY, buildAgreementDocument, renderAgreementHTML, renderAgreementText,
    hashAgreement, agreementPDF, receiptPDF, money, prettyDate,
} = docs;

module.exports = function initDocumentRoutes({
    app,
    pool,
    authenticateToken,      // admin/staff
    authenticatePortal,     // customer portal
    resolveLeadId,
    CANCELLATION_NOTICE_DAYS = Number(process.env.CANCELLATION_NOTICE_DAYS || 30),
}) {

    // ------------------------------------------------------------------
    // Schema tolerance
    // ------------------------------------------------------------------
    // This database has repeatedly turned out to be missing columns that a
    // migration was supposed to add (see 010 for the signed_at saga). Rather
    // than 500 when a column is absent, every query here is written against
    // columns that are checked first.
    let _cols = null;
    async function columnsOf(table) {
        if (!_cols) _cols = {};
        if (_cols[table]) return _cols[table];
        try {
            const r = await pool.query(
                'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
            _cols[table] = new Set(r.rows.map((x) => x.column_name));
        } catch {
            _cols[table] = new Set();
        }
        return _cols[table];
    }

    async function safeRows(sql, params, label) {
        try {
            return (await pool.query(sql, params)).rows;
        } catch (e) {
            // A missing optional table is normal on an older database; say so
            // quietly and carry on with an empty list rather than failing the
            // whole document.
            console.warn(`[DOCUMENTS] ${label} unavailable:`, e.message);
            return [];
        }
    }

    /**
     * Load everything a document needs, in one place, so the HTML view, the PDF
     * and the signature snapshot are all built from identical inputs.
     */
    async function loadAgreementContext(agreementId) {
        const ag = (await pool.query('SELECT * FROM sales_agreements WHERE id = $1', [agreementId])).rows[0];
        if (!ag) return null;

        const items = await safeRows(
            'SELECT * FROM agreement_items WHERE agreement_id = $1 ORDER BY sort_order, id',
            [agreementId], 'agreement_items');

        const milestones = await safeRows(
            'SELECT * FROM agreement_milestones WHERE agreement_id = $1 ORDER BY sort_order, id',
            [agreementId], 'agreement_milestones');

        const plan = (await safeRows(
            'SELECT * FROM maintenance_plans WHERE agreement_id = $1 ORDER BY id DESC LIMIT 1',
            [agreementId], 'maintenance_plans'))[0] || null;

        // agreement_signatures is the authority on whether this is signed —
        // sales_agreements.status has been wrong often enough that it can't be
        // trusted alone.
        const sig = (await safeRows(
            'SELECT * FROM agreement_signatures WHERE agreement_id = $1 ORDER BY id DESC LIMIT 1',
            [agreementId], 'agreement_signatures'))[0] || null;

        if (sig) {
            ag.signed_at = ag.signed_at || sig.signed_at;
            ag.signature_name = ag.signature_name || sig.signer_name;
            if (ag.status !== 'signed') ag.status = 'signed';
        }

        return { agreement: ag, items, milestones, plan, signature: sig,
                 noticeDays: CANCELLATION_NOTICE_DAYS };
    }

    function buildFrom(ctx) {
        return buildAgreementDocument({
            agreement: ctx.agreement,
            items: ctx.items,
            milestones: ctx.milestones,
            plan: ctx.plan,
            noticeDays: ctx.noticeDays,
        });
    }

    async function assertOwned(req, agreement) {
        const leadId = await resolveLeadId(req.user.id, req.user.email);
        return agreement && String(agreement.lead_id) === String(leadId);
    }

    // ======================================================================
    // 1. THE FULL AGREEMENT, FOR THE SIGNING SCREEN
    // ======================================================================
    /**
     * Returns the ENTIRE document as ready-to-insert HTML, plus the metadata
     * the signing UI needs (autopay consent text, document hash, whether it is
     * already signed).
     *
     * The hash is returned so the front end can send it back with the
     * signature: that proves the customer signed THIS text and not a version
     * edited between the page loading and the button being pressed.
     */
    app.get('/api/portal/sales-agreements/:id/document', authenticatePortal, async (req, res) => {
        try {
            const ctx = await loadAgreementContext(req.params.id);
            if (!ctx || !(await assertOwned(req, ctx.agreement))) {
                return res.status(404).json({ success: false, message: 'Agreement not found.' });
            }
            const document = buildFrom(ctx);
            res.json({
                success: true,
                html: renderAgreementHTML(document),
                meta: document.meta,
                autopay: document.meta.autopay,
                autopayConsentText: document.autopayConsentText,
                documentHash: hashAgreement(document),
                pdfUrl: `/api/portal/sales-agreements/${ctx.agreement.id}/pdf`,
            });
        } catch (e) {
            console.error('[DOCUMENT VIEW]', e.message);
            res.status(500).json({ success: false, message: 'Could not load the agreement.' });
        }
    });

    // Staff-side equivalent, so you can read exactly what the customer sees.
    app.get('/api/admin/sales-agreements/:id/document', authenticateToken, async (req, res) => {
        try {
            const ctx = await loadAgreementContext(req.params.id);
            if (!ctx) return res.status(404).json({ success: false, message: 'Agreement not found.' });
            const document = buildFrom(ctx);
            res.json({
                success: true,
                html: renderAgreementHTML(document),
                text: renderAgreementText(document),
                meta: document.meta,
                documentHash: hashAgreement(document),
                // The stored snapshot from signing, when there is one. If the
                // hashes differ, the agreement was edited after signing — which
                // is exactly the thing you'd want to know about.
                signedHash: ctx.signature ? ctx.signature.document_hash : null,
                snapshotMatches: ctx.signature && ctx.signature.document_hash
                    ? ctx.signature.document_hash === hashAgreement(document)
                    : null,
                pdfUrl: `/api/admin/sales-agreements/${ctx.agreement.id}/pdf`,
            });
        } catch (e) {
            console.error('[ADMIN DOCUMENT VIEW]', e.message);
            res.status(500).json({ success: false, message: 'Could not load the agreement.' });
        }
    });

    // ======================================================================
    // 2. AGREEMENT PDF
    // ======================================================================
    // Overrides the older generator in diamondback-portal.js, which produced a
    // one-page summary with no legal terms on it at all — a document you could
    // not have enforced.
    async function sendAgreementPDF(res, ctx, disposition = 'attachment') {
        const document = buildFrom(ctx);
        const pdf = await agreementPDF(document);
        const name = `Agreement-${(ctx.agreement.agreement_number || ctx.agreement.id)}.pdf`
            .replace(/[^\w.\-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length);
        res.setHeader('Content-Disposition', `${disposition}; filename="${name}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.send(pdf);
    }

    app.get('/api/portal/sales-agreements/:id/pdf', authenticatePortal, async (req, res) => {
        try {
            const ctx = await loadAgreementContext(req.params.id);
            if (!ctx || !(await assertOwned(req, ctx.agreement))) {
                return res.status(404).json({ success: false, message: 'Agreement not found.' });
            }
            // ?inline=1 opens in the browser's viewer instead of downloading —
            // what the "View" control uses, versus "Download".
            await sendAgreementPDF(res, ctx, req.query.inline ? 'inline' : 'attachment');
        } catch (e) {
            console.error('[AGREEMENT PDF]', e.message);
            res.status(500).json({ success: false, message: 'Could not generate the agreement PDF.' });
        }
    });

    app.get('/api/admin/sales-agreements/:id/pdf', authenticateToken, async (req, res) => {
        try {
            const ctx = await loadAgreementContext(req.params.id);
            if (!ctx) return res.status(404).json({ success: false, message: 'Agreement not found.' });
            await sendAgreementPDF(res, ctx, req.query.inline ? 'inline' : 'attachment');
        } catch (e) {
            console.error('[ADMIN AGREEMENT PDF]', e.message);
            res.status(500).json({ success: false, message: 'Could not generate the agreement PDF.' });
        }
    });

    // ======================================================================
    // 3. RECEIPTS
    // ======================================================================
    /** Everything a receipt needs, from a payments row outward. */
    async function loadReceiptContext(paymentId) {
        const p = (await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId])).rows[0];
        if (!p) return null;

        const lead = p.lead_id
            ? (await safeRows('SELECT * FROM leads WHERE id = $1', [p.lead_id], 'leads'))[0] || {}
            : {};
        const invoice = p.invoice_id
            ? (await safeRows('SELECT * FROM invoices WHERE id = $1', [p.invoice_id], 'invoices'))[0] || null
            : null;
        const plan = p.maintenance_plan_id
            ? (await safeRows('SELECT * FROM maintenance_plans WHERE id = $1',
                              [p.maintenance_plan_id], 'maintenance_plans'))[0] || null
            : null;
        const refunds = await safeRows(
            'SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at', [paymentId], 'refunds');

        return { payment: p, lead, invoice, plan, refunds };
    }

    async function sendReceipt(res, ctx, disposition = 'attachment') {
        const pdf = await receiptPDF(ctx);
        // Named for what it is — "Receipt-Monthly-Maintenance-Cancellation-
        // RCPT-INV000016.pdf" — so the saved file is identifiable in a
        // downloads folder without opening it.
        const filename = docs.receiptFilename(ctx.payment, ctx.plan, ctx.invoice);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length);
        res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.send(pdf);
    }

    app.get('/api/portal/payments/:id/receipt', authenticatePortal, async (req, res) => {
        try {
            const ctx = await loadReceiptContext(req.params.id);
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            if (!ctx || String(ctx.payment.lead_id) !== String(leadId)) {
                return res.status(404).json({ success: false, message: 'Receipt not found.' });
            }
            // A failed charge has no receipt to give. Saying so plainly beats
            // handing over a PDF that says a payment was received when it wasn't.
            if (ctx.payment.status === 'failed') {
                return res.status(409).json({
                    success: false,
                    message: 'That payment did not go through, so there is no receipt for it.',
                });
            }
            await sendReceipt(res, ctx, req.query.inline ? 'inline' : 'attachment');
        } catch (e) {
            console.error('[RECEIPT PDF]', e.message);
            res.status(500).json({ success: false, message: 'Could not generate the receipt.' });
        }
    });

    /**
     * Receipt by INVOICE, because that's how a customer thinks about it — they
     * remember the invoice they paid, not the internal payment id.
     */
    app.get('/api/portal/invoices/:id/receipt', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            const pay = (await pool.query(
                `SELECT id FROM payments
                  WHERE invoice_id = $1 AND lead_id = $2 AND status <> 'failed'
                  ORDER BY paid_at DESC LIMIT 1`,
                [req.params.id, leadId])).rows[0];
            if (!pay) {
                return res.status(404).json({
                    success: false,
                    message: 'No payment has been recorded against that invoice yet.',
                });
            }
            const ctx = await loadReceiptContext(pay.id);
            await sendReceipt(res, ctx, req.query.inline ? 'inline' : 'attachment');
        } catch (e) {
            console.error('[INVOICE RECEIPT PDF]', e.message);
            res.status(500).json({ success: false, message: 'Could not generate the receipt.' });
        }
    });

    app.get('/api/admin/payments/:id/receipt', authenticateToken, async (req, res) => {
        try {
            const ctx = await loadReceiptContext(req.params.id);
            if (!ctx) return res.status(404).json({ success: false, message: 'Receipt not found.' });
            await sendReceipt(res, ctx, req.query.inline ? 'inline' : 'attachment');
        } catch (e) {
            console.error('[ADMIN RECEIPT PDF]', e.message);
            res.status(500).json({ success: false, message: 'Could not generate the receipt.' });
        }
    });

    // ======================================================================
    // 4. OUTSTANDING — what the home screen shows
    // ======================================================================
    /**
     * THE RULE, stated once so nothing has to re-derive it:
     *
     *   MONTHLY recurring plans are OUTSTANDING as soon as their current period
     *   opens, whether or not the charge date has passed. A monthly plan is a
     *   commitment for the month you are in; showing it only once it is late is
     *   how a customer gets surprised by a charge.
     *
     *   ANNUAL plans are NOT outstanding. They sit in Billing as "upcoming" and
     *   are charged on their renewal date. Twelve months of a domain renewal
     *   parked on the home screen is noise, not information.
     *
     *   INVOICES follow the existing rule from migration 007: due_now counts,
     *   on_completion does not, and nothing counts against an unsigned document.
     *
     * Both figures are returned. The home screen shows `dueNow`; the billing
     * screen shows `dueNow` plus `upcomingAnnual`.
     */
    async function outstandingFor(leadId) {
        const planCols = await columnsOf('maintenance_plans');
        const invCols  = await columnsOf('invoices');

        const hasPeriod = planCols.has('current_period_start') && planCols.has('current_period_paid_at');
        const hasInterval = planCols.has('interval_unit');
        const hasSignedAt = planCols.has('signed_at');

        // ---- recurring plans ----------------------------------------------
        // Nothing is outstanding against an unsigned plan. That rule is already
        // enforced elsewhere for invoices; it applies here too.
        // A provisional signature still owes: they typed their name, the first
        // payment date passed, and no card arrived. Excluding those would make
        // signing-and-stalling cost nothing.
        // A plan whose first payment date has passed owes, signed or not —
        // otherwise ignoring the agreement is the cheapest option available.
        // LATE_FEES_REQUIRE_SIGNATURE=on restricts it to signed plans.
        const hasProvisional = planCols.has('provisional_signed_at');
        const requireSig = String(process.env.LATE_FEES_REQUIRE_SIGNATURE || '').toLowerCase() === 'on';
        const signedClause = (!requireSig || !hasSignedAt) ? 'TRUE'
            : hasProvisional
                ? '(mp.signed_at IS NOT NULL OR mp.provisional_signed_at IS NOT NULL)'
                : 'mp.signed_at IS NOT NULL';
        const intervalCol  = hasInterval ? "COALESCE(mp.interval_unit,'month')" : "'month'";
        const periodClause = hasPeriod
            ? 'mp.current_period_paid_at IS NULL'
            // Fallback for a database where 011 hasn't run: treat the period as
            // unpaid if no successful payment landed on/after the charge date.
            : `NOT EXISTS (SELECT 1 FROM payments pay
                            WHERE pay.maintenance_plan_id = mp.id
                              AND pay.status = 'succeeded'
                              AND pay.paid_at::date >= COALESCE(mp.next_charge_date, CURRENT_DATE))`;
        const periodStart = hasPeriod
            ? 'COALESCE(mp.current_period_start, mp.billing_start_date, mp.next_charge_date)'
            : 'COALESCE(mp.billing_start_date, mp.next_charge_date)';

        // A plan winding down has a cancellation date. Anything falling due ON
        // OR AFTER that date is never charged, so it must not be shown as
        // outstanding — see the filter below. Joined here rather than fetched
        // separately so a plan and its end date can't disagree.
        const plans = await safeRows(
            `SELECT mp.id, mp.label, mp.plan_type, mp.amount, mp.status,
                    mp.next_charge_date, ${intervalCol} AS interval_unit,
                    ${periodStart} AS period_start,
                    (${periodClause}) AS period_unpaid,
                    pc.effective_at AS cancels_at,
                    mp.tax_rate, mp.processing_fee_pct, mp.pricing_effective_from,
                    -- The method this plan will actually be charged on. The
                    -- processing fee is credit-card-only, so the amount owed
                    -- cannot be known without it.
                    pmeth.type AS pm_type, pmeth.funding AS pm_funding
               FROM maintenance_plans mp
               LEFT JOIN plan_cancellations pc
                      ON pc.maintenance_plan_id = mp.id AND pc.status = 'pending'
               LEFT JOIN leads l ON l.id = mp.lead_id
               LEFT JOIN payment_methods pmeth
                      ON pmeth.id = COALESCE(mp.payment_method_id, l.default_payment_method_id)
                     AND pmeth.status = 'active'
              WHERE mp.lead_id = $1
                AND mp.status IN ('active','past_due','pending_cancellation',
                                  'pending_payment_method','pending_signature')
                AND ${signedClause}
              ORDER BY mp.next_charge_date NULLS LAST, mp.id`,
            [leadId], 'maintenance_plans');

        const monthlyDue = [];
        const annualUpcoming = [];

        const today = new Date(); today.setHours(0, 0, 0, 0);

        plans.forEach((p) => {
            // NOT p.amount. That is the base rate before sales tax and before
            // the credit card processing fee — quoting it as the balance means
            // the customer sees $450.00 and gets charged $501.74.
            const method = p.pm_type ? { type: p.pm_type, funding: p.pm_funding } : null;
            const price = pricingEngine.priceFor(p, method);
            const amount = price.total;
            const cancelsAt = p.cancels_at ? new Date(p.cancels_at) : null;
            const dueDate = p.next_charge_date ? new Date(p.next_charge_date) : null;

            // ------------------------------------------------------------
            // A CANCELLED PLAN STOPS OWING AT ITS CANCELLATION DATE.
            //
            // The cancellation terms say charges falling due WITHIN the notice
            // window remain payable — so a charge dated before the end date
            // still counts. A charge dated on or after it never happens, and
            // showing it as outstanding bills someone for a month of service
            // they will not receive.
            //
            // Without this, pressing Cancel left next month's amount sitting in
            // the balance, and the settlement quote would ask them to pay it
            // before the cancellation could complete.
            // ------------------------------------------------------------
            const endsBeforeCharge = !!(cancelsAt && dueDate && dueDate >= cancelsAt);

            const entry = {
                kind: 'plan',
                planId: p.id,
                label: p.label,
                planType: p.plan_type,
                interval: p.interval_unit,
                amount,
                periodStart: p.period_start,
                dueDate: p.next_charge_date,
                dueDateLabel: prettyDate(p.next_charge_date),
                autopay: true,
                status: p.status,
                cancelsAt: p.cancels_at || null,
                cancelsAtLabel: prettyDate(p.cancels_at),
                // So the portal can show WHY the figure is what it is, rather
                // than a total the customer can't reconcile against the rate
                // they signed for.
                baseAmount: price.base,
                tax: price.tax,
                processingFee: price.fee,
                feeApplies: price.feeApplies,
                breakdown: price.lines,
                feeNote: pricingEngine.feeExplanation(price),
            };

            if (p.interval_unit === 'year') {
                if (endsBeforeCharge) return;

                // A renewal that has ALREADY COME AND GONE unpaid is not
                // "upcoming" — it is a debt, and it belongs in the balance
                // like any other. Only a genuinely future renewal stays
                // informational. Missing this meant an unpaid year sat quietly
                // in the Billing tab and never appeared as money owed.
                const owedY = arrears.arrearsFor(p, amount);
                if (p.period_unpaid && owedY.periodsMissed > 0 && amount > 0) {
                    monthlyDue.push({
                        ...entry,
                        outstanding: true,
                        overdue: true,
                        amount: owedY.total,
                        periodsOwed: owedY.periodsMissed,
                        perPeriod: amount,
                        arrearsLabel: arrears.arrearsLabel(p, owedY),
                        unpaidPeriods: owedY.periods,
                        isAnnualArrears: true,
                    });
                    return;
                }
                annualUpcoming.push({ ...entry, outstanding: false });
                return;
            }

            if (!p.period_unpaid) return;

            // Not billed, so not owed.
            if (endsBeforeCharge) return;

            // A ZERO-AMOUNT PLAN STILL SHOWS WHEN IT IS OVERDUE.
            //
            // Dropping it entirely was wrong: a $0.00 plan past its due date
            // disappeared from the balance completely, so there was no sign
            // anything was late — the customer and the admin both saw nothing.
            //
            // It owes $0.00, and 1.5% of $0.00 is $0.00, so no money is
            // invented. But it appears as an overdue line so the state is
            // visible, which is what a $0 test plan needs to be useful.
            const zeroAmount = amount <= 0;
            if (zeroAmount && !(dueDate && dueDate < today)) return;   // not due yet: hide it

            // EVERY unpaid period, not just this one. Missing three months has
            // to read as three months of money, or the balance quietly
            // under-states the debt and never catches up.
            const owed = arrears.arrearsFor(p, amount);
            const missed = Math.max(1, owed.periodsMissed);

            monthlyDue.push({
                ...entry,
                outstanding: true,
                zeroAmount,
                zeroNote: zeroAmount
                    ? 'This plan is set to $0.00, so nothing is charged and no late fee applies. '
                    + 'Set a price on the plan if it should be billing.'
                    : null,
                // Distinguishes "this month isn't paid yet" from "this is
                // late", so the UI can word it without alarming anyone.
                overdue: !!(dueDate && dueDate < today),
                // The full arrears, so one line can show "3 months owed".
                amount: missed > 1 ? owed.total : amount,
                periodsOwed: missed,
                perPeriod: amount,
                arrearsLabel: arrears.arrearsLabel(p, owed),
                unpaidPeriods: owed.periods,
                arrearsCapped: !!owed.capped,
            });
        });

        // ---- invoices -------------------------------------------------------
        const obligation = invCols.has('obligation') ? "COALESCE(i.obligation,'due_now')" : "'due_now'";
        const invoices = await safeRows(
            `SELECT i.id, i.invoice_number, i.total_amount, i.due_date, i.status,
                    ${obligation} AS obligation
               FROM invoices i
              WHERE i.lead_id = $1
                AND i.status NOT IN ('paid','void','cancelled','refunded','draft')
                AND ${obligation} = 'due_now'
                AND (i.agreement_id IS NULL OR EXISTS (
                      SELECT 1 FROM sales_agreements sa
                       WHERE sa.id = i.agreement_id
                         AND (sa.signed_at IS NOT NULL OR sa.status = 'signed')))
              ORDER BY i.due_date NULLS LAST, i.id`,
            [leadId], 'invoices');

        const invoiceDue = invoices.map((i) => ({
            kind: 'invoice',
            invoiceId: i.id,
            label: `Invoice ${i.invoice_number}`,
            number: i.invoice_number,
            amount: Number(i.total_amount || 0),
            dueDate: i.due_date,
            dueDateLabel: prettyDate(i.due_date),
            outstanding: true,
            overdue: !!(i.due_date && new Date(i.due_date) < new Date()),
            autopay: false,
        }));

        // ---- late fees ------------------------------------------------------
        // A fee only exists once something was genuinely LATE, so it is always
        // due now. It shows on the customer's dashboard as its own line rather
        // than being folded into the plan amount, so they can see exactly what
        // the extra money is and why.
        const feeRows = await safeRows(
            `SELECT lf.id, lf.amount, lf.rate, lf.base_amount, lf.due_date, lf.notes,
                    i.invoice_number, mp.label AS plan_label
               FROM late_fees lf
               LEFT JOIN invoices i ON i.id = lf.invoice_id
               LEFT JOIN maintenance_plans mp ON mp.id = lf.maintenance_plan_id
              WHERE lf.lead_id = $1 AND lf.status = 'outstanding'
              ORDER BY lf.due_date, lf.id`,
            [leadId], 'late_fees');

        const lateFeeItems = feeRows.map((f) => ({
            kind: 'late_fee',
            feeId: f.id,
            label: f.plan_label ? `Late fee — ${f.plan_label}`
                 : f.invoice_number ? `Late fee — invoice ${f.invoice_number}`
                 : 'Late fee',
            amount: Number(f.amount || 0),
            rate: Number(f.rate || 0),
            baseAmount: Number(f.base_amount || 0),
            dueDate: f.due_date,
            dueDateLabel: prettyDate(f.due_date),
            outstanding: true,
            overdue: true,          // by definition
            autopay: false,
            note: `${(Number(f.rate || 0) * 100).toFixed(2).replace(/\.?0+$/, '')}% of `
                + `${money(f.base_amount)}, applied because the payment due `
                + `${prettyDate(f.due_date) || 'earlier'} was not received on time.`,
        }));

        const dueNow = [...monthlyDue, ...invoiceDue, ...lateFeeItems];
        const total = dueNow.reduce((s, x) => s + x.amount, 0);
        const lateFeeTotal = Math.round(
            lateFeeItems.reduce((s, x) => s + x.amount, 0) * 100) / 100;

        return {
            // What the home screen shows.
            dueNow,
            total: Math.round(total * 100) / 100,
            totalLabel: money(total),
            count: dueNow.length,
            overdueCount: dueNow.filter((x) => x.overdue).length,
            lateFees: lateFeeItems,
            lateFeeTotal,
            // The customer-facing version of "caught up": nothing LATE. Money
            // owed but not yet due does not count against them.
            anythingLate: dueNow.some((x) => x.overdue),
            // Billing screen only. Never added into `total`.
            upcomingAnnual: annualUpcoming,
            upcomingAnnualTotal: Math.round(
                annualUpcoming.reduce((s, x) => s + x.amount, 0) * 100) / 100,
            // Stated in the payload so the UI copy and this rule can't diverge.
            rule: 'Every unpaid period counts, not just the most recent one. Late fees are '
                + '1.5% per missed month and 3% per missed year. '
                + 'Monthly plans count as outstanding for the current period even before the '
                + 'charge date. Annual plans are shown under Billing and charged on their renewal '
                + 'date. A plan with a cancellation in progress stops counting from its '
                + 'cancellation date, because nothing is charged on or after it.',
        };
    }

    app.get('/api/portal/outstanding', authenticatePortal, async (req, res) => {
        try {
            const leadId = await resolveLeadId(req.user.id, req.user.email);
            res.json({ success: true, outstanding: await outstandingFor(leadId) });
        } catch (e) {
            console.error('[OUTSTANDING]', e.message);
            res.status(500).json({ success: false, message: 'Could not load your balance.' });
        }
    });

    // Staff-side: the same figure for any customer, so the admin portal and the
    // customer portal can never quote different numbers at each other.
    app.get('/api/admin/customers/:leadId/outstanding', authenticateToken, async (req, res) => {
        try {
            res.json({ success: true, outstanding: await outstandingFor(req.params.leadId) });
        } catch (e) {
            console.error('[ADMIN OUTSTANDING]', e.message);
            res.status(500).json({ success: false, message: 'Could not load the balance.' });
        }
    });

    // Exposed so the lifecycle module can settle a period after a successful
    // charge without duplicating the rule.
    async function markPeriodPaid(planId, paidAt = new Date()) {
        const cols = await columnsOf('maintenance_plans');
        if (!cols.has('current_period_paid_at')) return;
        await pool.query(
            'UPDATE maintenance_plans SET current_period_paid_at = $2, updated_at = NOW() WHERE id = $1',
            [planId, paidAt]).catch((e) => console.warn('[DOCUMENTS] markPeriodPaid:', e.message));
    }

    /** Open the next period after a charge — this is what makes next month show up. */
    async function openNextPeriod(planId, periodStart) {
        const cols = await columnsOf('maintenance_plans');
        if (!cols.has('current_period_start')) return;
        await pool.query(
            `UPDATE maintenance_plans
                SET current_period_start = $2, current_period_paid_at = NULL, updated_at = NOW()
              WHERE id = $1`,
            [planId, periodStart]).catch((e) => console.warn('[DOCUMENTS] openNextPeriod:', e.message));
    }

    console.log(`[DOCUMENTS] Document + receipt routes mounted. Business address: ${COMPANY.addressOneLine}`);

    return { outstandingFor, markPeriodPaid, openNextPeriod, loadAgreementContext, buildFrom };
};