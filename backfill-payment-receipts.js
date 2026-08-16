#!/usr/bin/env node
/**
 * backfill-payment-receipts.js — Diamondback Coding
 *
 * Creates the missing `payments` rows for invoices that were paid before the
 * ledger fix shipped.
 *
 * THE PROBLEM THIS REPAIRS
 *
 * markInvoicePaidById() marked invoices paid and never wrote to `payments`.
 * Only the recurring autopay charger touched the ledger. So every invoice a
 * customer paid by hand — deposits, project balances, cancellation settlements
 * — shows under Invoices as "paid" and NOWHERE under Receipts, in Billing or in
 * Docs, with no downloadable receipt, because the receipt route resolves from a
 * payments row.
 *
 * That is now fixed going forward. This fixes the ones already in the database.
 *
 * WHAT IT USES
 *   invoices.paid_at           when it was paid
 *   invoices.payment_reference the Stripe payment intent (the idempotency key)
 *   invoices.total_amount      what was paid
 *   invoices.subtotal/tax_amount/processing_fee   the breakdown, where present
 *
 * WHAT IT WILL NOT DO
 *   * touch an invoice that already has a payments row
 *   * invent a payment for an invoice that was never actually paid
 *   * change any invoice, plan, or amount — it only inserts ledger rows
 *
 * Idempotent: safe to run repeatedly. Run the dry run first.
 *
 *   node scripts/backfill-payment-receipts.js --dry-run
 *   node scripts/backfill-payment-receipts.js
 *   node scripts/backfill-payment-receipts.js --lead 7      # one customer
 */

require('dotenv').config();
const { Pool } = require('pg');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const LEAD = (() => {
    const i = argv.indexOf('--lead');
    return i >= 0 ? parseInt(argv[i + 1], 10) : null;
})();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
        ? { rejectUnauthorized: false } : undefined,
});

const money = (n) => '$' + Number(n || 0).toFixed(2);
const short = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

