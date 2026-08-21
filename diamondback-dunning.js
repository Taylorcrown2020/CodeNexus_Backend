// ============================================================================
// diamondback-dunning.js — Diamondback Coding
//
// WHAT TO DO WHEN A CARD KEEPS DECLINING.
//
// This is the ordinary schedule a subscription business runs. It exists to do
// two things at once: give a customer with a genuine problem a fair chance to
// fix it, and stop an unpaid customer receiving the service indefinitely.
//
//   Day 0   charge declines. Email + SMS immediately, with the reason.
//   Day 1   retry
//   Day 3   retry
//   Day 5   retry + "your service will be suspended on <date>"
//   Day 7   retry
//   Day 10  retry + final notice
//   Day 14  SERVICE SUSPENDED. Plan stops, portal says why, work stops.
//   Day 30  plan ENDED. The balance is still owed.
//
// WHY A SCHEDULE AND NOT DAILY RETRIES
//
// The old code retried on every daily run, so a dead card was hit once a day
// forever. Visa caps retries of a declined transaction at 15 in 30 days and
// fines acquirers past that; Mastercard has its own limit. Beyond the rules,
// issuers start hard-declining an account that keeps getting hammered — so you
// can end up unable to charge a card that WOULD have worked once the customer
// topped it up. Spacing the attempts is worth real money.
//
// Retry days are also chosen to land on different days of the week, which
// catches the common case of a card that only has funds after payday.
//
// WHAT IT NEVER DOES
//
// It never writes off the debt. Suspending stops the service; ending the plan
// stops the billing. Neither forgives what is already owed — that stays on the
// account, with its late fees, until you waive it deliberately.
// ============================================================================

// Days after the first decline on which to retry.
const RETRY_DAYS = String(process.env.DUNNING_RETRY_DAYS || '1,3,5,7,10')
    .split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b);

const SUSPEND_DAY = Number(process.env.DUNNING_SUSPEND_DAY || 14);
const TERMINATE_DAY = Number(process.env.DUNNING_TERMINATE_DAY || 30);

const day = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysBetween = (a, b) => Math.floor((day(b) - day(a)) / 86400000);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/**
 * A Stripe decline code turned into something a customer can act on.
 * "card_declined" tells them nothing; "your bank declined it" tells them who to
 * call.
 */
function explainDecline(code, message) {
    const map = {
        insufficient_funds: 'There were not enough funds on the card.',
        card_declined: 'The bank declined the payment. They can usually tell you why.',
        expired_card: 'The card has expired.',
        incorrect_cvc: 'The security code was not accepted.',
        processing_error: 'The bank had a temporary problem processing it.',
        authentication_required: 'The bank needs you to confirm this payment.',
        do_not_honor: 'The bank declined it without giving a reason. They can tell you why.',
        lost_card: 'The card has been reported lost.',
        stolen_card: 'The card has been reported stolen.',
        pickup_card: 'The bank has blocked this card.',
        currency_not_supported: 'The card does not support payments in US dollars.',
    };
    return map[code] || message || 'The payment did not go through.';
}

/** What should happen to this plan today? */
function stageFor(plan, asOf = new Date()) {
    if (!plan.dunning_started_at) return { stage: 'none' };
    const age = daysBetween(plan.dunning_started_at, asOf);

    if (age >= TERMINATE_DAY) return { stage: 'terminate', age };
    if (age >= SUSPEND_DAY) return { stage: 'suspend', age };

    const dueRetry = RETRY_DAYS.includes(age);
    return {
        stage: dueRetry ? 'retry' : 'wait',
        age,
        nextRetryDay: RETRY_DAYS.find((d) => d > age) || null,
        suspendsOn: addDays(plan.dunning_started_at, SUSPEND_DAY),
        endsOn: addDays(plan.dunning_started_at, TERMINATE_DAY),
    };
}

module.exports = { RETRY_DAYS, SUSPEND_DAY, TERMINATE_DAY, explainDecline, stageFor,
                   daysBetween, addDays };

