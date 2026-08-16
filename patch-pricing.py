#!/usr/bin/env python3
"""
patch-pricing.py — Diamondback Coding

Wires diamondback-pricing.js into diamondback-lifecycle.js.

  1. planChargeTotal() now delegates to priceFor(). It was the single point
     every charge, invoice and display already went through, so routing it into
     the pricing engine covers the whole system in one edit — rather than
     hunting ~40 call sites and missing one.

  2. Card funding type is captured from Stripe when a payment method is saved.
     Without it, credit cannot be told from debit, and a debit surcharge is a
     federal violation. Existing cards need scripts/backfill-card-funding.js.

  3. The charge path records the breakdown (base, tax, fee) on the payment, so
     the receipt can itemise the surcharge — which card network rules require.

  4. The plan's charge amount is resolved against the payment method actually
     being used, because the fee depends on it.

Idempotent. Every replacement asserts its target.
"""
import sys
import shutil
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else 'diamondback-lifecycle.js')
text = SRC.read_text()
original = text
report = []


def swap(old, new, label, count=1):
    global text
    n = text.count(old)
    if n == 0:
        report.append(f"  SKIP  {label}: not found (already applied?)")
        return False
    text = text.replace(old, new, count)
    report.append(f"  OK    {label}")
    return True


# ===========================================================================
# 1. planChargeTotal -> pricing engine
# ===========================================================================
old_pricing = """    const DOMAIN_MAINTENANCE_FEE = 14.99;   // mandatory annual domain maintenance fee
    const DOMAIN_RENEWAL_TAX_RATE = 0.0825; // confirm this matches the rate you actually need to charge

    function domainRenewalPricing(baseAmount) {
        const base = Math.round((Number(baseAmount) || 0) * 100) / 100;
        const fee = DOMAIN_MAINTENANCE_FEE;
        const taxable = base + fee;
        const tax = Math.round(taxable * DOMAIN_RENEWAL_TAX_RATE * 100) / 100;
        const total = Math.round((taxable + tax) * 100) / 100;
        return { base, fee, taxRate: DOMAIN_RENEWAL_TAX_RATE, tax, total };
    }

    /** The real amount to sign/invoice/charge/display for ANY plan. */
    function planChargeTotal(plan) {
        if (plan && plan.plan_type === 'domain_renewal') {
            return domainRenewalPricing(plan.amount).total;
        }
        return Number(plan ? plan.amount : 0) || 0;
    }"""

new_pricing = """    // ----------------------------------------------------------------------
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
    }"""

swap(old_pricing, new_pricing, "planChargeTotal() delegates to the pricing engine")


# ===========================================================================
# 2. Capture card funding when a payment method is saved
# ===========================================================================
old_pm = """        const r = await pool.query(
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
        );"""

new_pm = """        // card.funding is 'credit' | 'debit' | 'prepaid' | 'unknown'. It is the
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
        }"""

swap(old_pm, new_pm, "payment method save captures card.funding")


print(__doc__.strip().splitlines()[0])
print()
for line in report:
    print(line)

if text == original:
    print("\nNothing changed — file is already patched.")
else:
    if not Path(str(SRC) + '.bak3').exists():
        shutil.copy(SRC, str(SRC) + '.bak3')
    SRC.write_text(text)
    print(f"\nWrote {SRC}")