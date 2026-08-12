#!/usr/bin/env python3
"""
patch_server.py — wire the lifecycle engine into server.js.

Four edits, each verified to match exactly once before applying:

  1. Mount diamondback-lifecycle.js next to the other init calls.
  2. Redirect /api/admin/client-accounts to create a CUSTOMER PORTAL account.
     This is the bug fix: that route used to build client_companies /
     is_company_admin CRM scaffolding and leave portal_kind at 'crm', which
     locked promoted customers out of the customer portal and dropped them
     into the CRM instead.
  3. Add the lifecycle's transactional email types to confirmationTypes, so
     billing and lifecycle mail is never tracked and therefore can never feed
     hot/cold lead scoring.
  4. Extend db.js's EXPECTED_TABLES so verifySchema() actually checks the
     portal and billing tables instead of reporting "all present" while they
     are missing.

Idempotent: re-running detects each marker and skips.

    python3 tools/patch_server.py .
"""

import sys
import pathlib

# ---------------------------------------------------------------- 1. mount
MOUNT_ANCHOR = """const initDiamondbackSms = require('./diamondback-sms.js');
initDiamondbackSms({ app, pool, authenticateToken, sendSmsViaBrevo, getBrevoKey });"""

MOUNT_NEW = """const initDiamondbackSms = require('./diamondback-sms.js');
initDiamondbackSms({ app, pool, authenticateToken, sendSmsViaBrevo, getBrevoKey });

// ---------------------------------------------------------------------------
// Lifecycle engine — customer provisioning, SLA signing, invoice generation,
// payment ledger with refunds, maintenance plans, 30-day cancellations.
//
// authenticatePortal lives inside diamondback-portal.js, so it is re-declared
// here rather than imported. Both verify the same 'portal' token type; keep
// them in step if either changes.
function authenticatePortalForLifecycle(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Access denied. Please log in.' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type !== 'portal') {
            return res.status(403).json({ success: false, message: 'Invalid access token.' });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }
}

const initLifecycle = require('./diamondback-lifecycle.js');
const lifecycle = initLifecycle({
    app, pool, stripe, transporter,
    authenticateToken,
    authenticatePortal: authenticatePortalForLifecycle,
    resolveLeadId,
    JWT_SECRET, jwt,
    PLATFORM_BREVO_KEY, PLATFORM_SENDER_EMAIL, PLATFORM_SENDER_NAME,
    sendViaBrevo, sendSmsViaBrevo, getBrevoKey,
});"""

# --------------------------------------------------- 2. customer provisioning
# The whole old body is replaced. Anchored on the route signature plus the
# guard immediately after it, so a partial match cannot silently apply.
PROV_START = "app.post('/api/admin/client-accounts', authenticateToken, async (req, res) => {"
PROV_END = "// Reset client password"

PROV_NEW = '''app.post('/api/admin/client-accounts', authenticateToken, async (req, res) => {
    // ------------------------------------------------------------------
    // Creates a CUSTOMER PORTAL account for a customer. Nothing else.
    //
    // WHAT CHANGED AND WHY
    //   This route used to create CRM scaffolding for every promoted lead:
    //   a client_companies tenant row, client_email_settings, a Brevo sender,
    //   is_company_admin = TRUE — and it never set portal_kind, leaving it at
    //   the migration default of 'crm'. The result was that a brand-new
    //   customer could not sign in at customer_portal.html (which requires
    //   portal_kind IN ('customer','both')) but COULD sign in to the CodeNexus
    //   CRM. That is exactly backwards.
    //
    //   CRM access is now additive and granted only when someone buys a
    //   CodeNexus subscription — see lifecycle.onCrmSubscriptionActivated,
    //   which is the only place client_companies is created.
    // ------------------------------------------------------------------
    const { leadId, email, temporaryPassword, sendWelcomeEmail = true } = req.body;

    try {
        const leadCheck = await pool.query(
            'SELECT id, name, email, is_customer, client_password, portal_kind FROM leads WHERE id = $1',
            [leadId]
        );
        if (leadCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found.' });
        }
        const lead = leadCheck.rows[0];

        if (!lead.is_customer) {
            return res.status(403).json({
                success: false,
                message: 'Convert this lead to a customer first, then create their portal account.'
            });
        }
        if (lead.client_password) {
            return res.status(409).json({
                success: false,
                message: 'This customer already has a portal account. Use Reset Password to change their credentials.'
            });
        }

        // Update the login email first if the admin supplied a different one.
        if (email && email.toLowerCase() !== String(lead.email || '').toLowerCase()) {
            await pool.query('UPDATE leads SET email = $1, updated_at = NOW() WHERE id = $2', [email, leadId]);
        }

        const result = await lifecycle.onCustomerCreated({
            leadId,
            temporaryPassword,
            sendCredentials: sendWelcomeEmail,
        });

        const finalEmail = email || lead.email;
        console.log(`[CUSTOMER ACCOUNT] Customer portal account created for ${lead.name} <${finalEmail}>`);

        res.json({
            success: true,
            message: 'Customer portal account created.',
            portal: 'customer',
            credentials: {
                email: finalEmail,
                temporaryPassword: result.temporaryPassword || temporaryPassword,
            },
        });
    } catch (error) {
        console.error('[CUSTOMER ACCOUNT] Creation failed:', error);
        res.status(500).json({ success: false, message: 'Failed to create account: ' + error.message });
    }
});

// Grant CodeNexus CRM access on top of an existing customer account. This is
// the ONLY path that creates CRM tenant scaffolding.
app.post('/api/admin/client-accounts/:leadId/grant-crm', authenticateToken, async (req, res) => {
    try {
        const { companyName, seats } = req.body || {};
        const lead = (await pool.query(
            'SELECT id, name, client_password FROM leads WHERE id = $1', [req.params.leadId]
        )).rows[0];
        if (!lead) return res.status(404).json({ success: false, message: 'Customer not found.' });
        if (!lead.client_password) {
            return res.status(400).json({
                success: false,
                message: 'Create their customer portal account first — CRM access is added on top of it.'
            });
        }
        const out = await lifecycle.onCrmSubscriptionActivated({
            leadId: lead.id, companyName, seats: seats || 1,
        });
        res.json({
            success: true,
            message: `CRM access granted to ${lead.name}.`,
            clientPortalId: out.clientPortalId,
        });
    } catch (e) {
        console.error('[GRANT CRM]', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Reset client password'''

