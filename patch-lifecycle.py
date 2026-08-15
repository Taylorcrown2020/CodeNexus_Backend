#!/usr/bin/env python3
"""
patch-lifecycle.py — Diamondback Coding

Applies four changes to diamondback-lifecycle.js:

  1. EMAIL CONTRAST. Thirteen table cells still carried `color:#fff` from the
     old dark email theme. The shell was converted to a light theme, so those
     are white text on a #f7f8f9 panel: invisible. Receipt numbers, invoice
     numbers, payment methods and preferred dates were all disappearing in
     customers' inboxes.

  2. AUSTIN ADDRESS. The email footer still said Dallas-Fort Worth.

  3. AUTOPAY IN THE AGREEMENT TERMS. The maintenance agreement's generated
     `terms` said payment was "charged automatically" but never presented that
     as an authorization the customer is granting by signing. It now does, and
     the autopay_* columns from migration 011 are populated at creation.

  4. PERIOD SETTLEMENT. After a successful recurring charge the plan's current
     period is closed and the next one opened, which is what makes the monthly
     outstanding rule work.

Every replacement asserts its target was found, so a silent no-op is impossible.
Idempotent: re-running finds nothing to do and says so.
"""
import re
import sys
import shutil
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else 'diamondback-lifecycle.js')
text = SRC.read_text()
original = text
report = []


def sub_all(pattern, repl, label, expect_min=1, regex=True):
    """Replace and report. Fails loudly if the target isn't there."""
    global text
    if regex:
        new, n = re.subn(pattern, repl, text)
    else:
        n = text.count(pattern)
        new = text.replace(pattern, repl)
    if n < expect_min:
        report.append(f"  SKIP  {label}: 0 matches (already applied?)")
    else:
        report.append(f"  OK    {label}: {n} replacement(s)")
    text = new
    return n


# ===========================================================================
# 1. EMAIL CONTRAST
# ===========================================================================
# The value cells in every inline key/value table. #fff on the #f7f8f9 panel
# these sit in is a 1.05:1 contrast ratio — literally unreadable. #0d0f12 is
# the ink the rest of the light shell already uses (15.5:1).
sub_all(r'color:#fff(?![0-9a-fA-F])', 'color:#0d0f12', 'email value cells (#fff -> ink)')

# The same panel used a light green for amounts. #16a34a on #f7f8f9 is 3.0:1 —
# under the 4.5:1 floor at the 17px it's used at. #15803d is 4.7:1.
sub_all(r'color:#16a34a', 'color:#15803d', 'email amount green (contrast floor)')

# Red used for past-due amounts, same problem.
sub_all(r'color:#(?:ef4444|dc2626)(?![0-9a-fA-F])', 'color:#a33a11',
        'email attention red (contrast floor)')

# Gold on white is 1.9:1 and must never carry text. If any survived the theme
# conversion, they'd be invisible too.
sub_all(r'color:#[dD]4[aA]574', 'color:#0d0f12', 'legacy gold text (unreadable on light)')


# ===========================================================================
# 2. AUSTIN ADDRESS
# ===========================================================================
sub_all(
    'Diamondback Coding &middot; Dallas&ndash;Fort Worth, TX',
    'Diamondback Coding &middot; 3600 N Capital of Texas Hwy, Building B, Suite 350, Austin, TX 78746',
    'email footer address (DFW -> Austin)', regex=False)

# Any other DFW mention in copy.
sub_all(r'Dallas&ndash;Fort Worth, TX', 'Austin, TX', 'remaining DFW mentions (html entity)')
sub_all(r'Dallas\\u2013Fort Worth, TX', 'Austin, TX', 'remaining DFW mentions (escape)')
sub_all(r'Dallas–Fort Worth, TX', 'Austin, TX', 'remaining DFW mentions (literal)')


# ===========================================================================
# 3. AUTOPAY IN THE MAINTENANCE AGREEMENT
# ===========================================================================
# The INSERT that creates the plan's agreement. Two changes: store the autopay
# columns (011), and make the terms text an actual authorization.
old_insert = """                const ag = await pool.query(
                    `INSERT INTO sales_agreements
                        (agreement_number, lead_id, customer_name, customer_email, service_type,
                         package_name, price, status, agreement_kind, intro, terms, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'sent','maintenance',$8,$9,NOW(),NOW())
                     RETURNING *`,"""

