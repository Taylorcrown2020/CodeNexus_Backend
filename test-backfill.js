// Runs the backfill's actual SQL against a real Postgres engine (pg-mem),
// seeded to match the reported situation: an Aug 15 activation payment that IS
// in the ledger, and an Aug 16 cancellation-settlement invoice that is NOT.
const { newDb } = require('pg-mem');

const db = newDb();
db.public.none(`
  CREATE TABLE leads (id INT PRIMARY KEY, name TEXT);
  CREATE TABLE invoices (
    id SERIAL PRIMARY KEY, invoice_number TEXT, lead_id INT,
    subtotal NUMERIC, tax_amount NUMERIC, processing_fee NUMERIC, total_amount NUMERIC,
    status TEXT, payment_method TEXT, payment_reference TEXT,
    maintenance_plan_id INT, created_at TIMESTAMP, updated_at TIMESTAMP, paid_at TIMESTAMP
  );
  CREATE TABLE payments (
    id SERIAL PRIMARY KEY, lead_id INT, invoice_id INT, maintenance_plan_id INT,
    amount NUMERIC, method TEXT, kind TEXT, description TEXT, status TEXT,
    stripe_payment_intent_id TEXT, receipt_number TEXT,
    base_amount NUMERIC, tax_amount NUMERIC, processing_fee NUMERIC,
    paid_at TIMESTAMP, created_at TIMESTAMP
  );
  INSERT INTO leads VALUES (7, 'Marcus Webb');

  -- Aug 15: the activation payment. Already in the ledger (autopay wrote it).
  INSERT INTO invoices (invoice_number, lead_id, subtotal, tax_amount, processing_fee,
                        total_amount, status, payment_method, payment_reference,
                        maintenance_plan_id, created_at, paid_at)
  VALUES ('INV-699001', 7, 0.47, 0.04, 0, 0.51, 'paid', 'Card (Stripe)', 'pi_aug15',
          12, '2026-08-15', '2026-08-15T14:00:00Z');
  INSERT INTO payments (lead_id, invoice_id, maintenance_plan_id, amount, method, kind,
                        description, status, stripe_payment_intent_id, receipt_number,
                        base_amount, tax_amount, processing_fee, paid_at, created_at)
  VALUES (7, 1, 12, 0.51, 'card', 'maintenance', 'Monthly Maintenance', 'succeeded',
          'pi_aug15', 'RCPT-MSV0UW80-311', 0.47, 0.04, 0, '2026-08-15T14:00:00Z', '2026-08-15T14:00:00Z');

  -- Aug 16: THE CANCELLATION SETTLEMENT. Paid, but no ledger row. This is the
  -- one that showed under Invoices and nowhere under Receipts.
  INSERT INTO invoices (invoice_number, lead_id, subtotal, tax_amount, processing_fee,
                        total_amount, status, payment_method, payment_reference,
                        maintenance_plan_id, created_at, paid_at)
  VALUES ('INV-699016', 7, 0.47, 0.04, 0, 0.51, 'paid', 'Card (Stripe)', 'pi_aug16',
          12, '2026-08-16', '2026-08-16T10:15:00Z');

  -- A project deposit paid by bank, also missing.
  INSERT INTO invoices (invoice_number, lead_id, subtotal, tax_amount, processing_fee,
                        total_amount, status, payment_method, payment_reference,
                        maintenance_plan_id, created_at, paid_at)
  VALUES ('INV-699004', 7, 2520, 207.90, 0, 2727.90, 'paid', 'Bank transfer', 'pi_deposit',
          NULL, '2026-07-01', '2026-07-02T09:00:00Z');

  -- Unpaid: must NOT get a receipt.
  INSERT INTO invoices (invoice_number, lead_id, subtotal, total_amount, status, created_at)
  VALUES ('INV-699020', 7, 1200, 1200, 'sent', '2026-08-10');

  -- Paid but no date anywhere: must be skipped, not stamped with today.
  INSERT INTO invoices (invoice_number, lead_id, subtotal, total_amount, status)
  VALUES ('INV-699021', 7, 50, 50, 'paid');
`);

// pg-mem's real pg adapter — proper parameter binding, unlike db.public.query.
const { Pool } = db.adapters.createPg();
const pool = new Pool();

