// ============================================================================
// diamondback-admin-accounts.js — Diamondback Coding
//
// The admin-side view of a single customer: everything about them on one
// screen, and the controls to act on it.
//
//   GET   /api/admin/accounts/:leadId              the whole account
//   POST  /api/admin/late-fees/assess              charge fees that are due
//   POST  /api/admin/late-fees/:id/waive           drop one fee
//   POST  /api/admin/accounts/:leadId/waive-fees   drop all of them
//   POST  /api/admin/accounts/:leadId/late-exempt  never charge this customer
//   POST  /api/admin/accounts/:leadId/welcome      resend the portal welcome
//   POST  /api/admin/accounts/:leadId/default-method  change their card
//   GET   /api/admin/accounts                      list, with standing
//
// THE STANDING RULE, which the whole screen hangs off:
//   CAUGHT UP means nothing is LATE. A monthly plan that is unpaid but not yet
//   due is normal and does not count against the customer. Only a missed due
//   date does. See diamondback-late-fees.js.
// ============================================================================

module.exports = function initAdminAccounts({
    app, pool, authenticateToken, lateFees, notify, PORTAL_URL,
}) {

    const money = (n) => Number(n || 0);

    /** Optional tables/columns differ across databases — never 500 over one. */
    async function safe(sql, params, label, fallback = []) {
        try {
            return (await pool.query(sql, params)).rows;
        } catch (e) {
            console.warn(`[ADMIN ACCOUNT] ${label}:`, e.message);
            return fallback;
        }
    }

    // ======================================================================
    // The whole account
    // ======================================================================
    app.get('/api/admin/accounts/:leadId', authenticateToken, async (req, res) => {
        const leadId = req.params.leadId;
        try {
            const lead = (await pool.query(
                `SELECT id, name, email, phone, company, address, status, portal_kind,
                        client_password IS NOT NULL AS has_portal_login,
                        portal_last_login, default_payment_method_id,
                        COALESCE(late_fees_exempt, FALSE) AS late_fees_exempt,
                        portal_welcome_sent_at, COALESCE(portal_welcome_count,0) AS portal_welcome_count,
                        created_at
                   FROM leads WHERE id = $1`, [leadId])).rows[0];
            if (!lead) return res.status(404).json({ success: false, message: 'Customer not found.' });

            // Charge anything that has genuinely fallen late before we read, so
            // the figure on screen is current rather than waiting on a nightly
            // job. Cheap — it writes nothing in the normal case.
            await lateFees.assessLateFees({ leadId }).catch(() => {});

            const standing = await lateFees.accountStanding(leadId);

            // ---- plans, split by cadence -----------------------------------
            const plans = await safe(
                `SELECT mp.*, pc.effective_at AS cancels_at,
                        pm.brand, pm.last4, pm.type AS method_type, pm.funding,
                        (SELECT COALESCE(SUM(amount),0) FROM payments
                          WHERE maintenance_plan_id = mp.id AND status='succeeded') AS collected,
                        (SELECT COUNT(*) FROM payments
                          WHERE maintenance_plan_id = mp.id AND status='succeeded') AS charges
                   FROM maintenance_plans mp
                   LEFT JOIN plan_cancellations pc
                          ON pc.maintenance_plan_id = mp.id AND pc.status='pending'
                   LEFT JOIN payment_methods pm
                          ON pm.id = COALESCE(mp.payment_method_id, $2)
                  WHERE mp.lead_id = $1
                  ORDER BY mp.status, mp.next_charge_date NULLS LAST`,
                [leadId, lead.default_payment_method_id], 'plans');

            /**
             * Where this plan is in its life. The admin's first question is
             * "what stage are they at", and status alone doesn't answer it —
             * 'pending_payment_method' and 'active but never charged' are very
             * different situations.
             */
            const stageOf = (p) => {
                if (p.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled', tone: 'grey' };
                if (p.cancels_at) return { key: 'cancelling', label: 'Cancelling', tone: 'warn' };
                if (!p.signed_at) return { key: 'awaiting_signature', label: 'Awaiting signature', tone: 'warn' };
                if (!p.payment_method_id && !lead.default_payment_method_id) {
                    return { key: 'awaiting_method', label: 'No payment method', tone: 'bad' };
                }
                if (lateFees.isPastDue(p.next_charge_date) && !p.current_period_paid_at) {
                    return { key: 'past_due', label: 'Past due', tone: 'bad' };
                }
                if (!Number(p.charges)) return { key: 'ready', label: 'Ready — not yet charged', tone: 'ok' };
                if (!p.current_period_paid_at) {
                    return { key: 'due_soon', label: 'This period unpaid', tone: 'ok' };
                }
                return { key: 'current', label: 'Paid up', tone: 'good' };
            };

            const shaped = plans.map((p) => ({
                ...p,
                stage: stageOf(p),
                is_annual: p.interval_unit === 'year',
                period_paid: !!p.current_period_paid_at,
                past_due: lateFees.isPastDue(p.next_charge_date) && !p.current_period_paid_at,
                days_late: p.current_period_paid_at ? 0 : lateFees.daysLate(p.next_charge_date),
                has_method: !!(p.payment_method_id || lead.default_payment_method_id),
            }));

            const invoices = await safe(
                `SELECT id, invoice_number, short_description, total_amount, status,
                        due_date, paid_at, obligation, maintenance_plan_id, agreement_id,
                        COALESCE(late_fee_amount,0) AS late_fee_amount, created_at
                   FROM invoices WHERE lead_id = $1 ORDER BY created_at DESC`,
                [leadId], 'invoices');

            const payments = await safe(
                `SELECT p.id, p.amount, p.status, p.kind, p.description, p.receipt_number,
                        p.method, p.method_brand, p.method_last4, p.paid_at,
                        COALESCE(p.base_amount,p.amount) AS base_amount,
                        COALESCE(p.tax_amount,0) AS tax_amount,
                        COALESCE(p.processing_fee,0) AS processing_fee,
                        COALESCE(p.refunded_amount,0) AS refunded_amount,
                        i.invoice_number
                   FROM payments p
                   LEFT JOIN invoices i ON i.id = p.invoice_id
                  WHERE p.lead_id = $1 ORDER BY p.paid_at DESC NULLS LAST, p.id DESC`,
                [leadId], 'payments');

            const agreements = await safe(
                `SELECT id, agreement_number, agreement_kind, package_name, service_type,
                        price, status, signed_at, signature_name, created_at
                   FROM sales_agreements WHERE lead_id = $1 ORDER BY created_at DESC`,
                [leadId], 'agreements');

            const projects = await safe(
                `SELECT id, name, status, progress, created_at
                   FROM client_projects WHERE lead_id = $1 ORDER BY created_at DESC`,
                [leadId], 'projects');

            const methods = await safe(
                `SELECT id, type, brand, last4, funding, exp_month, exp_year, bank_name,
                        status, is_default
                   FROM payment_methods
                  WHERE lead_id = $1 AND status = 'active' ORDER BY id DESC`,
                [leadId], 'payment methods');

            const requests = await safe(
                `SELECT id, service_type, project, status, preferred_date, created_at
                   FROM service_requests WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 20`,
                [leadId], 'service requests');

            // ---- money ------------------------------------------------------
            const openInvoices = invoices.filter(
                (i) => !['paid', 'void', 'cancelled', 'refunded', 'draft'].includes(i.status));
            const dueNowInvoices = openInvoices.filter(
                (i) => (i.obligation || 'due_now') === 'due_now');

            const totals = {
                collected: payments.filter((p) => p.status === 'succeeded')
                    .reduce((s, p) => s + money(p.amount), 0),
                refunded: payments.reduce((s, p) => s + money(p.refunded_amount), 0),
                // Owed but NOT necessarily late.
                outstandingInvoices: dueNowInvoices.reduce((s, i) => s + money(i.total_amount), 0),
                onCompletion: openInvoices.filter((i) => i.obligation === 'on_completion')
                    .reduce((s, i) => s + money(i.total_amount), 0),
                unpaidPlanPeriods: shaped
                    .filter((p) => !p.period_paid && !p.is_annual
                                && ['active', 'past_due', 'pending_cancellation'].includes(p.status))
                    .reduce((s, p) => s + money(p.charge_total != null ? p.charge_total : p.amount), 0),
                lateFees: standing.lateFeeTotal,
            };
            totals.outstanding = Math.round(
                (totals.outstandingInvoices + totals.unpaidPlanPeriods + totals.lateFees) * 100) / 100;

            res.json({
                success: true,
                lead,
                standing,          // caughtUp, lateItems, lateFees, lateTotal
                plans: {
                    monthly: shaped.filter((p) => !p.is_annual),
                    annual: shaped.filter((p) => p.is_annual),
                    all: shaped,
                },
                invoices,
                openInvoices,
                payments,
                agreements,
                unsignedAgreements: agreements.filter(
                    (a) => !a.signed_at && ['sent', 'draft'].includes(a.status)),
                projects,
                paymentMethods: methods,
                serviceRequests: requests,
                totals,
            });
        } catch (e) {
            console.error('[ADMIN ACCOUNT]', e.message);
            res.status(500).json({ success: false, message: 'Could not load that account.' });
        }
    });

    // ======================================================================
    // Account list, with standing — so the maintenance screen can show who is
    // actually behind without opening each one.
    // ======================================================================
    app.get('/api/admin/accounts', authenticateToken, async (req, res) => {
        try {
            await lateFees.assessLateFees({}).catch(() => {});
            const rows = await safe(
                `SELECT l.id, l.name, l.email, l.company,
                        (SELECT COUNT(*) FROM maintenance_plans mp
                          WHERE mp.lead_id=l.id AND mp.status IN ('active','past_due','pending_cancellation')) AS live_plans,
                        (SELECT COALESCE(SUM(lf.amount),0) FROM late_fees lf
                          WHERE lf.lead_id=l.id AND lf.status='outstanding') AS late_fee_total,
                        (SELECT COALESCE(SUM(p.amount),0) FROM payments p
                          WHERE p.lead_id=l.id AND p.status='succeeded') AS collected
                   FROM leads l
                  WHERE EXISTS (SELECT 1 FROM maintenance_plans mp WHERE mp.lead_id=l.id)
                     OR EXISTS (SELECT 1 FROM invoices i WHERE i.lead_id=l.id)
                  ORDER BY l.name`, [], 'accounts');

            const accounts = [];
            for (const r of rows) {
                const st = await lateFees.accountStanding(r.id);
                accounts.push({ ...r, caughtUp: st.caughtUp, lateCount: st.lateCount,
                                lateTotal: st.lateTotal, worstDaysLate: st.worstDaysLate });
            }
            res.json({
                success: true, accounts,
                summary: {
                    total: accounts.length,
                    behind: accounts.filter((a) => !a.caughtUp).length,
                    lateFeeTotal: Math.round(
                        accounts.reduce((s, a) => s + Number(a.late_fee_total || 0), 0) * 100) / 100,
                },
            });
        } catch (e) {
            console.error('[ADMIN ACCOUNTS]', e.message);
            res.status(500).json({ success: false, message: 'Could not load accounts.' });
        }
    });

    // ======================================================================
    // Late fees
    // ======================================================================
    app.post('/api/admin/late-fees/assess', authenticateToken, async (req, res) => {
        try {
            const created = await lateFees.assessLateFees({
                leadId: (req.body || {}).leadId || null });
            res.json({ success: true, created: created.length, fees: created });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    app.post('/api/admin/late-fees/:id/waive', authenticateToken, async (req, res) => {
        try {
            const fee = await lateFees.waiveFee({
                feeId: req.params.id,
                waivedBy: req.user && (req.user.email || req.user.username || 'admin'),
                reason: (req.body || {}).reason,
            });
            if (!fee) {
                return res.status(404).json({
                    success: false,
                    message: 'That fee was not found, or it has already been waived or paid.',
                });
            }
            res.json({ success: true, fee, message: `Late fee of $${Number(fee.amount).toFixed(2)} dropped.` });
        } catch (e) {
            console.error('[WAIVE FEE]', e.message);
            res.status(500).json({ success: false, message: 'Could not drop that fee.' });
        }
    });

    app.post('/api/admin/accounts/:leadId/waive-fees', authenticateToken, async (req, res) => {
        try {
            const fees = await lateFees.waiveAllForLead({
                leadId: req.params.leadId,
                waivedBy: req.user && (req.user.email || req.user.username || 'admin'),
                reason: (req.body || {}).reason || 'Waived from the admin portal',
            });
            const total = fees.reduce((s, f) => s + Number(f.amount || 0), 0);
            res.json({
                success: true, waived: fees.length, total,
                message: fees.length
                    ? `${fees.length} late fee(s) dropped, totalling $${total.toFixed(2)}.`
                    : 'There were no outstanding late fees to drop.',
            });
        } catch (e) {
            console.error('[WAIVE FEES]', e.message);
            res.status(500).json({ success: false, message: 'Could not drop those fees.' });
        }
    });

    /** Exempt a customer from late fees entirely, or put them back on. */
    app.post('/api/admin/accounts/:leadId/late-exempt', authenticateToken, async (req, res) => {
        try {
            const exempt = !!(req.body || {}).exempt;
            await pool.query(
                'UPDATE leads SET late_fees_exempt = $2 WHERE id = $1', [req.params.leadId, exempt]);
            res.json({
                success: true, exempt,
                message: exempt
                    ? 'This customer will no longer be charged late fees.'
                    : 'Late fees are back on for this customer.',
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // ======================================================================
    // Resend the portal welcome
    // ======================================================================
    app.post('/api/admin/accounts/:leadId/welcome', authenticateToken, async (req, res) => {
        try {
            const lead = (await pool.query(
                `SELECT id, name, email, portal_kind,
                        client_password IS NOT NULL AS has_login,
                        COALESCE(portal_welcome_count,0) AS sent_count
                   FROM leads WHERE id = $1`, [req.params.leadId])).rows[0];
            if (!lead) return res.status(404).json({ success: false, message: 'Customer not found.' });
            if (!lead.email) {
                return res.status(400).json({ success: false, message: 'That customer has no email address.' });
            }

            // A customer whose portal_kind is 'crm' cannot sign in to the
            // customer portal at all, so a welcome would send them to a login
            // that rejects them. Say so rather than sending it.
            if (lead.portal_kind === 'crm') {
                return res.status(400).json({
                    success: false,
                    message: 'This account is set to CRM access only. Change it to Customer or Both '
                           + 'before sending a portal welcome.',
                });
            }

            const setUp = !lead.has_login;
            await notify({
                lead,
                kind: 'portal_welcome',
                subject: setUp
                    ? `Set up your ${'Diamondback Coding'} customer portal`
                    : `Your ${'Diamondback Coding'} customer portal`,
                bodyHtml:
                    `<p style="margin:0 0 12px">Hi ${lead.name || 'there'},</p>` +
                    `<p style="margin:0 0 12px">Your customer portal is where you can see invoices, ` +
                    `receipts, agreements, project progress and your plans, and where you can pay or ` +
                    `update your payment method.</p>` +
                    (setUp
                        ? `<p style="margin:0 0 12px">Use <strong>Forgot password</strong> on the sign-in ` +
                          `page to set your password the first time — it will email you a link.</p>`
                        : `<p style="margin:0 0 12px">Sign in with your email address. If you have ` +
                          `forgotten your password, use <strong>Forgot password</strong> on the sign-in page.</p>`) +
                    `<p style="margin:0 0 12px">Any questions, just reply to this email.</p>`,
                cta: { url: PORTAL_URL, label: 'Open your portal' },
            });

            await pool.query(
                `UPDATE leads
                    SET portal_welcome_sent_at = NOW(),
                        portal_welcome_count = COALESCE(portal_welcome_count,0) + 1
                  WHERE id = $1`, [lead.id]).catch(() => {});

            res.json({
                success: true,
                message: `Welcome email sent to ${lead.email}.`
                       + (lead.sent_count ? ` (Sent ${lead.sent_count + 1} times in total.)` : ''),
            });
        } catch (e) {
            console.error('[WELCOME]', e.message);
            res.status(500).json({ success: false, message: 'Could not send the welcome email.' });
        }
    });

    // ======================================================================
    // Change which saved method a customer is billed on
    // ======================================================================
    // Deliberately only switches between methods the customer has already
    // added. Staff cannot type in a card number — that would put raw card data
    // through this server and take the whole platform out of PCI SAQ-A scope.
    app.post('/api/admin/accounts/:leadId/default-method', authenticateToken, async (req, res) => {
        try {
            const { paymentMethodId } = req.body || {};
            const pm = (await pool.query(
                `SELECT id, brand, last4, type FROM payment_methods
                  WHERE id=$1 AND lead_id=$2 AND status='active'`,
                [paymentMethodId, req.params.leadId])).rows[0];
            if (!pm) {
                return res.status(400).json({
                    success: false,
                    message: 'That payment method is not on this customer\'s account. '
                           + 'They need to add it from their portal first.',
                });
            }
            await pool.query(
                'UPDATE leads SET default_payment_method_id=$2 WHERE id=$1',
                [req.params.leadId, pm.id]);
            await pool.query(
                'UPDATE payment_methods SET is_default = (id = $2) WHERE lead_id = $1',
                [req.params.leadId, pm.id]).catch(() => {});
            res.json({
                success: true,
                message: `Now billing ${pm.type === 'card'
                    ? `${pm.brand || 'card'} ····${pm.last4}` : 'their bank account'}. `
                       + 'Every plan on the account uses this unless it has its own override.',
            });
        } catch (e) {
            console.error('[DEFAULT METHOD]', e.message);
            res.status(500).json({ success: false, message: 'Could not change the payment method.' });
        }
    });

    console.log('[ADMIN ACCOUNTS] Customer account routes mounted.');
};