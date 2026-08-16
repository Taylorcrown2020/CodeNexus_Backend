// ============================================================================
// diamondback-pricing.js — Diamondback Coding
//
// ONE PLACE THAT DECIDES WHAT A CUSTOMER IS CHARGED.
//
// Before this, `plan.amount` was read directly in some places and through
// planChargeTotal() in others, and domain renewals had their own arithmetic
// inline. Adding tax and a processing fee to that would have produced a
// different total depending on which code path you came through — the signed
// agreement saying one number, the Stripe charge another, the receipt a third.
//
// Everything now goes through priceFor(). If it doesn't, it's a bug.
//
// ────────────────────────────────────────────────────────────────────────────
// THE FEE IS CREDIT-ONLY, AND THAT IS A LEGAL CONSTRAINT, NOT A SETTING
// ────────────────────────────────────────────────────────────────────────────
// Surcharging a DEBIT or PREPAID card is prohibited by federal law (Durbin
// Amendment, 15 U.S.C. 1693o-2). It does not matter what the state allows or
// what the customer agreed to.
//
// So the fee is applied ONLY when we positively know the card is credit.
// 'unknown' — which is what every card reads as until the Stripe backfill has
// run — is treated as not surchargeable. Undercharging by 3% costs a few
// dollars. Surcharging a debit card is a federal violation and a card-network
// one, and the customer can and will get it reversed.
//
// ORDER OF OPERATIONS (as specified):
//     base
//   + tax        = base × taxRate
//   = taxed
//   + fee        = taxed × feePct        (credit cards only)
//   = total
// The fee is calculated on the taxed figure because that is what actually runs
// through the card, and the 3% is the cost of running it.
// ============================================================================

// Texas state + local. The document states the rate it was signed under, and
// plans store their own, so changing this does not retroactively move anyone.
const DEFAULT_TAX_RATE = Number(process.env.SALES_TAX_RATE || 0.0825);

// Card network rules cap a credit surcharge at the LOWER of 4% (Visa/MC) or
// your own effective discount rate. 3% is only compliant if you actually pay
// at least 3% to process — check your Stripe effective rate before relying on
// it. Stripe's headline 2.9% + 30¢ is above 3% on small tickets and below it
// on large ones.
const DEFAULT_FEE_PCT = Number(process.env.CARD_PROCESSING_FEE_PCT || 0.03);

// Mandatory annual domain maintenance fee, added before tax.
const DOMAIN_MAINTENANCE_FEE = Number(process.env.DOMAIN_MAINTENANCE_FEE || 14.99);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Is this payment method surchargeable?
 *
 * Only a confirmed credit card is. Everything else — debit, prepaid, unknown,
 * bank account, or no method on file at all — is not.
 */
function isSurchargeable(method) {
    if (!method) return false;
    if (method.type && method.type !== 'card') return false;   // ACH, never
    return String(method.funding || 'unknown').toLowerCase() === 'credit';
}

/**
 * Has this plan been moved onto tax-and-fee pricing yet?
 *
 * NULL pricing_effective_from means no — the plan keeps the flat amount its
 * customer signed for. A date means the new pricing applies to charges on or
 * after it. This is what stops migration 012 from silently raising the price
 * of every live autopay plan the moment it runs.
 */
function pricingActive(plan, asOf = new Date()) {
    if (!plan || !plan.pricing_effective_from) return false;
    const from = new Date(plan.pricing_effective_from);
    if (isNaN(from)) return false;
    return asOf >= from;
}

/**
 * THE function. Returns a full breakdown, never just a number, so a caller
 * can't accidentally display the base while charging the total.
 *
 * @param {object}  plan    maintenance_plans row
 * @param {object}  method  payment_methods row, or null
 * @param {object}  opts    { asOf, forceNewPricing } — forceNewPricing quotes
 *                          the new pricing for a plan not yet switched over,
 *                          which is what the notice email and the signing
 *                          preview need.
 *
 * @returns {{base, maintenanceFee, taxRate, tax, taxed, feePct, fee,
 *            feeApplies, feeReason, total, lines}}
 */
