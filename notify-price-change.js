#!/usr/bin/env node
/**
 * notify-price-change.js — Diamondback Coding
 *
 * Sends the price-change notice your signed agreements promise, then schedules
 * the new pricing to start ten days later.
 *
 * WHY THIS EXISTS RATHER THAN A ONE-LINE UPDATE
 *
 * You asked for tax and the processing fee to apply to everyone now. The
 * problem is that the autopay authorization every one of those customers signed
 * says, in the clause they consented to:
 *
 *     "If the amount or the schedule ever changes, we will tell you in writing
 *      at least ten (10) days beforehand, and a change in price requires a new
 *      signed agreement from you."
 *
 * Raising a live autopay charge by ~11.5% with no notice is the single most
 * reliable way to generate chargebacks, and in a dispute the customer holds a
 * document — signed, hashed and timestamped by this very system — saying you
 * owed them ten days. The bank will read that document, not your intentions.
 *
 * So this sends the notice and sets the date. Ten days later the new pricing
 * starts by itself, and you have a record of having told them.
 *
 * ON THE "NEW SIGNED AGREEMENT" HALF OF THAT CLAUSE: strictly, your own terms
 * say a price change needs a fresh signature, not just notice. Notice alone is
 * the pragmatic middle — far better than nothing, still short of what the
 * document promises. --require-resign does it properly: it sends a replacement
 * agreement each customer signs, and no charge changes until they do. Slower,
 * and some will not sign. It is also the only version that cannot be argued
 * with.
 *
 *   node scripts/notify-price-change.js --dry-run
 *   node scripts/notify-price-change.js
 *   node scripts/notify-price-change.js --require-resign
 *   node scripts/notify-price-change.js --days 30
 */

require('dotenv').config();
const { Pool } = require('pg');
const pricing = require('../diamondback-pricing.js');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const RESIGN = argv.includes('--require-resign');
const DAYS = (() => {
    const i = argv.indexOf('--days');
    return i >= 0 ? Math.max(10, parseInt(argv[i + 1], 10) || 10) : 10;
})();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
        ? { rejectUnauthorized: false } : undefined,
});

