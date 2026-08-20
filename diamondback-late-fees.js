// ============================================================================
// diamondback-late-fees.js — Diamondback Coding
//
// THE DISTINCTION THIS WHOLE FILE EXISTS TO PROTECT:
//
//   OUTSTANDING — owed, but not yet due. A monthly plan is outstanding from the
//                 day its period opens. The customer has done nothing wrong and
//                 owes no fee. This is what shows on their dashboard.
//
//   PAST DUE    — the due date has passed and it is still unpaid, because no
//                 payment method was on file or the charge failed. THIS is what
//                 earns a late fee.
//
// Charging 1.5% on money that was merely outstanding is both unfair and the
// kind of thing that gets an entire fee schedule struck down when a customer
// disputes it. Every function here checks the due date before it charges.
//
// A fee is also charged ONCE per obligation per period. The unique index in
// migration 013 enforces that at the database level, so a scheduler that runs
// twice cannot stack fees — but assessLateFees() is written not to try.
// ============================================================================

const DEFAULT_LATE_FEE_RATE = Number(process.env.LATE_FEE_RATE || 0.015);   // 1.5%

// Days after the due date before a fee is charged. Zero means the day after.
// A short grace period is worth having: a card that fails on the due date and
// retries successfully the next morning should not leave a fee behind.
// NO GRACE PERIOD BY DEFAULT. Past the due date is late.
//
// This defaulted to 3 days, which I added without being asked. It meant a
// payment two days overdue carried no fee and read as fine, which is exactly
// the case that looked broken. Set LATE_FEE_GRACE_DAYS=3 if you ever want a
// window for a card that fails and retries.
const GRACE_DAYS = Number(process.env.LATE_FEE_GRACE_DAYS || 0);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

/**
 * Is this obligation LATE, as opposed to merely outstanding?
 *
 * @param {Date|string} dueDate
 * @param {Date}        asOf
 * @param {number}      graceDays
 */
function isPastDue(dueDate, asOf = new Date(), graceDays = GRACE_DAYS) {
    if (!dueDate) return false;
    const due = startOfDay(dueDate);
    if (isNaN(due)) return false;
    const cutoff = new Date(due);
    cutoff.setDate(cutoff.getDate() + graceDays);
    return startOfDay(asOf) > cutoff;
}

/** How many days late, for display. Never negative. */
function daysLate(dueDate, asOf = new Date()) {
    if (!dueDate) return 0;
    const due = startOfDay(dueDate);
    if (isNaN(due)) return 0;
    return Math.max(0, Math.floor((startOfDay(asOf) - due) / 86400000));
}

/**
 * The period a fee belongs to, used as the once-per-period key.
 * Derived from the DUE DATE, not from today, so re-running on a later date
 * produces the same key and the unique index rejects the duplicate.
 */
function periodKey(kind, id, dueDate) {
    const d = dueDate ? new Date(dueDate) : new Date();
    const stamp = isNaN(d) ? 'unknown' : d.toISOString().slice(0, 10);
    return `${kind}:${id}:${stamp}`;
}

/** 1.5% of what is owed. */
function feeFor(baseAmount, rate = DEFAULT_LATE_FEE_RATE) {
    const base = Number(baseAmount || 0);
    if (base <= 0) return 0;          // nothing owed, nothing to charge on
    return round2(base * rate);
}