module.exports.init = function initDunning({ pool, notify, adminNotify, money, prettyDate,
                                             chargeMaintenancePlan, PORTAL_URL }) {

    /**
     * Record a declined charge and set the next retry.
     * Called from the charge path instead of the old "retry tomorrow" default.
     */
    async function recordFailure(plan, err) {
        const code = (err && (err.decline_code || err.code)) || null;
        const reason = explainDecline(code, err && err.message);
        const failures = Number(plan.consecutive_failures || 0) + 1;

        // The clock starts at the FIRST decline of this run and is not reset by
        // later attempts — otherwise every retry would push suspension back and
        // the service would never actually stop.
        const startedAt = plan.dunning_started_at || new Date();
        const age = daysBetween(startedAt, new Date());
        const nextDay = RETRY_DAYS.find((d) => d > age);
        const nextRetry = nextDay != null ? addDays(startedAt, nextDay) : null;

        await pool.query(
            `UPDATE maintenance_plans
                SET consecutive_failures = $2,
                    dunning_started_at = COALESCE(dunning_started_at, $3),
                    next_retry_at = $4,
                    last_failure_reason = $5,
                    last_failure_at = NOW(),
                    status = CASE WHEN status = 'active' THEN 'past_due' ELSE status END,
                    updated_at = NOW()
              WHERE id = $1`,
            [plan.id, failures, startedAt, nextRetry, reason]
        ).catch(async (e) => {
            console.warn('[DUNNING] columns missing — run migration 016:', e.message);
            await pool.query(
                `UPDATE maintenance_plans SET consecutive_failures=$2, updated_at=NOW() WHERE id=$1`,
                [plan.id, failures]).catch(() => {});
        });

        return { failures, reason, nextRetry, startedAt };
    }

    /** Clear dunning after a successful charge. */
    async function clearDunning(planId) {
        await pool.query(
            `UPDATE maintenance_plans
                SET consecutive_failures = 0, dunning_started_at = NULL,
                    next_retry_at = NULL, suspended_at = NULL,
                    last_failure_reason = NULL,
                    status = CASE WHEN status IN ('past_due','suspended') THEN 'active' ELSE status END,
                    updated_at = NOW()
              WHERE id = $1`, [planId]).catch(() => {});
    }

    /** Is this customer suspended for non-payment? One flag to read. */
    async function isSuspended(leadId) {
        try {
            const r = await pool.query(
                'SELECT service_suspended_at, service_suspended_reason FROM leads WHERE id=$1',
                [leadId]);
            const row = r.rows[0];
            return {
                suspended: !!(row && row.service_suspended_at),
                since: row && row.service_suspended_at,
                reason: row && row.service_suspended_reason,
            };
        } catch { return { suspended: false }; }
    }

    /**
     * Walk every plan in dunning and do whatever today calls for.
     * Runs from the daily job.
     */
    async function runDunningCycle(asOf = new Date()) {
        const out = { retried: 0, suspended: 0, terminated: 0, warned: 0 };

        const plans = (await pool.query(
            `SELECT mp.*, l.name, l.email, l.phone, l.id AS lead_id
               FROM maintenance_plans mp
               JOIN leads l ON l.id = mp.lead_id
              WHERE mp.dunning_started_at IS NOT NULL
                AND mp.status NOT IN ('cancelled')`
        ).catch(() => ({ rows: [] }))).rows;

        for (const plan of plans) {
            const lead = { id: plan.lead_id, name: plan.name, email: plan.email, phone: plan.phone };
            const s = stageFor(plan, asOf);

            // ---- END THE PLAN ------------------------------------------
            if (s.stage === 'terminate') {
                await pool.query(
                    `UPDATE maintenance_plans
                        SET status='cancelled', next_charge_date=NULL,
                            next_retry_at=NULL, updated_at=NOW()
                      WHERE id=$1`, [plan.id]);
                await notify({
                    lead, kind: 'maintenance_cancelled',
                    subject: `${plan.label} has been ended for non-payment`,
                    bodyHtml:
                        `<p style="margin:0 0 12px">We have not been able to take payment for `
                        + `<strong style="color:#0d0f12">${plan.label}</strong> for ${s.age} days, `
                        + `so the plan has now ended.</p>`
                        + `<p style="margin:0 0 12px">The outstanding balance is still due. `
                        + `If you would like to restart the plan, get in touch and we will set it up.</p>`,
                    smsText: `Diamondback Coding: ${plan.label} has ended for non-payment. `
                           + 'The balance is still due.',
                    channels: ['email', 'sms', 'portal'],
                }).catch(() => {});
                await adminNotify({
                    kind: 'plan_terminated_nonpayment',
                    title: `${plan.label} ended — non-payment`,
                    body: `${lead.name}: ${s.age} days without payment. Balance still owed.`,
                    severity: 'warning', onceKey: `dunning_term:${plan.id}`,
                }).catch(() => {});
                out.terminated += 1;
                continue;
            }

            // ---- SUSPEND THE SERVICE -----------------------------------
            if (s.stage === 'suspend') {
                if (!plan.suspended_at) {
                    await pool.query(
                        `UPDATE maintenance_plans
                            SET status='suspended', suspended_at=NOW(), updated_at=NOW()
                          WHERE id=$1`, [plan.id]);
                    await pool.query(
                        `UPDATE leads
                            SET service_suspended_at = COALESCE(service_suspended_at, NOW()),
                                service_suspended_reason = $2
                          WHERE id = $1`,
                        [plan.lead_id, `Unpaid ${plan.label} since ${prettyDate(plan.dunning_started_at)}`]
                    ).catch(() => {});

                    await notify({
                        lead, kind: 'maintenance_charge_failed',
                        subject: `${plan.label} is suspended`,
                        bodyHtml:
                            `<p style="margin:0 0 12px">We have not been able to take payment for `
                            + `<strong style="color:#0d0f12">${plan.label}</strong>, so the service `
                            + `is now suspended.</p>`
                            + `<p style="margin:0 0 12px">${plan.last_failure_reason || ''}</p>`
                            + `<p style="margin:0 0 12px">Add a working payment method in your portal `
                            + `and it will restart straight away. If nothing is paid by `
                            + `${prettyDate(addDays(plan.dunning_started_at, TERMINATE_DAY))}, `
                            + `the plan will be ended.</p>`,
                        smsText: `Diamondback Coding: ${plan.label} is suspended for non-payment. `
                               + 'Update your card in your portal to restart it.',
                        channels: ['email', 'sms', 'portal'],
                        cta: { url: PORTAL_URL, label: 'Update payment method' },
                    }).catch(() => {});
                    out.suspended += 1;
                }
                continue;
            }

            // ---- RETRY --------------------------------------------------
            if (s.stage === 'retry') {
                const res = await chargeMaintenancePlan(plan).catch(() => null);
                out.retried += 1;
                if (res && res.ok !== false) continue;   // succeeded; charge path clears dunning

                // Halfway warnings, so suspension is never a surprise.
                if (s.age >= 5 && !plan.suspended_at) {
                    await notify({
                        lead, kind: 'maintenance_charge_failed',
                        subject: `Still unable to take payment for ${plan.label}`,
                        bodyHtml:
                            `<p style="margin:0 0 12px">We have tried again and the payment for `
                            + `<strong style="color:#0d0f12">${plan.label}</strong> still is not going through.</p>`
                            + `<p style="margin:0 0 12px">${plan.last_failure_reason || ''}</p>`
                            + `<p style="margin:0 0 12px">If it is not resolved, the service will be `
                            + `suspended on <strong style="color:#0d0f12">`
                            + `${prettyDate(addDays(plan.dunning_started_at, SUSPEND_DAY))}</strong>.</p>`,
                        smsText: `Diamondback Coding: ${plan.label} payment still failing. `
                               + `Service suspends ${prettyDate(addDays(plan.dunning_started_at, SUSPEND_DAY))}.`,
                        channels: ['email', 'sms', 'portal'],
                        cta: { url: PORTAL_URL, label: 'Update payment method' },
                    }).catch(() => {});
                    out.warned += 1;
                }
            }
        }

        if (out.retried || out.suspended || out.terminated) {
            console.log(`[DUNNING] ${out.retried} retried, ${out.suspended} suspended, `
                      + `${out.terminated} ended.`);
        }
        return out;
    }

    /** Lift a suspension once they pay — called after a successful charge. */
    async function liftSuspension(leadId) {
        const stillBad = await pool.query(
            `SELECT 1 FROM maintenance_plans
              WHERE lead_id=$1 AND suspended_at IS NOT NULL AND status='suspended' LIMIT 1`,
            [leadId]).catch(() => ({ rows: [] }));
        if (stillBad.rows.length) return false;    // another plan is still suspended
        await pool.query(
            `UPDATE leads SET service_suspended_at=NULL, service_suspended_reason=NULL WHERE id=$1`,
            [leadId]).catch(() => {});
        return true;
    }

    return { recordFailure, clearDunning, runDunningCycle, isSuspended, liftSuspension,
             stageFor, explainDecline, RETRY_DAYS, SUSPEND_DAY, TERMINATE_DAY };
};