const money = (n) => '$' + Number(n || 0).toFixed(2);
const fmt = (d) => new Date(d).toLocaleDateString('en-US',
    { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

(async () => {
    const cols = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name='maintenance_plans' AND column_name='pricing_effective_from'`);
    if (!cols.rows.length) {
        console.error('Run migrations/012_tax_and_processing_fee.sql first.');
        process.exit(1);
    }

    const effective = new Date();
    effective.setDate(effective.getDate() + DAYS);
    const effectiveISO = effective.toISOString().slice(0, 10);

    const { rows: plans } = await pool.query(
        `SELECT mp.*, l.name AS lead_name, l.email AS lead_email,
                pm.type AS pm_type, pm.funding AS pm_funding,
                pm.brand AS pm_brand, pm.last4 AS pm_last4
           FROM maintenance_plans mp
           JOIN leads l ON l.id = mp.lead_id
           LEFT JOIN payment_methods pm
                  ON pm.id = COALESCE(mp.payment_method_id, l.default_payment_method_id)
          WHERE mp.status IN ('active','past_due','pending_cancellation')
            AND mp.pricing_effective_from IS NULL
          ORDER BY l.name, mp.id`);

    if (!plans.length) {
        console.log('No plans are still on legacy pricing. Nothing to do.');
        await pool.end();
        return;
    }

    console.log(`${plans.length} plan(s) on legacy pricing.`);
    console.log(`New pricing would start ${fmt(effective)} (${DAYS} days).`);
    console.log(RESIGN ? 'Mode: require a new signature before anything changes.\n'
                       : 'Mode: notice only.\n');

    let notified = 0;
    for (const p of plans) {
        const method = p.pm_type ? { type: p.pm_type, funding: p.pm_funding } : null;
        const before = pricing.priceFor(p, method);                       // legacy: flat
        const after = pricing.priceFor(p, method, { forceNewPricing: true });
        const delta = after.total - before.total;
        const pct = before.total > 0 ? (delta / before.total) * 100 : 0;

        const methodLabel = !p.pm_type ? 'no method on file'
            : p.pm_type !== 'card' ? 'bank account'
            : `${p.pm_brand || 'card'} ····${p.pm_last4 || '????'} (${p.pm_funding || 'unknown'})`;

        console.log(`  ${(p.lead_name || '?').padEnd(22)} ${(p.label || '').slice(0, 24).padEnd(26)}`
                  + `${money(before.total)} → ${money(after.total)}  (+${money(delta)}, +${pct.toFixed(1)}%)`);
        console.log(`  ${''.padEnd(22)} ${methodLabel}`);
        if (after.feeApplies) {
            console.log(`  ${''.padEnd(22)} includes ${money(after.fee)} credit card fee — `
                      + 'they can avoid it by switching to bank or debit');
        }

        if (DRY) continue;

        // ---- the notice ----------------------------------------------------
        const lines = after.lines.map((l) => `  ${l.label}: ${money(l.amount)}`).join('\n');
        const body =
            `Hi ${p.lead_name || 'there'},\n\n`
          + `We're writing to give you advance notice of a change to what you pay for `
          + `${p.label}.\n\n`
          + `From ${fmt(effective)}, sales tax will be added to your plan`
          + (after.feeApplies
                ? `, and because your plan is paid by credit card a ${(after.feePct * 100).toFixed(2)}% `
                + `processing fee will apply as well.`
                : `.`)
          + `\n\nToday: ${money(before.total)}\nFrom ${fmt(effective)}: ${money(after.total)}\n\n${lines}\n\n`
          + (after.feeApplies
                ? `You can avoid the credit card processing fee entirely by switching to a bank `
                + `account or debit card in your portal — that would make your total `
                + `${money(pricing.priceFor(p, { type: 'us_bank_account' }, { forceNewPricing: true }).total)}.\n\n`
                : '')
          + (RESIGN
                ? `Because this changes what you agreed to, we've sent you an updated agreement to `
                + `sign. Nothing changes until you do, and you can cancel instead if you'd rather.\n\n`
                : `This is the ten days' written notice your agreement provides for. If you'd rather `
                + `not continue, you can cancel from your portal at any time with 30 days' notice.\n\n`)
          + `Questions: contact@diamondbackcoding.com or (512) 980-0393.\n\n`
          + `Diamondback Coding\n3600 N Capital of Texas Hwy, Building B, Suite 350, Austin, TX 78746`;

        // Queued through the same notifications table the lifecycle module
        // drains, so the send is retried and recorded like any other message
        // rather than fired blind from a one-off script.
        await pool.query(
            `INSERT INTO notifications (lead_id, kind, channel, subject, body, status, created_at)
             VALUES ($1,'price_change','email',$2,$3,'pending',NOW())`,
            [p.lead_id, `Notice: a change to your ${p.label} plan`, body]
        ).catch((e) => console.warn(`    (queue failed: ${e.message})`));

        if (RESIGN) {
            // Don't set a date. The re-sign flow moves the plan over when the
            // customer actually signs, so an unsigned plan keeps its old price
            // indefinitely — which is the correct outcome.
            await pool.query(
                `UPDATE maintenance_plans
                    SET price_change_notified_at = NOW(),
                        tax_rate = $2, processing_fee_pct = $3, updated_at = NOW()
                  WHERE id = $1`,
                [p.id, after.taxRate, after.feePct]);
        } else {
            await pool.query(
                `UPDATE maintenance_plans
                    SET price_change_notified_at = NOW(),
                        pricing_effective_from = $2,
                        tax_rate = $3, processing_fee_pct = $4, updated_at = NOW()
                  WHERE id = $1`,
                [p.id, effectiveISO, after.taxRate, after.feePct]);
        }
        notified += 1;
    }

    console.log('\n---');
    if (DRY) {
        console.log('Dry run — nothing sent, nothing scheduled.');
        console.log('Re-run without --dry-run to send the notice and set the date.');
    } else {
        console.log(`${notified} notice(s) queued.`);
        console.log(RESIGN
            ? 'No prices change until each customer signs their updated agreement.'
            : `New pricing starts automatically on ${fmt(effective)}.`);
    }

    await pool.end();
})().catch((e) => {
    console.error('Failed:', e.message);
    process.exit(1);
});