module.exports = function initLateFees({ pool }) {

    // Which optional columns exist. Probed once, because naming a column that
    // migration 015 has not added yet made the WHOLE assessment throw — and a
    // missing migration must degrade, not silently stop charging late fees.
    let _cols = null;
    async function planCols() {
        if (_cols) return _cols;
        try {
            const r = await pool.query(
                `SELECT column_name FROM information_schema.columns
                  WHERE table_name='maintenance_plans'`);
            _cols = new Set(r.rows.map((x) => x.column_name));
        } catch { _cols = new Set(); }
        return _cols;
    }

    /**
     * Which plans can accrue arrears and late fees.
     *
     * A plan whose first payment date has passed owes, whether or not the
     * agreement was ever signed. That is deliberate and it is what was asked
     * for: an agreement sent, a first payment date set, and neither a signature
     * nor a payment by that date is exactly the case the late fee exists to
     * discourage. Requiring a signature first meant ignoring the agreement was
     * the cheapest thing a customer could do.
     *
     * Set LATE_FEES_REQUIRE_SIGNATURE=on to charge only signed and provisionally
     * signed plans.
     *
     * WORTH KNOWING ONCE: a fee on a never-signed agreement is harder to
     * enforce than one on a signed plan — there is no contract to point at. It
     * is fine as a prompt to sign or cancel; treat an unsigned balance as
     * something to chase rather than something to sue over.
     */
    async function signedClause(prefix = 'mp.') {
        if (String(process.env.LATE_FEES_REQUIRE_SIGNATURE || '').toLowerCase() !== 'on') {
            return 'TRUE';
        }
        const c = await planCols();
        const hasSigned = c.has('signed_at');
        const hasProv = c.has('provisional_signed_at');
        if (!hasSigned && !hasProv) return 'TRUE';
        if (hasSigned && hasProv) {
            return `(${prefix}signed_at IS NOT NULL OR ${prefix}provisional_signed_at IS NOT NULL)`;
        }
        return hasSigned ? `${prefix}signed_at IS NOT NULL`
                         : `${prefix}provisional_signed_at IS NOT NULL`;
    }

    async function hasTable() {
        try {
            const r = await pool.query(
                `SELECT 1 FROM information_schema.tables WHERE table_name='late_fees'`);
            return r.rows.length > 0;
        } catch { return false; }
    }

    /**
     * Charge late fees on everything that is genuinely late and has none yet.
     *
     * Called from the billing scheduler and, cheaply, whenever the admin opens
     * a customer — so the figure on screen is never stale.
     *
     * Returns the fees created. Never throws: a failure here must not break
     * billing or a page load.
     */
    async function assessLateFees({ leadId = null, asOf = new Date() } = {}) {
        if (!(await hasTable())) return [];
        const created = [];

        try {
            // ---- late INVOICES ------------------------------------------
            // due_now only. A project balance sitting at 'on_completion' is not
            // due yet, so it cannot be late.
            const invoices = await pool.query(
                `SELECT i.id, i.lead_id, i.invoice_number, i.total_amount, i.due_date,
                        COALESCE(l.late_fees_exempt, FALSE) AS exempt
                   FROM invoices i
                   JOIN leads l ON l.id = i.lead_id
                  WHERE i.status NOT IN ('paid','void','cancelled','refunded','draft')
                    AND i.due_date IS NOT NULL
                    AND COALESCE(i.obligation,'due_now') = 'due_now'
                    AND ($1::int IS NULL OR i.lead_id = $1)`,
                [leadId]);

            for (const inv of invoices.rows) {
                if (inv.exempt) continue;
                if (!isPastDue(inv.due_date, asOf)) continue;      // outstanding, not late
                const amount = feeFor(inv.total_amount);
                if (amount <= 0) continue;
                const key = periodKey('invoice', inv.id, inv.due_date);
                const ins = await pool.query(
                    `INSERT INTO late_fees
                        (lead_id, invoice_id, base_amount, rate, amount, due_date, period_key, notes)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT DO NOTHING
                     RETURNING *`,
                    [inv.lead_id, inv.id, inv.total_amount, DEFAULT_LATE_FEE_RATE, amount,
                     inv.due_date, key,
                     `Late fee on invoice ${inv.invoice_number}`]);
                if (ins.rows[0]) created.push(ins.rows[0]);
            }

            // ---- late RECURRING PLANS -----------------------------------
            // A plan is late when its charge date has passed and the current
            // period is still unpaid — which in practice means no payment
            // method on file, or the charge failed.
            const plans = await pool.query(
                `SELECT mp.id, mp.lead_id, mp.label, mp.amount, mp.next_charge_date,
                        mp.late_fee_rate, mp.interval_unit,
                        COALESCE(l.late_fees_exempt, FALSE) AS exempt,
                        mp.current_period_paid_at
                   FROM maintenance_plans mp
                   JOIN leads l ON l.id = mp.lead_id
                  WHERE mp.status IN ('active','past_due','pending_cancellation',
                                      'pending_payment_method','pending_signature')
                    AND mp.next_charge_date IS NOT NULL
                    AND mp.current_period_paid_at IS NULL
                    -- A PROVISIONAL signature still owes: they typed their name
                    -- and never added a card. If that meant no late fees,
                    -- stalling would be free and holding the signature would
                    -- achieve nothing.
                    AND ${await signedClause('mp.')}
                    AND ($1::int IS NULL OR mp.lead_id = $1)`,
                [leadId]);

            // ONE FEE PER MISSED PERIOD, not one per plan.
            //
            // This used to charge a single fee keyed on next_charge_date, so a
            // customer six months behind paid one 1.5% fee on one month. The
            // arrears walk below produces every missed period, and each gets
            // its own fee with its own period_key — so the unique index still
            // stops duplicates, but six missed months now means six fees.
            const arrears = require('./diamondback-arrears.js');

            for (const p of plans.rows) {
                if (p.exempt) continue;
                if (Number(p.amount || 0) <= 0) continue;   // a $0 plan owes nothing

                const owed = arrears.arrearsFor(p, Number(p.amount || 0), asOf);
                let markedPastDue = false;

                for (const period of owed.periods) {
                    if (!period.isLate || period.lateFee <= 0) continue;   // still in grace

                    const key = periodKey('plan', p.id, period.dueDate);
                    const ins = await pool.query(
                        `INSERT INTO late_fees
                            (lead_id, maintenance_plan_id, base_amount, rate, amount,
                             due_date, period_key, notes)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                         ON CONFLICT DO NOTHING
                         RETURNING *`,
                        [p.lead_id, p.id, p.amount, period.lateFeeRate, period.lateFee,
                         period.dueDate, key,
                         `Late fee — ${p.label} (${p.interval_unit === 'year' ? 'annual' : 'monthly'}) `
                         + `for ${period.dueDate}`]);

                    if (ins.rows[0]) {
                        created.push(ins.rows[0]);
                        if (!markedPastDue) {
                            // Dated from the OLDEST missed period, so "past due
                            // since" says how long they have actually been
                            // behind rather than when we last looked.
                            await pool.query(
                                `UPDATE maintenance_plans
                                    SET past_due_since = COALESCE(past_due_since, $2), updated_at = NOW()
                                  WHERE id = $1`, [p.id, owed.periods[0].dueDate]).catch(() => {});
                            markedPastDue = true;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[LATE FEES] assessment skipped:', e.message);
        }

        if (created.length) {
            console.log(`[LATE FEES] ${created.length} fee(s) charged`
                      + (leadId ? ` for lead ${leadId}` : '') + '.');
        }
        return created;
    }

    /** Outstanding late fees for a customer. */
    async function outstandingFees(leadId) {
        if (!(await hasTable())) return { fees: [], total: 0 };
        try {
            const r = await pool.query(
                `SELECT lf.*, i.invoice_number, mp.label AS plan_label
                   FROM late_fees lf
                   LEFT JOIN invoices i ON i.id = lf.invoice_id
                   LEFT JOIN maintenance_plans mp ON mp.id = lf.maintenance_plan_id
                  WHERE lf.lead_id = $1 AND lf.status = 'outstanding'
                  ORDER BY lf.due_date, lf.id`, [leadId]);
            return {
                fees: r.rows,
                total: round2(r.rows.reduce((s, f) => s + Number(f.amount || 0), 0)),
            };
        } catch (e) {
            console.warn('[LATE FEES] read skipped:', e.message);
            return { fees: [], total: 0 };
        }
    }

    /**
     * Drop a late fee. Recorded, not deleted — if the customer ever disputes
     * what they were charged, the waiver needs to be provable.
     */
    async function waiveFee({ feeId, waivedBy, reason }) {
        const r = await pool.query(
            `UPDATE late_fees
                SET status='waived', waived_at=NOW(), waived_by=$2, waive_reason=$3, updated_at=NOW()
              WHERE id=$1 AND status='outstanding'
              RETURNING *`,
            [feeId, (waivedBy || 'admin').slice(0, 120), (reason || '').slice(0, 500)]);
        return r.rows[0] || null;
    }

    /** Drop every outstanding fee on an account at once. */
    async function waiveAllForLead({ leadId, waivedBy, reason }) {
        const r = await pool.query(
            `UPDATE late_fees
                SET status='waived', waived_at=NOW(), waived_by=$2, waive_reason=$3, updated_at=NOW()
              WHERE lead_id=$1 AND status='outstanding'
              RETURNING *`,
            [leadId, (waivedBy || 'admin').slice(0, 120), (reason || '').slice(0, 500)]);
        return r.rows;
    }

    /**
     * IS THIS CUSTOMER CAUGHT UP?
     *
     * The admin-facing definition, which is deliberately NOT the same as
     * "nothing outstanding": a customer with an unpaid month that is not yet
     * due is perfectly fine and should read as caught up. What matters is
     * whether anything is LATE.
     */
    async function accountStanding(leadId, asOf = new Date()) {
        const reasons = [];

        const inv = await pool.query(
            `SELECT invoice_number, total_amount, due_date FROM invoices
              WHERE lead_id=$1
                AND status NOT IN ('paid','void','cancelled','refunded','draft')
                AND COALESCE(obligation,'due_now')='due_now'
                AND due_date IS NOT NULL`, [leadId]).catch(() => ({ rows: [] }));
        inv.rows.forEach((i) => {
            if (isPastDue(i.due_date, asOf)) {
                reasons.push({
                    kind: 'invoice', label: `Invoice ${i.invoice_number}`,
                    amount: Number(i.total_amount || 0),
                    dueDate: i.due_date, daysLate: daysLate(i.due_date, asOf),
                });
            }
        });

        const plans = await pool.query(
            `SELECT id, label, amount, next_charge_date FROM maintenance_plans
              WHERE lead_id=$1
                AND status IN ('active','past_due','pending_cancellation',
                               'pending_payment_method','pending_signature')
                AND current_period_paid_at IS NULL AND next_charge_date IS NOT NULL
                AND ${await signedClause('')}`,
            [leadId]).catch(() => ({ rows: [] }));
        plans.rows.forEach((p) => {
            // A $0.00 plan past its due date is still LATE — it just owes
            // nothing. Excluding it made an overdue plan read as caught up,
            // which is the opposite of useful.
            if (isPastDue(p.next_charge_date, asOf)) {
                reasons.push({
                    kind: 'plan', label: p.label, amount: Number(p.amount || 0),
                    dueDate: p.next_charge_date, daysLate: daysLate(p.next_charge_date, asOf),
                });
            }
        });

        const fees = await outstandingFees(leadId);

        const lateTotal = round2(
            reasons.reduce((s, r) => s + r.amount, 0) + fees.total);

        return {
            // The green tick in the admin portal.
            caughtUp: reasons.length === 0 && fees.total === 0,
            lateItems: reasons,
            lateCount: reasons.length,
            lateFees: fees.fees,
            lateFeeTotal: fees.total,
            lateTotal,
            worstDaysLate: reasons.reduce((m, r) => Math.max(m, r.daysLate), 0),
            // Stated in the payload so the UI copy cannot drift from the rule.
            rule: 'Caught up means nothing is LATE. Money that is owed but not '
                + 'yet due does not count against the customer.',
        };
    }

    return {
        DEFAULT_LATE_FEE_RATE, GRACE_DAYS,
        isPastDue, daysLate, feeFor, periodKey,
        assessLateFees, outstandingFees, waiveFee, waiveAllForLead, accountStanding,
    };
};

module.exports.isPastDue = isPastDue;
module.exports.daysLate = daysLate;
module.exports.feeFor = feeFor;
module.exports.periodKey = periodKey;
module.exports.DEFAULT_LATE_FEE_RATE = DEFAULT_LATE_FEE_RATE;
module.exports.GRACE_DAYS = GRACE_DAYS;