new_insert = """                // autopay_* are written here, at creation, so the SIGNED
                // document carries its own record of what was authorized. A
                // later edit to maintenance_plans then cannot silently restate
                // what the customer agreed to — which is the whole point of
                // storing it on the agreement rather than reading the plan.
                const ag = await pool.query(
                    `INSERT INTO sales_agreements
                        (agreement_number, lead_id, customer_name, customer_email, service_type,
                         package_name, price, status, agreement_kind, intro, terms,
                         autopay, autopay_interval, autopay_amount, autopay_day,
                         billing_start_date, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'sent','maintenance',$8,$9,
                             TRUE,$10,$7,$11,$12,NOW(),NOW())
                     RETURNING *`,"""

if old_insert in text:
    text = text.replace(old_insert, new_insert)
    report.append("  OK    maintenance agreement INSERT: autopay columns added")
else:
    report.append("  SKIP  maintenance agreement INSERT: not found (already applied?)")

# The terms string, and the parameter list that follows it.
old_terms = """                     `This plan renews ${unit === 'year' ? 'annually' : 'monthly'} at ${money(totalToSign)}${breakdown}. Payment is charged automatically to the payment method saved on your account. ` +
                     `You may cancel at any time from your customer portal; cancellation takes effect ${CANCELLATION_NOTICE_DAYS} days after the request, ` +
                     `and service continues until that date.`]
                );"""

new_terms = """                     // The customer-facing authorization. Worded as consent
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
                     `bank details, ACH debits, and continues for each billing period until you cancel it.\\n\\n` +
                     `You are responsible for keeping a valid payment method on file. A declined charge may be retried and any ` +
                     `unpaid amount is subject to late charges.\\n\\n` +
                     `TO STOP AUTOMATIC PAYMENTS: cancel the plan from your customer portal at any time, or email ` +
                     `contact@diamondbackcoding.com. Cancellation takes effect ${CANCELLATION_NOTICE_DAYS} days after we receive ` +
                     `your request; charges falling due within that notice period remain payable and service continues until ` +
                     `the cancellation date.\\n\\n` +
                     `If the amount or schedule ever changes we will tell you in writing at least ten (10) days beforehand, and ` +
                     `a change in price requires a new signed agreement from you.`,
                     unit, day, dateOnly(firstCharge)]
                );"""

if old_terms in text:
    text = text.replace(old_terms, new_terms)
    report.append("  OK    maintenance agreement terms: autopay authorization language")
else:
    report.append("  SKIP  maintenance agreement terms: not found (already applied?)")

# ordinalDay helper, next to the other small helpers. "day 1" reads like a bug
# to a customer; "the 1st" reads like a date.
anchor = "    const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);"
helper = anchor + """
    /** 1st / 2nd / 3rd — autopay copy says "the 12th", never "day 12". */
    const ordinalDay = (n) => {
        const v = Number(n);
        if (!v || v < 1 || v > 31) return 'same day';
        const s = ['th', 'st', 'nd', 'rd'];
        const m = v % 100;
        return v + (s[(m - 20) % 10] || s[m] || s[0]);
    };"""
if anchor in text and 'const ordinalDay' not in text:
    text = text.replace(anchor, helper, 1)
    report.append("  OK    ordinalDay() helper added")
else:
    report.append("  SKIP  ordinalDay() helper: already present or anchor missing")


# ===========================================================================
# 4. PERIOD SETTLEMENT AFTER A SUCCESSFUL RECURRING CHARGE
# ===========================================================================
# Without this, a monthly plan charged today would still read as outstanding,
# because nothing ever closes the period that migration 011 opened.
old_next = """    app.get('/api/portal/plans', authenticatePortal, async (req, res) => {"""
new_next = """    /**
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

""" + old_next

if old_next in text and 'settlePlanPeriod' not in text:
    text = text.replace(old_next, new_next, 1)
    report.append("  OK    settlePlanPeriod() added")
else:
    report.append("  SKIP  settlePlanPeriod(): already present or anchor missing")


# ===========================================================================
# Write
# ===========================================================================
print(__doc__.strip().splitlines()[0])
print()
for line in report:
    print(line)

if text == original:
    print("\nNothing changed — file is already patched.")
else:
    shutil.copy(SRC, str(SRC) + '.bak')
    SRC.write_text(text)
    print(f"\nWrote {SRC} (backup at {SRC}.bak)")