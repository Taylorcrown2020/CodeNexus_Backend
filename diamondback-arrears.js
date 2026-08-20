// ============================================================================
// diamondback-arrears.js — Diamondback Coding
//
// EVERY UNPAID PERIOD COUNTS, NOT JUST THE LATEST ONE.
//
// The outstanding balance was derived from a single flag —
// `current_period_paid_at IS NULL` — which can only ever describe ONE period.
// A customer who missed three months owed three months and was shown one. A
// customer who missed two annual renewals owed two years and was shown one.
// The money was real; the balance simply did not reflect it, and nothing ever
// caught up.
//
// This walks the schedule from the last period they actually paid for to
// today, and returns EVERY period in between. Miss six months and you see six
// lines and six months of money.
//
// LATE FEES ACCRUE PER PERIOD TOO. One fee on the oldest missed month, while
// five more went unpaid, undercharges by exactly as much as the balance did.
//
// The rates differ by cadence on purpose:
//   MONTHLY 1.5% — a month is a short period and 1.5% per month is the usual
//                  commercial rate, which is what the agreements state.
//   ANNUAL  3.0% — a missed annual renewal is a year of unpaid service, not a
//                  month, so the same 1.5% would be trivial against it.
//
// Both are overridable per plan (`maintenance_plans.late_fee_rate`) and by
// environment, so neither is baked in.
// ============================================================================

const MONTHLY_LATE_FEE_RATE = Number(process.env.LATE_FEE_RATE || 0.015);          // 1.5%
const ANNUAL_LATE_FEE_RATE  = Number(process.env.ANNUAL_LATE_FEE_RATE || 0.03);    // 3%

// Days after a due date before it counts as late. A card that fails and retries
// successfully the next morning should not leave a fee behind.
// NO GRACE PERIOD BY DEFAULT. Past the due date is late.
//
// This defaulted to 3 days, which I added without being asked. It meant a
// payment two days overdue carried no fee and read as fine, which is exactly
// the case that looked broken. Set LATE_FEE_GRACE_DAYS=3 if you ever want a
// window for a card that fails and retries.
const GRACE_DAYS = Number(process.env.LATE_FEE_GRACE_DAYS || 0);

// Never walk further back than this. A plan with a corrupt or ancient start
// date must not generate hundreds of periods and a balance nobody can explain.
const MAX_PERIODS = Number(process.env.MAX_ARREARS_PERIODS || 36);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** Month-safe: normalise to the 1st before shifting, then clamp the day. */
function addMonth(from, day) {
    const first = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(day || from.getUTCDate(), last));
    return first;
}

/** Same month and day, next year. Clamps 29 Feb in a non-leap year. */
function addYear(from, month, day) {
    const y = from.getUTCFullYear() + 1;
    const last = new Date(Date.UTC(y, (month || from.getUTCMonth() + 1), 0)).getUTCDate();
    return new Date(Date.UTC(y, (month || (from.getUTCMonth() + 1)) - 1,
                             Math.min(day || from.getUTCDate(), last)));
}

function nextPeriod(plan, from) {
    return plan.interval_unit === 'year'
        ? addYear(from, plan.billing_month, plan.billing_day)
        : addMonth(from, plan.billing_day);
}

function lateFeeRateFor(plan) {
    if (plan.late_fee_rate != null) return Number(plan.late_fee_rate);
    return plan.interval_unit === 'year' ? ANNUAL_LATE_FEE_RATE : MONTHLY_LATE_FEE_RATE;
}

/**
 * Every period this plan owes for, oldest first.
 *
 * @param {object} plan     maintenance_plans row
 * @param {number} amount   what one period costs, fully priced (base+tax+fee)
 * @param {Date}   asOf
 *
 * @returns {{periods:[], total, lateTotal, grandTotal, periodsMissed}}
 *
 * A period is owed once its charge date has ARRIVED. A period whose date is
 * still in the future is not arrears — that is the outstanding-vs-late
 * distinction, applied period by period.
 */
function arrearsFor(plan, amount, asOf = new Date()) {
    const today = startOfDay(asOf);
    const periods = [];

    // ANCHOR ON next_charge_date — THE DATE MONEY IS DUE.
    //
    // This used to start from current_period_start, which is when a period
    // OPENED, not when it is payable. On a brand-new plan created today with a
    // first charge next month, current_period_start is today — so the walk
    // found "today's period" already due and charged it the instant a card was
    // added, a month early. Adding a payment method must never bring a charge
    // forward; it only settles what was already due.
    //
    // next_charge_date is the earliest UNPAID due date: the charger advances it
    // only after a successful charge, so on a plan three months behind it still
    // points at the oldest missed date and the walk finds all three.
    let cursor = plan.next_charge_date || plan.current_period_start
              || plan.billing_start_date || plan.last_charge_date;
    if (!cursor) return { periods: [], total: 0, lateTotal: 0, grandTotal: 0, periodsMissed: 0 };

    cursor = new Date(cursor);
    if (isNaN(cursor)) return { periods: [], total: 0, lateTotal: 0, grandTotal: 0, periodsMissed: 0 };

    // If that exact period has already been settled, arrears start at the next.
    if (plan.current_period_paid_at) cursor = nextPeriod(plan, cursor);

    const rate = lateFeeRateFor(plan);
    const per = round2(amount);
    let guard = 0;

    while (startOfDay(cursor) <= today && guard < MAX_PERIODS) {
        const due = new Date(cursor);
        const graceEnd = new Date(due);
        graceEnd.setDate(graceEnd.getDate() + GRACE_DAYS);

        const isLate = today > startOfDay(graceEnd);
        const daysLate = Math.max(0, Math.floor((today - startOfDay(due)) / 86400000));

        periods.push({
            dueDate: due.toISOString().slice(0, 10),
            amount: per,
            // A fee per missed period. One fee for six missed months
            // undercharges by exactly as much as showing one month did.
            lateFee: isLate && per > 0 ? round2(per * rate) : 0,
            lateFeeRate: rate,
            isLate,
            daysLate,
        });

        cursor = nextPeriod(plan, cursor);
        guard += 1;
    }

    const total = round2(periods.reduce((s, p) => s + p.amount, 0));
    const lateTotal = round2(periods.reduce((s, p) => s + p.lateFee, 0));

    return {
        periods,
        total,                                   // the unpaid periods themselves
        lateTotal,                               // fees on the late ones
        grandTotal: round2(total + lateTotal),
        periodsMissed: periods.length,
        // True when the walk hit the ceiling — the figure is a floor, not the
        // whole debt, and saying so beats quietly under-reporting it.
        capped: guard >= MAX_PERIODS,
        rate,
    };
}

/** "3 months behind" / "2 years behind" — for the UI, computed once here. */
function arrearsLabel(plan, arrears) {
    const n = arrears.periodsMissed;
    if (!n) return null;
    const unit = plan.interval_unit === 'year' ? 'year' : 'month';
    const late = arrears.periods.filter((p) => p.isLate).length;
    if (n === 1) return late ? `1 ${unit} overdue` : `1 ${unit} due`;
    return `${n} ${unit}s owed${late ? `, ${late} overdue` : ''}`;
}

module.exports = {
    MONTHLY_LATE_FEE_RATE, ANNUAL_LATE_FEE_RATE, GRACE_DAYS, MAX_PERIODS,
    arrearsFor, arrearsLabel, lateFeeRateFor, nextPeriod, addMonth, addYear,
};