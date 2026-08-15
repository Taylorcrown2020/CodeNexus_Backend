#!/usr/bin/env python3
"""
patch-signing-proof.py — Diamondback Coding

Makes the signature record carry PROOF OF WHAT WAS SIGNED.

Before: agreement_signatures stored a typed name, an IP and a generic consent
line ("By typing my name I agree to the terms"). That is weak evidence. It does
not establish WHICH terms, and it says nothing about recurring payment consent —
which is the specific thing a bank asks for when a customer disputes an autopay
charge.

After: signing also stores
  * document_snapshot — the exact rendered text the customer was shown
  * document_hash     — sha256 of it, so tampering is detectable
  * viewed_in_full    — whether the signing UI confirmed they scrolled to the end
  * autopay_consent   — separate, explicit consent to recurring charges
  * autopay_consent_text — the exact authorization wording they agreed to

The snapshot is built by diamondback-documents.js, the same module that renders
the on-screen view and the PDF. That is what guarantees the stored proof matches
what was actually displayed — the three cannot drift, because there is one
renderer.

All of it is optional at the database level and wrapped in try/catch: if
migration 011 hasn't run, signing still works exactly as before rather than
failing on a missing column.
"""
import sys
import shutil
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else 'diamondback-lifecycle.js')
text = SRC.read_text()
original = text
report = []

# ===========================================================================
# 1. Capture the document at signing time and store it with the signature
# ===========================================================================
old_sig = """        await pool.query(
            `INSERT INTO agreement_signatures
                (agreement_id, lead_id, signer_name, signer_email, typed_name, signature_svg,
                 ip_address, user_agent, consent_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (agreement_id) DO NOTHING`,
            [agreementId, a.lead_id, name, (lead && lead.email) || a.customer_email, name, svg,
             (ip || '').slice(0, 64), (userAgent || '').slice(0, 500),
             'By typing my name I agree to the terms of this agreement and consent to sign electronically.']
        );"""

new_sig = """        // ------------------------------------------------------------------
        // Capture the document exactly as rendered, and hash it.
        //
        // This is the evidence that matters in a dispute: not "they clicked a
        // box" but "here is the text they were shown, here is its hash, and
        // here is the hash stored the moment they signed". Built from the same
        // module that renders the on-screen view and the PDF, so all three are
        // necessarily identical.
        //
        // Best-effort throughout. A failure here must never block a signature
        // the customer has already given.
        // ------------------------------------------------------------------
        let docSnapshot = null;
        let docHash = null;
        let autopayConsentText = null;
        const isAutopayAgreement = !!a.autopay
            || ['maintenance', 'subscription'].includes(a.agreement_kind);

        try {
            const documents = require('./diamondback-documents.js');
            const items = await pool.query(
                'SELECT * FROM agreement_items WHERE agreement_id=$1 ORDER BY sort_order, id',
                [agreementId]).then((r) => r.rows).catch(() => []);
            const stones = await pool.query(
                'SELECT * FROM agreement_milestones WHERE agreement_id=$1 ORDER BY sort_order, id',
                [agreementId]).then((r) => r.rows).catch(() => []);
            const linkedPlan = await pool.query(
                'SELECT * FROM maintenance_plans WHERE agreement_id=$1 ORDER BY id DESC LIMIT 1',
                [agreementId]).then((r) => r.rows[0] || null).catch(() => null);

            const built = documents.buildAgreementDocument({
                agreement: a,
                items,
                milestones: stones,
                plan: linkedPlan,
                noticeDays: CANCELLATION_NOTICE_DAYS,
            });
            docSnapshot = documents.renderAgreementText(built);
            docHash = documents.hashAgreement(built);
            autopayConsentText = built.autopayConsentText;
        } catch (docErr) {
            console.warn('[LIFECYCLE] document snapshot unavailable:', docErr.message);
        }

        // The columns land only if migration 011 has run. Detected rather than
        // assumed, because this database has a history of migrations that were
        // recorded as applied without their statements succeeding (see 010).
        let hasProofColumns = false;
        try {
            hasProofColumns = (await pool.query(
                `SELECT 1 FROM information_schema.columns
                  WHERE table_name='agreement_signatures' AND column_name='document_hash'`
            )).rows.length > 0;
        } catch { /* treat as absent */ }

        const baseConsent = isAutopayAgreement
            ? 'By typing my name I agree to the terms of this agreement, including the automatic '
              + 'payment authorization it contains, and consent to sign electronically.'
            : 'By typing my name I agree to the terms of this agreement and consent to sign electronically.';

        if (hasProofColumns) {
            await pool.query(
                `INSERT INTO agreement_signatures
                    (agreement_id, lead_id, signer_name, signer_email, typed_name, signature_svg,
                     ip_address, user_agent, consent_text,
                     document_hash, document_snapshot, viewed_in_full,
                     autopay_consent, autopay_consent_text)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 ON CONFLICT (agreement_id) DO NOTHING`,
                [agreementId, a.lead_id, name, (lead && lead.email) || a.customer_email, name, svg,
                 (ip || '').slice(0, 64), (userAgent || '').slice(0, 500), baseConsent,
                 docHash, docSnapshot, !!viewedInFull,
                 isAutopayAgreement, autopayConsentText]
            );
        } else {
            // Pre-011 shape. Signing still works; the proof is just not stored.
            console.warn('[LIFECYCLE] agreement_signatures lacks proof columns — '
                       + 'run migrations/011_autopay_receipts_and_outstanding.sql');
            await pool.query(
                `INSERT INTO agreement_signatures
                    (agreement_id, lead_id, signer_name, signer_email, typed_name, signature_svg,
                     ip_address, user_agent, consent_text)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (agreement_id) DO NOTHING`,
                [agreementId, a.lead_id, name, (lead && lead.email) || a.customer_email, name, svg,
                 (ip || '').slice(0, 64), (userAgent || '').slice(0, 500), baseConsent]
            );
        }"""

