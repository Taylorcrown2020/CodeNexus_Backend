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

    /** Does a column exist? Cached per process — schema does not change under us. */
    const _colCache = new Map();
    async function hasColumn(column, table) {
        const key = `${table}.${column}`;
        if (_colCache.has(key)) return _colCache.get(key);
        let ok = false;
        try {
            const r = await pool.query(
                `SELECT 1 FROM information_schema.columns
                  WHERE table_name = $1 AND column_name = $2`, [table, column]);
            ok = r.rows.length > 0;
        } catch { ok = false; }
        _colCache.set(key, ok);
        return ok;
    }

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
            // ------------------------------------------------------------
            // SELECT * PLUS DERIVED FIELDS, not a hand-written column list.
            //
            // The previous version named late_fees_exempt,
            // portal_welcome_sent_at and portal_welcome_count directly. Those
            // arrive with migration 013 — so on a database where 013 has not
            // run, this single query threw and the ENTIRE account screen
            // returned "Could not load that account". Every other query in
            // this route is wrapped in safe(); this one was not, which made it
            // the one place a missing migration could take the whole screen
            // down.
            //
            // Now: take the row as it is, and default anything the migration
            // would have added. The screen degrades to "no late-fee controls"
            // instead of failing.
            // ------------------------------------------------------------
            const leadRow = (await pool.query(
                `SELECT *, client_password IS NOT NULL AS has_portal_login
                   FROM leads WHERE id = $1`, [leadId])).rows[0];
            if (!leadRow) return res.status(404).json({ success: false, message: 'Customer not found.' });

            const lead = {
                ...leadRow,
                late_fees_exempt: leadRow.late_fees_exempt === true,
                portal_welcome_sent_at: leadRow.portal_welcome_sent_at || null,
                portal_welcome_count: Number(leadRow.portal_welcome_count || 0),
            };
            delete lead.client_password;      // never send the hash to a browser

            // Tell the front end what it can actually offer, so the UI can hide
            // a control rather than showing one that will fail.
            const features = {
                lateFees: await hasColumn('late_fees_exempt', 'leads'),
                welcomeTracking: await hasColumn('portal_welcome_sent_at', 'leads'),
                periodTracking: await hasColumn('current_period_paid_at', 'maintenance_plans'),
            };

            // Charge anything that has genuinely fallen late before we read, so
            // the figure on screen is current rather than waiting on a nightly
            // job. Cheap — it writes nothing in the normal case.
            await lateFees.assessLateFees({ leadId }).catch(() => {});

            const standing = await lateFees.accountStanding(leadId);

            // ---- plans, split by cadence -----------------------------------
            // Aggregates come from ONE grouped pass joined in, not two
            // correlated subqueries per row. Same result, one scan of payments
            // instead of 2N, and it is a shape that can actually be tested.
            const plans = await safe(
                `SELECT mp.*, pc.effective_at AS cancels_at,
                        pm.brand, pm.last4, pm.type AS method_type, pm.funding,
                        COALESCE(pay.collected, 0) AS collected,
                        COALESCE(pay.charges, 0)   AS charges,
                        ${await hasColumn('current_period_paid_at','maintenance_plans')
                            ? 'mp.current_period_paid_at' : 'NULL'} AS period_paid_at
                   FROM maintenance_plans mp
                   LEFT JOIN plan_cancellations pc
                          ON pc.maintenance_plan_id = mp.id AND pc.status = 'pending'
                   LEFT JOIN payment_methods pm ON pm.id = mp.payment_method_id
                   LEFT JOIN (
                        SELECT maintenance_plan_id,
                               COALESCE(SUM(amount),0) AS collected,
                               COUNT(*) AS charges
                          FROM payments
                         WHERE status = 'succeeded' AND maintenance_plan_id IS NOT NULL
                         GROUP BY maintenance_plan_id
                   ) pay ON pay.maintenance_plan_id = mp.id
                  WHERE mp.lead_id = $1
                  ORDER BY mp.next_charge_date NULLS LAST, mp.id`,
                [leadId], 'plans');

            // The account default, resolved once and applied to any plan with
            // no override of its own.
            const defaultMethod = lead.default_payment_method_id
                ? (await safe('SELECT * FROM payment_methods WHERE id = $1',
                              [lead.default_payment_method_id], 'default method'))[0] || null
                : null;

            /**
             * Where this plan is in its life. The admin's first question is
             * "what stage are they at", and status alone doesn't answer it —
             * 'pending_payment_method' and 'active but never charged' are very
             * different situations.
             */
            const stageOf = (p) => {
                if (p.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled', tone: 'grey' };
                if (p.cancels_at) return { key: 'cancelling', label: 'Cancelling', tone: 'warn' };
                if (p.pending_agreement_id) {
                    return { key: 'price_change_pending',
                             label: 'Price change awaiting signature', tone: 'warn' };
                }
                if (!p.signed_at) return { key: 'awaiting_signature', label: 'Awaiting signature', tone: 'warn' };
                if (!p.payment_method_id && !lead.default_payment_method_id) {
                    return { key: 'awaiting_method', label: 'No payment method', tone: 'bad' };
                }
                if (lateFees.isPastDue(p.next_charge_date) && !p.period_paid_at) {
                    return { key: 'past_due', label: 'Past due', tone: 'bad' };
                }
                if (!Number(p.charges)) return { key: 'ready', label: 'Ready — not yet charged', tone: 'ok' };
                if (!p.period_paid_at) {
                    return { key: 'due_soon', label: 'This period unpaid', tone: 'ok' };
                }
                return { key: 'current', label: 'Paid up', tone: 'good' };
            };

            const shaped = plans.map((p) => ({
                ...p,
                // The method this plan actually bills on: its own override, or
                // the account default.
                brand: p.brand || (defaultMethod && defaultMethod.brand) || null,
                last4: p.last4 || (defaultMethod && defaultMethod.last4) || null,
                method_type: p.method_type || (defaultMethod && defaultMethod.type) || null,
                funding: p.funding || (defaultMethod && defaultMethod.funding) || null,
                stage: stageOf(p),
                is_annual: p.interval_unit === 'year',
                period_paid: !!p.period_paid_at,
                past_due: lateFees.isPastDue(p.next_charge_date) && !p.period_paid_at,
                days_late: p.period_paid_at ? 0 : lateFees.daysLate(p.next_charge_date),
                has_method: !!(p.payment_method_id || lead.default_payment_method_id),
                // A price/schedule change awaiting signature. Both figures are
                // sent because the plan is still billing the old one.
                pending_amount: p.pending_amount != null ? Number(p.pending_amount) : null,
                pending_billing_day: p.pending_billing_day != null ? Number(p.pending_billing_day) : null,
                pending_agreement_id: p.pending_agreement_id || null,
                pending_since: p.pending_since || null,
            }));

            const hasInvLateFee = await hasColumn('late_fee_amount', 'invoices');
            const invoices = await safe(
                `SELECT id, invoice_number, short_description, total_amount, status,
                        due_date, paid_at, obligation, maintenance_plan_id, agreement_id,
                        ${hasInvLateFee ? 'COALESCE(late_fee_amount,0)' : '0'} AS late_fee_amount,
                        created_at
                   FROM invoices WHERE lead_id = $1 ORDER BY created_at DESC`,
                [leadId], 'invoices');

            const hasPayBreakdown = await hasColumn('base_amount', 'payments');
            const payments = await safe(
                `SELECT p.id, p.amount, p.status, p.kind, p.description, p.receipt_number,
                        p.method, p.method_brand, p.method_last4, p.paid_at,
                        ${hasPayBreakdown ? 'COALESCE(p.base_amount,p.amount)' : 'p.amount'} AS base_amount,
                        ${hasPayBreakdown ? 'COALESCE(p.tax_amount,0)' : '0'} AS tax_amount,
                        ${hasPayBreakdown ? 'COALESCE(p.processing_fee,0)' : '0'} AS processing_fee,
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
                features,
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
            // Say WHAT failed. "Could not load that account" sent me looking in
            // the wrong place for an hour; the Postgres message names the
            // missing column and the migration that adds it.
            console.error('[ADMIN ACCOUNT] lead', leadId, '-', e.code, e.message);
            const missingCol = /column "?([\w.]+)"? does not exist/i.exec(e.message || '');
            res.status(500).json({
                success: false,
                message: missingCol
                    ? `The database is missing "${missingCol[1]}". Run the migrations in migrations/ `
                    + `(011, 012 and 013) against this database, then reload.`
                    : `Could not load that account: ${e.message}`,
            });
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
            // SELECT * — not a column list.
            //
            // This named portal_welcome_count, which arrives with migration
            // 013. On a database without 013 the query threw and the route
            // answered "Could not send the welcome email", which said nothing
            // about the actual cause. Third time this pattern has bitten; it is
            // now the same defensive shape as the account screen.
            const lead = (await pool.query(
                'SELECT *, client_password IS NOT NULL AS has_login FROM leads WHERE id = $1',
                [req.params.leadId])).rows[0];
            if (!lead) return res.status(404).json({ success: false, message: 'Customer not found.' });
            const sentCount = Number(lead.portal_welcome_count || 0);
            if (!lead.email) {
                return res.status(400).json({ success: false, message: 'That customer has no email address.' });
            }

            // A customer whose portal_kind is 'crm' cannot sign in to the
            // customer portal at all, so a welcome would send them to a login
            // that rejects them. Say so rather than sending it.
            // portal_kind defaults to 'crm' for every account that existed
            // before migration 001, so refusing outright blocked customers who
            // are perfectly real and just never got promoted. Promote them here
            // instead — sending a portal welcome IS the decision that they are
            // a portal customer.
            if (lead.portal_kind === 'crm') {
                await pool.query(
                    `UPDATE leads SET portal_kind = 'both' WHERE id = $1`, [lead.id]
                ).catch((e) => console.warn('[WELCOME] portal_kind not updated:', e.message));
                console.log(`[WELCOME] lead ${lead.id} was CRM-only — promoted to 'both' `
                          + 'so the portal login will accept them.');
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
                       + (sentCount ? ` (Sent ${sentCount + 1} times in total.)` : ''),
            });
        } catch (e) {
            console.error('[WELCOME] lead', req.params.leadId, '-', e.code, e.message);
            const col = /column "?([\w.]+)"? does not exist/i.exec(e.message || '');
            res.status(500).json({
                success: false,
                message: col
                    ? `The database is missing "${col[1]}" — run the migrations in migrations/ `
                    + '(011, 012, 013, 014) against this database, then try again.'
                    : `Could not send the welcome email: ${e.message}`,
            });
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

    // ======================================================================
    // EDIT A CUSTOMER'S BILLING INFORMATION
    //
    // Name, email, phone, company and billing address. These are what appear
    // on their invoices, receipts and agreements, so getting them wrong is
    // visible to the customer and, for the address, matters for sales tax.
    //
    // Only columns that exist are written, so this works on any migration
    // level rather than failing whole because one field is absent.
    // ======================================================================
    app.patch('/api/admin/accounts/:leadId/billing-info', authenticateToken, async (req, res) => {
        try {
            const b = req.body || {};
            const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.leadId])).rows[0];
            if (!lead) return res.status(404).json({ success: false, message: 'Customer not found.' });

            const cols = new Set((await pool.query(
                `SELECT column_name FROM information_schema.columns WHERE table_name='leads'`
            )).rows.map((r) => r.column_name));

            const sets = [];
            const vals = [req.params.leadId];
            const put = (col, val) => {
                if (!cols.has(col)) return;
                vals.push(val);
                sets.push(`${col} = $${vals.length}`);   // note the $$ — see plan edit
            };

            const text = (v, max) => {
                if (v === undefined) return undefined;
                const t = String(v == null ? '' : v).trim();
                return t ? t.slice(0, max) : null;
            };

            if (b.name !== undefined) {
                const n = text(b.name, 255);
                if (!n) {
                    return res.status(400).json({ success: false, message: 'A name is required.' });
                }
                put('name', n);
            }

            if (b.email !== undefined) {
                const e = text(b.email, 255);
                // An invoice or a receipt with no valid address on it cannot be
                // delivered, and the portal login IS the email — so a typo here
                // locks the customer out of their own account.
                if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
                    return res.status(400).json({
                        success: false,
                        message: 'That email address does not look valid. It is also their portal '
                               + 'login, so a typo would lock them out.',
                    });
                }
                const clash = await pool.query(
                    'SELECT id, name FROM leads WHERE LOWER(email)=LOWER($1) AND id <> $2',
                    [e, req.params.leadId]);
                if (clash.rows.length) {
                    return res.status(409).json({
                        success: false,
                        message: `${clash.rows[0].name || 'Another customer'} already uses that email. `
                               + 'Two accounts sharing one address breaks the portal login.',
                    });
                }
                put('email', e);
            }

            if (b.phone   !== undefined) put('phone', text(b.phone, 40));
            if (b.company !== undefined) put('company', text(b.company, 255));
            if (b.address !== undefined) put('address', text(b.address, 500));
            if (b.city    !== undefined) put('city', text(b.city, 120));
            if (b.state   !== undefined) put('state', text(b.state, 60));
            if (b.zip     !== undefined) put('zip', text(b.zip, 20));
            if (b.notes   !== undefined) put('notes', text(b.notes, 2000));

            if (b.portal_kind !== undefined
                && ['crm', 'customer', 'both'].includes(b.portal_kind)) {
                put('portal_kind', b.portal_kind);
            }

            if (!sets.length) {
                return res.json({ success: true, message: 'Nothing to change.', lead });
            }

            const upd = (await pool.query(
                `UPDATE leads SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)).rows[0];
            delete upd.client_password;

            res.json({
                success: true,
                lead: upd,
                message: 'Billing details updated. They show on the customer\'s next invoice, '
                       + 'receipt and agreement, and in their portal.',
            });
        } catch (e) {
            console.error('[BILLING INFO]', e.code, e.message);
            const col = /column "?([\w.]+)"? does not exist/i.exec(e.message || '');
            res.status(500).json({
                success: false,
                message: col
                    ? `The database is missing "${col[1]}". Run the migrations in migrations/.`
                    : `Could not save those details: ${e.message}`,
            });
        }
    });

    // ======================================================================
    // RECURRING REVENUE FORECAST
    //
    // What the plans are actually worth, at the prices they will really be
    // charged — base plus tax plus the card fee where it applies, per plan,
    // not a flat SUM(amount) that would understate every plan on the new
    // pricing and overstate nothing.
    //
    // Annual plans are converted to a monthly equivalent for the MRR figure
    // and shown separately as well, because a $70/yr domain renewal sitting in
    // the same column as a $450/mo plan makes the number meaningless.
    // ======================================================================
    app.get('/api/admin/revenue-forecast', authenticateToken, async (req, res) => {
        try {
            const pricing = require('./diamondback-pricing.js');
            const months = Math.min(24, Math.max(1, Number((req.query || {}).months) || 12));

            const rows = await safe(
                `SELECT mp.*, l.name AS customer, l.id AS lead_id,
                        pm.type AS pm_type, pm.funding AS pm_funding,
                        pc.effective_at AS cancels_at
                   FROM maintenance_plans mp
                   JOIN leads l ON l.id = mp.lead_id
                   LEFT JOIN payment_methods pm
                          ON pm.id = COALESCE(mp.payment_method_id, l.default_payment_method_id)
                   LEFT JOIN plan_cancellations pc
                          ON pc.maintenance_plan_id = mp.id AND pc.status = 'pending'
                  WHERE mp.status IN ('active','past_due','pending_cancellation','pending_payment_method')
                  ORDER BY mp.next_charge_date NULLS LAST`, [], 'forecast plans');

            const priced = rows.map((p) => {
                const method = p.pm_type ? { type: p.pm_type, funding: p.pm_funding } : null;
                const q = pricing.priceFor(p, method);
                return {
                    id: p.id, customer: p.customer, leadId: p.lead_id, label: p.label,
                    planType: p.plan_type,
                    interval: p.interval_unit === 'year' ? 'year' : 'month',
                    base: q.base, tax: q.tax, fee: q.fee, total: q.total,
                    newPricing: q.newPricing,
                    status: p.status,
                    cancelsAt: p.cancels_at || null,
                    nextCharge: p.next_charge_date,
                    // A plan that cannot be charged is not revenue, however
                    // good it looks in a total.
                    billable: !!p.signed_at && !!method,
                    blockedReason: !p.signed_at ? 'not signed'
                                 : !method ? 'no payment method' : null,
                };
            });

            const live = priced.filter((p) => p.billable && !p.cancelsAt);
            const monthly = live.filter((p) => p.interval === 'month');
            const annual  = live.filter((p) => p.interval === 'year');
            const atRisk  = priced.filter((p) => !p.billable || p.cancelsAt);

            const sum = (a) => Math.round(a.reduce((s, x) => s + x.total, 0) * 100) / 100;
            const mrr = sum(monthly);
            const arrFromAnnual = sum(annual);
            // MRR counts annual plans at a twelfth of their value.
            const blendedMrr = Math.round((mrr + arrFromAnnual / 12) * 100) / 100;

            // ---- month-by-month, so a forecast is a shape and not one number ----
            const timeline = [];
            const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
            for (let i = 0; i < months; i++) {
                const from = new Date(start); from.setMonth(from.getMonth() + i);
                const to   = new Date(from);  to.setMonth(to.getMonth() + 1);

                let expected = 0;
                const items = [];
                live.forEach((p) => {
                    if (p.interval === 'month') {
                        expected += p.total;
                        if (i === 0) items.push(p.label);
                    } else if (p.nextCharge) {
                        // An annual plan lands in exactly one month of the year.
                        const due = new Date(p.nextCharge);
                        const anniversary = new Date(due);
                        while (anniversary < from) anniversary.setFullYear(anniversary.getFullYear() + 1);
                        if (anniversary >= from && anniversary < to) {
                            expected += p.total;
                            items.push(p.label);
                        }
                    }
                });
                timeline.push({
                    month: from.toISOString().slice(0, 7),
                    label: from.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
                    expected: Math.round(expected * 100) / 100,
                    annualRenewals: items.filter((x, n) => items.indexOf(x) === n),
                });
            }

            const next12 = Math.round(
                timeline.slice(0, 12).reduce((s, m) => s + m.expected, 0) * 100) / 100;

            res.json({
                success: true,
                summary: {
                    mrr,                                   // monthly plans only
                    blendedMrr,                            // + annual / 12
                    arr: Math.round(blendedMrr * 12 * 100) / 100,
                    annualRenewalsPerYear: arrFromAnnual,
                    next12Months: next12,
                    monthlyPlans: monthly.length,
                    annualPlans: annual.length,
                    // Revenue you are NOT going to collect unless something is fixed.
                    atRiskCount: atRisk.length,
                    atRiskValue: sum(atRisk),
                    taxCollectedPerMonth: Math.round(
                        monthly.reduce((s, p) => s + p.tax, 0) * 100) / 100,
                    feesCollectedPerMonth: Math.round(
                        monthly.reduce((s, p) => s + p.fee, 0) * 100) / 100,
                    onOldPricing: priced.filter((p) => !p.newPricing).length,
                },
                timeline,
                monthly, annual, atRisk,
                note: 'Figures are what each plan will actually be charged — base plus tax plus '
                    + 'the card fee where the customer pays by credit card. Plans that cannot be '
                    + 'charged (unsigned, or no payment method) are excluded and listed under atRisk.',
            });
        } catch (e) {
            console.error('[FORECAST]', e.message);
            res.status(500).json({ success: false, message: 'Could not build the forecast: ' + e.message });
        }
    });

    console.log('[ADMIN ACCOUNTS] Customer account + forecast routes mounted.');
};