function priceFor(plan, method = null, opts = {}) {
    const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
    const p = plan || {};

    const base = round2(p.amount);

    // Domain renewals carry a mandatory maintenance fee, added before tax.
    const maintenanceFee = p.plan_type === 'domain_renewal' ? DOMAIN_MAINTENANCE_FEE : 0;
    const subtotal = round2(base + maintenanceFee);

    const active = opts.forceNewPricing || pricingActive(p, asOf);

    // A plan not yet switched over is charged exactly what it always was.
    // No tax line, no fee line, no change to the amount.
    if (!active) {
        return {
            base, maintenanceFee, subtotal,
            taxRate: 0, tax: 0, taxed: subtotal,
            feePct: 0, fee: 0, feeApplies: false,
            feeReason: 'legacy_pricing',
            total: subtotal,
            newPricing: false,
            lines: buildLines({ base, maintenanceFee, tax: 0, taxRate: 0, fee: 0, feePct: 0, planType: p.plan_type }),
        };
    }

    const taxRate = p.tax_rate != null ? Number(p.tax_rate) : DEFAULT_TAX_RATE;
    const tax = round2(subtotal * taxRate);
    const taxed = round2(subtotal + tax);

    const feePct = p.processing_fee_pct != null ? Number(p.processing_fee_pct) : DEFAULT_FEE_PCT;
    const feeApplies = isSurchargeable(method);
    const fee = feeApplies ? round2(taxed * feePct) : 0;

    // Why the fee is or isn't there, so the UI and the receipt can say so
    // rather than leaving the customer to guess.
    let feeReason;
    if (feeApplies) feeReason = 'credit_card';
    else if (!method) feeReason = 'no_method';
    else if (method.type && method.type !== 'card') feeReason = 'bank_account';
    else {
        const f = String(method.funding || 'unknown').toLowerCase();
        feeReason = f === 'unknown' ? 'funding_unknown' : f;  // 'debit' | 'prepaid'
    }

    return {
        base, maintenanceFee, subtotal,
        taxRate, tax, taxed,
        feePct, fee, feeApplies, feeReason,
        total: round2(taxed + fee),
        newPricing: true,
        lines: buildLines({ base, maintenanceFee, tax, taxRate, fee, feePct, planType: p.plan_type }),
    };
}

/** Human-readable breakdown, shared by the portal, the PDF and the email. */
function buildLines({ base, maintenanceFee, tax, taxRate, fee, feePct, planType }) {
    const lines = [{
        label: planType === 'domain_renewal' ? 'Domain renewal' : 'Plan',
        amount: base,
    }];
    if (maintenanceFee > 0) lines.push({ label: 'Domain maintenance fee', amount: maintenanceFee });
    if (tax > 0) lines.push({ label: `Sales tax (${(taxRate * 100).toFixed(3).replace(/\.?0+$/, '')}%)`, amount: tax });
    if (fee > 0) {
        lines.push({
            // Named explicitly as a credit-card surcharge. Card network rules
            // require the surcharge be disclosed as such on the receipt — a
            // vague "service fee" does not satisfy that.
            label: `Credit card processing fee (${(feePct * 100).toFixed(2).replace(/\.?0+$/, '')}%)`,
            amount: fee,
        });
    }
    return lines;
}

/** One sentence explaining the fee, or how to avoid it. */
function feeExplanation(price) {
    if (!price.newPricing) return null;
    if (price.feeApplies) {
        return `A ${(price.feePct * 100).toFixed(2).replace(/\.?0+$/, '')}% processing fee applies because this `
             + 'is a credit card. Paying by bank account or debit card avoids it.';
    }
    switch (price.feeReason) {
        case 'bank_account':
            return 'No processing fee — bank payments are not surcharged.';
        case 'debit':
        case 'prepaid':
            return 'No processing fee — debit cards are not surcharged.';
        case 'no_method':
            return 'A 3% processing fee applies to credit cards. Bank or debit payments avoid it.';
        case 'funding_unknown':
            // Honest about the state of the world rather than inventing a
            // reason. The customer is being undercharged, which is fine.
            return 'No processing fee applied.';
        default:
            return null;
    }
}

/**
 * What the AGREEMENT says, before any payment method exists.
 *
 * A signed document can't state one final number, because the total depends on
 * how they choose to pay. It states the base, the tax, and the conditional fee
 * — which is also the disclosure the card networks require.
 */
function agreementPricingSentence(plan, interval = 'month') {
    const withFee = priceFor(plan, { type: 'card', funding: 'credit' }, { forceNewPricing: true });
    const without = priceFor(plan, { type: 'us_bank_account' }, { forceNewPricing: true });
    const per = interval === 'year' ? 'per year' : 'per month';
    const money = (n) => '$' + Number(n).toFixed(2);

    return `${money(without.total)} ${per} (${money(without.subtotal)} plus `
         + `${(withFee.taxRate * 100).toFixed(3).replace(/\.?0+$/, '')}% sales tax) when paid by bank account or `
         + `debit card, or ${money(withFee.total)} ${per} when paid by credit card, which includes a `
         + `${(withFee.feePct * 100).toFixed(2).replace(/\.?0+$/, '')}% credit card processing fee`;
}

module.exports = {
    DEFAULT_TAX_RATE,
    DEFAULT_FEE_PCT,
    DOMAIN_MAINTENANCE_FEE,
    priceFor,
    isSurchargeable,
    pricingActive,
    feeExplanation,
    agreementPricingSentence,
    buildLines,
    round2,
};