if old_sig in text:
    text = text.replace(old_sig, new_sig, 1)
    report.append("  OK    signature insert: document proof + autopay consent recorded")
else:
    report.append("  SKIP  signature insert: not found (already applied?)")

# ===========================================================================
# 2. onAgreementSigned must accept viewedInFull
# ===========================================================================
old_fn = "    async function onAgreementSigned({ agreementId, signerName, ip, userAgent }) {"
new_fn = ("    async function onAgreementSigned({ agreementId, signerName, ip, userAgent,\n"
          "                                      viewedInFull = false }) {")
if old_fn in text:
    text = text.replace(old_fn, new_fn, 1)
    report.append("  OK    onAgreementSigned(): accepts viewedInFull")
else:
    # Signature may be formatted differently; try a looser match.
    import re as _re
    m = _re.search(r'async function onAgreementSigned\(\{([^}]*)\}\)', text)
    if m and 'viewedInFull' not in m.group(1):
        text = text[:m.start(1)] + m.group(1).rstrip() + ', viewedInFull = false ' + text[m.end(1):]
        report.append("  OK    onAgreementSigned(): accepts viewedInFull (loose match)")
    else:
        report.append("  SKIP  onAgreementSigned(): already accepts viewedInFull or not found")

# ===========================================================================
# 3. The portal sign route passes the flags through
# ===========================================================================
old_route = """            const { typedName, agree } = req.body || {};
            if (!agree) {
                return res.status(400).json({ success: false, message: 'Please check the box to agree to the terms.' });
            }"""
new_route = """            // autopayConsent is a SEPARATE checkbox from `agree` on any
            // recurring agreement. Bundling them would mean one tick standing
            // for two different consents, which is exactly the arrangement a
            // card network treats as no consent at all.
            const { typedName, agree, autopayConsent, viewedInFull, documentHash } = req.body || {};
            if (!agree) {
                return res.status(400).json({ success: false, message: 'Please check the box to agree to the terms.' });
            }"""
if old_route in text:
    text = text.replace(old_route, new_route, 1)
    report.append("  OK    sign route: reads autopayConsent / viewedInFull / documentHash")
else:
    report.append("  SKIP  sign route body destructure: not found (already applied?)")

old_own = """            const own = await pool.query(
                'SELECT id, lead_id, status FROM sales_agreements WHERE id=$1', [req.params.id]
            );"""
new_own = """            const own = await pool.query(
                `SELECT id, lead_id, status, agreement_kind,
                        COALESCE(autopay, FALSE) AS autopay
                   FROM sales_agreements WHERE id=$1`, [req.params.id]
            );"""
if old_own in text:
    text = text.replace(old_own, new_own, 1)
    report.append("  OK    sign route: loads autopay flag")
else:
    report.append("  SKIP  sign route ownership query: not found (already applied?)")

old_check = """            if (a.status === 'signed') {
                return res.status(409).json({ success: false, message: 'This agreement is already signed.' });
            }"""
new_check = """            if (a.status === 'signed') {
                return res.status(409).json({ success: false, message: 'This agreement is already signed.' });
            }

            // A recurring agreement cannot be signed without explicit autopay
            // consent. Refusing here rather than inferring it is the difference
            // between an authorization you can produce and one you can't.
            const needsAutopayConsent = !!a.autopay
                || ['maintenance', 'subscription'].includes(a.agreement_kind);
            if (needsAutopayConsent && !autopayConsent) {
                return res.status(400).json({
                    success: false,
                    needsAutopayConsent: true,
                    message: 'Please tick the box authorizing automatic payment before signing.',
                });
            }"""
if old_check in text:
    text = text.replace(old_check, new_check, 1)
    report.append("  OK    sign route: autopay consent required for recurring agreements")
else:
    report.append("  SKIP  sign route consent gate: not found (already applied?)")

old_call = """                out = await onAgreementSigned({
                    agreementId: a.id,
                    signerName: String(typedName).trim(),
                    ip: req.headers['x-forwarded-for'] || req.ip,
                    userAgent: req.headers['user-agent'],
                });"""
new_call = """                out = await onAgreementSigned({
                    agreementId: a.id,
                    signerName: String(typedName).trim(),
                    ip: req.headers['x-forwarded-for'] || req.ip,
                    userAgent: req.headers['user-agent'],
                    viewedInFull: !!viewedInFull,
                });"""
if old_call in text:
    text = text.replace(old_call, new_call, 1)
    report.append("  OK    sign route: passes viewedInFull through")
else:
    report.append("  SKIP  sign route call: not found (already applied?)")

print(__doc__.strip().splitlines()[0])
print()
for line in report:
    print(line)

if text == original:
    print("\nNothing changed — file is already patched.")
else:
    if not Path(str(SRC) + '.bak2').exists():
        shutil.copy(SRC, str(SRC) + '.bak2')
    SRC.write_text(text)
    print(f"\nWrote {SRC}")