# ------------------------------------------------- 3. scoring firewall types
TYPES_ANCHOR = """        'subscription_payment_failed',
        'subscription_duplicate'
    ];"""

TYPES_NEW = """        'subscription_payment_failed',
        'subscription_duplicate',
        // --- lifecycle / billing (diamondback-lifecycle.js) ---------------
        // These are transactional. Listing them here strips the open pixel and
        // link wrapping, which is what keeps a receipt or a dunning notice from
        // registering as engagement and reheating a lead.
        'portal_credentials',
        'sla_ready_to_sign',
        'sla_signed',
        'admin_assigned',
        'invoice_created',
        'invoice_due',
        'invoice_paid',
        'milestone_completed',
        'project_completed',
        'portal_message_waiting',
        'maintenance_agreement',
        'maintenance_charged',
        'maintenance_charge_failed',
        'cancellation_confirmed',
        'cancellation_reminder',
        'cancellation_completed',
        'refund_issued',
        'crm_subscription_active',
        'dunning_reminder'
    ];"""

# ------------------------------------------------------- 4. EXPECTED_TABLES
DB_ANCHOR = """    'support_tickets', 'tasks', 'ticket_responses',
];"""

DB_NEW = """    'support_tickets', 'tasks', 'ticket_responses',
    // --- customer portal (migrations/001) -------------------------------
    // These were missing, so verifySchema() reported "all tables present"
    // while every customer-portal route 500'd on a missing relation.
    'client_messages', 'sales_agreements', 'service_requests', 'sms_marketing_auto',
    // --- billing + dunning (migrations/002) -----------------------------
    'billing_schedules', 'agreement_items', 'agreement_templates',
    'invoice_dunning', 'billing_notifications',
    // --- lifecycle (migrations/003) -------------------------------------
    'payments', 'refunds', 'payment_methods', 'maintenance_plans',
    'plan_cancellations', 'agreement_signatures', 'lifecycle_events',
    'admin_notifications',
];"""


def apply_edit(text, old, new, label, marker):
    if marker in text:
        return text, f'{label}: skipped (already applied)'
    n = text.count(old)
    if n != 1:
        return text, f'{label}: FAILED — anchor matched {n} times (expected 1)'
    return text.replace(old, new, 1), f'{label}: applied'


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    report = []

    # ---- server.js -------------------------------------------------------
    sp = root / 'server.js'
    s = sp.read_text(encoding='utf-8', errors='replace')

    s, r = apply_edit(s, MOUNT_ANCHOR, MOUNT_NEW,
                      '1. mount lifecycle', 'diamondback-lifecycle.js')
    report.append(r)

    # provisioning: cut from route start to the next-route comment
    if 'portal: \'customer\',' in s or "portal: 'customer'," in s:
        report.append('2. customer provisioning: skipped (already applied)')
    else:
        i = s.find(PROV_START)
        j = s.find(PROV_END, i)
        if i == -1 or j == -1:
            report.append('2. customer provisioning: FAILED — anchors not found')
        elif s.count(PROV_START) != 1:
            report.append(f'2. customer provisioning: FAILED — route matched {s.count(PROV_START)} times')
        else:
            s = s[:i] + PROV_NEW + s[j + len(PROV_END):]
            report.append('2. customer provisioning: applied')

    s, r = apply_edit(s, TYPES_ANCHOR, TYPES_NEW,
                      '3. scoring firewall types', "'maintenance_charged',")
    report.append(r)

    sp.write_text(s, encoding='utf-8')

    # ---- db.js -----------------------------------------------------------
    dp = root / 'db.js'
    d = dp.read_text(encoding='utf-8', errors='replace')
    d, r = apply_edit(d, DB_ANCHOR, DB_NEW,
                      '4. EXPECTED_TABLES', "'maintenance_plans',")
    report.append(r)
    dp.write_text(d, encoding='utf-8')

    print('\n'.join(report))
    return 0 if not any('FAILED' in r for r in report) else 1


if __name__ == '__main__':
    sys.exit(main())