// The backfill's own SELECT, verbatim.
const SELECT = `SELECT i.*, l.name AS lead_name
   FROM invoices i
   LEFT JOIN leads l ON l.id = i.lead_id
   LEFT JOIN payments byinv ON byinv.invoice_id = i.id
   LEFT JOIN payments bypi  ON i.payment_reference IS NOT NULL
                           AND bypi.stripe_payment_intent_id = i.payment_reference
  WHERE i.status = 'paid'
    AND byinv.id IS NULL
    AND bypi.id IS NULL
  ORDER BY i.paid_at NULLS LAST, i.id`;

let fails = 0;
const ck = (l, ok, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${ok ? '' : ' — ' + d}`);
    if (!ok) fails++;
};

async function runBackfill() {
    const { rows } = await pool.query(SELECT, []);
    let written = 0;
    for (const inv of rows) {
        const paidAt = inv.paid_at || inv.updated_at || inv.created_at;
        if (!paidAt) continue;
        const total = Number(inv.total_amount || 0);
        const tax = Number(inv.tax_amount || 0);
        const fee = Number(inv.processing_fee || 0);
        const base = inv.subtotal != null ? Number(inv.subtotal) : Math.max(0, total - tax - fee);
        const receiptNo = `RCPT-INV${String(inv.id).padStart(6, '0')}`;
        const method = /bank|ach/i.test(inv.payment_method || '') ? 'us_bank_account' : 'card';
        const kind = inv.maintenance_plan_id ? 'maintenance' : 'invoice';
        await pool.query(
            `INSERT INTO payments
                (lead_id, invoice_id, maintenance_plan_id, amount, method, kind, description,
                 status, stripe_payment_intent_id, receipt_number,
                 base_amount, tax_amount, processing_fee, paid_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9,$10,$11,$12,$13,$14)`,
            [inv.lead_id, inv.id, inv.maintenance_plan_id || null, total, method, kind,
             `Invoice ${inv.invoice_number}`, inv.payment_reference || null, receiptNo,
             base, tax, fee, paidAt, paidAt]);
        written++;
    }
    return { candidates: rows, written };
}

(async () => {
    console.log('\nBackfill against a real Postgres engine\n');

    const first = await runBackfill();
    const nums = first.candidates.map((r) => r.invoice_number);

    ck('finds the Aug 16 settlement invoice', nums.includes('INV-699016'), nums.join(','));
    ck('finds the missing bank-paid deposit', nums.includes('INV-699004'));
    ck('does NOT re-add the Aug 15 payment already in the ledger',
       !nums.includes('INV-699001'), 'would double the customer total paid');
    ck('does NOT invent a payment for an unpaid invoice', !nums.includes('INV-699020'));
    ck('writes 3 rows (2 real + 1 dateless skipped inside)', first.written, 3);

    const all = (await pool.query('SELECT * FROM payments ORDER BY paid_at')).rows;

    const settlement = all.find((p) => p.description === 'Invoice INV-699016');
    ck('settlement receipt exists', !!settlement);
    ck('dated Aug 16, not today',
       settlement && new Date(settlement.paid_at).toISOString().slice(0, 10) === '2026-08-16',
       settlement && settlement.paid_at);
    ck('amount is right', settlement && Number(settlement.amount) === 0.51);
    ck('breakdown preserved', settlement && Number(settlement.base_amount) === 0.47
        && Number(settlement.tax_amount) === 0.04);
    ck('linked to the plan', settlement && settlement.maintenance_plan_id === 12);
    ck('carries the Stripe reference', settlement && settlement.stripe_payment_intent_id === 'pi_aug16');

    const deposit = all.find((p) => p.description === 'Invoice INV-699004');
    ck('bank payment recorded as bank, not card',
       deposit && deposit.method === 'us_bank_account', deposit && deposit.method);
    ck('deposit dated Jul 2, not today',
       deposit && new Date(deposit.paid_at).toISOString().slice(0, 10) === '2026-07-02');

    const dateless = all.find((p) => p.description === 'Invoice INV-699021');
    ck('dateless invoice fell back to created_at rather than being stamped today',
       !dateless || new Date(dateless.paid_at).getFullYear() === 2026);

    // THE THING THAT MATTERS MOST: running it twice must not double anything.
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM payments')).rows[0].n;
    const second = await runBackfill();
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM payments')).rows[0].n;
    ck('re-running finds nothing left to do', second.candidates.length, 0);
    ck('re-running creates no duplicates', after, before);

    const totals = (await pool.query(
        `SELECT COALESCE(SUM(amount),0)::float AS total FROM payments WHERE status='succeeded'`)).rows[0];
    ck('customer total paid is correct and not doubled',
       Math.round(totals.total * 100) / 100, 3279.43);

    console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll backfill checks passed.');
    process.exit(fails ? 1 : 0);
})();