#!/usr/bin/env node
/**
 * backfill-card-funding.js — Diamondback Coding
 *
 * Fills in payment_methods.funding from Stripe.
 *
 * WHY THIS HAS TO RUN BEFORE THE PROCESSING FEE EARNS YOU ANYTHING
 *
 * The 3% fee is credit-card-only, because surcharging a debit or prepaid card
 * is prohibited by federal law (Durbin Amendment). Telling them apart needs
 * Stripe's card.funding value, which this database never stored.
 *
 * Until a card has been checked, it reads 'unknown', and the pricing engine
 * treats unknown as NOT surchargeable. So before this runs, every existing
 * customer pays base + tax and no fee. That is the safe failure direction —
 * you lose 3% on some credit cards rather than illegally surcharging a debit
 * card — but it does mean the fee earns nothing on existing customers until
 * this has been run.
 *
 * Read-only against Stripe. Touches nothing but the funding columns.
 *
 *   node scripts/backfill-card-funding.js --dry-run
 *   node scripts/backfill-card-funding.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const DRY = process.argv.includes('--dry-run');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
        ? { rejectUnauthorized: false } : undefined,
});

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY is not set. Nothing to do.');
    process.exit(1);
}
const stripe = require('stripe')(stripeKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    // Guard: the columns arrive with migration 012.
    const cols = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name='payment_methods' AND column_name='funding'`);
    if (!cols.rows.length) {
        console.error('payment_methods.funding does not exist.\n'
                    + 'Run migrations/012_tax_and_processing_fee.sql first.');
        process.exit(1);
    }

    const { rows } = await pool.query(
        `SELECT id, stripe_pm_id, brand, last4, lead_id
           FROM payment_methods
          WHERE type = 'card' AND status = 'active'
            AND (funding IS NULL OR funding = 'unknown')
          ORDER BY id`);

    if (!rows.length) {
        console.log('Every active card already has a funding type. Nothing to do.');
        await pool.end();
        return;
    }

    console.log(`${rows.length} card(s) to check${DRY ? ' (dry run — nothing will be written)' : ''}.\n`);

    const tally = { credit: 0, debit: 0, prepaid: 0, unknown: 0, missing: 0, error: 0 };

    for (const pm of rows) {
        const label = `#${pm.id} ${pm.brand || 'card'} ····${pm.last4 || '????'}`;
        try {
            const sp = await stripe.paymentMethods.retrieve(pm.stripe_pm_id);
            const funding = String((sp.card && sp.card.funding) || 'unknown').toLowerCase();
            tally[funding] = (tally[funding] || 0) + 1;

            const note = funding === 'credit' ? '→ 3% fee will apply'
                       : funding === 'unknown' ? '→ no fee (Stripe could not say)'
                       : '→ no fee (surcharge prohibited)';
            console.log(`  ${label.padEnd(28)} ${funding.padEnd(8)} ${note}`);

            if (!DRY) {
                await pool.query(
                    'UPDATE payment_methods SET funding=$2, funding_checked_at=NOW() WHERE id=$1',
                    [pm.id, funding]);
            }
        } catch (e) {
            // A payment method deleted in Stripe, or a key from a different
            // account. Left as 'unknown', which means no fee — safe.
            if (e && e.code === 'resource_missing') {
                tally.missing += 1;
                console.log(`  ${label.padEnd(28)} gone     → not in Stripe; left as unknown`);
            } else {
                tally.error += 1;
                console.log(`  ${label.padEnd(28)} ERROR    ${e.message}`);
            }
        }
        // Stripe's read limit is generous, but there is no reason to sprint.
        await sleep(120);
    }

    console.log('\n---');
    console.log(`  credit  ${tally.credit}   (these will be surcharged)`);
    console.log(`  debit   ${tally.debit}`);
    console.log(`  prepaid ${tally.prepaid}`);
    console.log(`  unknown ${tally.unknown + tally.missing}   (no fee — safe default)`);
    if (tally.error) console.log(`  errors  ${tally.error}`);
    if (DRY) console.log('\nDry run — nothing written. Re-run without --dry-run to apply.');

    await pool.end();
})().catch((e) => {
    console.error('Failed:', e.message);
    process.exit(1);
});