(async () => {
    const cols = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='payments'`);
    const has = new Set(cols.rows.map((c) => c.column_name));
    const extended = has.has('base_amount') && has.has('tax_amount') && has.has('processing_fee');
    const hasReceiptNo = has.has('receipt_number');

    if (!hasReceiptNo) {
        console.error('payments.receipt_number does not exist.\n'
                    + 'Run migrations/011_autopay_receipts_and_outstanding.sql first.');
        process.exit(1);
    }
    if (!extended) {
        console.warn('NOTE: payments lacks the breakdown columns (migration 012). '
                   + 'Receipts will show a total but not the tax/fee split.\n');
    }

    // Paid invoices with no ledger row. Matched on invoice_id, and also on the
    // payment intent — a payment may exist against the intent without the
    // invoice_id having been set, and double-inserting would double the
    // customer's visible "total paid".
    // The optional --lead filter is appended rather than passed as a nullable
    // parameter: `$1::int IS NULL OR i.lead_id = $1` reads cleverly and behaves
    // differently across engines. A plain conditional clause does not.
    const { rows } = await pool.query(
        `SELECT i.*, l.name AS lead_name
           FROM invoices i
           LEFT JOIN leads l ON l.id = i.lead_id
           -- Two ways a ledger row may already exist: linked by invoice_id, or
           -- linked only by the Stripe payment intent (the autopay charger sets
           -- the intent but not always the invoice). Both must exclude the
           -- invoice, or the backfill doubles the customer's total paid.
           LEFT JOIN payments byinv ON byinv.invoice_id = i.id
           LEFT JOIN payments bypi  ON i.payment_reference IS NOT NULL
                                   AND bypi.stripe_payment_intent_id = i.payment_reference
          WHERE i.status = 'paid'
            AND byinv.id IS NULL
            AND bypi.id IS NULL
            ${LEAD ? 'AND i.lead_id = $1' : ''}
          ORDER BY i.paid_at NULLS LAST, i.id`,
        LEAD ? [LEAD] : []);

    if (!rows.length) {
        console.log('Every paid invoice already has a receipt. Nothing to do.');
        await pool.end();
        return;
    }

    console.log(`${rows.length} paid invoice(s) with no receipt`
              + `${DRY ? ' (dry run — nothing will be written)' : ''}.\n`);

    let written = 0;
    let skipped = 0;

    for (const inv of rows) {
        // paid_at is the truth about when. Fall back to the issue date rather
        // than stamping today, which would put a 2026 receipt on a 2025
        // payment and quietly corrupt the customer's history.
        const paidAt = inv.paid_at || inv.updated_at || inv.created_at;
        if (!paidAt) {
            console.log(`  SKIP  ${inv.invoice_number} — marked paid but has no date anywhere.`);
            skipped += 1;
            continue;
        }

        const total = Number(inv.total_amount || 0);
        const tax = Number(inv.tax_amount || 0);
        const fee = Number(inv.processing_fee || 0);
        const base = inv.subtotal != null ? Number(inv.subtotal) : Math.max(0, total - tax - fee);

        // Deterministic receipt number, derived from the invoice id. A receipt
        // downloaded today and one downloaded next year are then identical, and
        // re-running this script cannot mint a second number for the same
        // payment.
        const receiptNo = `RCPT-INV${String(inv.id).padStart(6, '0')}`;

        const method = /bank|ach/i.test(inv.payment_method || '') ? 'us_bank_account' : 'card';
        const kind = inv.maintenance_plan_id ? 'maintenance' : 'invoice';

        console.log(`  ${short(paidAt)}  ${(inv.invoice_number || '').padEnd(16)}`
                  + `${money(total).padStart(11)}  ${(inv.lead_name || '—').slice(0, 20).padEnd(22)}`
                  + `${receiptNo}`);
        if (tax > 0 || fee > 0) {
            console.log(`              base ${money(base)}  tax ${money(tax)}  fee ${money(fee)}`);
        }

        if (DRY) continue;

        try {
            if (extended) {
                await pool.query(
                    `INSERT INTO payments
                        (lead_id, invoice_id, maintenance_plan_id, amount, method, kind, description,
                         status, stripe_payment_intent_id, receipt_number,
                         base_amount, tax_amount, processing_fee, paid_at, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9,$10,$11,$12,$13,$14)
                     ON CONFLICT DO NOTHING`,
                    [inv.lead_id, inv.id, inv.maintenance_plan_id || null, total, method, kind,
                     `Invoice ${inv.invoice_number}`, inv.payment_reference || null, receiptNo,
                     base, tax, fee, paidAt, paidAt]);
            } else {
                await pool.query(
                    `INSERT INTO payments
                        (lead_id, invoice_id, maintenance_plan_id, amount, method, kind, description,
                         status, stripe_payment_intent_id, receipt_number, paid_at, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9,$10,$11)
                     ON CONFLICT DO NOTHING`,
                    [inv.lead_id, inv.id, inv.maintenance_plan_id || null, total, method, kind,
                     `Invoice ${inv.invoice_number}`, inv.payment_reference || null, receiptNo,
                     paidAt, paidAt]);
            }
            written += 1;
        } catch (e) {
            console.log(`  ERROR ${inv.invoice_number}: ${e.message}`);
            skipped += 1;
        }
    }

    console.log('\n---');
    if (DRY) {
        console.log(`${rows.length} receipt(s) would be created.`);
        console.log('Re-run without --dry-run to write them.');
    } else {
        console.log(`${written} receipt(s) created${skipped ? `, ${skipped} skipped` : ''}.`);
        console.log('They now appear under Billing → Payment history and Docs → Receipts,');
        console.log('each with a downloadable PDF.');
    }

    await pool.end();
})().catch((e) => {
    console.error('Failed:', e.message);
    process.exit(1);
});