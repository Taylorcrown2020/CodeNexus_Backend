// ========================================
// server.js - Complete CraftedCode Co. Backend
// ========================================

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SibApiV3Sdk = require('@getbrevo/brevo');
const dns = require('dns').promises;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://diamondbackcoding.com';

// Service Packages Definition (same as frontend)
const servicePackages = {
    'free-basic': {
        name: 'Free Basic Website',
        price: 0,
        isFree: true
    },
    'free-portfolio': {
        name: 'Free Portfolio Website',
        price: 0,
        isFree: true
    },
    'free-business-card': {
        name: 'Free Business Card Website',
        price: 0,
        isFree: true
    },
    'free-landing-page': {
        name: 'Free Landing Page',
        price: 0,
        isFree: true
    },
    'starter-website': {
        name: 'Starter Package - $1,499',
        price: 1499,
        isFree: false
    },
    'professional-website': {
        name: 'Professional Package - $2,999',
        price: 2999,
        isFree: false
    },
    'enterprise-website': {
        name: 'Enterprise Package - Custom Pricing',
        price: 0,
        isFree: false
    },
    'seo-services': {
        name: 'SEO Services - $199/month',
        price: 199,
        isFree: false
    },
    'digital-marketing': {
        name: 'Digital Marketing Services - Custom Pricing',
        price: 0,
        isFree: false
    }
};

const { transporter, verifyEmailConfig } = require('./email-config.js');

// ==================== ENHANCED WEBHOOK HANDLER ====================
// This should REPLACE your existing webhook handler
// Make sure this route comes BEFORE app.use(express.json())

app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
        console.error('⚠️ STRIPE_WEBHOOK_SECRET not set - webhooks will fail!');
        return res.status(500).send('Webhook secret not configured');
    }
    
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        console.log(`[WEBHOOK] Received event: ${event.type}`);
    } catch (err) {
        console.error('⚠️  Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            
            console.log('[WEBHOOK] Processing checkout.session.completed');
            console.log('[WEBHOOK] Session ID:', session.id);
            console.log('[WEBHOOK] Metadata:', session.metadata);
            
            // Get invoice ID from metadata
            const invoiceId = session.metadata?.invoice_id;
            
            if (!invoiceId) {
                console.log('[WEBHOOK] No invoice_id in metadata, skipping');
                return res.json({received: true});
            }
            
            try {
                console.log(`[WEBHOOK] Processing payment for invoice ${invoiceId}`);
                
                // Mark invoice as paid
                const updateResult = await pool.query(
                    `UPDATE invoices 
                     SET status = 'paid', 
                         paid_at = CURRENT_TIMESTAMP,
                         payment_method = 'Stripe',
                         payment_reference = $1
                     WHERE id = $2
                     RETURNING *`,
                    [session.id, invoiceId]
                );
                
                if (updateResult.rows.length === 0) {
                    console.error('[WEBHOOK] Invoice not found:', invoiceId);
                    return res.json({received: true});
                }
                
                console.log(`[WEBHOOK] ✅ Invoice ${invoiceId} marked as PAID`);
                
                // Get invoice and customer details
                const invoiceResult = await pool.query(
                    `SELECT i.*, l.id as lead_id, l.name, l.email, l.is_customer, l.customer_status
                     FROM invoices i
                     LEFT JOIN leads l ON i.lead_id = l.id
                     WHERE i.id = $1`,
                    [invoiceId]
                );
                
                const invoice = invoiceResult.rows[0];
                
                if (!invoice) {
                    console.error('[WEBHOOK] Could not retrieve invoice details:', invoiceId);
                    return res.json({received: true});
                }
                
                console.log(`[WEBHOOK] Processing for customer: ${invoice.name} (${invoice.email})`);
                
                // Convert to customer if not already
                if (!invoice.is_customer) {
                    await pool.query(
                        `UPDATE leads 
                         SET is_customer = TRUE, 
                             customer_status = 'active',
                             status = 'closed',
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $1`,
                        [invoice.lead_id]
                    );
                    console.log(`[WEBHOOK] ✅ Lead converted to ACTIVE CUSTOMER: ${invoice.name}`);
                } else {
                    // Make sure customer is active
                    await pool.query(
                        `UPDATE leads 
                         SET customer_status = 'active',
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $1`,
                        [invoice.lead_id]
                    );
                    console.log(`[WEBHOOK] ✅ Customer status updated to ACTIVE: ${invoice.name}`);
                }
                
                // Update lifetime value
                const lifetimeValue = await pool.query(
                    `SELECT COALESCE(SUM(total_amount), 0) as total
                     FROM invoices
                     WHERE lead_id = $1 AND status = 'paid'`,
                    [invoice.lead_id]
                );
                
                await pool.query(
                    `UPDATE leads 
                     SET lifetime_value = $1,
                         last_payment_date = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [lifetimeValue.rows[0].total, invoice.lead_id]
                );
                
                console.log('');
                console.log('========================================');
                console.log('✅ PAYMENT PROCESSED SUCCESSFULLY');
                console.log('========================================');
                console.log(`   Invoice: ${invoice.invoice_number}`);
                console.log(`   Amount: $${parseFloat(invoice.total_amount).toLocaleString()}`);
                console.log(`   Customer: ${invoice.name}`);
                console.log(`   Email: ${invoice.email}`);
                console.log(`   Lifetime Value: $${parseFloat(lifetimeValue.rows[0].total).toLocaleString()}`);
                console.log(`   Payment Method: Stripe`);
                console.log(`   Session ID: ${session.id}`);
                console.log('========================================');
                console.log('');
                
            } catch (error) {
                console.error('[WEBHOOK ERROR] Failed to process payment:', error);
                console.error('[WEBHOOK ERROR] Stack:', error.stack);
            }
            break;
            
        case 'payment_intent.succeeded':
            console.log('[WEBHOOK] 💳 Payment intent succeeded:', event.data.object.id);
            break;
            
        case 'payment_intent.payment_failed':
            console.log('[WEBHOOK] ❌ Payment failed:', event.data.object.id);
            break;
            
        default:
            console.log(`[WEBHOOK] Unhandled event type: ${event.type}`);
    }
    
    res.json({received: true});
});

// ========================================
// MIDDLEWARE (AFTER WEBHOOK!)
// ========================================
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Request logging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});

// ========================================
// MIDDLEWARE (AFTER WEBHOOK!)
// ========================================
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Request logging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});

// **ADD THIS DEBUG ROUTE HERE - NO AUTH REQUIRED**
app.get('/api/test/ping', (req, res) => {
    console.log('[TEST] Ping received');
    res.json({ 
        success: true, 
        message: 'Server is responding',
        timestamp: new Date().toISOString()
    });
});

// ========================================
// DATABASE CONNECTION
// ========================================


// ========================================
// SHARED EMAIL TEMPLATE
// ========================================
// Single source of truth for all outgoing email styling.
// Matches the diamondbackcoding.com brand: black / gold / white.
// Usage: buildEmailHTML(bodyHTML, { unsubscribeUrl })

function buildEmailHTML(bodyHTML, opts = {}) {
    const year = new Date().getFullYear();
    const unsubscribeBlock = opts.unsubscribeUrl
        ? `<tr><td style="padding: 12px 0 0 0; border-top: 1px solid #3a3a3a;">
            <a href="${opts.unsubscribeUrl}" style="color: #888; font-size: 11px; text-decoration: none;">Unsubscribe from follow-up emails</a>
           </td></tr>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Diamondback Coding</title>
<style>
    body, td, th, div, p, a, ul, li, ol { margin: 0; padding: 0; }
    img { border: none; display: block; }
    body {
        font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
        background-color: #f0efe9;
        color: #2a2a2a;
        -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; text-decoration: none; }
    .email-outer {
        max-width: 620px;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }
    .email-header {
        background-color: #111111;
        padding: 32px 36px 28px;
    }
    .logo-row {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .logo-icon { width: 28px; height: 28px; }
    .logo-text {
        font-size: 18px;
        font-weight: 600;
        letter-spacing: 2.2px;
        text-transform: uppercase;
        color: #D4A847;
        font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
    }
    .email-body {
        padding: 36px 40px 32px;
        background: #ffffff;
    }
    .email-body p {
        font-size: 15px;
        line-height: 1.75;
        color: #3d3d3d;
        margin-bottom: 16px;
    }
    .email-body p:last-child { margin-bottom: 0; }
    .email-body ul, .email-body ol {
        padding-left: 22px;
        margin-bottom: 16px;
    }
    .email-body li {
        font-size: 15px;
        line-height: 1.75;
        color: #3d3d3d;
        margin-bottom: 6px;
    }
    .email-body h2 {
        font-size: 20px;
        color: #111111;
        margin-bottom: 10px;
        font-weight: 600;
    }
    .email-body h3 {
        font-size: 16px;
        color: #111111;
        margin-top: 24px;
        margin-bottom: 8px;
        font-weight: 600;
    }
    .info-box {
        background: #faf8f2;
        border-left: 3px solid #D4A847;
        border-radius: 4px;
        padding: 18px 20px;
        margin: 20px 0;
    }
    .info-row {
        display: flex;
        justify-content: space-between;
        font-size: 14px;
        padding: 5px 0;
    }
    .info-label { color: #777; font-weight: 600; }
    .info-value { color: #111; font-weight: 700; }
    .info-value.gold { color: #D4A847; }
    .highlight-box {
        background: #faf8f2;
        border-radius: 6px;
        padding: 24px;
        text-align: center;
        margin: 24px 0;
    }
    .highlight-label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: #888;
        margin-bottom: 6px;
    }
    .highlight-value {
        font-size: 28px;
        font-weight: 700;
        color: #D4A847;
    }
    .btn-gold {
        display: inline-block;
        background: #D4A847;
        color: #111111;
        font-weight: 700;
        font-size: 14px;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        padding: 14px 32px;
        border-radius: 4px;
        text-decoration: none;
        margin: 8px 0;
    }
    .btn-center { text-align: center; margin: 28px 0; }
    .btn-note { font-size: 11px; color: #999; text-align: center; margin-top: 6px; }
    .attachment-box {
        background: #faf8f2;
        border: 1px solid #e8e0c8;
        border-radius: 6px;
        padding: 16px 20px;
        margin: 20px 0;
        font-size: 14px;
        color: #555;
    }
    .attachment-box strong { color: #111; }
    .inv-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .inv-table th {
        background: #f5f3ed;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: #888;
        padding: 10px 12px;
        text-align: left;
        border-bottom: 2px solid #D4A847;
    }
    .inv-table th:last-child, .inv-table td:last-child { text-align: right; }
    .inv-table th:nth-child(2) { text-align: center; }
    .inv-table td {
        padding: 11px 12px;
        border-bottom: 1px solid #eee;
        font-size: 14px;
        color: #3d3d3d;
    }
    .inv-table td:nth-child(2) { text-align: center; }
    .inv-totals { text-align: right; margin-top: 14px; }
    .inv-totals p { font-size: 14px; color: #555; margin-bottom: 4px; }
    .inv-totals .total-line { font-size: 18px; font-weight: 700; color: #111; }
    .inv-totals .total-line span { color: #D4A847; }
    .notes-box {
        background: #faf8f2;
        border-radius: 6px;
        padding: 16px 20px;
        margin: 20px 0;
    }
    .notes-box p { font-size: 14px; color: #555; }
    .sign-off { margin-top: 28px; }
    .sign-off p { font-size: 15px; color: #3d3d3d; margin-bottom: 2px; }
    .sign-off .team-name { font-weight: 600; color: #111; }
    .email-footer {
        background: #1a1a1a;
        padding: 28px 36px 24px;
    }
    .footer-brand {
        font-size: 13px;
        font-weight: 600;
        color: #D4A847;
        letter-spacing: 1.5px;
        text-transform: uppercase;
        margin-bottom: 10px;
    }
    .footer-address {
        font-size: 12px;
        color: #777;
        line-height: 1.7;
        margin-bottom: 14px;
    }
    .footer-nav {
        font-size: 11px;
        color: #666;
        margin-bottom: 18px;
    }
    .footer-nav a { color: #999; margin-right: 14px; text-decoration: none; }
    .footer-nav a:hover { color: #D4A847; }
    .footer-copy {
        font-size: 11px;
        color: #555;
        padding-top: 14px;
        border-top: 1px solid #2e2e2e;
    }
</style>
</head>
<body>
<div style="padding: 28px 0;" align="center">
    <div class="email-outer">
        <div class="email-header">
            <div class="logo-row">
                <svg class="logo-icon" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M14 2L26 8.5V21.5L14 28L2 21.5V8.5L14 2Z" stroke="#D4A847" stroke-width="1.8" fill="none"/>
                    <path d="M14 2L26 8.5L14 15L2 8.5L14 2Z" stroke="#D4A847" stroke-width="1.2" fill="none" opacity="0.5"/>
                    <path d="M14 15V28" stroke="#D4A847" stroke-width="1.2" opacity="0.5"/>
                </svg>
                <span class="logo-text">Diamondback Coding</span>
            </div>
        </div>
        <div class="email-body">
            ${bodyHTML}
        </div>
        <div class="email-footer">
            <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td class="footer-brand">Diamondback Coding</td></tr>
                <tr><td class="footer-address">
                    15709 Spillman Ranch Loop, Austin, TX 78738<br>
                    <a href="mailto:contact@diamondbackcoding.com" style="color:#999;">contact@diamondbackcoding.com</a> &nbsp;\u00b7&nbsp;
                    <a href="tel:+19402178680" style="color:#999;">(940) 217-8680</a>
                </td></tr>
                <tr><td class="footer-nav">
                    <a href="https://diamondbackcoding.com">Website</a>
                    <a href="https://diamondbackcoding.com/projects">Projects</a>
                    <a href="https://diamondbackcoding.com/services">Services</a>
                    <a href="https://diamondbackcoding.com/company">Company</a>
                </td></tr>
                ${unsubscribeBlock}
                <tr><td class="footer-copy">&copy; ${year} Diamondback Coding. All rights reserved.</td></tr>
            </table>
        </div>
    </div>
</div>
</body>
</html>`;
}

const pool = new Pool({  // Create pool FIRST
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Error connecting to database:', err.stack);
    } else {
        console.log('✅ Database connected successfully');
        release();
    }
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// ========================================
// SHARED: Tracked email sender
// Logs to email_log, injects open-tracking pixel, then sends.
// Use this for ALL follow-up / outreach sends so the analytics report is accurate.
// ========================================
// ========================================
// EMAIL SENDING HELPERS
// ========================================

// Send email via Brevo
async function sendViaBrevo(brevoApiKey, senderEmail, senderName, to, subject, html) {
    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, brevoApiKey);
    
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.sender = { email: senderEmail, name: senderName || 'Diamondback Coding' };
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = html;
    
    try {
        const response = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('[BREVO] ✅ Email accepted by Brevo:', response);
        return response;
    } catch (error) {
        // Extract detailed error information from Brevo API
        const errorMessage = error.response?.body?.message || error.message || 'Unknown Brevo error';
        const errorCode = error.response?.body?.code || error.statusCode;
        console.error('[BREVO] ❌ Failed to send email:', {
            to,
            subject,
            error: errorMessage,
            code: errorCode
        });
        // Re-throw with more context so sendTrackedEmail can catch it
        throw new Error(`Brevo send failed: ${errorMessage}`);
    }
}

// Validate email domain has mail servers BEFORE sending
async function validateEmailDomain(email) {
    try {
        // Basic format check
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return { valid: false, reason: 'Invalid email format' };
        }

        // Extract domain
        const domain = email.split('@')[1].toLowerCase();
        
        // Common typo detection
        const commonTypos = {
            'gmial.com': 'gmail.com',
            'gmai.com': 'gmail.com',
            'yahooo.com': 'yahoo.com',
            'yaho.com': 'yahoo.com',
            'hotmial.com': 'hotmail.com',
            'outlok.com': 'outlook.com',
            'outloo.com': 'outlook.com'
        };
        
        if (commonTypos[domain]) {
            return { 
                valid: false, 
                reason: `Possible typo detected. Did you mean ${commonTypos[domain]}?`,
                suggestion: email.replace(domain, commonTypos[domain])
            };
        }
        
        // Check if domain has MX records (mail servers)
        try {
            const mxRecords = await dns.resolveMx(domain);
            if (!mxRecords || mxRecords.length === 0) {
                return { valid: false, reason: 'Domain has no mail servers (no MX records)' };
            }
            
            console.log(`[EMAIL-VALIDATION] ✅ Domain ${domain} has ${mxRecords.length} mail server(s)`);
            return { valid: true, mxRecords };
            
        } catch (dnsError) {
            if (dnsError.code === 'ENOTFOUND' || dnsError.code === 'ENODATA') {
                return { valid: false, reason: `Domain '${domain}' does not exist` };
            }
            // DNS lookup failed for other reasons - log but assume valid to avoid false negatives
            console.warn(`[EMAIL-VALIDATION] ⚠️  Could not verify domain ${domain}:`, dnsError.message);
            return { valid: true, warning: `Could not verify domain: ${dnsError.message}` };
        }
    } catch (error) {
        console.error('[EMAIL-VALIDATION] Error validating email:', error);
        // On unexpected errors, assume valid to avoid blocking legitimate emails
        return { valid: true, warning: `Validation error: ${error.message}` };
    }
}

// Get current email settings
async function getEmailSettings() {
    try {
        const result = await pool.query('SELECT settings FROM admin_users LIMIT 1');
        if (result.rows.length > 0 && result.rows[0].settings) {
            return result.rows[0].settings;
        }
        return { useBrevo: false };
    } catch (error) {
        console.error('[EMAIL SETTINGS] Error fetching settings:', error);
        return { useBrevo: false };
    }
}

async function sendTrackedEmail({ leadId, to, subject, html, isMarketing = false }) {
    // 1. Create email_log row with 'pending' status BEFORE sending so we have the ID
    let emailLogId = null;
    try {
        const logRow = await pool.query(
            `INSERT INTO email_log (lead_id, subject, status) VALUES ($1, $2, 'pending') RETURNING id`,
            [leadId || null, subject]
        );
        emailLogId = logRow.rows[0]?.id;
        console.log(`[EMAIL] Created email_log entry ${emailLogId} for ${to} - Status: pending`);
    } catch (e) {
        console.warn('[TRACKED-EMAIL] Could not insert email_log row:', e.message);
    }

    // 2. VALIDATE EMAIL DOMAIN BEFORE SENDING - Catch typos early!
    console.log(`[EMAIL] Validating email address: ${to}`);
    const validation = await validateEmailDomain(to);
    
    if (!validation.valid) {
        console.error(`\n========================================`);
        console.error(`[EMAIL] ❌❌❌ EMAIL VALIDATION FAILED ❌❌❌`);
        console.error(`[EMAIL] To: ${to}`);
        console.error(`[EMAIL] Reason: ${validation.reason}`);
        if (validation.suggestion) {
            console.error(`[EMAIL] Suggestion: ${validation.suggestion}`);
        }
        console.error(`========================================\n`);
        
        // Mark as failed BEFORE attempting to send
        if (emailLogId) {
            await pool.query(
                `UPDATE email_log 
                 SET status = 'failed', 
                     error_message = $2,
                     sent_at = CURRENT_TIMESTAMP 
                 WHERE id = $1`,
                [emailLogId, `Email validation failed: ${validation.reason}`]
            );
            console.log(`[EMAIL] ❌ Email_log ${emailLogId} marked as FAILED (validation failed)`);
        }
        
        console.log(`[FOLLOW-UP] ❌ Lead ${leadId} NOT advanced - email validation failed\n`);
        throw new Error(`Email validation failed: ${validation.reason}`);
    }
    
    console.log(`[EMAIL] ✅ Email validation passed for ${to}`);
    if (validation.warning) {
        console.warn(`[EMAIL] ⚠️  Warning: ${validation.warning}`);
    }

    // 3. Inject 1×1 open-tracking pixel
    if (emailLogId) {
        const pixel = `<img src="${BASE_URL}/api/track/open/${emailLogId}" width="1" height="1" style="display:none;border:0;" alt="" />`;
        html = html.replace(/<\/body>/i, `${pixel}</body>`);
        if (!html.includes(pixel)) html += pixel; // fallback if no </body>
    }

    // 4. Wrap ALL diamondbackcoding.com links with tracking (makes leads hot when clicked)
    if (leadId) {
        // Replace all diamondbackcoding.com links with tracked versions
        const websiteUrlPattern = /(https?:\/\/(?:www\.)?diamondbackcoding\.com[^"'\s]*)/gi;
        html = html.replace(websiteUrlPattern, (match) => {
            // Don't double-wrap or wrap tracking URLs
            if (match.includes('/api/track/click/')) return match;
            if (match.includes('/api/track/open/')) return match; // ← CRITICAL FIX: Don't wrap tracking pixels!
            return `${BASE_URL}/api/track/click/${leadId}?url=${encodeURIComponent(match)}`;
        });
    }

    // 5. Get email settings to check if Brevo is enabled
    const emailSettings = await getEmailSettings();
    
    // 6. Send via Brevo or Nodemailer
    try {
        console.log(`[EMAIL] Attempting to send to: ${to} | Subject: ${subject} | Method: ${emailSettings.useBrevo ? 'Brevo' : 'Nodemailer'}`);
        
        if (emailSettings.useBrevo && emailSettings.brevoApiKey) {
            console.log('[EMAIL] Sending via Brevo...');
            await sendViaBrevo(
                emailSettings.brevoApiKey,
                emailSettings.brevoSenderEmail || process.env.EMAIL_USER,
                emailSettings.brevoSenderName || 'Diamondback Coding',
                to,
                subject,
                html
            );
            console.log(`[EMAIL] ✅ Email accepted by Brevo for ${to}`);
        } else {
            console.log('[EMAIL] Sending via Nodemailer...');
            const info = await transporter.sendMail({
                from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
                to,
                subject,
                html
            });
            
            console.log(`[EMAIL] Nodemailer messageId: ${info.messageId}`);
            console.log(`[EMAIL] Nodemailer response: ${info.response}`);
            
            // Check if email was rejected by the mail server
            if (info.rejected && info.rejected.length > 0) {
                throw new Error(`Email rejected by mail server: ${info.rejected.join(', ')}`);
            }
            
            console.log(`[EMAIL] ✅ Email accepted by mail server for ${to}`);
        }
        
        // 7. CRITICAL CHANGE: Keep status as 'queued' (not 'sent') until delivery confirmation
        // Status will change to 'sent' only when:
        // - Bounce tracking confirms delivery, OR
        // - User opens the email (tracking pixel fires), OR  
        // - After 24 hours with no bounce (assumed delivered)
        if (emailLogId) {
            await pool.query(
                `UPDATE email_log 
                 SET status = 'queued', 
                     sent_at = CURRENT_TIMESTAMP 
                 WHERE id = $1`,
                [emailLogId]
            );
            console.log(`[EMAIL] ⏳ Email_log ${emailLogId} marked as QUEUED (awaiting delivery confirmation)`);
        }
        
        // 8. DO NOT update follow-up tracking yet - wait for actual delivery
        // We'll update this when:
        // - Email is opened (status becomes 'opened')
        // - 24 hours pass with no bounce (background job marks as 'sent')
        console.log(`[FOLLOW-UP] ⏳ Lead ${leadId} follow-up pending - waiting for delivery confirmation`);
        
    } catch (error) {
        console.error(`\n========================================`);
        console.error(`[EMAIL] ❌❌❌ SEND FAILED ❌❌❌`);
        console.error(`[EMAIL] To: ${to}`);
        console.error(`[EMAIL] Subject: ${subject}`);
        console.error(`[EMAIL] Error: ${error.message}`);
        console.error(`========================================\n`);
        
        // Mark as failed - DO NOT update follow_up_count or last_contact_date
        if (emailLogId) {
            await pool.query(
                `UPDATE email_log SET status = 'failed', sent_at = CURRENT_TIMESTAMP, error_message = $2 WHERE id = $1`,
                [emailLogId, error.message]
            );
            console.log(`[EMAIL] ❌ Email_log ${emailLogId} marked as FAILED`);
        }
        
        console.log(`[FOLLOW-UP] ❌ Lead ${leadId} NOT advanced - email failed to send\n`);
        
        throw error;
    }

    return emailLogId;
}

// ========================================
// DATABASE INITIALIZATION
// ========================================
async function initializeDatabase(){
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='support_tickets'
            AND column_name='client_name'
        ) THEN
            ALTER TABLE support_tickets
            ADD COLUMN client_name TEXT;
        END IF;
    END $$;
`);

// Add follow_up_step column to leads table (PostgreSQL syntax)
await client.query(`
    DO $$ 
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='leads' AND column_name='follow_up_step'
        ) THEN
            ALTER TABLE leads ADD COLUMN follow_up_step INTEGER DEFAULT 0;
            RAISE NOTICE 'Added follow_up_step column to leads table';
        END IF;
        
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='leads' AND column_name='last_contact_date'
        ) THEN
            ALTER TABLE leads ADD COLUMN last_contact_date DATE;
            RAISE NOTICE 'Added last_contact_date column to leads table';
        END IF;
        
        -- Add lead temperature tracking columns
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='leads' AND column_name='lead_temperature'
        ) THEN
            ALTER TABLE leads ADD COLUMN lead_temperature VARCHAR(20) DEFAULT 'cold';
            RAISE NOTICE 'Added lead_temperature column to leads table';
        END IF;
        
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='leads' AND column_name='became_hot_at'
        ) THEN
            ALTER TABLE leads ADD COLUMN became_hot_at TIMESTAMP;
            RAISE NOTICE 'Added became_hot_at column to leads table';
        END IF;
        
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='leads' AND column_name='last_engagement_at'
        ) THEN
            ALTER TABLE leads ADD COLUMN last_engagement_at TIMESTAMP;
            RAISE NOTICE 'Added last_engagement_at column to leads table';
        END IF;
        
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='leads' AND column_name='engagement_score'
        ) THEN
            ALTER TABLE leads ADD COLUMN engagement_score INTEGER DEFAULT 0;
            RAISE NOTICE 'Added engagement_score column to leads table';
        END IF;
        
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='leads' AND column_name='engagement_history'
        ) THEN
            ALTER TABLE leads ADD COLUMN engagement_history JSONB DEFAULT '[]'::jsonb;
            RAISE NOTICE 'Added engagement_history column to leads table';
        END IF;
        
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='leads' AND column_name='follow_up_count'
        ) THEN
            ALTER TABLE leads ADD COLUMN follow_up_count INTEGER DEFAULT 0;
            RAISE NOTICE 'Added follow_up_count column to leads table';
        END IF;
        
        -- Add email_log tracking columns for better analytics
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='email_log' AND column_name='error_message'
        ) THEN
            ALTER TABLE email_log ADD COLUMN error_message TEXT;
            RAISE NOTICE 'Added error_message column to email_log table';
        END IF;
        
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='email_log' AND column_name='created_at'
        ) THEN
            ALTER TABLE email_log ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            -- Set created_at for existing rows
            UPDATE email_log SET created_at = COALESCE(sent_at, CURRENT_TIMESTAMP) WHERE created_at IS NULL;
            RAISE NOTICE 'Added created_at column to email_log table';
        END IF;
    END $$;
`);

console.log('✅ Follow-up tracking columns initialized');

        // Client uploads table
await client.query(`
    CREATE TABLE IF NOT EXISTS client_uploads (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        project_id INTEGER,
        filename VARCHAR(500) NOT NULL,
        filepath TEXT NOT NULL,
        file_size BIGINT,
        mime_type VARCHAR(100),
        description TEXT,
        shared_by_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

// Client projects table
await client.query(`
    CREATE TABLE IF NOT EXISTS client_projects (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        project_name VARCHAR(500) NOT NULL,
        description TEXT,
        start_date DATE,
        end_date DATE,
        status VARCHAR(50) DEFAULT 'in_progress',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

// Project milestones table
await client.query(`
    CREATE TABLE IF NOT EXISTS project_milestones (
        id SERIAL PRIMARY KEY,
        project_id INTEGER REFERENCES client_projects(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        due_date DATE,
        order_index INTEGER DEFAULT 0,
        approval_required BOOLEAN DEFAULT FALSE,
        status VARCHAR(50) DEFAULT 'pending',
        client_feedback TEXT,
        completed_at TIMESTAMP,
        approved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

// Support tickets table
await client.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        client_name VARCHAR(255),
        client_email VARCHAR(255),
        subject VARCHAR(500) NOT NULL,
        message TEXT NOT NULL,
        priority VARCHAR(50) DEFAULT 'medium',
        category VARCHAR(100) DEFAULT 'general',
        status VARCHAR(50) DEFAULT 'open',
        assigned_to INTEGER REFERENCES admin_users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

// Ticket responses table
await client.query(`
    CREATE TABLE IF NOT EXISTS ticket_responses (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
        user_id INTEGER,
        user_type VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

// Create indexes for better performance
await client.query(`
    CREATE INDEX IF NOT EXISTS idx_client_uploads_lead 
    ON client_uploads(lead_id, created_at DESC)
`);

await client.query(`
    CREATE INDEX IF NOT EXISTS idx_client_projects_lead 
    ON client_projects(lead_id, created_at DESC)
`);

await client.query(`
    CREATE INDEX IF NOT EXISTS idx_project_milestones_project 
    ON project_milestones(project_id, order_index)
`);

await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_lead 
    ON support_tickets(lead_id, created_at DESC)
`);

await client.query(`
    CREATE INDEX IF NOT EXISTS idx_ticket_responses_ticket 
    ON ticket_responses(ticket_id, created_at ASC)
`);

        // Create admin_users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        `);

        // Create leads table with customer columns
        await client.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                service VARCHAR(255),
                budget VARCHAR(100),
                details TEXT,
                status VARCHAR(50) DEFAULT 'new',
                priority VARCHAR(50) DEFAULT 'medium',
                is_customer BOOLEAN DEFAULT FALSE,
                customer_status VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create employees table
        await client.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(50),
                role VARCHAR(100),
                start_date DATE,
                end_date DATE,
                notes TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                projects_assigned INTEGER DEFAULT 0,
                tasks_completed INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Update leads table structure - ADD new columns first
        await client.query(`
            DO $$ 
            BEGIN 
                -- Add name column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='name') THEN
                    ALTER TABLE leads ADD COLUMN name VARCHAR(255);
                END IF;
                
                -- Add company column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='company') THEN
                    ALTER TABLE leads ADD COLUMN company VARCHAR(255);
                END IF;
                
                -- Add project_type column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='project_type') THEN
                    ALTER TABLE leads ADD COLUMN project_type VARCHAR(255);
                END IF;

                -- Add lifetime_value column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='lifetime_value') THEN
                    ALTER TABLE leads ADD COLUMN lifetime_value DECIMAL(10, 2) DEFAULT 0;
                END IF;

                -- Add last_payment_date column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='last_payment_date') THEN
                    ALTER TABLE leads ADD COLUMN last_payment_date TIMESTAMP;
                END IF;
                
                -- Add message column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='message') THEN
                    ALTER TABLE leads ADD COLUMN message TEXT;
                END IF;
                
                -- Add timeline column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='timeline') THEN
                    ALTER TABLE leads ADD COLUMN timeline VARCHAR(100);
                END IF;
                
                -- Add notes column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='notes') THEN
                    ALTER TABLE leads ADD COLUMN notes TEXT;
                END IF;
                
                -- Add assigned_to column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='assigned_to') THEN
                    ALTER TABLE leads ADD COLUMN assigned_to INTEGER REFERENCES employees(id);
                END IF;

                -- Add address columns if they don't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='address_line1') THEN
                    ALTER TABLE leads ADD COLUMN address_line1 VARCHAR(255);
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='address_line2') THEN
                    ALTER TABLE leads ADD COLUMN address_line2 VARCHAR(255);
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='city') THEN
                    ALTER TABLE leads ADD COLUMN city VARCHAR(100);
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='state') THEN
                    ALTER TABLE leads ADD COLUMN state VARCHAR(100);
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='zip_code') THEN
                    ALTER TABLE leads ADD COLUMN zip_code VARCHAR(20);
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='country') THEN
                    ALTER TABLE leads ADD COLUMN country VARCHAR(100) DEFAULT 'USA';
                END IF;

                -- Add client portal columns
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='client_password') THEN
                    ALTER TABLE leads ADD COLUMN client_password TEXT;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='client_account_created_at') THEN
                    ALTER TABLE leads ADD COLUMN client_account_created_at TIMESTAMP;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='client_last_login') THEN
                    ALTER TABLE leads ADD COLUMN client_last_login TIMESTAMP;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='password_reset_required') THEN
                    ALTER TABLE leads ADD COLUMN password_reset_required BOOLEAN DEFAULT FALSE;
                END IF;

                -- Add unsubscribe columns for email opt-out
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='unsubscribed') THEN
                    ALTER TABLE leads ADD COLUMN unsubscribed BOOLEAN DEFAULT FALSE;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='unsubscribe_token') THEN
                    ALTER TABLE leads ADD COLUMN unsubscribe_token VARCHAR(255);
                END IF;
            END $$;
        `);

        // Create index on unsubscribe_token for fast lookups
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_leads_unsubscribe_token 
            ON leads(unsubscribe_token) 
            WHERE unsubscribe_token IS NOT NULL
        `);

        // Migrate existing data from first_name/last_name to name
        await client.query(`
            UPDATE leads 
            SET name = CONCAT(first_name, ' ', last_name) 
            WHERE name IS NULL AND first_name IS NOT NULL
        `);

        // NOW make first_name and last_name nullable and drop NOT NULL constraint
        await client.query(`
            DO $$ 
            BEGIN 
                -- Make first_name nullable
                ALTER TABLE leads ALTER COLUMN first_name DROP NOT NULL;
                
                -- Make last_name nullable  
                ALTER TABLE leads ALTER COLUMN last_name DROP NOT NULL;
            EXCEPTION
                WHEN OTHERS THEN
                    -- Ignore errors if constraints already don't exist
                    NULL;
            END $$;
        `);

        // Add customer-related columns if they don't exist
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='is_customer') THEN
                    ALTER TABLE leads ADD COLUMN is_customer BOOLEAN DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='customer_status') THEN
                    ALTER TABLE leads ADD COLUMN customer_status VARCHAR(50);
                END IF;
            END $$;
        `);

        // Create notes table
        await client.query(`
            CREATE TABLE IF NOT EXISTS lead_notes (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                note_text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by INTEGER REFERENCES admin_users(id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS cookie_consent (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255),
                consent_type VARCHAR(50) NOT NULL,
                preferences JSONB,
                ip_address VARCHAR(45),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Lead source tracking
        await client.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='source') THEN
                    ALTER TABLE leads ADD COLUMN source VARCHAR(100);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='source_details') THEN
                    ALTER TABLE leads ADD COLUMN source_details TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='last_contact_date') THEN
                    ALTER TABLE leads ADD COLUMN last_contact_date TIMESTAMP;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='win_loss_reason') THEN
                    ALTER TABLE leads ADD COLUMN win_loss_reason TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='deal_value') THEN
                    ALTER TABLE leads ADD COLUMN deal_value DECIMAL(10, 2);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='probability') THEN
                    ALTER TABLE leads ADD COLUMN probability INTEGER DEFAULT 50;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='expected_close_date') THEN
                    ALTER TABLE leads ADD COLUMN expected_close_date DATE;
                END IF;
            END $$;
        `);

        // Activity log table
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_log (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES admin_users(id),
                activity_type VARCHAR(100) NOT NULL,
                description TEXT,
                metadata JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Email tracking
        await client.query(`
            CREATE TABLE IF NOT EXISTS email_log (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                template_id INTEGER,
                subject VARCHAR(500),
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                opened_at TIMESTAMP,
                clicked_at TIMESTAMP,
                status VARCHAR(50) DEFAULT 'sent'
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS scoring_rules (
                id SERIAL PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                description TEXT,
                rule_type VARCHAR(50) NOT NULL,
                field_name VARCHAR(100),
                operator VARCHAR(20),
                value TEXT,
                points INTEGER NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS lead_scores (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
                total_score INTEGER DEFAULT 0,
                engagement_score INTEGER DEFAULT 0,
                demographic_score INTEGER DEFAULT 0,
                behavioral_score INTEGER DEFAULT 0,
                grade VARCHAR(1),
                last_calculated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_lead_score UNIQUE (lead_id)
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS score_history (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                rule_id INTEGER REFERENCES scoring_rules(id),
                points_added INTEGER,
                reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_lead_scores_total 
            ON lead_scores(total_score DESC);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_score_history_lead 
            ON score_history(lead_id, created_at DESC);
        `);

        // Insert default scoring rules
        await client.query(`
            INSERT INTO scoring_rules (name, description, rule_type, field_name, operator, value, points)
            VALUES 
                ('Email Opened', 'Lead opened an email', 'behavioral', 'email_opened', 'equals', 'true', 5),
                ('Email Clicked', 'Lead clicked link in email', 'behavioral', 'email_clicked', 'equals', 'true', 10),
                ('Form Submitted', 'Lead submitted contact form', 'behavioral', 'form_submitted', 'equals', 'true', 15),
                ('High Lifetime Value', 'Potential lifetime value > $10,000', 'demographic', 'lifetime_value', 'greater_than', '10000', 20),
                ('Has Phone Number', 'Lead provided phone number', 'demographic', 'phone', 'is_not_null', '', 5),
                ('Company Size Large', 'Company has 100+ employees', 'demographic', 'company_size', 'greater_than', '100', 15),
                ('Multiple Page Views', 'Viewed 5+ pages', 'behavioral', 'page_views', 'greater_than', '5', 10),
                ('Repeat Visitor', 'Visited site 3+ times', 'behavioral', 'visit_count', 'greater_than', '3', 8)
            ON CONFLICT DO NOTHING;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS documents (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                filename VARCHAR(500) NOT NULL,
                original_filename VARCHAR(500) NOT NULL,
                file_path TEXT NOT NULL,
                file_size BIGINT,
                mime_type VARCHAR(100),
                document_type VARCHAR(100),
                description TEXT,
                uploaded_by INTEGER REFERENCES admin_users(id),
                is_shared BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS document_versions (
                id SERIAL PRIMARY KEY,
                document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
                version_number INTEGER NOT NULL,
                filename VARCHAR(500) NOT NULL,
                file_path TEXT NOT NULL,
                file_size BIGINT,
                uploaded_by INTEGER REFERENCES admin_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS document_shares (
                id SERIAL PRIMARY KEY,
                document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
                shared_with_email VARCHAR(255),
                share_token VARCHAR(255) UNIQUE,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_documents_lead 
            ON documents(lead_id, created_at DESC);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_document_shares_token 
            ON document_shares(share_token);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS pipeline_stages (
                id SERIAL PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                description TEXT,
                color VARCHAR(50),
                position INTEGER NOT NULL,
                probability INTEGER DEFAULT 50,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS pipeline_deals (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                stage_id INTEGER REFERENCES pipeline_stages(id),
                title VARCHAR(500) NOT NULL,
                value DECIMAL(10, 2),
                expected_close_date DATE,
                probability INTEGER DEFAULT 50,
                position INTEGER DEFAULT 0,
                notes TEXT,
                assigned_to INTEGER REFERENCES admin_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS deal_activities (
                id SERIAL PRIMARY KEY,
                deal_id INTEGER REFERENCES pipeline_deals(id) ON DELETE CASCADE,
                activity_type VARCHAR(100) NOT NULL,
                description TEXT,
                metadata JSONB,
                created_by INTEGER REFERENCES admin_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_pipeline_deals_stage 
            ON pipeline_deals(stage_id, position);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_deal_activities_deal 
            ON deal_activities(deal_id, created_at DESC);
        `);

        // Insert default pipeline stages
        await client.query(`
            INSERT INTO pipeline_stages (name, description, color, position, probability)
            VALUES 
                ('New Lead', 'Initial contact', '#3b82f6', 1, 10),
                ('Qualified', 'Lead has been qualified', '#10b981', 2, 25),
                ('Proposal Sent', 'Proposal has been sent to client', '#f59e0b', 3, 50),
                ('Negotiation', 'Negotiating terms', '#8b5cf6', 4, 75),
                ('Closed Won', 'Deal won', '#22c55e', 5, 100),
                ('Closed Lost', 'Deal lost', '#ef4444', 6, 0)
            ON CONFLICT DO NOTHING;
        `);

await client.query(`CREATE TABLE IF NOT EXISTS client_uploads (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    filename VARCHAR(500) NOT NULL,
    filepath TEXT NOT NULL,
    file_size BIGINT,
    mime_type VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

console.log('✅ Client portal tables initialized');

await client.query(`CREATE TABLE IF NOT EXISTS auto_campaigns (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    subject VARCHAR(500) NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Migration: ensure all columns exist on auto_campaigns (safe if table already existed without them)
await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auto_campaigns' AND column_name = 'is_active') THEN
            ALTER TABLE auto_campaigns ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auto_campaigns' AND column_name = 'updated_at') THEN
            ALTER TABLE auto_campaigns ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auto_campaigns' AND column_name = 'last_sent_at') THEN
            ALTER TABLE auto_campaigns ADD COLUMN last_sent_at TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auto_campaigns' AND column_name = 'stopped_at') THEN
            ALTER TABLE auto_campaigns ADD COLUMN stopped_at TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auto_campaigns' AND column_name = 'stop_reason') THEN
            ALTER TABLE auto_campaigns ADD COLUMN stop_reason TEXT;
        END IF;
    END $$;
`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_auto_campaigns_lead ON auto_campaigns(lead_id)`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_auto_campaigns_active ON auto_campaigns(is_active) WHERE is_active = TRUE`);
console.log('✅ Auto-campaigns table initialized');

// ── Recruitment: jobs & applications ──
await client.query(`CREATE TABLE IF NOT EXISTS jobs (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    department VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'Full-time',
    location VARCHAR(100) NOT NULL DEFAULT 'Remote',
    description TEXT,
    duties TEXT[] DEFAULT '{}',
    requirements TEXT[] DEFAULT '{}',
    published BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_published ON jobs(published)`);

await client.query(`CREATE TABLE IF NOT EXISTS applications (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    first_name VARCHAR(150) NOT NULL,
    last_name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    city VARCHAR(100),
    state VARCHAR(100),
    linkedin_url TEXT,
    portfolio_url TEXT,
    experience VARCHAR(20),
    cover_letter TEXT,
    start_date VARCHAR(50),
    expected_salary VARCHAR(100),
    referral_source VARCHAR(100),
    resume_path TEXT,
    resume_original_name TEXT,
    status VARCHAR(50) DEFAULT 'new',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id)`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status)`);
console.log('✅ Recruitment tables (jobs, applications) initialized');

        // ========================================
        // DATABASE MIGRATIONS
        // ========================================
        console.log('🔄 Running database migrations...');
        
        // Migration 1: Add user_name column to ticket_responses if it doesn't exist
        await client.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'ticket_responses' 
                    AND column_name = 'user_name'
                ) THEN
                    ALTER TABLE ticket_responses 
                    ADD COLUMN user_name VARCHAR(255) DEFAULT 'Unknown';
                    
                    -- Update existing rows to set a default user_name
                    UPDATE ticket_responses 
                    SET user_name = CASE 
                        WHEN user_type = 'admin' THEN 'Admin'
                        WHEN user_type = 'client' THEN 'Client'
                        ELSE 'Unknown'
                    END
                    WHERE user_name IS NULL OR user_name = '';
                    
                    -- Make the column NOT NULL after setting defaults
                    ALTER TABLE ticket_responses 
                    ALTER COLUMN user_name SET NOT NULL;
                    
                    RAISE NOTICE 'Added user_name column to ticket_responses';
                END IF;
            END $$;
        `);
        
        // Migration 2: Add missing columns to employees table if they don't exist
        await client.query(`
            DO $$ 
            BEGIN
                -- Add start_date column if it doesn't exist
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'employees' 
                    AND column_name = 'start_date'
                ) THEN
                    ALTER TABLE employees 
                    ADD COLUMN start_date DATE;
                    RAISE NOTICE 'Added start_date column to employees';
                END IF;
                
                -- Add end_date column if it doesn't exist
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'employees' 
                    AND column_name = 'end_date'
                ) THEN
                    ALTER TABLE employees 
                    ADD COLUMN end_date DATE;
                    RAISE NOTICE 'Added end_date column to employees';
                END IF;
                
                -- Add notes column if it doesn't exist
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'employees' 
                    AND column_name = 'notes'
                ) THEN
                    ALTER TABLE employees 
                    ADD COLUMN notes TEXT;
                    RAISE NOTICE 'Added notes column to employees';
                END IF;
                
                -- Add is_active column if it doesn't exist
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'employees' 
                    AND column_name = 'is_active'
                ) THEN
                    ALTER TABLE employees 
                    ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
                    RAISE NOTICE 'Added is_active column to employees';
                END IF;
                
                -- Add projects_assigned column if it doesn't exist
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'employees' 
                    AND column_name = 'projects_assigned'
                ) THEN
                    ALTER TABLE employees 
                    ADD COLUMN projects_assigned INTEGER DEFAULT 0;
                    RAISE NOTICE 'Added projects_assigned column to employees';
                END IF;
                
                -- Add tasks_completed column if it doesn't exist
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'employees' 
                    AND column_name = 'tasks_completed'
                ) THEN
                    ALTER TABLE employees 
                    ADD COLUMN tasks_completed INTEGER DEFAULT 0;
                    RAISE NOTICE 'Added tasks_completed column to employees';
                END IF;
            END $$;
        `);
        
        // Migration 3: Create tasks table
        await client.query(`
            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY,
                title VARCHAR(500) NOT NULL,
                description TEXT,
                due_date DATE,
                priority VARCHAR(20) DEFAULT 'medium',
                status VARCHAR(50) DEFAULT 'pending',
                completed BOOLEAN DEFAULT FALSE,
                assigned_to INTEGER REFERENCES employees(id),
                created_by VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            )
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed)
        `);
        
        // Migration 4: Add settings column to admin_users
        await client.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'admin_users' 
                    AND column_name = 'settings'
                ) THEN
                    ALTER TABLE admin_users 
                    ADD COLUMN settings JSONB DEFAULT '{}'::jsonb;
                    RAISE NOTICE 'Added settings column to admin_users';
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'admin_users' 
                    AND column_name = 'updated_at'
                ) THEN
                    ALTER TABLE admin_users 
                    ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                    RAISE NOTICE 'Added updated_at column to admin_users';
                END IF;
            END $$;
        `);
        
        // Migration 5: Create admin_sessions table for session tracking
        // Drop existing tables if they're corrupted
        await client.query(`DROP TABLE IF EXISTS admin_sessions CASCADE`);
        await client.query(`DROP TABLE IF EXISTS activity_log CASCADE`);
        
        // Create admin_sessions table
        await client.query(`
            CREATE TABLE admin_sessions (
                id SERIAL PRIMARY KEY,
                user_email VARCHAR(255),
                token VARCHAR(500) UNIQUE NOT NULL,
                ip_address VARCHAR(50),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE,
                CONSTRAINT admin_sessions_user_email_fkey 
                    FOREIGN KEY (user_email) 
                    REFERENCES admin_users(email) 
                    ON DELETE CASCADE
            )
        `);
        
        await client.query(`
            CREATE INDEX idx_sessions_user_email ON admin_sessions(user_email)
        `);
        await client.query(`
            CREATE INDEX idx_sessions_token ON admin_sessions(token)
        `);
        await client.query(`
            CREATE INDEX idx_sessions_active ON admin_sessions(is_active)
        `);
        
        // Migration 6: Create activity_log table for audit trail
        await client.query(`
            CREATE TABLE activity_log (
                id SERIAL PRIMARY KEY,
                user_email VARCHAR(255),
                action VARCHAR(100) NOT NULL,
                resource_type VARCHAR(50),
                resource_id INTEGER,
                details JSONB,
                ip_address VARCHAR(50),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_activity_user_email ON activity_log(user_email)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at)
        `);
        
        console.log('✅ Database migrations completed');

        await client.query('COMMIT');
        console.log('✅ Database tables initialized');

        // Create default admin user if none exists
        const adminCheck = await pool.query('SELECT * FROM admin_users LIMIT 1');
        
        if (adminCheck.rows.length === 0) {
            const defaultPassword = 'Tango0401!';
            const hashedPassword = await bcrypt.hash(defaultPassword, 10);
            
            await pool.query(
                'INSERT INTO admin_users (username, email, password_hash) VALUES ($1, $2, $3)',
                ['admin', 'admin@CraftedCode Co..dev', hashedPassword]
            );
            
            console.log('');
            console.log('========================================');
            console.log('✅ Default admin user created');
            console.log('   Username: admin');
            console.log('   Password: Admin123!');
            console.log('   ⚠️  CHANGE THIS PASSWORD IMMEDIATELY!');
            console.log('========================================');
            console.log('');
        }
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Database initialization error:', error);
        throw error;
    } finally {
        client.release();
    }
}

// ========================================
// ACTIVITY LOGGING HELPER
// ========================================
async function logActivity(userEmail, action, resourceType = null, resourceId = null, details = null, req = null) {
    try {
        const ipAddress = req ? (req.headers['x-forwarded-for'] || req.connection.remoteAddress) : null;
        const userAgent = req ? req.headers['user-agent'] : null;
        
        await pool.query(`
            INSERT INTO activity_log (user_email, action, resource_type, resource_id, details, ip_address, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [userEmail, action, resourceType, resourceId, details ? JSON.stringify(details) : null, ipAddress, userAgent]);
    } catch (error) {
        console.error('Activity logging error:', error);
        // Don't throw - logging shouldn't break the main operation
    }
}

// ========================================
// AUTHENTICATION MIDDLEWARE
// ========================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ 
            success: false, 
            message: 'Access denied. No token provided.' 
        });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ 
                success: false, 
                message: 'Invalid or expired token.' 
            });
        }
        req.user = user;
        next();
    });
}

// ========================================
// AUTHENTICATION ROUTES
// ========================================

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password, rememberMe } = req.body;

        if (!username || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Username and password are required.' 
            });
        }

        const result = await pool.query(
            'SELECT * FROM admin_users WHERE username = $1 OR email = $1',
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid credentials.' 
            });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid credentials.' 
            });
        }

        await pool.query(
            'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
            [user.id]
        );

        const expiresIn = rememberMe ? '30d' : '24h';
        const token = jwt.sign(
            { id: user.id, username: user.username, email: user.email },
            JWT_SECRET,
            { expiresIn }
        );
        
        // Create session record
        const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'];
        const expiresAt = new Date(Date.now() + (rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
        
        await pool.query(`
            INSERT INTO admin_sessions (user_email, token, ip_address, user_agent, expires_at)
            VALUES ($1, $2, $3, $4, $5)
        `, [user.email, token, ipAddress, userAgent, expiresAt]);
        
        // Log activity
        await logActivity(user.email, 'LOGIN', 'session', null, { rememberMe }, req);

        res.json({
            success: true,
            token: token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during login.' 
        });
    }
});

// Verify Token
app.post('/api/admin/verify', authenticateToken, (req, res) => {
    res.json({ 
        success: true, 
        user: req.user 
    });
});

// Change Password
app.post('/api/admin/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;

        const userResult = await pool.query('SELECT * FROM admin_users WHERE id = $1', [userId]);
        const user = userResult.rows[0];

        const validPassword = await bcrypt.compare(currentPassword, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ 
                success: false, 
                message: 'Current password is incorrect.' 
            });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await pool.query(
            'UPDATE admin_users SET password_hash = $1 WHERE id = $2',
            [hashedPassword, userId]
        );

        res.json({ 
            success: true, 
            message: 'Password updated successfully.' 
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// ========================================
// LEAD STATISTICS (BEFORE :id ROUTE!)
// ========================================
app.get('/api/leads/stats', authenticateToken, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE is_customer = FALSE) as total_leads,
                COUNT(*) FILTER (WHERE is_customer = TRUE) as total_customers,
                COUNT(*) FILTER (WHERE status = 'new' AND is_customer = FALSE) as new,
                COUNT(*) FILTER (WHERE status = 'pending' AND is_customer = FALSE) as pending,
                COUNT(*) FILTER (WHERE status = 'contacted' AND is_customer = FALSE) as contacted,
                COUNT(*) FILTER (WHERE status = 'closed' OR is_customer = TRUE) as closed
            FROM leads
        `);

        res.json({
            success: true,
            stats: stats.rows[0]
        });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Get all leads (must come BEFORE :id route)
app.get('/api/leads', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT l.*, 
                   e.name as employee_name,
                   e.email as employee_email
            FROM leads l
            LEFT JOIN employees e ON l.assigned_to = e.id
            ORDER BY l.created_at DESC
        `);

        res.json({
            success: true,
            leads: result.rows
        });
    } catch (error) {
        console.error('Get all leads error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Export ALL leads - complete database with no filters
app.get('/api/leads/all-complete', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT l.*, 
                   e.name as employee_name,
                   e.email as employee_email
            FROM leads l
            LEFT JOIN employees e ON l.assigned_to = e.id
            ORDER BY l.created_at DESC
        `);

        res.json({
            success: true,
            leads: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        console.error('Export all leads error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to export all leads.' 
        });
    }
});

// Export ALL leads in follow-up process (whether in queue or already followed up)
app.get('/api/leads/followup-all', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                l.*,
                e.name as employee_name,
                e.email as employee_email,
                COALESCE(EXTRACT(DAY FROM CURRENT_DATE - l.last_contact_date)::INTEGER, 999) as days_since_contact,
                CASE 
                    WHEN l.last_contact_date IS NULL THEN true
                    WHEN (l.lead_temperature = 'hot' AND (
                        l.last_contact_date IS NULL 
                        OR (l.follow_up_count >= 1 AND l.follow_up_count % 2 = 1 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '3.5 days')
                        OR (l.follow_up_count >= 2 AND l.follow_up_count % 2 = 0 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '7 days')
                    )) THEN true
                    WHEN (COALESCE(l.lead_temperature, 'cold') != 'hot' AND (
                        l.last_contact_date IS NULL
                        OR (l.follow_up_count = 0 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '3 days')
                        OR (l.follow_up_count = 1 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '5 days')
                        OR (l.follow_up_count >= 2 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '7 days')
                    )) THEN true
                    ELSE false
                END as in_followup_queue
            FROM leads l
            LEFT JOIN employees e ON l.assigned_to = e.id
            WHERE l.status IN ('new', 'contacted', 'qualified', 'pending')
            AND l.is_customer = FALSE
            AND l.unsubscribed = FALSE
            AND NOT EXISTS (
                SELECT 1 FROM auto_campaigns ac WHERE ac.lead_id = l.id AND ac.is_active = TRUE
            )
            ORDER BY l.last_contact_date ASC NULLS FIRST, l.created_at DESC
        `);

        res.json({
            success: true,
            leads: result.rows,
            total: result.rows.length,
            in_queue: result.rows.filter(l => l.in_followup_queue).length,
            already_followed_up: result.rows.filter(l => !l.in_followup_queue).length
        });
    } catch (error) {
        console.error('Export follow-up leads error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to export follow-up leads.' 
        });
    }
});

// ========================================
// LEAD MANAGEMENT ROUTES
// ========================================

// Get all leads
// Replace your existing GET /api/leads/:id route with this:
app.get('/api/leads/:id', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;

        // Get lead with employee info
        const leadResult = await pool.query(`
            SELECT l.*, 
                   e.name as employee_name,
                   e.email as employee_email
            FROM leads l
            LEFT JOIN employees e ON l.assigned_to = e.id
            WHERE l.id = $1
        `, [leadId]);
        
        if (leadResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Lead not found.' 
            });
        }

        const notesResult = await pool.query(
            'SELECT * FROM lead_notes WHERE lead_id = $1 ORDER BY created_at DESC',
            [leadId]
        );

        res.json({
            success: true,
            lead: leadResult.rows[0],
            notes: notesResult.rows
        });
    } catch (error) {
        console.error('Get lead error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Update lead (including notes)
app.put('/api/leads/:id', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const updates = req.body;

        // Build dynamic update query
        const fields = [];
        const values = [];
        let paramIndex = 1;

        Object.keys(updates).forEach(key => {
            if (updates[key] !== undefined && key !== 'id') {
                fields.push(`${key} = $${paramIndex}`);
                values.push(updates[key]);
                paramIndex++;
            }
        });

        if (fields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update.'
            });
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(leadId);

        const query = `
            UPDATE leads 
            SET ${fields.join(', ')} 
            WHERE id = $${paramIndex}
            RETURNING *
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Lead not found.' 
            });
        }

        res.json({
            success: true,
            message: 'Lead updated successfully.',
            lead: result.rows[0]
        });
    } catch (error) {
        console.error('Update lead error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Delete lead/customer
app.delete('/api/leads/:id', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;

        // First delete all notes associated with the lead
        await pool.query('DELETE FROM lead_notes WHERE lead_id = $1', [leadId]);
        
        // Then delete the lead/customer
        const result = await pool.query('DELETE FROM leads WHERE id = $1 RETURNING *', [leadId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Lead not found.' 
            });
        }

        console.log(`✅ Lead/Customer ${leadId} deleted`);

        res.json({
            success: true,
            message: 'Lead/Customer deleted successfully.'
        });
    } catch (error) {
        console.error('Delete lead error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Update lead status (HANDLES CUSTOMER CONVERSION)
// Update lead status (HANDLES CUSTOMER CONVERSION + LAST CONTACTED)
app.patch('/api/leads/:id/status', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { status, isCustomer, customerStatus, last_contacted } = req.body;

        // If converting to customer
        if (isCustomer) {
            await pool.query(
                `UPDATE leads 
                 SET status = $1, 
                     is_customer = $2, 
                     customer_status = $3,
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $4`,
                [status, true, customerStatus || 'onboarding', leadId]
            );
            
            console.log(`✅ Lead ${leadId} converted to customer`);
        } 
        // If updating to 'contacted' status with last_contacted timestamp
        else if (status === 'contacted' && last_contacted) {
            await pool.query(
                `UPDATE leads 
                 SET status = $1, 
                     last_contacted = $2,
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $3`,
                [status, last_contacted, leadId]
            );
            
            console.log(`✅ Lead ${leadId} marked as contacted at ${last_contacted}`);
        }
        // Regular status update
        else {
            await pool.query(
                'UPDATE leads SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [status, leadId]
            );
        }

        res.json({
            success: true,
            message: isCustomer ? 'Lead converted to customer successfully.' : 'Status updated successfully.'
        });
    } catch (error) {
        console.error('Update status error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Update customer status
app.patch('/api/leads/:id/customer-status', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { customerStatus } = req.body;

        await pool.query(
            'UPDATE leads SET customer_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [customerStatus, leadId]
        );

        console.log(`✅ Customer ${leadId} status updated to ${customerStatus}`);

        res.json({
            success: true,
            message: 'Customer status updated successfully.'
        });
    } catch (error) {
        console.error('Update customer status error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Update lead priority
app.patch('/api/leads/:id/priority', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { priority } = req.body;

        await pool.query(
            'UPDATE leads SET priority = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [priority, leadId]
        );

        res.json({
            success: true,
            message: 'Priority updated successfully.'
        });
    } catch (error) {
        console.error('Update priority error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Add note to lead
app.post('/api/leads/:id/notes', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { noteText } = req.body;
        const userId = req.user.id;

        const result = await pool.query(
            `INSERT INTO lead_notes (lead_id, note_text, created_by)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [leadId, noteText, userId]
        );

        res.json({
            success: true,
            message: 'Note added successfully.',
            note: result.rows[0]
        });
    } catch (error) {
        console.error('Add note error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// ========================================
// COOKIE CONSENT ROUTE
// ========================================

// Save cookie consent (PUBLIC)
app.post('/api/cookie-consent', async (req, res) => {
    try {
        const { consentType, preferences, userId } = req.body;
        const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'];

        if (!consentType) {
            return res.status(400).json({
                success: false,
                message: 'Consent type is required.'
            });
        }

        const result = await pool.query(
            `INSERT INTO cookie_consent (user_id, consent_type, preferences, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [userId || null, consentType, JSON.stringify(preferences || {}), ipAddress, userAgent]
        );

        console.log('✅ Cookie consent saved:', result.rows[0]);

        res.json({
            success: true,
            message: 'Cookie consent saved successfully.',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Save cookie consent error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error. Please try again.' 
        });
    }
});

// ========================================
// SERVE HTML FILES
// ========================================

// Main index page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Contact page
app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact_form.html'));
});

// Admin login
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

// Admin portal
app.get('/admin/portal', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_portal.html'));
});

app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_portal.html'));
});

// Privacy Policy page
app.get('/privacy-policy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy_policy.html'));
});

app.get('/privacy', (req, res) => {
    res.redirect('/privacy-policy');
});

// Terms of Service page
app.get('/terms-of-service', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms_of_service.html'));
});

app.get('/terms', (req, res) => {
    res.redirect('/terms-of-service');
});

// ========================================
// COOKIE CONSENT ADMIN ROUTES
// ========================================

// Get all cookie consents
app.get('/api/admin/cookie-consent', authenticateToken, async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        
        const result = await pool.query(
            `SELECT * FROM cookie_consent 
             ORDER BY created_at DESC 
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const countResult = await pool.query('SELECT COUNT(*) FROM cookie_consent');

        res.json({
            success: true,
            consents: result.rows,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Get cookie consents error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Get cookie consent statistics
app.get('/api/admin/cookie-consent/stats', authenticateToken, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN consent_type = 'accepted' THEN 1 END) as accepted,
                COUNT(CASE WHEN consent_type = 'declined' THEN 1 END) as declined,
                COUNT(CASE WHEN consent_type = 'custom' THEN 1 END) as custom
            FROM cookie_consent
        `);

        res.json({
            success: true,
            stats: stats.rows[0]
        });
    } catch (error) {
        console.error('Get cookie stats error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// ========================================
// EMPLOYEE MANAGEMENT ROUTES
// ========================================

// Get all employees
app.get('/api/employees', authenticateToken, async (req, res) => {
    try {
        // First, ensure the table exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(50),
                role VARCHAR(100) DEFAULT 'Team Member',
                is_active BOOLEAN DEFAULT TRUE,
                projects_assigned INTEGER DEFAULT 0,
                tasks_completed INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        const result = await pool.query(
            'SELECT * FROM employees WHERE is_active = TRUE ORDER BY name'
        );

        res.json({
            success: true,
            employees: result.rows
        });
    } catch (error) {
        console.error('Get employees error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error: ' + error.message 
        });
    }
});

// Get single employee
app.get('/api/employees/:id', authenticateToken, async (req, res) => {
    try {
        const employeeId = req.params.id;

        const result = await pool.query(
            'SELECT * FROM employees WHERE id = $1',
            [employeeId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Employee not found.' 
            });
        }

        // Get assigned leads/customers count
        const assignedCount = await pool.query(
            'SELECT COUNT(*) FROM leads WHERE assigned_to = $1',
            [employeeId]
        );

        res.json({
            success: true,
            employee: result.rows[0],
            assignedCount: parseInt(assignedCount.rows[0].count)
        });
    } catch (error) {
        console.error('Get employee error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Create new employee
app.post('/api/employees', authenticateToken, async (req, res) => {
    try {
        // First, ensure the table exists with all fields
        await pool.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(50),
                role VARCHAR(100) DEFAULT 'Team Member',
                start_date DATE,
                end_date DATE,
                notes TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                projects_assigned INTEGER DEFAULT 0,
                tasks_completed INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        const { name, email, phone, role, start_date, end_date, notes } = req.body;
        
        console.log('📝 Creating employee:', { name, email, phone, role, start_date, end_date });

        if (!name || !email) {
            return res.status(400).json({
                success: false,
                message: 'Name and email are required.'
            });
        }

        const result = await pool.query(
            `INSERT INTO employees (name, email, phone, role, start_date, end_date, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                name.trim(), 
                email.trim().toLowerCase(), 
                phone || null, 
                role || 'Team Member',
                start_date || null,
                end_date || null,
                notes || null
            ]
        );

        console.log('✅ New employee created:', result.rows[0]);

        res.json({
            success: true,
            message: 'Employee created successfully.',
            employee: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Create employee error:', error);
        
        if (error.code === '23505') {
            return res.status(400).json({
                success: false,
                message: 'An employee with this email already exists.'
            });
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Server error: ' + error.message 
        });
    }
});

// Update employee
app.patch('/api/employees/:id', authenticateToken, async (req, res) => {
    try {
        const employeeId = req.params.id;
        const { name, email, phone, role } = req.body;

        const result = await pool.query(
            `UPDATE employees 
             SET name = $1, 
                 email = $2, 
                 phone = $3, 
                 role = $4,
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $5
             RETURNING *`,
            [name, email, phone, role, employeeId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Employee not found.' 
            });
        }

        console.log('✅ Employee updated:', employeeId);

        res.json({
            success: true,
            message: 'Employee updated successfully.',
            employee: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({
                success: false,
                message: 'An employee with this email already exists.'
            });
        }
        console.error('Update employee error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// ========================================
// TASKS ENDPOINTS
// ========================================

// Get all tasks
app.get('/api/tasks', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, e.name as assigned_name, e.email as assigned_email
            FROM tasks t
            LEFT JOIN employees e ON t.assigned_to = e.id
            ORDER BY t.created_at DESC
        `);
        
        res.json({ success: true, tasks: result.rows });
    } catch (error) {
        console.error('Get tasks error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Create new task
app.post('/api/tasks', authenticateToken, async (req, res) => {
    try {
        const { title, description, due_date, priority, assigned_to } = req.body;
        
        if (!title) {
            return res.status(400).json({
                success: false,
                message: 'Task title is required.'
            });
        }

        const result = await pool.query(`
            INSERT INTO tasks (title, description, due_date, priority, assigned_to, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [title, description, due_date, priority || 'medium', assigned_to, req.user.email]);

        // Get employee name if assigned
        let task = result.rows[0];
        if (task.assigned_to) {
            const empResult = await pool.query('SELECT name, email FROM employees WHERE id = $1', [task.assigned_to]);
            if (empResult.rows.length > 0) {
                task.assigned_name = empResult.rows[0].name;
                task.assigned_email = empResult.rows[0].email;
            }
        }

        res.json({ 
            success: true, 
            message: 'Task created successfully',
            task: task
        });
    } catch (error) {
        console.error('Create task error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Update task (toggle completion, edit, etc)
app.put('/api/tasks/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, due_date, priority, assigned_to, completed, status } = req.body;
        
        let query = 'UPDATE tasks SET updated_at = CURRENT_TIMESTAMP';
        let values = [];
        let paramCount = 1;
        
        if (title !== undefined) {
            query += `, title = $${paramCount++}`;
            values.push(title);
        }
        if (description !== undefined) {
            query += `, description = $${paramCount++}`;
            values.push(description);
        }
        if (due_date !== undefined) {
            query += `, due_date = $${paramCount++}`;
            values.push(due_date);
        }
        if (priority !== undefined) {
            query += `, priority = $${paramCount++}`;
            values.push(priority);
        }
        if (assigned_to !== undefined) {
            query += `, assigned_to = $${paramCount++}`;
            values.push(assigned_to);
        }
        if (completed !== undefined) {
            query += `, completed = $${paramCount++}`;
            values.push(completed);
            if (completed) {
                query += `, completed_at = CURRENT_TIMESTAMP`;
            } else {
                query += `, completed_at = NULL`;
            }
        }
        if (status !== undefined) {
            query += `, status = $${paramCount++}`;
            values.push(status);
        }
        
        query += ` WHERE id = $${paramCount} RETURNING *`;
        values.push(id);
        
        const result = await pool.query(query, values);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Task not found.'
            });
        }

        // Get employee name if assigned
        let task = result.rows[0];
        if (task.assigned_to) {
            const empResult = await pool.query('SELECT name, email FROM employees WHERE id = $1', [task.assigned_to]);
            if (empResult.rows.length > 0) {
                task.assigned_name = empResult.rows[0].name;
                task.assigned_email = empResult.rows[0].email;
            }
        }

        res.json({
            success: true,
            message: 'Task updated successfully',
            task: task
        });
    } catch (error) {
        console.error('Update task error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Delete task
app.delete('/api/tasks/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING *', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Task not found.'
            });
        }

        res.json({
            success: true,
            message: 'Task deleted successfully'
        });
    } catch (error) {
        console.error('Delete task error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ========================================
// USER SETTINGS ENDPOINTS
// ========================================

// Get user settings
app.get('/api/settings', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT settings FROM admin_users WHERE email = $1
        `, [req.user.email]);
        
        if (result.rows.length === 0) {
            return res.json({ 
                success: true, 
                settings: {
                    emailNotifications: true,
                    pushNotifications: false,
                    weeklyReport: true,
                    darkMode: true,
                    autoAssign: false,
                    twoFactorAuth: false,
                    sessionTimeout: 30,
                    ipWhitelist: [],
                    useBrevo: false,
                    brevoApiKey: '',
                    brevoSenderEmail: '',
                    brevoSenderName: ''
                }
            });
        }

        res.json({ 
            success: true, 
            settings: result.rows[0].settings || {}
        });
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Update user settings
app.put('/api/settings', authenticateToken, async (req, res) => {
    try {
        const settings = req.body;
        
        await pool.query(`
            UPDATE admin_users 
            SET settings = $1, updated_at = CURRENT_TIMESTAMP
            WHERE email = $2
        `, [JSON.stringify(settings), req.user.email]);

        res.json({
            success: true,
            message: 'Settings updated successfully',
            settings: settings
        });
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Change password endpoint
app.post('/api/admin/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required.'
            });
        }
        
        // Get user's current password hash
        const userResult = await pool.query(
            'SELECT password_hash FROM admin_users WHERE email = $1',
            [req.user.email]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found.'
            });
        }
        
        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
        
        if (!isValid) {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect.'
            });
        }
        
        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        
        // Update password
        await pool.query(
            'UPDATE admin_users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2',
            [newPasswordHash, req.user.email]
        );
        
        // Log activity
        await logActivity(req.user.email, 'PASSWORD_CHANGED', null, null, null, req);
        
        res.json({
            success: true,
            message: 'Password changed successfully.'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get active sessions
app.get('/api/admin/sessions', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, ip_address, user_agent, created_at, last_activity, expires_at
            FROM admin_sessions
            WHERE user_email = $1 AND is_active = true
            ORDER BY last_activity DESC
        `, [req.user.email]);
        
        res.json({
            success: true,
            sessions: result.rows
        });
    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Revoke a session
app.delete('/api/admin/sessions/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        await pool.query(`
            UPDATE admin_sessions 
            SET is_active = false 
            WHERE id = $1 AND user_email = $2
        `, [id, req.user.email]);
        
        res.json({
            success: true,
            message: 'Session revoked successfully'
        });
    } catch (error) {
        console.error('Revoke session error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get activity log
app.get('/api/admin/activity-log', authenticateToken, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        
        const result = await pool.query(`
            SELECT id, action, resource_type, resource_id, details, ip_address, created_at
            FROM activity_log
            WHERE user_email = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
        `, [req.user.email, limit, offset]);
        
        res.json({
            success: true,
            activities: result.rows
        });
    } catch (error) {
        console.error('Get activity log error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Create new lead OR update existing (PUBLIC - from contact form AND authenticated admin creation)
app.post('/api/leads', async (req, res) => {
    try {
        const { 
            name, firstName, lastName, email, phone, 
            company, project_type, message, budget, timeline,
            service, details, priority, status, 
            isCustomer, customerStatus, assignedTo 
        } = req.body;

        // Handle both name formats
        let fullName = name;
        if (!fullName && firstName && lastName) {
            fullName = `${firstName} ${lastName}`;
        }
        if (!fullName && firstName) {
            fullName = firstName;
        }

        if (!fullName || !email) {
            return res.status(400).json({
                success: false,
                message: 'Name and email are required.'
            });
        }

        // Check if email already exists in the system
        const existingLead = await pool.query(
            'SELECT id, name, email, status, is_customer FROM leads WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        const isAuthenticated = req.headers.authorization;

        // If lead exists and this is from the contact form (not authenticated admin)
        if (existingLead.rows.length > 0 && !isAuthenticated) {
            const existing = existingLead.rows[0];
            
            console.log('📧 Existing lead re-engaged via contact form:', email);
            
            // Track this engagement (will automatically make them hot)
            console.log(`[CONTACT FORM] 📝 Tracking re-engagement for existing lead ${existing.id}`);
            const trackResult = await trackEngagement(existing.id, 'form_fill', 'Submitted contact form again');
            console.log(`[CONTACT FORM] Track result:`, trackResult);
            
            // Update the existing lead with new information
            const updateResult = await pool.query(
                `UPDATE leads 
                 SET 
                    phone = COALESCE($1, phone),
                    company = COALESCE($2, company),
                    project_type = COALESCE($3, project_type),
                    message = CASE 
                        WHEN $4::TEXT IS NOT NULL THEN 
                            COALESCE(message || E'\n\n--- New Form Submission ---\n' || $4::TEXT, $4::TEXT)
                        ELSE message 
                    END,
                    budget = COALESCE($5, budget),
                    timeline = COALESCE($6, timeline),
                    last_contact_date = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP,
                    -- If they were closed/lost, move them back to contacted
                    status = CASE 
                        WHEN status IN ('closed', 'lost') THEN 'contacted'
                        WHEN status = 'new' THEN 'contacted'
                        ELSE status 
                    END
                 WHERE id = $7
                 RETURNING *`,
                [
                    phone || null,
                    company || null,
                    project_type || service || null,
                    message || details || null,
                    budget || null,
                    timeline || null,
                    existing.id
                ]
            );

            // Create an activity/note to track this re-engagement
            try {
                await pool.query(
                    `INSERT INTO lead_notes (lead_id, note_text, created_at)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)`,
                    [existing.id, `Lead re-engaged via contact form. New message: ${message || details || 'No message provided'}`]
                );
            } catch (noteError) {
                console.error('⚠️ Failed to create note (non-critical):', noteError);
                // Continue anyway - this is not critical to the lead update
            }

            // Send notification email to admin about re-engagement
            try {
                const notificationHTML = buildEmailHTML(`
                    <h2 style="color: #D4A847; margin-bottom: 20px;">🔔 Existing Lead Re-Engaged!</h2>
                    
                    <p style="font-size: 16px; color: #333; margin-bottom: 24px;">
                        An existing lead has filled out your contact form again. Here are the details:
                    </p>

                    <div style="background: #f8f9fa; border-left: 4px solid #D4A847; padding: 20px; margin: 24px 0; border-radius: 4px;">
                        <p style="margin: 0 0 12px 0;"><strong>Name:</strong> ${fullName}</p>
                        <p style="margin: 0 0 12px 0;"><strong>Email:</strong> ${email}</p>
                        ${phone ? `<p style="margin: 0 0 12px 0;"><strong>Phone:</strong> ${phone}</p>` : ''}
                        ${company ? `<p style="margin: 0 0 12px 0;"><strong>Company:</strong> ${company}</p>` : ''}
                        ${project_type || service ? `<p style="margin: 0 0 12px 0;"><strong>Project Type:</strong> ${project_type || service}</p>` : ''}
                        ${budget ? `<p style="margin: 0 0 12px 0;"><strong>Budget:</strong> ${budget}</p>` : ''}
                        ${timeline ? `<p style="margin: 0 0 12px 0;"><strong>Timeline:</strong> ${timeline}</p>` : ''}
                        <p style="margin: 0 0 12px 0;"><strong>Previous Status:</strong> ${existing.status}</p>
                    </div>

                    ${message || details ? `
                        <div style="background: #fff; border: 1px solid #e0e0e0; padding: 20px; margin: 24px 0; border-radius: 4px;">
                            <p style="font-weight: 600; margin-bottom: 12px; color: #333;">New Message:</p>
                            <p style="color: #555; line-height: 1.6; white-space: pre-wrap;">${message || details}</p>
                        </div>
                    ` : ''}

                    <div style="margin-top: 32px; padding: 20px; background: #f0f7ff; border-radius: 4px;">
                        <p style="margin: 0 0 12px 0; color: #0066cc;">
                            <strong>👉 Action Required:</strong> This lead has already been in your system and is now reaching out again.
                        </p>
                        <p style="margin: 0; color: #555;">
                            Their status has been updated to "contacted" and their information has been merged with any new details they provided.
                        </p>
                    </div>

                    <div style="text-align: center; margin-top: 32px;">
                        <a href="${BASE_URL}/admin-portal" 
                           style="display: inline-block; background: #D4A847; color: #fff; padding: 14px 32px; 
                                  text-decoration: none; border-radius: 4px; font-weight: 600;">
                            View Lead in CRM
                        </a>
                    </div>

                    <div class="sign-off" style="margin-top: 32px;">
                        <p>This is an automated notification from your CRM system.</p>
                    </div>
                `);

                const mailOptions = {
                    from: `"Diamondback Coding CRM" <${process.env.EMAIL_USER}>`,
                    to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
                    subject: `🔔 Lead Re-Engaged: ${fullName} submitted contact form again`,
                    html: notificationHTML
                };

                await transporter.sendMail(mailOptions);
                console.log('📧 Re-engagement notification email sent to admin');
            } catch (emailError) {
                console.error('⚠️ Failed to send re-engagement notification email:', emailError);
                // Don't fail the request if email fails
            }

            console.log('✅ Existing lead updated with new contact form data:', existing.email);

            return res.json({
                success: true,
                message: 'Thank you for contacting us! We\'ll get back to you within 24 hours.',
                lead: updateResult.rows[0],
                updated: true  // Flag to indicate this was an update
            });
        }

        // If lead exists but this is from authenticated admin, reject duplicate
        if (existingLead.rows.length > 0 && isAuthenticated) {
            console.log('❌ Admin attempted duplicate lead creation:', email);
            return res.status(409).json({
                success: false,
                message: `A lead with email ${email} already exists in the system (${existingLead.rows[0].name}). Please use a different email or update the existing lead.`
            });
        }

        // No existing lead - create new one
        console.log('📝 New lead submission:', { name: fullName, email, phone, company, project_type, message });

        const result = await pool.query(
            `INSERT INTO leads (
                name, email, phone, company, project_type, message, 
                budget, timeline, priority, status, 
                is_customer, customer_status, assigned_to
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *`,
            [
                fullName,
                email, 
                phone || null, 
                company || null,
                project_type || service || null,
                message || details || null,
                budget || null, 
                timeline || null,
                priority || 'medium',
                status || 'new',
                isCustomer || false,
                customerStatus || null,
                assignedTo || null
            ]
        );

        console.log('✅ New lead created:', result.rows[0].email);
        
        // If this is from the contact form (not admin), track engagement and make them hot
        if (!isAuthenticated) {
            console.log(`[CONTACT FORM] 📝 Tracking engagement for new lead ${result.rows[0].id}`);
            const trackResult = await trackEngagement(result.rows[0].id, 'form_fill', 'Initial contact form submission');
            console.log(`[CONTACT FORM] Track result:`, trackResult);
        }

        res.json({
            success: true,
            message: isAuthenticated ? 'Lead created successfully.' : 'Thank you for contacting us! We\'ll get back to you within 24 hours.',
            lead: result.rows[0],
            updated: false  // Flag to indicate this was a new creation
        });
    } catch (error) {
        console.error('❌ Create lead error:', error);
        console.error('Request body:', req.body);
        res.status(500).json({ 
            success: false, 
            message: 'Server error. Please try again.',
            error: error.message 
        });
    }
});

// Delete employee
app.delete('/api/employees/:id', authenticateToken, async (req, res) => {
    try {
        const employeeId = req.params.id;

        // Actually delete from database (not just mark inactive)
        const result = await pool.query(
            'DELETE FROM employees WHERE id = $1 RETURNING *',
            [employeeId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Employee not found.' 
            });
        }

        res.json({
            success: true,
            message: 'Employee permanently deleted from database.'
        });
    } catch (error) {
        console.error('Delete employee error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Update employee
app.put('/api/employees/:id', authenticateToken, async (req, res) => {
    try {
        const employeeId = req.params.id;
        const { name, email, phone, role, start_date, end_date, notes, is_active } = req.body;
        
        console.log('📝 Updating employee:', employeeId, { name, email, phone, role, start_date, end_date, is_active });

        if (!name || !email) {
            return res.status(400).json({
                success: false,
                message: 'Name and email are required.'
            });
        }

        const result = await pool.query(
            `UPDATE employees 
             SET name = $1, 
                 email = $2, 
                 phone = $3, 
                 role = $4, 
                 start_date = $5, 
                 end_date = $6, 
                 notes = $7,
                 is_active = $8,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $9
             RETURNING *`,
            [
                name.trim(), 
                email.trim().toLowerCase(), 
                phone || null, 
                role || 'Team Member',
                start_date || null,
                end_date || null,
                notes || null,
                is_active !== undefined ? is_active : true,
                employeeId
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found.'
            });
        }

        console.log('✅ Employee updated:', result.rows[0]);

        res.json({
            success: true,
            employee: result.rows[0],
            message: 'Employee updated successfully.'
        });
    } catch (error) {
        console.error('Update employee error:', error);
        
        if (error.code === '23505') {
            return res.status(400).json({
                success: false,
                message: 'Email already in use by another employee.'
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// Assign lead to employee
app.patch('/api/leads/:id/assign', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { employeeId } = req.body;

        // If employeeId is null, unassign
        const result = await pool.query(
            'UPDATE leads SET assigned_to = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [employeeId || null, leadId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Lead not found.' 
            });
        }

        console.log(`✅ Lead ${leadId} ${employeeId ? 'assigned to employee ' + employeeId : 'unassigned'}`);

        res.json({
            success: true,
            message: employeeId ? 'Lead assigned successfully.' : 'Lead unassigned successfully.'
        });
    } catch (error) {
        console.error('Assign lead error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// ========================================
// EXPENSE MANAGEMENT ROUTES
// Add these routes to your server.js file
// ========================================

// Get all expenses for a lead/customer
app.get('/api/leads/:id/expenses', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { includeInvoiced } = req.query;
        
        let query = 'SELECT * FROM expenses WHERE lead_id = $1';
        const params = [leadId];
        
        if (includeInvoiced !== 'true') {
            query += ' AND is_invoiced = FALSE';
        }
        
        query += ' ORDER BY expense_date DESC, created_at DESC';
        
        const result = await pool.query(query, params);

        res.json({
            success: true,
            expenses: result.rows
        });
    } catch (error) {
        console.error('Get expenses error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Add expense to lead/customer
app.post('/api/leads/:id/expenses', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { description, amount, quantity, expenseDate, category, isBillable, notes } = req.body;
        const userId = req.user.id;

        if (!description || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Description and amount are required.'
            });
        }

        const result = await pool.query(
            `INSERT INTO expenses (lead_id, description, amount, quantity, expense_date, category, is_billable, notes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [leadId, description, amount, quantity || 1, expenseDate || new Date(), category, isBillable !== false, notes, userId]
        );

        console.log('✅ Expense added to lead:', leadId);

        res.json({
            success: true,
            message: 'Expense added successfully.',
            expense: result.rows[0]
        });
    } catch (error) {
        console.error('Add expense error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Update expense
app.patch('/api/expenses/:id', authenticateToken, async (req, res) => {
    try {
        const expenseId = req.params.id;
        const { description, amount, quantity, expenseDate, category, isBillable, notes } = req.body;

        const result = await pool.query(
            `UPDATE expenses 
             SET description = $1, amount = $2, quantity = $3, expense_date = $4, 
                 category = $5, is_billable = $6, notes = $7
             WHERE id = $8 AND is_invoiced = FALSE
             RETURNING *`,
            [description, amount, quantity, expenseDate, category, isBillable, notes, expenseId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Expense not found or already invoiced.' 
            });
        }

        res.json({
            success: true,
            message: 'Expense updated successfully.',
            expense: result.rows[0]
        });
    } catch (error) {
        console.error('Update expense error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Delete expense
app.delete('/api/expenses/:id', authenticateToken, async (req, res) => {
    try {
        const expenseId = req.params.id;

        const result = await pool.query(
            'DELETE FROM expenses WHERE id = $1 AND is_invoiced = FALSE RETURNING *',
            [expenseId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Expense not found or already invoiced.' 
            });
        }

        res.json({
            success: true,
            message: 'Expense deleted successfully.'
        });
    } catch (error) {
        console.error('Delete expense error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// ========================================
// INVOICE MANAGEMENT ROUTES
// ========================================

// Get all invoices
// Get all invoices
app.get('/api/invoices', authenticateToken, async (req, res) => {
    try {
        const { status, leadId } = req.query;
        
let query = `
    SELECT i.*, 
           l.name, l.email, l.company,
           l.address_line1, l.address_line2, l.city, l.state, l.zip_code, l.country,
                   (SELECT json_agg(json_build_object(
                       'description', ii.description,
                       'quantity', ii.quantity,
                       'unit_price', ii.unit_price,
                       'amount', ii.amount
                   ))
                   FROM invoice_items ii
                   WHERE ii.invoice_id = i.id) as items
            FROM invoices i
            LEFT JOIN leads l ON i.lead_id = l.id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (status && status !== 'all') {
            query += ` AND i.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (leadId) {
            query += ` AND i.lead_id = $${paramIndex}`;
            params.push(leadId);
            paramIndex++;
        }

        query += ' ORDER BY i.created_at DESC';

        const result = await pool.query(query, params);

        // Format the results
const invoices = result.rows.map(inv => ({
    ...inv,
    customer_name: inv.name,
    customer_email: inv.email,
    customer_company: inv.company,
    address_line1: inv.address_line1,
    address_line2: inv.address_line2,
    city: inv.city,
    state: inv.state,
    zip_code: inv.zip_code,
    country: inv.country,
    items: inv.items || []
}));

        res.json({
            success: true,
            invoices: invoices
        });
    } catch (error) {
        console.error('Get invoices error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Get single invoice with details
app.get('/api/invoices/:id', authenticateToken, async (req, res) => {
    try {
        const invoiceId = req.params.id;

        const invoiceResult = await pool.query(
            `SELECT i.*, 
                    l.first_name, l.last_name, l.email, l.phone, l.company, l.website
             FROM invoices i
             LEFT JOIN leads l ON i.lead_id = l.id
             WHERE i.id = $1`,
            [invoiceId]
        );

        if (invoiceResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Invoice not found.' 
            });
        }

        const expensesResult = await pool.query(
            'SELECT * FROM expenses WHERE invoice_id = $1 ORDER BY expense_date',
            [invoiceId]
        );

        const itemsResult = await pool.query(
            'SELECT * FROM invoice_items WHERE invoice_id = $1',
            [invoiceId]
        );

        res.json({
            success: true,
            invoice: invoiceResult.rows[0],
            expenses: expensesResult.rows,
            items: itemsResult.rows
        });
    } catch (error) {
        console.error('Get invoice error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Generate invoice number
function generateInvoiceNumber() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `INV-${year}${month}-${random}`;
}

// Create invoice
app.post('/api/invoices', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        const { 
            invoice_number, lead_id, issue_date, due_date,
            subtotal, tax_rate, tax_amount, discount_amount, total_amount,
            status, notes, short_description, items  // ADD short_description here
        } = req.body;
        const userId = req.user.id;

        if (!lead_id || !items || items.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Lead ID and at least one item are required.'
            });
        }

        // Get lead info with full address
        const leadResult = await client.query(
            `SELECT name, email, company, 
                    address_line1, address_line2, city, state, zip_code, country
             FROM leads WHERE id = $1`,
            [lead_id]
        );

        if (leadResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Lead not found.'
            });
        }

        const lead = leadResult.rows[0];

        // Create invoice WITH short_description
        const invoiceResult = await client.query(
            `INSERT INTO invoices 
             (invoice_number, lead_id, issue_date, due_date, subtotal, tax_rate, tax_amount, 
              discount_amount, total_amount, status, notes, short_description, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING *`,
            [invoice_number, lead_id, issue_date, due_date, subtotal, tax_rate || 0, tax_amount || 0, 
             discount_amount || 0, total_amount, status || 'draft', notes, short_description, userId]
        );

        const invoiceId = invoiceResult.rows[0].id;

        // Add items to invoice
        for (const item of items) {
            if (item.expense_id) {
                // Mark expense as invoiced
                await client.query(
                    'UPDATE expenses SET is_invoiced = TRUE, invoice_id = $1 WHERE id = $2',
                    [invoiceId, item.expense_id]
                );
            }
            
            // Add to invoice_items
            await client.query(
                `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
                 VALUES ($1, $2, $3, $4, $5)`,
                [invoiceId, item.description, item.quantity, item.unit_price, item.amount]
            );
        }

        await client.query('COMMIT');

        console.log('✅ Invoice created:', invoice_number);

        // Return complete invoice data with address
        const fullInvoice = {
            ...invoiceResult.rows[0],
            customer_name: lead.name,
            customer_email: lead.email,
            customer_company: lead.company,
            address_line1: lead.address_line1,
            address_line2: lead.address_line2,
            city: lead.city,
            state: lead.state,
            zip_code: lead.zip_code,
            country: lead.country,
            items: items
        };

        res.json({
            success: true,
            message: 'Invoice created successfully.',
            invoice: fullInvoice
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create invoice error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error creating invoice.' 
        });
    } finally {
        client.release();
    }
});

// Update invoice details (due_date, issue_date, notes, etc.)
app.patch('/api/invoices/:id', authenticateToken, async (req, res) => {
    try {
        const invoiceId = req.params.id;
        const { issue_date, due_date, notes, short_description, tax_rate, discount_amount } = req.body;

        // Build dynamic update query
        const fields = [];
        const values = [];
        let paramIndex = 1;

        if (issue_date !== undefined) {
            fields.push(`issue_date = $${paramIndex}`);
            values.push(issue_date);
            paramIndex++;
        }

        if (due_date !== undefined) {
            fields.push(`due_date = $${paramIndex}`);
            values.push(due_date);
            paramIndex++;
        }

        if (notes !== undefined) {
            fields.push(`notes = $${paramIndex}`);
            values.push(notes);
            paramIndex++;
        }

        if (short_description !== undefined) {
            fields.push(`short_description = $${paramIndex}`);
            values.push(short_description);
            paramIndex++;
        }

        if (tax_rate !== undefined) {
            fields.push(`tax_rate = $${paramIndex}`);
            values.push(tax_rate);
            paramIndex++;
        }

        if (discount_amount !== undefined) {
            fields.push(`discount_amount = $${paramIndex}`);
            values.push(discount_amount);
            paramIndex++;
        }

        if (fields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update.'
            });
        }

        values.push(invoiceId);

        const query = `
            UPDATE invoices 
            SET ${fields.join(', ')} 
            WHERE id = $${paramIndex}
            RETURNING *
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Invoice not found.' 
            });
        }

        console.log(`✅ Invoice ${result.rows[0].invoice_number} updated`);

        res.json({
            success: true,
            message: 'Invoice updated successfully.',
            invoice: result.rows[0]
        });
    } catch (error) {
        console.error('Update invoice error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Update invoice status
app.patch('/api/invoices/:id/status', authenticateToken, async (req, res) => {
    try {
        const invoiceId = req.params.id;
        const { status } = req.body;

        const validStatuses = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status.'
            });
        }

        const paidAt = status === 'paid' ? new Date() : null;

        const result = await pool.query(
            'UPDATE invoices SET status = $1, paid_at = $2 WHERE id = $3 RETURNING *',
            [status, paidAt, invoiceId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Invoice not found.' 
            });
        }

        res.json({
            success: true,
            message: 'Invoice status updated.',
            invoice: result.rows[0]
        });
    } catch (error) {
        console.error('Update invoice status error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Delete invoice (and unmark expenses)
app.delete('/api/invoices/:id', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        const invoiceId = req.params.id;

        // Get invoice details first
        const invoiceCheck = await client.query(
            'SELECT * FROM invoices WHERE id = $1',
            [invoiceId]
        );

        if (invoiceCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                success: false, 
                message: 'Invoice not found.' 
            });
        }

        const invoice = invoiceCheck.rows[0];

        // Unmark all expenses associated with this invoice
        await client.query(
            'UPDATE expenses SET is_invoiced = FALSE, invoice_id = NULL WHERE invoice_id = $1',
            [invoiceId]
        );

        // Delete invoice items
        await client.query(
            'DELETE FROM invoice_items WHERE invoice_id = $1',
            [invoiceId]
        );

        // Delete the invoice
        await client.query(
            'DELETE FROM invoices WHERE id = $1',
            [invoiceId]
        );

        await client.query('COMMIT');

        console.log(`✅ Invoice ${invoice.invoice_number} deleted successfully`);

        res.json({
            success: true,
            message: 'Invoice deleted successfully.'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete invoice error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    } finally {
        client.release();
    }
});

// Update invoice status with business workflow
app.patch('/api/invoices/:id/status', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        const invoiceId = req.params.id;
        const { status, paymentMethod, paymentReference, paymentNotes } = req.body;

        const validStatuses = ['draft', 'sent', 'paid', 'overdue', 'cancelled', 'void'];
        if (!validStatuses.includes(status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Invalid status.'
            });
        }

        // Get invoice details
        const invoiceResult = await client.query(
            `SELECT i.*, l.name, l.email, l.is_customer, l.customer_status
             FROM invoices i
             LEFT JOIN leads l ON i.lead_id = l.id
             WHERE i.id = $1`,
            [invoiceId]
        );

        if (invoiceResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                success: false, 
                message: 'Invoice not found.' 
            });
        }

        const invoice = invoiceResult.rows[0];
        const previousStatus = invoice.status;

        // Handle PAID status - Full business workflow
        if (status === 'paid' && previousStatus !== 'paid') {
            const paidAt = new Date();

            // 1. Update invoice status to PAID
            await client.query(
                `UPDATE invoices 
                 SET status = $1, 
                     paid_at = $2,
                     payment_method = $3,
                     payment_reference = $4,
                     payment_notes = $5
                 WHERE id = $6`,
                [status, paidAt, paymentMethod || null, paymentReference || null, paymentNotes || null, invoiceId]
            );

            // 2. If lead is not already a customer, convert them
            if (!invoice.is_customer) {
                await client.query(
                    `UPDATE leads 
                     SET is_customer = TRUE, 
                         customer_status = 'active',
                         status = 'closed',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [invoice.lead_id]
                );
                console.log(`✅ Lead ${invoice.name} converted to ACTIVE CUSTOMER`);
            } else {
                // 3. If already a customer, ensure they're active
                if (invoice.customer_status !== 'active') {
                    await client.query(
                        `UPDATE leads 
                         SET customer_status = 'active',
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $1`,
                        [invoice.lead_id]
                    );
                    console.log(`✅ Customer ${invoice.name} status set to ACTIVE`);
                }
            }

            // 4. Add payment received note to customer record
            const paymentNote = {
                text: `Payment received for invoice ${invoice.invoice_number}. Amount: $${parseFloat(invoice.total_amount).toLocaleString()}${paymentMethod ? `. Payment method: ${paymentMethod}` : ''}${paymentReference ? `. Reference: ${paymentReference}` : ''}.`,
                author: 'System',
                date: paidAt.toISOString()
            };

            // Get existing notes or create new array
            const notesResult = await client.query(
                'SELECT notes FROM leads WHERE id = $1',
                [invoice.lead_id]
            );
            
            let notes = [];
            if (notesResult.rows[0].notes) {
                try {
                    notes = JSON.parse(notesResult.rows[0].notes);
                } catch (e) {
                    notes = [];
                }
            }
            notes.push(paymentNote);

            await client.query(
                'UPDATE leads SET notes = $1 WHERE id = $2',
                [JSON.stringify(notes), invoice.lead_id]
            );

            // 5. Update customer lifetime value and payment history
            const lifetimeValue = await client.query(
                `SELECT COALESCE(SUM(total_amount), 0) as total
                 FROM invoices
                 WHERE lead_id = $1 AND status = 'paid'`,
                [invoice.lead_id]
            );

            await client.query(
                `UPDATE leads 
                 SET lifetime_value = $1,
                     last_payment_date = $2,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [lifetimeValue.rows[0].total, paidAt, invoice.lead_id]
            );

            console.log(`✅ Invoice ${invoice.invoice_number} marked as PAID`);
            console.log(`   💰 Amount: $${parseFloat(invoice.total_amount).toLocaleString()}`);
            console.log(`   👤 Customer: ${invoice.name}`);
            console.log(`   📊 Lifetime Value: $${parseFloat(lifetimeValue.rows[0].total).toLocaleString()}`);

        } else if (status === 'void' || status === 'cancelled') {
            // Handle VOID/CANCELLED - Unmark expenses so they can be invoiced again
            await client.query(
                'UPDATE expenses SET is_invoiced = FALSE, invoice_id = NULL WHERE invoice_id = $1',
                [invoiceId]
            );

            await client.query(
                'UPDATE invoices SET status = $1 WHERE id = $2',
                [status, invoiceId]
            );

            console.log(`✅ Invoice ${invoice.invoice_number} marked as ${status.toUpperCase()}`);

        } else {
            // Standard status update
            await client.query(
                'UPDATE invoices SET status = $1 WHERE id = $2',
                [status, invoiceId]
            );

            console.log(`✅ Invoice ${invoice.invoice_number} status updated to ${status.toUpperCase()}`);
        }

        await client.query('COMMIT');

        // Fetch updated invoice
        const updatedInvoice = await pool.query(
            'SELECT * FROM invoices WHERE id = $1',
            [invoiceId]
        );

        res.json({
            success: true,
            message: `Invoice ${status === 'paid' ? 'marked as paid' : 'status updated'} successfully.`,
            invoice: updatedInvoice.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update invoice status error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    } finally {
        client.release();
    }
});

// Update database initialization function
async function initializeExpenseTables() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Create expenses table
        await client.query(`
            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                description VARCHAR(500) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                quantity INTEGER DEFAULT 1,
                expense_date DATE DEFAULT CURRENT_DATE,
                category VARCHAR(100),
                is_billable BOOLEAN DEFAULT TRUE,
                is_invoiced BOOLEAN DEFAULT FALSE,
                invoice_id INTEGER,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by INTEGER REFERENCES admin_users(id)
            )
        `);

        // Create invoices table with ALL required columns
        await client.query(`
            CREATE TABLE IF NOT EXISTS invoices (
                id SERIAL PRIMARY KEY,
                invoice_number VARCHAR(50) UNIQUE NOT NULL,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                issue_date DATE DEFAULT CURRENT_DATE,
                due_date DATE,
                subtotal DECIMAL(10, 2) NOT NULL,
                tax_rate DECIMAL(5, 2) DEFAULT 0,
                tax_amount DECIMAL(10, 2) DEFAULT 0,
                discount_amount DECIMAL(10, 2) DEFAULT 0,
                total_amount DECIMAL(10, 2) NOT NULL,
                status VARCHAR(50) DEFAULT 'draft',
                payment_terms VARCHAR(255),
                notes TEXT,
                short_description VARCHAR(255),
                stripe_payment_link TEXT,
                payment_method VARCHAR(100),
                payment_reference VARCHAR(255),
                payment_notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by INTEGER REFERENCES admin_users(id),
                paid_at TIMESTAMP
            )
        `);

        // Add columns if they don't exist (for existing databases)
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='invoices' AND column_name='short_description') THEN
                    ALTER TABLE invoices ADD COLUMN short_description VARCHAR(255);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='invoices' AND column_name='stripe_payment_link') THEN
                    ALTER TABLE invoices ADD COLUMN stripe_payment_link TEXT;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='invoices' AND column_name='payment_method') THEN
                    ALTER TABLE invoices ADD COLUMN payment_method VARCHAR(100);
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='invoices' AND column_name='payment_reference') THEN
                    ALTER TABLE invoices ADD COLUMN payment_reference VARCHAR(255);
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='invoices' AND column_name='payment_notes') THEN
                    ALTER TABLE invoices ADD COLUMN payment_notes TEXT;
                END IF;
            END $$;
        `);

        // Create invoice_items table
        await client.query(`
            CREATE TABLE IF NOT EXISTS invoice_items (
                id SERIAL PRIMARY KEY,
                invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
                description VARCHAR(500) NOT NULL,
                quantity INTEGER DEFAULT 1,
                unit_price DECIMAL(10, 2) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Add foreign key if not exists
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.table_constraints 
                    WHERE constraint_name = 'fk_expense_invoice'
                ) THEN
                    ALTER TABLE expenses 
                    ADD CONSTRAINT fk_expense_invoice 
                    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
                END IF;
            END $$;
        `);

        // Create indexes
        await client.query('CREATE INDEX IF NOT EXISTS idx_expenses_lead_id ON expenses(lead_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_expenses_invoiced ON expenses(is_invoiced)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_invoices_lead_id ON invoices(lead_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)');

        await client.query('COMMIT');
        console.log('✅ Expense and invoice tables initialized');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Call this in your startServer function after initializeDatabase()
// await initializeExpenseTables();

// ========================================
// STRIPE PAYMENT ROUTES
// ========================================

// Create Stripe payment link for an invoice
app.post('/api/invoices/:id/payment-link', authenticateToken, async (req, res) => {
    try {
        const invoiceId = req.params.id;
        
        console.log('🔍 Starting payment link creation for invoice:', invoiceId);
        
        // Get invoice details with customer address
        const invoiceResult = await pool.query(`
            SELECT i.*, l.name, l.email, l.company,
                   l.address_line1, l.address_line2, l.city, l.state, l.zip_code, l.country
            FROM invoices i
            LEFT JOIN leads l ON i.lead_id = l.id
            WHERE i.id = $1
        `, [invoiceId]);
        
        if (invoiceResult.rows.length === 0) {
            console.error('❌ Invoice not found:', invoiceId);
            return res.status(404).json({ 
                success: false, 
                message: 'Invoice not found.' 
            });
        }
        
        const invoice = invoiceResult.rows[0];
        console.log('📋 Invoice details:', {
            id: invoice.id,
            number: invoice.invoice_number,
            amount: invoice.total_amount,
            customer: invoice.name
        });
        
        // Check if payment link already exists
        if (invoice.stripe_payment_link) {
            console.log('ℹ️ Using existing payment link for invoice:', invoice.invoice_number);
            return res.json({
                success: true,
                paymentLink: invoice.stripe_payment_link,
                message: 'Using existing payment link'
            });
        }
        
        const description = invoice.short_description || `Invoice ${invoice.invoice_number}`;
        
        console.log('💳 Creating Stripe price...');
        
        // Create Stripe Price
        const price = await stripe.prices.create({
            unit_amount: Math.round(parseFloat(invoice.total_amount) * 100),
            currency: 'usd',
            product_data: {
                name: `Invoice ${invoice.invoice_number} — ${description}`,
                metadata: {
                    invoice_id: invoiceId.toString(),
                    invoice_number: invoice.invoice_number
                }
            },
        });
        
        console.log('✅ Stripe price created:', price.id);
        console.log('🔗 Creating payment link...');
        
        // Create Payment Link
        const paymentLink = await stripe.paymentLinks.create({
            line_items: [{
                price: price.id,
                quantity: 1,
            }],
            after_completion: {
                type: 'hosted_confirmation',
                hosted_confirmation: {
                    custom_message: `Thank you for your payment! Invoice ${invoice.invoice_number} has been marked as paid. You will receive a confirmation email shortly.`
                }
            },
            metadata: {
                invoice_id: invoiceId.toString(),
                invoice_number: invoice.invoice_number,
                customer_name: invoice.name || '',
                customer_email: invoice.email || '',
                source: 'admin_portal'
            },
            customer_creation: 'always',
            invoice_creation: {
                enabled: true,
                invoice_data: {
                    description: `Invoice ${invoice.invoice_number} - ${description}`,
                    metadata: {
                        invoice_id: invoiceId.toString(),
                        invoice_number: invoice.invoice_number
                    },
                    footer: 'Thank you for your business!'
                }
            },
            phone_number_collection: {
                enabled: true
            },
            billing_address_collection: 'auto'
        });
        
        console.log('✅ Payment link created successfully:', paymentLink.url);
        
        // Store payment link in database
        await pool.query(
            'UPDATE invoices SET stripe_payment_link = $1 WHERE id = $2',
            [paymentLink.url, invoiceId]
        );
        
        console.log('✅ Payment link saved to database');
        
        res.json({
            success: true,
            paymentLink: paymentLink.url,
            message: 'Payment link created successfully'
        });
        
    } catch (error) {
        console.error('❌ Stripe API error details:', {
            message: error.message,
            type: error.type,
            code: error.code,
            statusCode: error.statusCode
        });
        
        res.status(500).json({ 
            success: false, 
            message: 'Stripe error: ' + error.message,
            details: error.type
        });
    }
});

// Add this route with your other API routes
app.post('/api/email/send-timeline', authenticateToken, async (req, res) => {
    try {
        const { timeline, clientEmail, clientName } = req.body;
        
        if (!timeline || !clientEmail) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Calculate total price
        let totalPrice = 0;
        timeline.packages.forEach(key => {
            if (servicePackages[key] && !servicePackages[key].isFree) {
                totalPrice += servicePackages[key].price;
            }
        });

        // Generate PDF using PDFKit
        const doc = new PDFDocument({ 
            margin: 50, 
            size: 'LETTER',
            info: {
                Title: `SLA - ${timeline.clientName}`,
                Author: 'Diamondback Coding'
            }
        });
        
        const pdfBuffers = [];
        doc.on('data', pdfBuffers.push.bind(pdfBuffers));

        // === PDF CONTENT ===
        
        // Header (Green bar)
        doc.rect(0, 0, doc.page.width, 100).fill('#22c55e');
        doc.fillColor('#ffffff')
           .fontSize(28)
           .font('Helvetica-Bold')
           .text('DIAMONDBACK CODING', 50, 30);
        doc.fontSize(10).text('PREMIUM DEVELOPMENT SERVICES', 50, 65);

        // Reset to black text
        doc.fillColor('#000000');
        doc.y = 150;

        // Title
        doc.fontSize(24)
           .font('Helvetica-Bold')
           .text('SERVICE LEVEL AGREEMENT', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(12)
           .font('Helvetica')
           .fillColor('#666666')
           .text('Project Timeline & Terms of Service', { align: 'center' });
        doc.fillColor('#000000');
        doc.moveDown(2);

        // Agreement Overview
        doc.fontSize(10)
           .font('Helvetica-Bold')
           .fillColor('#22c55e')
           .text('AGREEMENT OVERVIEW');
        doc.moveDown(0.5);
        doc.fontSize(11)
           .font('Helvetica')
           .fillColor('#000000')
           .text(`This Service Level Agreement is entered into as of ${new Date(timeline.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} by and between Diamondback Coding and ${timeline.clientName}${timeline.clientCompany ? ' / ' + timeline.clientCompany : ''}.`);
        doc.moveDown(2);

        // Two columns for parties
        const leftCol = 50;
        const rightCol = 320;
        const colTop = doc.y;

        // Service Provider (left column)
        doc.fontSize(9)
           .font('Helvetica-Bold')
           .fillColor('#22c55e')
           .text('SERVICE PROVIDER', leftCol, colTop);
        doc.fillColor('#000000')
           .fontSize(12)
           .text('Diamondback Coding', leftCol, colTop + 15);
        doc.fontSize(10)
           .font('Helvetica')
           .fillColor('#666666')
           .text('15709 Spillman Ranch Loop', leftCol, colTop + 32)
           .text('Austin, TX 78738', leftCol, colTop + 46)
           .text('contact@diamondbackcoding.com', leftCol, colTop + 60)
           .text('(940) 217-8680', leftCol, colTop + 74);

        // Client (right column)
        doc.fontSize(9)
           .font('Helvetica-Bold')
           .fillColor('#22c55e')
           .text('CLIENT', rightCol, colTop);
        doc.fillColor('#000000')
           .fontSize(12)
           .text(timeline.clientName, rightCol, colTop + 15);
        doc.fontSize(10)
           .font('Helvetica')
           .fillColor('#666666');
        let clientY = colTop + 32;
        if (timeline.clientCompany) {
            doc.text(timeline.clientCompany, rightCol, clientY);
            clientY += 14;
        }
        if (timeline.clientEmail) {
            doc.text(timeline.clientEmail, rightCol, clientY);
            clientY += 14;
        }
        if (timeline.clientPhone) {
            doc.text(timeline.clientPhone, rightCol, clientY);
        }

        doc.y = colTop + 120;
        doc.moveDown(2);

        // Project Details
        doc.fontSize(10)
           .font('Helvetica-Bold')
           .fillColor('#22c55e')
           .text('PROJECT DETAILS');
        doc.moveDown(0.5);
        
        doc.fontSize(11)
           .font('Helvetica')
           .fillColor('#000000')
           .text(`Project Name: ${timeline.projectName || 'Web Development Project'}`)
           .text(`Start Date: ${new Date(timeline.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`)
           .text(`Total Investment: ${timeline.isFreeProject ? 'FREE' : '$' + totalPrice.toLocaleString()}`)
           .text(`Payment Terms: ${getPaymentTermsText(timeline)}`);
        doc.moveDown(2);

        // Selected Services
        doc.fontSize(10)
           .font('Helvetica-Bold')
           .fillColor('#22c55e')
           .text('SELECTED SERVICES');
        doc.moveDown(0.5);
        
        timeline.packages.forEach(key => {
            const pkg = servicePackages[key];
            if (pkg) {
                doc.fontSize(11)
                   .font('Helvetica')
                   .fillColor('#000000')
                   .text(`✓ ${pkg.name}${pkg.isFree ? ' (FREE)' : ''}`);
            }
        });
        doc.moveDown(2);

        // Scope if exists
        if (timeline.scope) {
            doc.fontSize(10)
               .font('Helvetica-Bold')
               .fillColor('#22c55e')
               .text('PROJECT SCOPE');
            doc.moveDown(0.5);
            doc.fontSize(11)
               .font('Helvetica')
               .fillColor('#000000')
               .text(timeline.scope, { width: 500 });
            doc.moveDown(2);
        }

        // Add new page for timeline
        doc.addPage();

        // Detailed Timeline
        doc.fontSize(14)
           .font('Helvetica-Bold')
           .fillColor('#22c55e')
           .text('DETAILED PROJECT TIMELINE');
        doc.moveDown(1);

        let phaseNumber = 1;
        timeline.packages.forEach(packageKey => {
            const pkg = servicePackages[packageKey];
            if (!pkg || !pkg.phases) return;

            // Package name
            doc.fontSize(12)
               .font('Helvetica-Bold')
               .fillColor('#000000')
               .text(pkg.name);
            doc.fontSize(10)
               .font('Helvetica')
               .fillColor('#666666')
               .text(pkg.description);
            doc.moveDown(0.5);

            pkg.phases.forEach(phase => {
                doc.fontSize(11)
                   .font('Helvetica-Bold')
                   .fillColor('#000000')
                   .text(`Phase ${phaseNumber}: ${phase.name} (${phase.duration})`);
                
                phase.tasks.forEach(task => {
                    doc.fontSize(10)
                       .font('Helvetica')
                       .fillColor('#333333')
                       .text(`  • ${task}`, { indent: 20 });
                });
                
                doc.moveDown(0.5);
                phaseNumber++;
            });

            doc.moveDown(1);
        });

        // Client Responsibilities
        if (doc.y > 600) doc.addPage();
        
        doc.fontSize(12)
           .font('Helvetica-Bold')
           .fillColor('#22c55e')
           .text('CLIENT RESPONSIBILITIES');
        doc.moveDown(0.5);
        
        const responsibilities = [
            'Provide all required content within 3 business days of request',
            'Respond to design/development reviews within 5 business days',
            'Attend scheduled bi-weekly progress meetings',
            'Designate a single point of contact for communications',
            'Make payments according to agreed schedule',
            'Provide access to necessary accounts and credentials'
        ];
        
        responsibilities.forEach(resp => {
            doc.fontSize(10)
               .font('Helvetica')
               .fillColor('#000000')
               .text(`• ${resp}`, { indent: 10 });
        });
        doc.moveDown(2);

        // Signature area
        doc.fontSize(11)
           .font('Helvetica-Bold')
           .fillColor('#000000')
           .text('CLIENT SIGNATURE REQUIRED:');
        doc.moveDown(1);
        
        doc.moveTo(50, doc.y)
           .lineTo(300, doc.y)
           .stroke();
        doc.moveDown(0.3);
        doc.fontSize(9)
           .font('Helvetica')
           .fillColor('#666666')
           .text('Client Signature');
        doc.moveDown(2);
        
        doc.moveTo(50, doc.y)
           .lineTo(300, doc.y)
           .stroke();
        doc.moveDown(0.3);
        doc.text('Date');

        // End PDF
        doc.end();

        // Wait for PDF to finish
        await new Promise((resolve) => {
            doc.on('end', resolve);
        });

        const pdfBuffer = Buffer.concat(pdfBuffers);

        // Email HTML content
        const packagesText = timeline.packages.map(k => 
            servicePackages[k]?.name || k
        ).join(', ');

        const emailHtml = buildEmailHTML(`
            <p><strong style="font-size:16px;">Hi ${timeline.clientName},</strong></p>

            <p>
                Thank you for choosing Diamondback Coding! We're excited to work with you on
                <strong>${timeline.projectName || 'your project'}</strong>.
            </p>

            <p>
                Attached to this email is your complete <strong>Service Level Agreement (SLA)</strong>
                which includes the detailed project timeline, deliverables, and terms.
            </p>

            <div class="info-box">
                <div class="info-row">
                    <span class="info-label">Project</span>
                    <span class="info-value">${timeline.projectName || 'Web Development'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Investment</span>
                    <span class="info-value gold">${timeline.isFreeProject ? 'FREE' : '$' + totalPrice.toLocaleString()}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Services</span>
                    <span class="info-value">${packagesText}</span>
                </div>
            </div>

            <div class="attachment-box">
                <strong>📎 PDF Attached</strong> — Please review the attached SLA document for complete
                project details, timeline, and terms. <strong>Your signature is required</strong> to proceed.
            </div>

            <h3>Next Steps</h3>
            <ol>
                <li><strong>Review</strong> the attached SLA document carefully</li>
                <li><strong>Sign</strong> the document in the designated client signature area</li>
                <li><strong>Return</strong> the signed copy to us via email</li>
                <li>We'll schedule our <strong>kick-off meeting</strong> to get started!</li>
            </ol>

            <p>Have questions? We're here to help — feel free to reach out anytime.</p>

            <div class="sign-off">
                <p>Looking forward to building something amazing together!</p>
                <p class="team-name">— The Diamondback Coding Team</p>
            </div>
        `);

        // Send email with PDF attachment
        const mailOptions = {
            from: {
                name: 'Diamondback Coding',
                address: process.env.EMAIL_USER
            },
            to: clientEmail,
            subject: `Service Level Agreement - ${timeline.projectName || 'Project Timeline'}`,
            html: emailHtml,
            attachments: [
                {
                    filename: `SLA-${timeline.clientName.replace(/\s+/g, '_')}-${new Date().getFullYear()}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        };

        await transporter.sendMail(mailOptions);
        
        res.json({ 
            success: true, 
            message: `SLA sent successfully to ${clientEmail}` 
        });
    } catch (error) {
        console.error('Send timeline email error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to send email: ' + error.message 
        });
    }
});

// Helper function
function getPaymentTermsText(timeline) {
    if (timeline.isFreeProject) return 'No Payment Required';
    switch (timeline.paymentTerms) {
        case 'completion': return '50% Deposit + 50% on Completion';
        case 'net30': return 'Net 30 Days After Completion';
        case 'net15': return 'Net 15 Days After Completion';
        case 'milestone': return 'Milestone-Based Payments';
        case 'custom': return timeline.customPaymentDetails || 'Custom Payment Plan';
        default: return '50% Deposit + 50% on Completion';
    }
}

// REPLACE THIS ENTIRE ENDPOINT
app.post('/api/email/send-invoice', authenticateToken, async (req, res) => {
    try {
        console.log('Starting invoice email send...');
        const { invoice, clientEmail, clientName } = req.body;
        
        if (!clientEmail) {
            console.error('No client email provided');
            return res.status(400).json({ 
                success: false, 
                message: 'Client email is required' 
            });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(clientEmail)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email address format'
            });
        }
        
        // Build invoice items table
        const items = invoice.items || [];
        const itemsHTML = items.map(item => `
            <tr>
                <td>${item.description}</td>
                <td>${item.quantity || 1}</td>
                <td>$${parseFloat(item.unit_price || item.amount).toLocaleString()}</td>
                <td>$${parseFloat(item.amount).toLocaleString()}</td>
            </tr>
        `).join('');
        
        const taxAmount = parseFloat(invoice.tax_amount || 0);
        const discount = parseFloat(invoice.discount_amount || 0);
        
        const emailHTML = buildEmailHTML(`
            <p><strong style="font-size:16px;">Hello ${clientName || 'Valued Customer'},</strong></p>

            <p>Thank you for your business! Here is your invoice.</p>

            <div class="info-box">
                <div class="info-row">
                    <span class="info-label">Invoice Number</span>
                    <span class="info-value">${invoice.invoice_number}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Issue Date</span>
                    <span class="info-value">${new Date(invoice.issue_date).toLocaleDateString()}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Due Date</span>
                    <span class="info-value">${new Date(invoice.due_date).toLocaleDateString()}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Amount Due</span>
                    <span class="info-value gold" style="font-size:20px;">$${parseFloat(invoice.total_amount).toLocaleString()}</span>
                </div>
            </div>

            <h3>Invoice Details</h3>
            <table class="inv-table">
                <thead>
                    <tr>
                        <th>Description</th>
                        <th>Qty</th>
                        <th>Unit Price</th>
                        <th>Amount</th>
                    </tr>
                </thead>
                <tbody>${itemsHTML}</tbody>
            </table>

            <div class="inv-totals">
                <p><strong>Subtotal:</strong> $${parseFloat(invoice.subtotal).toLocaleString()}</p>
                ${taxAmount > 0 ? `<p><strong>Tax (${invoice.tax_rate}%):</strong> $${taxAmount.toLocaleString()}</p>` : ''}
                ${discount > 0 ? `<p><strong>Discount:</strong> -$${discount.toLocaleString()}</p>` : ''}
                <p class="total-line"><strong>Total:</strong> <span>$${parseFloat(invoice.total_amount).toLocaleString()}</span></p>
            </div>

            ${invoice.stripe_payment_link ? `
                <div class="btn-center">
                    <a href="${invoice.stripe_payment_link}" class="btn-gold">Pay Invoice Now</a>
                    <p class="btn-note">Secure payment powered by Stripe</p>
                </div>
            ` : ''}

            ${invoice.notes ? `
                <div class="notes-box">
                    <p><strong>Notes</strong></p>
                    <p>${invoice.notes}</p>
                </div>
            ` : ''}

            <p>If you have any questions about this invoice, please don't hesitate to contact us.</p>

            <div class="sign-off">
                <p>Best regards,</p>
                <p class="team-name">The Diamondback Coding Team</p>
            </div>
        `);
        
        console.log('Preparing to send email...');
        console.log('From:', process.env.EMAIL_USER);
        console.log('To:', clientEmail);
        
        const info = await transporter.sendMail({
            from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
            to: clientEmail,
            subject: `Invoice ${invoice.invoice_number} from Diamondback Coding`,
            html: emailHTML
        });
        
        console.log('Invoice email sent successfully');
        console.log('Message ID:', info.messageId);
        
        res.json({ 
            success: true, 
            message: `Invoice email sent successfully to ${clientEmail}`,
            details: {
                messageId: info.messageId,
                to: clientEmail
            }
        });
        
    } catch (error) {
        console.error('Invoice email error:', error);
        
        let userMessage = 'Failed to send invoice email. ';
        if (error.code === 'EAUTH') {
            userMessage += 'Email authentication failed.';
        } else if (error.code === 'EENVELOPE') {
            userMessage += 'Invalid recipient email address.';
        } else {
            userMessage += error.message;
        }
        
        res.status(500).json({ 
            success: false, 
            message: userMessage,
            error: error.code
        });
    }
});

// Add this test endpoint
app.post('/api/email/test', authenticateToken, async (req, res) => {
    try {
        console.log('Testing email configuration...');
        console.log('From:', process.env.EMAIL_USER);
        console.log('To:', process.env.EMAIL_USER);
        
        const info = await transporter.sendMail({
            from: `"Diamondback Coding Test" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_USER,
            subject: 'Email Test - Diamondback Coding',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: #22c55e; color: white; padding: 30px; text-align: center;">
                        <h1 style="margin: 0;">Email is Working!</h1>
                    </div>
                    <div style="padding: 30px; background: #f8f9fa;">
                        <h2>Test Successful</h2>
                        <p>If you're reading this, your email configuration is working correctly!</p>
                        <p><strong>Configuration Details:</strong></p>
                        <ul>
                            <li>Email User: ${process.env.EMAIL_USER}</li>
                            <li>Service: Gmail</li>
                            <li>Time: ${new Date().toISOString()}</li>
                        </ul>
                        <p>You can now send invoices and SLAs to your clients.</p>
                    </div>
                    <div style="padding: 20px; text-align: center; background: #333; color: white; font-size: 12px;">
                        <p>Diamondback Coding Email System</p>
                    </div>
                </div>
            `
        });
        
        console.log('Test email sent successfully');
        console.log('Message ID:', info.messageId);
        console.log('Response:', info.response);
        
        res.json({ 
            success: true, 
            message: 'Test email sent successfully! Check your inbox.',
            details: {
                messageId: info.messageId,
                response: info.response,
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER
            }
        });
    } catch (error) {
        console.error('Test email failed:', error);
        
        let helpMessage = '';
        if (error.code === 'EAUTH') {
            helpMessage = 'Authentication failed. Please check your EMAIL_PASSWORD is a valid Google App Password.';
        } else if (error.code === 'ESOCKET') {
            helpMessage = 'Connection failed. Check your internet connection.';
        } else if (error.code === 'EENVELOPE') {
            helpMessage = 'Invalid email address. Check your EMAIL_USER in .env file.';
        }
        
        res.status(500).json({ 
            success: false, 
            message: helpMessage || error.message,
            error: {
                code: error.code,
                command: error.command
            }
        });
    }
});

// Helper function to generate email HTML
function generateInvoiceEmailHTML(invoice) {
    // Use similar HTML structure as your PDF export
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #22c55e; color: white; padding: 30px; text-align: center; }
                .invoice-details { padding: 20px; background: #f8f9fa; }
                .total { font-size: 24px; font-weight: bold; color: #22c55e; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Diamondback Coding</h1>
                    <p>Invoice ${invoice.invoice_number}</p>
                </div>
                <div class="invoice-details">
                    <p><strong>To:</strong> ${invoice.customer_name}</p>
                    <p><strong>Amount Due:</strong> <span class="total">$${parseFloat(invoice.total_amount).toLocaleString()}</span></p>
                    <p><strong>Due Date:</strong> ${new Date(invoice.due_date).toLocaleDateString()}</p>
                    ${invoice.stripe_payment_link ? `
                        <p style="margin-top: 30px;">
                            <a href="${invoice.stripe_payment_link}" 
                               style="background: #22c55e; color: white; padding: 15px 30px; 
                                      text-decoration: none; border-radius: 5px; display: inline-block;">
                                Pay Invoice
                            </a>
                        </p>
                    ` : ''}
                </div>
            </div>
        </body>
        </html>
    `;
}

app.post('/api/email/send-invoice', authenticateToken, async (req, res) => {
    try {
        console.log('📧 Starting invoice email send...');
        const { invoice, clientEmail, clientName } = req.body;
        
        if (!clientEmail) {
            console.error('❌ No client email provided');
            return res.status(400).json({ 
                success: false, 
                message: 'Client email is required' 
            });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(clientEmail)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email address format'
            });
        }
        
        console.log('📝 Generating invoice PDF...');
        const pdfHTML = generateInvoicePDFHTML(invoice);
        const pdfBuffer = await generatePDFFromHTML(pdfHTML);
        console.log('✅ PDF generated successfully');
        
        console.log('📧 Creating email HTML...');
        const emailHTML = buildEmailHTML(`
            <p><strong style="font-size:16px;">Hello ${clientName || 'Valued Customer'},</strong></p>

            <p>Your invoice is attached to this email. Here is a quick summary:</p>

            <div class="info-box">
                <div class="info-row">
                    <span class="info-label">Invoice Number</span>
                    <span class="info-value">${invoice.invoice_number}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Issue Date</span>
                    <span class="info-value">${new Date(invoice.issue_date).toLocaleDateString()}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Due Date</span>
                    <span class="info-value">${new Date(invoice.due_date).toLocaleDateString()}</span>
                </div>
            </div>

            <div class="highlight-box">
                <div class="highlight-label">Amount Due</div>
                <div class="highlight-value">$${parseFloat(invoice.total_amount).toLocaleString()}</div>
            </div>

            ${invoice.stripe_payment_link ? `
                <div class="btn-center">
                    <a href="${invoice.stripe_payment_link}" class="btn-gold">Pay Invoice Online</a>
                    <p class="btn-note">Secure payment powered by Stripe</p>
                </div>
            ` : ''}

            <div class="attachment-box">
                <strong>📎 PDF Attached</strong> — Your complete invoice is attached to this email for your records.
            </div>

            <p>If you have any questions about this invoice, please don't hesitate to contact us.</p>

            <div class="sign-off">
                <p>Best regards,</p>
                <p class="team-name">The Diamondback Coding Team</p>
            </div>
        `);
        
        console.log('📤 Preparing to send email...');
        console.log('📧 From:', process.env.EMAIL_USER);
        console.log('📧 To:', clientEmail);
        
        const info = await transporter.sendMail({
            from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
            to: clientEmail,
            subject: `Invoice ${invoice.invoice_number} from Diamondback Coding`,
            html: emailHTML,
            attachments: [
                {
                    filename: `Invoice-${invoice.invoice_number}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        });
        
        console.log('✅ Invoice email sent successfully');
        console.log('📨 Message ID:', info.messageId);
        console.log('📬 To:', clientEmail);
        
        res.json({ 
            success: true, 
            message: `Invoice email sent successfully to ${clientEmail}`,
            details: {
                messageId: info.messageId,
                to: clientEmail
            }
        });
        
    } catch (error) {
        console.error('❌ Invoice email error:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            command: error.command,
            response: error.response
        });
        
        let userMessage = 'Failed to send invoice email. ';
        if (error.code === 'EAUTH') {
            userMessage += 'Email authentication failed. Please check your email configuration.';
        } else if (error.code === 'EENVELOPE') {
            userMessage += 'Invalid recipient email address.';
        } else {
            userMessage += error.message;
        }
        
        res.status(500).json({ 
            success: false, 
            message: userMessage,
            error: error.code
        });
    }
});

// Get all scoring rules
app.get('/api/scoring/rules', authenticateToken, async (req, res) => {
    try {
        const rules = await pool.query(`
            SELECT * FROM scoring_rules 
            WHERE is_active = TRUE
            ORDER BY points DESC, name ASC
        `);
        
        res.json({
            success: true,
            rules: rules.rows
        });
    } catch (error) {
        console.error('Get scoring rules error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Create scoring rule
app.post('/api/scoring/rules', authenticateToken, async (req, res) => {
    try {
        const { name, description, rule_type, field_name, operator, value, points } = req.body;
        
        const result = await pool.query(
            `INSERT INTO scoring_rules 
             (name, description, rule_type, field_name, operator, value, points)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [name, description, rule_type, field_name, operator, value, points]
        );
        
        res.json({
            success: true,
            message: 'Scoring rule created successfully.',
            rule: result.rows[0]
        });
    } catch (error) {
        console.error('Create scoring rule error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Update scoring rule
app.put('/api/scoring/rules/:id', authenticateToken, async (req, res) => {
    try {
        const ruleId = req.params.id;
        const { name, description, rule_type, field_name, operator, value, points, is_active } = req.body;
        
        const result = await pool.query(
            `UPDATE scoring_rules 
             SET name = $1, description = $2, rule_type = $3, field_name = $4, 
                 operator = $5, value = $6, points = $7, is_active = $8
             WHERE id = $9
             RETURNING *`,
            [name, description, rule_type, field_name, operator, value, points, is_active, ruleId]
        );
        
        res.json({
            success: true,
            message: 'Scoring rule updated successfully.',
            rule: result.rows[0]
        });
    } catch (error) {
        console.error('Update scoring rule error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Delete scoring rule
app.delete('/api/scoring/rules/:id', authenticateToken, async (req, res) => {
    try {
        const ruleId = req.params.id;
        
        await pool.query(
            `UPDATE scoring_rules SET is_active = FALSE WHERE id = $1`,
            [ruleId]
        );
        
        res.json({
            success: true,
            message: 'Scoring rule deleted successfully.'
        });
    } catch (error) {
        console.error('Delete scoring rule error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Calculate lead score
async function calculateLeadScore(leadId) {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Get lead data
        const leadData = await client.query(
            `SELECT * FROM leads WHERE id = $1`,
            [leadId]
        );
        
        if (leadData.rows.length === 0) {
            throw new Error('Lead not found');
        }
        
        const lead = leadData.rows[0];
        
        // Get all active scoring rules
        const rules = await client.query(
            `SELECT * FROM scoring_rules WHERE is_active = TRUE`
        );
        
        let totalScore = 0;
        let engagementScore = 0;
        let demographicScore = 0;
        let behavioralScore = 0;
        
        // Apply each rule
        for (const rule of rules.rows) {
            let ruleMatches = false;
            
            // Evaluate rule based on operator
            const fieldValue = lead[rule.field_name];
            
            switch (rule.operator) {
                case 'equals':
                    ruleMatches = String(fieldValue) === String(rule.value);
                    break;
                case 'not_equals':
                    ruleMatches = String(fieldValue) !== String(rule.value);
                    break;
                case 'greater_than':
                    ruleMatches = parseFloat(fieldValue) > parseFloat(rule.value);
                    break;
                case 'less_than':
                    ruleMatches = parseFloat(fieldValue) < parseFloat(rule.value);
                    break;
                case 'contains':
                    ruleMatches = String(fieldValue).toLowerCase().includes(String(rule.value).toLowerCase());
                    break;
                case 'is_not_null':
                    ruleMatches = fieldValue != null && fieldValue !== '';
                    break;
                case 'is_null':
                    ruleMatches = fieldValue == null || fieldValue === '';
                    break;
            }
            
            if (ruleMatches) {
                totalScore += rule.points;
                
                // Categorize score
                switch (rule.rule_type) {
                    case 'engagement':
                        engagementScore += rule.points;
                        break;
                    case 'demographic':
                        demographicScore += rule.points;
                        break;
                    case 'behavioral':
                        behavioralScore += rule.points;
                        break;
                }
                
                // Log score change
                await client.query(
                    `INSERT INTO score_history (lead_id, rule_id, points_added, reason)
                     VALUES ($1, $2, $3, $4)`,
                    [leadId, rule.id, rule.points, rule.name]
                );
            }
        }
        
        // Calculate grade (A-F based on score)
        let grade;
        if (totalScore >= 80) grade = 'A';
        else if (totalScore >= 60) grade = 'B';
        else if (totalScore >= 40) grade = 'C';
        else if (totalScore >= 20) grade = 'D';
        else grade = 'F';
        
        // Upsert lead score
        await client.query(
            `INSERT INTO lead_scores 
             (lead_id, total_score, engagement_score, demographic_score, behavioral_score, grade, last_calculated)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
             ON CONFLICT (lead_id) 
             DO UPDATE SET 
                total_score = $2,
                engagement_score = $3,
                demographic_score = $4,
                behavioral_score = $5,
                grade = $6,
                last_calculated = CURRENT_TIMESTAMP`,
            [leadId, totalScore, engagementScore, demographicScore, behavioralScore, grade]
        );
        
        await client.query('COMMIT');
        
        return { totalScore, grade, engagementScore, demographicScore, behavioralScore };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Calculate score for a lead
app.post('/api/scoring/calculate/:leadId', authenticateToken, async (req, res) => {
    try {
        const leadId = parseInt(req.params.leadId);
        const result = await calculateLeadScore(leadId);
        
        res.json({
            success: true,
            message: 'Lead score calculated successfully.',
            score: result
        });
    } catch (error) {
        console.error('Calculate score error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Recalculate all lead scores
app.post('/api/scoring/recalculate-all', authenticateToken, async (req, res) => {
    try {
        const leads = await pool.query(`SELECT id FROM leads`);
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const lead of leads.rows) {
            try {
                await calculateLeadScore(lead.id);
                successCount++;
            } catch (error) {
                console.error(`Error calculating score for lead ${lead.id}:`, error);
                errorCount++;
            }
        }
        
        res.json({
            success: true,
            message: `Recalculated scores for ${successCount} leads. ${errorCount} errors.`,
            successCount,
            errorCount
        });
    } catch (error) {
        console.error('Recalculate all scores error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get lead scores with rankings
app.get('/api/scoring/leaderboard', authenticateToken, async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        
        const leaderboard = await pool.query(`
            SELECT 
                ls.*,
                l.name,
                l.email,
                l.company,
                l.status,
                RANK() OVER (ORDER BY ls.total_score DESC) as rank
            FROM lead_scores ls
            JOIN leads l ON ls.lead_id = l.id
            ORDER BY ls.total_score DESC
            LIMIT $1
        `, [parseInt(limit)]);
        
        res.json({
            success: true,
            leaderboard: leaderboard.rows
        });
    } catch (error) {
        console.error('Get leaderboard error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get score history for a lead
app.get('/api/scoring/history/:leadId', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.leadId;
        
        const history = await pool.query(`
            SELECT 
                sh.*,
                sr.name as rule_name
            FROM score_history sh
            LEFT JOIN scoring_rules sr ON sh.rule_id = sr.id
            WHERE sh.lead_id = $1
            ORDER BY sh.created_at DESC
            LIMIT 50
        `, [leadId]);
        
        res.json({
            success: true,
            history: history.rows
        });
    } catch (error) {
        console.error('Get score history error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get scoring statistics
app.get('/api/scoring/stats', authenticateToken, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_leads,
                ROUND(AVG(total_score), 2) as avg_score,
                MAX(total_score) as max_score,
                MIN(total_score) as min_score,
                COUNT(*) FILTER (WHERE grade = 'A') as grade_a_count,
                COUNT(*) FILTER (WHERE grade = 'B') as grade_b_count,
                COUNT(*) FILTER (WHERE grade = 'C') as grade_c_count,
                COUNT(*) FILTER (WHERE grade = 'D') as grade_d_count,
                COUNT(*) FILTER (WHERE grade = 'F') as grade_f_count
            FROM lead_scores
        `);
        
        res.json({
            success: true,
            stats: stats.rows[0]
        });
    } catch (error) {
        console.error('Get scoring stats error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});



// ==================== PHASE 5: DOCUMENT MANAGEMENT ====================
// Add this to your server.js file
// NOTE: This implementation uses file uploads - you'll need multer package
// Install with: npm install multer

const multer = require('multer');
const fs = require('fs').promises;

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads', 'documents');
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        // Allow common document types
        const allowedTypes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'image/jpeg',
            'image/png',
            'image/gif',
            'text/plain'
        ];
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: PDF, DOC, DOCX, XLS, XLSX, images, TXT'));
        }
    }
});

// ==================== DATABASE SCHEMA ====================
// Add to initializeDatabase() function:



// ==================== API ENDPOINTS ====================

// ==================== LEAD/CUSTOMER DOCUMENT ENDPOINTS ====================

// Get documents for a specific lead/customer
app.get('/api/leads/:leadId/documents', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.leadId;
        
        console.log('[LEAD DOCS] Getting documents for lead:', leadId);
        
        const result = await pool.query(`
            SELECT 
                id,
                filename as file_name,
                original_filename as file_name,
                file_path,
                file_size,
                mime_type,
                document_type,
                CASE 
                    WHEN uploaded_by IS NULL THEN 'client'
                    ELSE 'admin'
                END as uploaded_by,
                created_at as uploaded_at,
                description
            FROM documents
            WHERE lead_id = $1
            ORDER BY created_at DESC
        `, [leadId]);
        
        console.log('[LEAD DOCS] Found', result.rows.length, 'documents');
        
        res.json({
            success: true,
            documents: result.rows
        });
    } catch (error) {
        console.error('[LEAD DOCS] Get error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load documents'
        });
    }
});

// Upload documents for a specific lead/customer
app.post('/api/leads/:leadId/documents', authenticateToken, upload.array('documents', 10), async (req, res) => {
    try {
        const leadId = req.params.leadId;
        const files = req.files;
        const { uploaded_by, description } = req.body;
        
        console.log('[LEAD DOCS] Uploading', files?.length || 0, 'documents for lead:', leadId);
        
        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No files uploaded'
            });
        }
        
        const uploadedDocs = [];
        const fs = require('fs');
        
        for (const file of files) {
            // Set file permissions
            try {
                fs.chmodSync(file.path, 0o644);
            } catch (permError) {
                console.error('[LEAD DOCS] Permission error:', permError);
            }
            
            // Insert into database
            const result = await pool.query(`
                INSERT INTO documents (
                    lead_id,
                    filename,
                    original_filename,
                    file_path,
                    file_size,
                    mime_type,
                    document_type,
                    uploaded_by,
                    description,
                    created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
                RETURNING id, original_filename as file_name, file_size
            `, [
                leadId,
                file.filename,
                file.originalname,
                file.path,
                file.size,
                file.mimetype,
                uploaded_by === 'client' ? 'client_upload' : 'admin_upload',
                uploaded_by === 'client' ? null : req.user.id,
                description || null
            ]);
            
            uploadedDocs.push(result.rows[0]);
        }
        
        console.log('[LEAD DOCS] Successfully uploaded', uploadedDocs.length, 'documents');
        
        res.json({
            success: true,
            message: `${uploadedDocs.length} document(s) uploaded successfully`,
            documents: uploadedDocs
        });
    } catch (error) {
        console.error('[LEAD DOCS] Upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload documents',
            error: error.message
        });
    }
});

// Download a specific document
app.get('/api/documents/:documentId/download', authenticateToken, async (req, res) => {
    try {
        const documentId = req.params.documentId;
        
        console.log('[DOC DOWNLOAD] Request for document:', documentId);
        
        const result = await pool.query(
            'SELECT * FROM documents WHERE id = $1',
            [documentId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }
        
        const doc = result.rows[0];
        const fs = require('fs');
        
        if (!fs.existsSync(doc.file_path)) {
            console.error('[DOC DOWNLOAD] File not found on disk:', doc.file_path);
            return res.status(404).json({
                success: false,
                message: 'File not found on disk'
            });
        }
        
        res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${doc.original_filename}"`);
        res.setHeader('Content-Length', doc.file_size);
        
        const fileStream = fs.createReadStream(doc.file_path);
        fileStream.pipe(res);
        
        console.log('[DOC DOWNLOAD] Streaming file:', doc.original_filename);
    } catch (error) {
        console.error('[DOC DOWNLOAD] Error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: 'Failed to download document'
            });
        }
    }
});

// Delete a document
app.delete('/api/documents/:documentId', authenticateToken, async (req, res) => {
    try {
        const documentId = req.params.documentId;
        
        console.log('[DOC DELETE] Deleting document:', documentId);
        
        // Get document info
        const result = await pool.query(
            'SELECT * FROM documents WHERE id = $1',
            [documentId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }
        
        const doc = result.rows[0];
        
        // Delete file from disk
        const fs = require('fs');
        try {
            if (fs.existsSync(doc.file_path)) {
                fs.unlinkSync(doc.file_path);
                console.log('[DOC DELETE] File deleted from disk');
            }
        } catch (fsError) {
            console.error('[DOC DELETE] Error deleting file:', fsError);
        }
        
        // Delete from database
        await pool.query('DELETE FROM documents WHERE id = $1', [documentId]);
        
        console.log('[DOC DELETE] Document deleted from database');
        
        res.json({
            success: true,
            message: 'Document deleted successfully'
        });
    } catch (error) {
        console.error('[DOC DELETE] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete document'
        });
    }
});

// ==================== GENERAL DOCUMENT ENDPOINTS ====================

// Get all documents (with optional lead filter)
app.get('/api/documents', authenticateToken, async (req, res) => {
    try {
        const { lead_id } = req.query;
        
        let query = `
            SELECT 
                d.*,
                au.username as uploaded_by_name,
                l.name as lead_name
            FROM documents d
            LEFT JOIN admin_users au ON d.uploaded_by = au.id
            LEFT JOIN leads l ON d.lead_id = l.id
        `;
        
        const params = [];
        if (lead_id) {
            query += ' WHERE d.lead_id = $1';
            params.push(lead_id);
        }
        
        query += ' ORDER BY d.created_at DESC';
        
        const documents = await pool.query(query, params);
        
        res.json({
            success: true,
            documents: documents.rows
        });
    } catch (error) {
        console.error('Get documents error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Upload document
app.post('/api/documents/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }
        
        const { lead_id, document_type, description } = req.body;
        const userId = req.user.id;
        
        const result = await pool.query(
            `INSERT INTO documents 
             (lead_id, filename, original_filename, file_path, file_size, mime_type, 
              document_type, description, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                lead_id || null,
                req.file.filename,
                req.file.originalname,
                req.file.path,
                req.file.size,
                req.file.mimetype,
                document_type || 'general',
                description || null,
                userId
            ]
        );
        
        res.json({
            success: true,
            message: 'Document uploaded successfully.',
            document: result.rows[0]
        });
    } catch (error) {
        console.error('Upload document error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Download document
app.get('/api/documents/:id/download', authenticateToken, async (req, res) => {
    try {
        const documentId = req.params.id;
        
        const document = await pool.query(
            `SELECT * FROM documents WHERE id = $1`,
            [documentId]
        );
        
        if (document.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Document not found.' });
        }
        
        const doc = document.rows[0];
        
        res.download(doc.file_path, doc.original_filename);
    } catch (error) {
        console.error('Download document error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Update document metadata
app.put('/api/documents/:id', authenticateToken, async (req, res) => {
    try {
        const documentId = req.params.id;
        const { document_type, description, is_shared } = req.body;
        
        const result = await pool.query(
            `UPDATE documents 
             SET document_type = $1, description = $2, is_shared = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [document_type, description, is_shared, documentId]
        );
        
        res.json({
            success: true,
            message: 'Document updated successfully.',
            document: result.rows[0]
        });
    } catch (error) {
        console.error('Update document error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Delete document
app.delete('/api/documents/:id', authenticateToken, async (req, res) => {
    try {
        const documentId = req.params.id;
        
        // Get document info to delete file
        const document = await pool.query(
            `SELECT * FROM documents WHERE id = $1`,
            [documentId]
        );
        
        if (document.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Document not found.' });
        }
        
        const doc = document.rows[0];
        
        // Delete from database
        await pool.query(`DELETE FROM documents WHERE id = $1`, [documentId]);
        
        // Delete file from disk
        try {
            await fs.unlink(doc.file_path);
        } catch (err) {
            console.error('Error deleting file:', err);
        }
        
        res.json({
            success: true,
            message: 'Document deleted successfully.'
        });
    } catch (error) {
        console.error('Delete document error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Upload new version of document
app.post('/api/documents/:id/version', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        const documentId = req.params.id;
        
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }
        
        const userId = req.user.id;
        
        // Get current version number
        const versions = await pool.query(
            `SELECT COALESCE(MAX(version_number), 0) as max_version 
             FROM document_versions WHERE document_id = $1`,
            [documentId]
        );
        
        const newVersion = versions.rows[0].max_version + 1;
        
        // Save old version
        const currentDoc = await pool.query(
            `SELECT * FROM documents WHERE id = $1`,
            [documentId]
        );
        
        if (currentDoc.rows.length > 0) {
            const doc = currentDoc.rows[0];
            await pool.query(
                `INSERT INTO document_versions 
                 (document_id, version_number, filename, file_path, file_size, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [documentId, newVersion - 1, doc.filename, doc.file_path, doc.file_size, doc.uploaded_by]
            );
        }
        
        // Update document with new file
        const result = await pool.query(
            `UPDATE documents 
             SET filename = $1, file_path = $2, file_size = $3, 
                 mime_type = $4, updated_at = CURRENT_TIMESTAMP
             WHERE id = $5
             RETURNING *`,
            [req.file.filename, req.file.path, req.file.size, req.file.mimetype, documentId]
        );
        
        res.json({
            success: true,
            message: 'New version uploaded successfully.',
            document: result.rows[0],
            version: newVersion
        });
    } catch (error) {
        console.error('Upload version error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get document versions
app.get('/api/documents/:id/versions', authenticateToken, async (req, res) => {
    try {
        const documentId = req.params.id;
        
        const versions = await pool.query(`
            SELECT 
                dv.*,
                au.username as uploaded_by_name
            FROM document_versions dv
            LEFT JOIN admin_users au ON dv.uploaded_by = au.id
            WHERE dv.document_id = $1
            ORDER BY dv.version_number DESC
        `, [documentId]);
        
        res.json({
            success: true,
            versions: versions.rows
        });
    } catch (error) {
        console.error('Get versions error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Create shareable link
app.post('/api/documents/:id/share', authenticateToken, async (req, res) => {
    try {
        const documentId = req.params.id;
        const { email, expires_in_days = 7 } = req.body;
        
        const crypto = require('crypto');
        const shareToken = crypto.randomBytes(32).toString('hex');
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + parseInt(expires_in_days));
        
        const result = await pool.query(
            `INSERT INTO document_shares 
             (document_id, shared_with_email, share_token, expires_at)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [documentId, email, shareToken, expiresAt]
        );
        
        const shareUrl = `${req.protocol}://${req.get('host')}/api/documents/shared/${shareToken}`;
        
        res.json({
            success: true,
            message: 'Share link created successfully.',
            share: result.rows[0],
            share_url: shareUrl
        });
    } catch (error) {
        console.error('Create share link error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Access shared document (no auth required)
app.get('/api/documents/shared/:token', async (req, res) => {
    try {
        const token = req.params.token;
        
        const share = await pool.query(`
            SELECT ds.*, d.file_path, d.original_filename, d.mime_type
            FROM document_shares ds
            JOIN documents d ON ds.document_id = d.id
            WHERE ds.share_token = $1 
                AND ds.expires_at > CURRENT_TIMESTAMP
        `, [token]);
        
        if (share.rows.length === 0) {
            return res.status(404).send('Link expired or invalid.');
        }
        
        const doc = share.rows[0];
        res.download(doc.file_path, doc.original_filename);
    } catch (error) {
        console.error('Shared document error:', error);
        res.status(500).send('Server error.');
    }
});

// Get storage statistics
app.get('/api/documents/stats', authenticateToken, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_documents,
                SUM(file_size) as total_size,
                COUNT(DISTINCT lead_id) as leads_with_docs,
                COUNT(*) FILTER (WHERE document_type = 'contract') as contracts,
                COUNT(*) FILTER (WHERE document_type = 'proposal') as proposals,
                COUNT(*) FILTER (WHERE document_type = 'invoice') as invoices
            FROM documents
        `);
        
        res.json({
            success: true,
            stats: stats.rows[0]
        });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ==================== PHASE 6: SALES PIPELINE / KANBAN BOARD ====================
// Add this to your server.js file

// ==================== DATABASE SCHEMA ====================
// Add to initializeDatabase() function:

// ==================== API ENDPOINTS ====================

// Get all pipeline stages
app.get('/api/pipeline/stages', authenticateToken, async (req, res) => {
    try {
        const stages = await pool.query(`
            SELECT * FROM pipeline_stages 
            WHERE is_active = TRUE
            ORDER BY position ASC
        `);
        
        res.json({
            success: true,
            stages: stages.rows
        });
    } catch (error) {
        console.error('Get pipeline stages error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Create pipeline stage
app.post('/api/pipeline/stages', authenticateToken, async (req, res) => {
    try {
        const { name, description, color, probability } = req.body;
        
        // Get max position
        const maxPos = await pool.query(
            `SELECT COALESCE(MAX(position), 0) as max_position FROM pipeline_stages`
        );
        
        const position = maxPos.rows[0].max_position + 1;
        
        const result = await pool.query(
            `INSERT INTO pipeline_stages (name, description, color, position, probability)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [name, description, color, position, probability]
        );
        
        res.json({
            success: true,
            message: 'Pipeline stage created successfully.',
            stage: result.rows[0]
        });
    } catch (error) {
        console.error('Create pipeline stage error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Update pipeline stage
app.put('/api/pipeline/stages/:id', authenticateToken, async (req, res) => {
    try {
        const stageId = req.params.id;
        const { name, description, color, probability, position } = req.body;
        
        const result = await pool.query(
            `UPDATE pipeline_stages 
             SET name = $1, description = $2, color = $3, probability = $4, position = $5
             WHERE id = $6
             RETURNING *`,
            [name, description, color, probability, position, stageId]
        );
        
        res.json({
            success: true,
            message: 'Pipeline stage updated successfully.',
            stage: result.rows[0]
        });
    } catch (error) {
        console.error('Update pipeline stage error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get all deals with stage info
app.get('/api/pipeline/deals', authenticateToken, async (req, res) => {
    try {
        const deals = await pool.query(`
            SELECT 
                pd.*,
                ps.name as stage_name,
                ps.color as stage_color,
                l.name as lead_name,
                l.email as lead_email,
                l.company as lead_company,
                au.username as assigned_to_name
            FROM pipeline_deals pd
            LEFT JOIN pipeline_stages ps ON pd.stage_id = ps.id
            LEFT JOIN leads l ON pd.lead_id = l.id
            LEFT JOIN admin_users au ON pd.assigned_to = au.id
            ORDER BY ps.position ASC, pd.position ASC
        `);
        
        res.json({
            success: true,
            deals: deals.rows
        });
    } catch (error) {
        console.error('Get pipeline deals error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Create deal
app.post('/api/pipeline/deals', authenticateToken, async (req, res) => {
    try {
        const { lead_id, stage_id, title, value, expected_close_date, probability, notes } = req.body;
        const userId = req.user.id;
        
        // Get max position in this stage
        const maxPos = await pool.query(
            `SELECT COALESCE(MAX(position), 0) as max_position 
             FROM pipeline_deals WHERE stage_id = $1`,
            [stage_id]
        );
        
        const position = maxPos.rows[0].max_position + 1;
        
        const result = await pool.query(
            `INSERT INTO pipeline_deals 
             (lead_id, stage_id, title, value, expected_close_date, probability, position, notes, assigned_to)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [lead_id, stage_id, title, value, expected_close_date, probability, position, notes, userId]
        );
        
        // Log activity
        await pool.query(
            `INSERT INTO deal_activities (deal_id, activity_type, description, created_by)
             VALUES ($1, 'created', 'Deal created', $2)`,
            [result.rows[0].id, userId]
        );
        
        res.json({
            success: true,
            message: 'Deal created successfully.',
            deal: result.rows[0]
        });
    } catch (error) {
        console.error('Create deal error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Update deal
app.put('/api/pipeline/deals/:id', authenticateToken, async (req, res) => {
    try {
        const dealId = req.params.id;
        const { title, value, expected_close_date, probability, notes, assigned_to } = req.body;
        const userId = req.user.id;
        
        const result = await pool.query(
            `UPDATE pipeline_deals 
             SET title = $1, value = $2, expected_close_date = $3, 
                 probability = $4, notes = $5, assigned_to = $6, updated_at = CURRENT_TIMESTAMP
             WHERE id = $7
             RETURNING *`,
            [title, value, expected_close_date, probability, notes, assigned_to, dealId]
        );
        
        // Log activity
        await pool.query(
            `INSERT INTO deal_activities (deal_id, activity_type, description, created_by)
             VALUES ($1, 'updated', 'Deal updated', $2)`,
            [dealId, userId]
        );
        
        res.json({
            success: true,
            message: 'Deal updated successfully.',
            deal: result.rows[0]
        });
    } catch (error) {
        console.error('Update deal error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Move deal to different stage
app.patch('/api/pipeline/deals/:id/move', authenticateToken, async (req, res) => {
    try {
        const dealId = req.params.id;
        const { stage_id, position } = req.body;
        const userId = req.user.id;
        
        // Get current deal info
        const currentDeal = await pool.query(
            `SELECT * FROM pipeline_deals WHERE id = $1`,
            [dealId]
        );
        
        if (currentDeal.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Deal not found.' });
        }
        
        const oldStageId = currentDeal.rows[0].stage_id;
        
        // If moving to different stage
        if (oldStageId !== stage_id) {
            // Get max position in new stage
            const maxPos = await pool.query(
                `SELECT COALESCE(MAX(position), 0) as max_position 
                 FROM pipeline_deals WHERE stage_id = $1`,
                [stage_id]
            );
            
            const newPosition = position !== undefined ? position : maxPos.rows[0].max_position + 1;
            
            // Update deal
            const result = await pool.query(
                `UPDATE pipeline_deals 
                 SET stage_id = $1, position = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3
                 RETURNING *`,
                [stage_id, newPosition, dealId]
            );
            
            // Get stage names for activity log
            const stages = await pool.query(
                `SELECT id, name FROM pipeline_stages WHERE id IN ($1, $2)`,
                [oldStageId, stage_id]
            );
            
            const oldStageName = stages.rows.find(s => s.id === oldStageId)?.name;
            const newStageName = stages.rows.find(s => s.id === stage_id)?.name;
            
            // Log activity
            await pool.query(
                `INSERT INTO deal_activities (deal_id, activity_type, description, created_by)
                 VALUES ($1, 'stage_changed', $2, $3)`,
                [dealId, `Moved from "${oldStageName}" to "${newStageName}"`, userId]
            );
            
            res.json({
                success: true,
                message: 'Deal moved successfully.',
                deal: result.rows[0]
            });
        } else {
            // Just reposition within same stage
            await pool.query(
                `UPDATE pipeline_deals SET position = $1 WHERE id = $2`,
                [position, dealId]
            );
            
            res.json({
                success: true,
                message: 'Deal repositioned successfully.'
            });
        }
    } catch (error) {
        console.error('Move deal error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Delete deal
app.delete('/api/pipeline/deals/:id', authenticateToken, async (req, res) => {
    try {
        const dealId = req.params.id;
        
        await pool.query(`DELETE FROM pipeline_deals WHERE id = $1`, [dealId]);
        
        res.json({
            success: true,
            message: 'Deal deleted successfully.'
        });
    } catch (error) {
        console.error('Delete deal error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get deal activities
app.get('/api/pipeline/deals/:id/activities', authenticateToken, async (req, res) => {
    try {
        const dealId = req.params.id;
        
        const activities = await pool.query(`
            SELECT 
                da.*,
                au.username as created_by_name
            FROM deal_activities da
            LEFT JOIN admin_users au ON da.created_by = au.id
            WHERE da.deal_id = $1
            ORDER BY da.created_at DESC
            LIMIT 50
        `, [dealId]);
        
        res.json({
            success: true,
            activities: activities.rows
        });
    } catch (error) {
        console.error('Get deal activities error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Add note to deal
app.post('/api/pipeline/deals/:id/note', authenticateToken, async (req, res) => {
    try {
        const dealId = req.params.id;
        const { note } = req.body;
        const userId = req.user.id;
        
        await pool.query(
            `INSERT INTO deal_activities (deal_id, activity_type, description, created_by)
             VALUES ($1, 'note', $2, $3)`,
            [dealId, note, userId]
        );
        
        res.json({
            success: true,
            message: 'Note added successfully.'
        });
    } catch (error) {
        console.error('Add note error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get pipeline statistics
app.get('/api/pipeline/stats', authenticateToken, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_deals,
                SUM(value) as total_value,
                SUM(value * (probability / 100.0)) as weighted_value,
                AVG(value) as avg_deal_size,
                COUNT(*) FILTER (WHERE stage_id IN (
                    SELECT id FROM pipeline_stages WHERE name LIKE '%Won%'
                )) as won_deals,
                COUNT(*) FILTER (WHERE stage_id IN (
                    SELECT id FROM pipeline_stages WHERE name LIKE '%Lost%'
                )) as lost_deals
            FROM pipeline_deals
        `);
        
        const stageBreakdown = await pool.query(`
            SELECT 
                ps.name as stage_name,
                ps.color as stage_color,
                COUNT(pd.id) as deal_count,
                COALESCE(SUM(pd.value), 0) as total_value
            FROM pipeline_stages ps
            LEFT JOIN pipeline_deals pd ON ps.id = pd.stage_id
            WHERE ps.is_active = TRUE
            GROUP BY ps.id, ps.name, ps.color, ps.position
            ORDER BY ps.position ASC
        `);
        
        res.json({
            success: true,
            stats: stats.rows[0],
            stage_breakdown: stageBreakdown.rows
        });
    } catch (error) {
        console.error('Get pipeline stats error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get pipeline forecast
app.get('/api/pipeline/forecast', authenticateToken, async (req, res) => {
    try {
        const { months = 3 } = req.query;
        
        const forecast = await pool.query(`
            SELECT 
                DATE_TRUNC('month', expected_close_date) as month,
                COUNT(*) as deal_count,
                SUM(value) as total_value,
                SUM(value * (probability / 100.0)) as weighted_value
            FROM pipeline_deals
            WHERE expected_close_date IS NOT NULL
                AND expected_close_date >= CURRENT_DATE
                AND expected_close_date <= CURRENT_DATE + INTERVAL '${parseInt(months)} months'
            GROUP BY DATE_TRUNC('month', expected_close_date)
            ORDER BY month ASC
        `);
        
        res.json({
            success: true,
            forecast: forecast.rows
        });
    } catch (error) {
        console.error('Get forecast error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ========================================
// PDF GENERATION FUNCTIONS
// ========================================

const puppeteer = require('puppeteer');

// ========================================
// PDF GENERATION FUNCTIONS
// ========================================

async function generatePDFFromHTML(html) {
    let browser;
    try {
        console.log('🚀 Launching browser...');
        
        const launchOptions = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions'
            ]
        };

        browser = await puppeteer.launch(launchOptions);
        console.log('✅ Browser launched successfully');
        
        const page = await browser.newPage();
        await page.setContent(html, { 
            waitUntil: 'networkidle0',
            timeout: 30000 
        });
        
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '20px',
                right: '20px',
                bottom: '20px',
                left: '20px'
            }
        });
        
        console.log('✅ PDF generated successfully');
        return pdf;
        
    } catch (error) {
        console.error('❌ PDF generation error:', error);
        throw new Error('Failed to generate PDF: ' + error.message);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

function generateTimelinePDFHTML(timeline) {
    let totalPrice = 0;
    let hasPaidPackage = false;
    
    timeline.packages.forEach(function(key) {
        if (servicePackages[key] && !servicePackages[key].isFree) {
            hasPaidPackage = true;
            totalPrice += servicePackages[key].price;
        }
    });
    
    const companySignatureDate = new Date(timeline.createdAt).toLocaleDateString();
    const documentId = `SLA-${new Date(timeline.createdAt).getFullYear()}-${String(Date.now()).slice(-6)}`;
    
    let packagesListHtml = '';
    timeline.packages.forEach(function(key) {
        if (servicePackages[key]) {
            const pkg = servicePackages[key];
            packagesListHtml += `<div style="display: inline-block; background: #f8f9fa; border: 1px solid #22c55e; color: #000; padding: 6px 14px; border-radius: 4px; font-size: 11px; font-weight: 600; margin: 0 8px 8px 0;">${pkg.name}${pkg.isFree ? ' <span style="color: #22c55e;">(FREE)</span>' : ''}</div>`;
        }
    });
    
    let paymentTermsHtml = '';
    if (timeline.isFreeProject || !hasPaidPackage) {
        paymentTermsHtml = 'No Payment Required';
    } else {
        switch (timeline.paymentTerms) {
            case 'completion':
                paymentTermsHtml = '50% Deposit + 50% on Completion';
                break;
            case 'net30':
                paymentTermsHtml = '50% Deposit + 50% Net 30';
                break;
            default:
                paymentTermsHtml = '50% Deposit + 50% on Completion';
        }
    }
    
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>SLA - ${timeline.clientName}</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: "Segoe UI", Arial, sans-serif; background: #fff; color: #000; padding: 40px; }
                h1 { color: #22c55e; font-size: 32px; margin-bottom: 20px; }
                .section { margin-bottom: 30px; }
                .label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #666; margin-bottom: 6px; }
                .value { font-size: 14px; color: #000; font-weight: 600; }
            </style>
        </head>
        <body>
            <h1>SERVICE LEVEL AGREEMENT</h1>
            <div class="section">
                <div class="label">Client</div>
                <div class="value">${timeline.clientName}</div>
            </div>
            <div class="section">
                <div class="label">Project</div>
                <div class="value">${timeline.projectName || 'Web Development Project'}</div>
            </div>
            <div class="section">
                <div class="label">Total Investment</div>
                <div class="value">${timeline.isFreeProject ? 'FREE' : '$' + totalPrice.toLocaleString()}</div>
            </div>
            <div class="section">
                <div class="label">Payment Terms</div>
                <div class="value">${paymentTermsHtml}</div>
            </div>
            <div class="section">
                <div class="label">Selected Services</div>
                <div>${packagesListHtml}</div>
            </div>
            <div class="section">
                <div class="label">Document ID</div>
                <div class="value">${documentId}</div>
            </div>
        </body>
        </html>
    `;
}

function generateInvoicePDFHTML(invoice) {
    const items = invoice.items || [];
    const taxAmount = parseFloat(invoice.tax_amount || 0);
    const discount = parseFloat(invoice.discount_amount || 0);
    
    const itemsHTML = items.map(item => `
        <tr>
            <td>${item.description}</td>
            <td style="text-align: center;">${item.quantity || 1}</td>
            <td style="text-align: right;">$${parseFloat(item.unit_price || item.amount).toLocaleString()}</td>
            <td style="text-align: right; font-weight: bold;">$${parseFloat(item.amount).toLocaleString()}</td>
        </tr>
    `).join('');
    
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Invoice ${invoice.invoice_number}</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: "Segoe UI", Arial, sans-serif; padding: 40px; }
                .header { background: #22c55e; color: white; padding: 30px; margin-bottom: 30px; }
                h1 { font-size: 32px; }
                table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                th { background: #f5f5f5; padding: 12px; text-align: left; font-size: 11px; text-transform: uppercase; }
                td { padding: 12px; border-bottom: 1px solid #eee; }
                .total { font-size: 24px; font-weight: bold; color: #22c55e; text-align: right; margin-top: 20px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>INVOICE</h1>
                <p>#${invoice.invoice_number}</p>
            </div>
            <p><strong>Bill To:</strong> ${invoice.customer_name || 'Customer'}</p>
            <p><strong>Email:</strong> ${invoice.customer_email || ''}</p>
            <p><strong>Issue Date:</strong> ${new Date(invoice.issue_date).toLocaleDateString()}</p>
            <p><strong>Due Date:</strong> ${new Date(invoice.due_date).toLocaleDateString()}</p>
            <table>
                <thead>
                    <tr>
                        <th>Description</th>
                        <th style="text-align: center;">Qty</th>
                        <th style="text-align: right;">Unit Price</th>
                        <th style="text-align: right;">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsHTML}
                </tbody>
            </table>
            <div style="text-align: right;">
                <p><strong>Subtotal:</strong> $${parseFloat(invoice.subtotal).toLocaleString()}</p>
                ${taxAmount > 0 ? `<p><strong>Tax (${invoice.tax_rate}%):</strong> $${taxAmount.toLocaleString()}</p>` : ''}
                ${discount > 0 ? `<p><strong>Discount:</strong> -$${discount.toLocaleString()}</p>` : ''}
                <p class="total">Total: $${parseFloat(invoice.total_amount).toLocaleString()}</p>
            </div>
        </body>
        </html>
    `;
}

// Revenue Analytics
app.get('/api/analytics/revenue', authenticateToken, async (req, res) => {
    try {
        const { period = '30' } = req.query; // days
        
        const revenueData = await pool.query(`
            SELECT 
                DATE_TRUNC('day', paid_at) as date,
                SUM(total_amount) as revenue,
                COUNT(*) as invoice_count
            FROM invoices
            WHERE status = 'paid' 
                AND paid_at >= NOW() - INTERVAL '${parseInt(period)} days'
            GROUP BY DATE_TRUNC('day', paid_at)
            ORDER BY date DESC
        `);
        
        const projectedRevenue = await pool.query(`
            SELECT 
                SUM(total_amount * (probability / 100.0)) as projected
            FROM invoices i
            JOIN leads l ON i.lead_id = l.id
            WHERE i.status IN ('draft', 'sent')
                AND l.expected_close_date >= CURRENT_DATE
                AND l.expected_close_date <= CURRENT_DATE + INTERVAL '90 days'
        `);
        
        res.json({
            success: true,
            revenue: revenueData.rows,
            projected: projectedRevenue.rows[0].projected || 0
        });
    } catch (error) {
        console.error('Revenue analytics error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Conversion Funnel
app.get('/api/analytics/funnel', authenticateToken, async (req, res) => {
    try {
        const funnel = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'new' AND is_customer = FALSE) as new_leads,
                COUNT(*) FILTER (WHERE status = 'contacted' AND is_customer = FALSE) as contacted,
                COUNT(*) FILTER (WHERE status = 'pending' AND is_customer = FALSE) as pending,
                COUNT(*) FILTER (WHERE is_customer = true) as converted,
                ROUND(
                    COUNT(*) FILTER (WHERE is_customer = true)::numeric / 
                    NULLIF(COUNT(*), 0) * 100, 
                    2
                ) as conversion_rate
            FROM leads
        `);
        
        res.json({
            success: true,
            funnel: funnel.rows[0]
        });
    } catch (error) {
        console.error('Funnel analytics error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Employee Performance
app.get('/api/analytics/employee-performance', authenticateToken, async (req, res) => {
    try {
        const performance = await pool.query(`
            SELECT 
                e.id,
                e.name,
                COUNT(DISTINCT l.id) as total_leads,
                COUNT(DISTINCT l.id) FILTER (WHERE l.is_customer = true) as converted,
                COALESCE(SUM(l.lifetime_value), 0) as total_revenue,
                ROUND(
                    COUNT(DISTINCT l.id) FILTER (WHERE l.is_customer = true)::numeric / 
                    NULLIF(COUNT(DISTINCT l.id), 0) * 100,
                    2
                ) as conversion_rate
            FROM employees e
            LEFT JOIN leads l ON l.assigned_to = e.id
            WHERE e.is_active = true
            GROUP BY e.id, e.name
            ORDER BY total_revenue DESC
        `);
        
        res.json({
            success: true,
            performance: performance.rows
        });
    } catch (error) {
        console.error('Performance analytics error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Lead Sources
app.get('/api/analytics/sources', authenticateToken, async (req, res) => {
    try {
        const sources = await pool.query(`
            SELECT 
                COALESCE(source, 'Unknown') as source,
                COUNT(*) as count,
                COUNT(*) FILTER (WHERE is_customer = true) as converted,
                ROUND(
                    COUNT(*) FILTER (WHERE is_customer = true)::numeric / 
                    NULLIF(COUNT(*), 0) * 100,
                    2
                ) as conversion_rate
            FROM leads
            WHERE is_customer = FALSE
            GROUP BY source
            ORDER BY count DESC
        `);
        
        res.json({
            success: true,
            sources: sources.rows
        });
    } catch (error) {
        console.error('Sources analytics error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get upcoming reminders
app.get('/api/reminders', authenticateToken, async (req, res) => {
    try {
        const reminders = await pool.query(`
            SELECT r.*, l.name as lead_name, l.email
            FROM reminders r
            LEFT JOIN leads l ON r.lead_id = l.id
            WHERE r.is_completed = FALSE
                AND r.reminder_date <= NOW() + INTERVAL '7 days'
            ORDER BY r.reminder_date ASC
        `);
        
        res.json({
            success: true,
            reminders: reminders.rows
        });
    } catch (error) {
        console.error('Get reminders error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Create reminder
app.post('/api/reminders', authenticateToken, async (req, res) => {
    try {
        const { lead_id, reminder_type, reminder_date, message } = req.body;
        const userId = req.user.id;
        
        const result = await pool.query(
            `INSERT INTO reminders (lead_id, user_id, reminder_type, reminder_date, message)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [lead_id, userId, reminder_type, reminder_date, message]
        );
        
        res.json({
            success: true,
            message: 'Reminder created successfully.',
            reminder: result.rows[0]
        });
    } catch (error) {
        console.error('Create reminder error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Complete reminder
app.patch('/api/reminders/:id/complete', authenticateToken, async (req, res) => {
    try {
        const reminderId = req.params.id;
        
        await pool.query(
            `UPDATE reminders 
             SET is_completed = TRUE, completed_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [reminderId]
        );
        
        res.json({
            success: true,
            message: 'Reminder marked as complete.'
        });
    } catch (error) {
        console.error('Complete reminder error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Auto-generate follow-up reminders (run daily via cron)
app.post('/api/automation/generate-followup-reminders', authenticateToken, async (req, res) => {
    try {
        // Find leads that haven't been contacted in 7+ days
        const staleLeads = await pool.query(`
            SELECT l.* 
            FROM leads l
            LEFT JOIN reminders r ON r.lead_id = l.id AND r.is_completed = FALSE
            WHERE l.status IN ('new', 'contacted', 'pending')
                AND l.is_customer = FALSE
                AND (l.last_contact_date IS NULL OR l.last_contact_date < NOW() - INTERVAL '7 days')
                AND r.id IS NULL
        `);
        
        for (const lead of staleLeads.rows) {
            await pool.query(
                `INSERT INTO reminders (lead_id, user_id, reminder_type, reminder_date, message)
                 VALUES ($1, $2, 'follow-up', NOW() + INTERVAL '1 day', $3)`,
                [
                    lead.id,
                    lead.assigned_to || 1,
                    `Follow up with ${lead.name} - no contact in 7+ days`
                ]
            );
        }
        
        res.json({
            success: true,
            message: `Generated ${staleLeads.rows.length} follow-up reminders.`
        });
    } catch (error) {
        console.error('Generate reminders error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ========================================
// ADD THESE ROUTES TO YOUR server.js
// Place them with your other email routes
// ========================================

// ========================================
// GET DEAD LEADS (unsubscribed)
// ========================================
app.get('/api/follow-ups/dead-leads', authenticateToken, async (req, res) => {
    try {
        console.log('[DEAD-LEADS] Fetching unsubscribed leads');
        const result = await pool.query(`
            SELECT 
                l.*,
                COALESCE(EXTRACT(DAY FROM CURRENT_DATE - l.last_contact_date)::INTEGER, 999) as days_since_contact
            FROM leads l
            WHERE l.unsubscribed = TRUE
            AND l.is_customer = FALSE
            ORDER BY l.updated_at DESC NULLS LAST
        `);
        console.log(`[DEAD-LEADS] Found ${result.rows.length} unsubscribed leads`);
        res.json({ success: true, leads: result.rows, total: result.rows.length });
    } catch (error) {
        console.error('[DEAD-LEADS] Error:', error);
        res.status(500).json({ success: false, message: 'Error fetching dead leads', error: error.message });
    }
});

// ========================================
// EMAIL OPEN TRACKING PIXEL
// ========================================
app.get('/api/track/open/:emailLogId', async (req, res) => {
    try {
        const { emailLogId } = req.params;
        
        // CRITICAL: When email is opened, this confirms delivery
        // Update status from 'queued' → 'opened' OR 'sent' → 'opened'
        const result = await pool.query(
            `UPDATE email_log 
             SET opened_at = CURRENT_TIMESTAMP, 
                 status = 'opened'
             WHERE id = $1 
             AND status IN ('queued', 'sent')  -- Accept both queued and sent
             AND opened_at IS NULL  -- Only track first open
             RETURNING lead_id, status`,
            [emailLogId]
        );
        
        // If we updated a row, this means the email was actually delivered and opened
        if (result.rows.length > 0) {
            const leadId = result.rows[0].lead_id;
            const previousStatus = result.rows[0].status;
            
            console.log(`[TRACKING] ✅ Email ${emailLogId} OPENED by lead ${leadId} (was: ${previousStatus})`);
            
            if (leadId) {
                // NOW we can confidently advance the lead since we have proof of delivery
                await pool.query(
                    `UPDATE leads 
                     SET last_contact_date = CURRENT_DATE, 
                         follow_up_count = COALESCE(follow_up_count, 0) + 1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1
                     AND (last_contact_date IS NULL OR last_contact_date < CURRENT_DATE)`,
                    [leadId]
                );
                console.log(`[FOLLOW-UP] ✅ Lead ${leadId} advanced - email was ACTUALLY DELIVERED and opened`);
                
                // Track engagement to make them hot
                await trackEngagement(leadId, 'email_open', 5);
            }
        } else {
            // Email wasn't in queued/sent status - either already opened, failed, or doesn't exist
            console.log(`[TRACKING] ⚠️  Pixel request for email ${emailLogId} but email was not in 'queued' or 'sent' status`);
        }
    } catch (e) {
        console.error('[TRACKING] Error tracking email open:', e);
        // Silently swallow - never break pixel delivery
    }
    // Return 1×1 transparent GIF regardless of success/failure
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
    res.end(pixel);
});

// ========================================
// ANALYTICS: Email Open Report
// ========================================
app.get('/api/analytics/email-opens', authenticateToken, async (req, res) => {
    try {
        // Overall stats - Updated to show queued separately
        const statsResult = await pool.query(`
            SELECT
                COUNT(*) as total_emails,
                COUNT(*) FILTER (WHERE status = 'sent' OR status = 'opened') as total_sent,
                COUNT(*) FILTER (WHERE status = 'queued') as total_queued,
                COUNT(*) FILTER (WHERE status = 'failed') as total_failed,
                COUNT(*) FILTER (WHERE status = 'pending') as total_pending,
                COUNT(*) FILTER (WHERE status = 'opened') as total_opened,
                COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) as total_clicked,
                ROUND(
                    COUNT(*) FILTER (WHERE status IN ('sent', 'opened', 'queued'))::NUMERIC /
                    NULLIF(COUNT(*), 0) * 100, 1
                ) as delivery_rate,
                ROUND(
                    COUNT(*) FILTER (WHERE status = 'opened')::NUMERIC /
                    NULLIF(COUNT(*) FILTER (WHERE status IN ('sent', 'opened', 'queued')), 0) * 100, 1
                ) as open_rate,
                ROUND(
                    COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::NUMERIC /
                    NULLIF(COUNT(*) FILTER (WHERE status IN ('sent', 'opened', 'queued')), 0) * 100, 1
                ) as click_rate
            FROM email_log
        `);

        // Leads that opened and became hot
        const hotConversionsResult = await pool.query(`
            SELECT COUNT(DISTINCT el.lead_id) as opened_and_became_hot
            FROM email_log el
            JOIN leads l ON el.lead_id = l.id
            WHERE el.status = 'opened'
            AND l.lead_temperature = 'hot'
        `);

        // Recent emails with lead info (last 100) - show all statuses
        const recentEmailsResult = await pool.query(`
            SELECT
                el.id,
                el.subject,
                el.sent_at,
                el.opened_at,
                el.clicked_at,
                el.status,
                el.error_message,
                l.name as lead_name,
                l.email as lead_email,
                l.lead_temperature,
                l.company
            FROM email_log el
            LEFT JOIN leads l ON el.lead_id = l.id
            ORDER BY el.sent_at DESC NULLS LAST, el.id DESC
            LIMIT 100
        `);

        // Email trends per day (last 30 days) - show sent, queued, opened, and failed
        const trendsResult = await pool.query(`
            SELECT
                DATE(COALESCE(sent_at, created_at)) as date,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'sent' OR status = 'opened') as sent,
                COUNT(*) FILTER (WHERE status = 'queued') as queued,
                COUNT(*) FILTER (WHERE status = 'opened') as opened,
                COUNT(*) FILTER (WHERE status = 'failed') as failed
            FROM email_log
            WHERE COALESCE(sent_at, created_at) >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY DATE(COALESCE(sent_at, created_at))
            ORDER BY date DESC
        `);

        res.json({
            success: true,
            stats: {
                ...statsResult.rows[0],
                opened_and_became_hot: hotConversionsResult.rows[0]?.opened_and_became_hot || 0
            },
            recent_emails: recentEmailsResult.rows,
            daily_trends: trendsResult.rows
        });
    } catch (error) {
        console.error('[ANALYTICS] Email analytics error:', error);
        res.status(500).json({ success: false, message: 'Error fetching email analytics', error: error.message });
    }
});

// Get follow-ups separated by temperature (hot/cold)
app.get('/api/follow-ups/by-temperature', authenticateToken, async (req, res) => {
    try {
        console.log('[FOLLOW-UPS] Getting leads by temperature');
        
        const result = await pool.query(`
            SELECT 
                l.*,
                COALESCE(EXTRACT(DAY FROM CURRENT_DATE - l.last_contact_date)::INTEGER, 999) as days_since_contact,
                COALESCE(EXTRACT(DAY FROM CURRENT_DATE - l.last_engagement_at)::INTEGER, 999) as days_since_engagement,
                COALESCE(l.follow_up_count, 0) as follow_up_count
            FROM leads l
            WHERE l.status IN ('new', 'contacted', 'qualified', 'pending')
            AND l.is_customer = FALSE
            AND l.unsubscribed = FALSE
            AND NOT EXISTS (
                SELECT 1 FROM auto_campaigns ac WHERE ac.lead_id = l.id AND ac.is_active = TRUE
            )
            AND (
                -- HOT LEADS TIMELINE:
                -- Show immediately when they become hot (last_contact_date reset to NULL in trackEngagement)
                -- After first contact on hot lead: 3.5 days
                -- After 2nd contact: 7 days  
                -- After 3rd+ contacts: alternates between 3.5 and 7 days
                (l.lead_temperature = 'hot' AND (
                    l.last_contact_date IS NULL 
                    OR (l.follow_up_count >= 1 AND l.follow_up_count % 2 = 1 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '3.5 days')
                    OR (l.follow_up_count >= 2 AND l.follow_up_count % 2 = 0 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '7 days')
                ))
                OR
                -- COLD LEADS TIMELINE:
                -- Never contacted: show immediately
                -- 1st follow-up: 3 days
                -- 2nd follow-up: 5 days
                -- 3rd+ follow-ups: every 7 days
                (COALESCE(l.lead_temperature, 'cold') != 'hot' AND (
                    l.last_contact_date IS NULL
                    OR (l.follow_up_count = 0 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '3 days')
                    OR (l.follow_up_count = 1 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '5 days')
                    OR (l.follow_up_count >= 2 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '7 days')
                ))
            )
            ORDER BY 
                CASE l.lead_temperature
                    WHEN 'hot' THEN 1
                    ELSE 2
                END,
                l.last_contact_date ASC NULLS FIRST,
                l.became_hot_at DESC NULLS LAST
        `);
        
        // Separate into hot and cold
        const hotLeads = result.rows.filter(lead => lead.lead_temperature === 'hot');
        const coldLeads = result.rows.filter(lead => lead.lead_temperature !== 'hot' || !lead.lead_temperature);
        
        console.log(`[FOLLOW-UPS] ✅ Found ${hotLeads.length} hot leads, ${coldLeads.length} cold leads`);
        
        res.json({
            success: true,
            data: {
                hot: hotLeads,
                cold: coldLeads,
                stats: {
                    total: result.rows.length,
                    hot: hotLeads.length,
                    cold: coldLeads.length
                }
            }
        });
    } catch (error) {
        console.error('[FOLLOW-UPS] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching follow-ups by temperature',
            error: error.message
        });
    }
});

// Get follow-ups grouped by category with leads and notes
app.get('/api/follow-ups/categorized', authenticateToken, async (req, res) => {
    try {
        console.log('[FOLLOW-UPS] Getting categorized follow-ups');
        
        const result = await pool.query(`
            WITH follow_up_leads AS (
                SELECT 
                    l.*,
                    CASE 
                        WHEN l.last_contact_date IS NULL THEN 'never_contacted'
                        WHEN EXTRACT(DAY FROM CURRENT_DATE - l.last_contact_date) >= 14 THEN '14_day'
                        WHEN EXTRACT(DAY FROM CURRENT_DATE - l.last_contact_date) >= 7 THEN '7_day'
                        WHEN EXTRACT(DAY FROM CURRENT_DATE - l.last_contact_date) >= 3 THEN '3_day'
                        WHEN EXTRACT(DAY FROM CURRENT_DATE - l.last_contact_date) >= 1 THEN '1_day'
                        ELSE NULL
                    END as follow_up_category,
                    COALESCE(EXTRACT(DAY FROM CURRENT_DATE - l.last_contact_date)::INTEGER, 999) as days_since_contact
                FROM leads l
                WHERE l.status IN ('new', 'contacted', 'qualified', 'pending')
                AND l.is_customer = FALSE
                AND l.unsubscribed = FALSE
                AND (
                    l.last_contact_date IS NULL
                    OR l.last_contact_date <= CURRENT_DATE - INTERVAL '1 day'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM auto_campaigns ac WHERE ac.lead_id = l.id AND ac.is_active = TRUE
                )
            )
            SELECT 
                follow_up_category,
                COUNT(*) as count,
                json_agg(
                    json_build_object(
                        'id', id,
                        'name', name,
                        'email', email,
                        'company', company,
                        'status', status,
                        'last_contact_date', last_contact_date,
                        'days_since_contact', days_since_contact,
                        'notes', notes
                    ) ORDER BY days_since_contact DESC
                ) as leads
            FROM follow_up_leads
            WHERE follow_up_category IS NOT NULL
            GROUP BY follow_up_category
            ORDER BY 
                CASE follow_up_category
                    WHEN 'never_contacted' THEN 1
                    WHEN '14_day' THEN 2
                    WHEN '7_day' THEN 3
                    WHEN '3_day' THEN 4
                    WHEN '1_day' THEN 5
                END
        `);
        
        console.log(`[FOLLOW-UPS] ✅ Found ${result.rows.length} categories`);
        
        res.json({
            success: true,
            categories: result.rows
        });
    } catch (error) {
        console.error('[FOLLOW-UPS] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching categorized follow-ups',
            error: error.message
        });
    }
});

// Send custom email
app.post('/api/email/send-custom', authenticateToken, async (req, res) => {
    try {
        const { to, subject, body, leadId, toName } = req.body;
        
        console.log('[EMAIL API] Sending custom email to:', to);
        console.log('[EMAIL API] Lead ID:', leadId);
        
        // Validate required fields
        if (!to || !subject || !body) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: to, subject, body'
            });
        }
        
        // Create email HTML
        // Generate unsubscribe token if this is for a lead
        let unsubscribeUrl = null;
        if (leadId) {
            try {
                const leadRow = await pool.query('SELECT unsubscribe_token FROM leads WHERE id = $1', [leadId]);
                let token = leadRow.rows[0]?.unsubscribe_token;
                if (!token) {
                    token = crypto.randomBytes(32).toString('hex');
                    await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [token, leadId]);
                }
                unsubscribeUrl = `${BASE_URL}/api/unsubscribe/${token}`;
            } catch (e) {
                console.warn('[EMAIL API] Could not generate unsubscribe token:', e.message);
            }
        }

        // Create email HTML
        const emailHTML = buildEmailHTML(`
            <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${body.replace(/\n/g, '<br>')}</div>

            <div class="sign-off">
                <p>Warm regards,</p>
                <p class="team-name">The Diamondback Coding Team</p>
            </div>
        `, { unsubscribeUrl });
        
        // Send via tracked helper (logs to email_log + injects open pixel)
        try {
            await sendTrackedEmail({ leadId: leadId || null, to, subject, html: emailHTML });
            console.log('[EMAIL API] ✅ Email sent successfully to:', to);
        } catch (emailError) {
            console.error('[EMAIL API] ❌ Email send error:', emailError);
            return res.status(500).json({
                success: false,
                message: 'Failed to send email: ' + emailError.message
            });
        }
        
        // ✅ CRITICAL: Do NOT update last_contact_date here!
        // The sendTrackedEmail function and tracking pixel endpoint handle this correctly:
        // - Email opens → status becomes 'opened' → lead advances
        // - 24 hours without bounce → status becomes 'sent' → lead advances
        // This was the 7th instance of the immediate update bug!
        
        // Return success response
        res.json({ 
            success: true, 
            message: 'Email queued - awaiting delivery confirmation (will confirm within 24 hours or when opened)',
            status: 'queued'
        });
        
    } catch (error) {
        console.error('[EMAIL API] ❌ Unexpected error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error: ' + error.message 
        });
    }
});

// ========================================
// LEAD SOURCE TRACKING
// Add these columns to leads table
// ========================================

async function addLeadSourceTracking() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Add source tracking columns
        await client.query(`
            DO $$ 
            BEGIN 
                -- Lead source
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='source') THEN
                    ALTER TABLE leads ADD COLUMN source VARCHAR(100);
                END IF;
                
                -- Lead source details
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='source_details') THEN
                    ALTER TABLE leads ADD COLUMN source_details TEXT;
                END IF;
                
                -- Referring URL
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='referrer_url') THEN
                    ALTER TABLE leads ADD COLUMN referrer_url TEXT;
                END IF;
                
                -- UTM parameters
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='utm_source') THEN
                    ALTER TABLE leads ADD COLUMN utm_source VARCHAR(255);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='utm_medium') THEN
                    ALTER TABLE leads ADD COLUMN utm_medium VARCHAR(255);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='utm_campaign') THEN
                    ALTER TABLE leads ADD COLUMN utm_campaign VARCHAR(255);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='utm_content') THEN
                    ALTER TABLE leads ADD COLUMN utm_content VARCHAR(255);
                END IF;
                
                -- First contact date
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='first_contact_date') THEN
                    ALTER TABLE leads ADD COLUMN first_contact_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                END IF;
                
                -- Last contact date
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='leads' AND column_name='last_contact_date') THEN
                    ALTER TABLE leads ADD COLUMN last_contact_date TIMESTAMP;
                END IF;
            END $$;
        `);
        
        await client.query('COMMIT');
        console.log('✅ Lead source tracking columns added');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding lead source tracking:', error);
    } finally {
        client.release();
    }
}

// Get lead source analytics
app.get('/api/analytics/lead-sources', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        let query = `
            SELECT 
                source,
                COUNT(*) as count,
                COUNT(CASE WHEN is_customer = TRUE THEN 1 END) as converted,
                ROUND(
                    (COUNT(CASE WHEN is_customer = TRUE THEN 1 END)::numeric / COUNT(*)::numeric) * 100,
                    2
                ) as conversion_rate
            FROM leads
            WHERE 1=1
        `;
        
        const params = [];
        let paramIndex = 1;
        
        if (startDate) {
            query += ` AND created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }
        
        if (endDate) {
            query += ` AND created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }
        
        query += ` GROUP BY source ORDER BY count DESC`;
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            sources: result.rows
        });
    } catch (error) {
        console.error('Get lead sources error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get conversion funnel data
// Get revenue analytics
app.get('/api/analytics/revenue', authenticateToken, async (req, res) => {
    try {
        const { period = 'month' } = req.query; // month, quarter, year
        
        let dateFormat;
        switch (period) {
            case 'quarter':
                dateFormat = 'YYYY-Q';
                break;
            case 'year':
                dateFormat = 'YYYY';
                break;
            default:
                dateFormat = 'YYYY-MM';
        }
        
        const result = await pool.query(`
            SELECT 
                TO_CHAR(issue_date, $1) as period,
                COUNT(*) as invoice_count,
                SUM(total_amount) FILTER (WHERE status = 'paid') as revenue,
                SUM(total_amount) FILTER (WHERE status != 'paid' AND status != 'cancelled' AND status != 'void') as pending,
                AVG(total_amount) FILTER (WHERE status = 'paid') as avg_deal_size
            FROM invoices
            WHERE issue_date >= CURRENT_DATE - INTERVAL '12 months'
            GROUP BY TO_CHAR(issue_date, $1)
            ORDER BY period DESC
        `, [dateFormat]);
        
        res.json({
            success: true,
            revenue: result.rows
        });
    } catch (error) {
        console.error('Get revenue analytics error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Client Dashboard Data
app.get('/api/client/dashboard', authenticateClient, async (req, res) => {
    try {
        const clientId = req.user.id;
        
        console.log('[DASHBOARD] Loading dashboard for client:', clientId);
        
        // Get invoices
        const invoicesResult = await pool.query(
            'SELECT * FROM invoices WHERE lead_id = $1 ORDER BY created_at DESC',
            [clientId]
        );
        
        // Get projects
        let projects = [];
        try {
            const projectsResult = await pool.query(`
                SELECT cp.*, 
                       (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id) as total_milestones,
                       (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id AND status = 'completed') as completed_milestones
                FROM client_projects cp
                WHERE cp.lead_id = $1
                ORDER BY cp.created_at DESC
            `, [clientId]);
            projects = projectsResult.rows;
        } catch (e) {
            console.log('[WARNING] Project tables may not exist yet');
        }
        
        // Get support tickets
        let tickets = [];
        try {
            const ticketsResult = await pool.query(
                'SELECT * FROM support_tickets WHERE lead_id = $1 ORDER BY created_at DESC',
                [clientId]
            );
            tickets = ticketsResult.rows;
        } catch (e) {
            console.log('[WARNING] Support ticket tables may not exist yet');
        }
        
        // Get recent activity
        let activity = [];
        try {
            const activityResult = await pool.query(`
                SELECT 'invoice' as type, id, created_at, 
                       'Invoice #' || invoice_number || ' created' as description, 
                       '' as details
                FROM invoices WHERE lead_id = $1
                ORDER BY created_at DESC LIMIT 10
            `, [clientId]);
            activity = activityResult.rows;
        } catch (e) {
            console.log('[WARNING] Could not load activity');
        }
        
        res.json({
            success: true,
            dashboard: {
                invoices: invoicesResult.rows,
                projects,
                tickets,
                activity
            }
        });
        
    } catch (error) {
        console.error('[ERROR] Dashboard error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load dashboard' 
        });
    }
});

// Download Invoice PDF
app.get('/api/client/invoice/:id/download', authenticateClient, async (req, res) => {
    try {
        const invoice = await db.get(
            'SELECT * FROM invoices WHERE id = ? AND lead_id = ?',
            [req.params.id, req.user.id]
        );
        
        if (!invoice) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }
        
        // Generate PDF (implement PDF generation)
        res.json({ success: true, message: 'PDF generation not yet implemented' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Download failed' });
    }
});

// Client Projects
// Get all projects for authenticated client
app.get('/api/client/projects', authenticateClient, async (req, res) => {
    try {
        const clientId = req.user.id;
        
        const result = await pool.query(`
            SELECT p.*, 
                   COUNT(DISTINCT pm.id) as milestone_count,
                   COUNT(DISTINCT CASE WHEN pm.status = 'completed' THEN pm.id END) as completed_milestones
            FROM projects p
            LEFT JOIN project_milestones pm ON p.id = pm.project_id
            WHERE p.lead_id = $1
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `, [clientId]);
        
        res.json({
            success: true,
            projects: result.rows
        });
    } catch (error) {
        console.error('Get client projects error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load projects' 
        });
    }
});

// Get milestones for a specific project
app.get('/api/client/projects/:projectId/milestones', authenticateClient, async (req, res) => {
    try {
        const clientId = req.user.id;
        const projectId = req.params.projectId;
        
        // Verify project belongs to client
        const projectCheck = await pool.query(
            'SELECT id FROM projects WHERE id = $1 AND lead_id = $2',
            [projectId, clientId]
        );
        
        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Project not found' 
            });
        }
        
        const result = await pool.query(`
            SELECT * FROM project_milestones
            WHERE project_id = $1
            ORDER BY due_date ASC, created_at ASC
        `, [projectId]);
        
        res.json({
            success: true,
            milestones: result.rows
        });
    } catch (error) {
        console.error('Get project milestones error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load milestones' 
        });
    }
});

// Get all projects (admin)
app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, l.name as client_name, l.company,
                   COUNT(DISTINCT pm.id) as milestone_count,
                   COUNT(DISTINCT CASE WHEN pm.status = 'completed' THEN pm.id END) as completed_milestones
            FROM projects p
            LEFT JOIN leads l ON p.lead_id = l.id
            LEFT JOIN project_milestones pm ON p.id = pm.project_id
            GROUP BY p.id, l.name, l.company
            ORDER BY p.created_at DESC
        `);
        
        res.json({
            success: true,
            projects: result.rows
        });
    } catch (error) {
        console.error('Get projects error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load projects' 
        });
    }
});

// Get projects for specific client (admin viewing client portal)
app.get('/api/client/:clientId/projects', authenticateToken, async (req, res) => {
    try {
        const clientId = req.params.clientId;
        
        const result = await pool.query(`
            SELECT p.*, 
                   COUNT(DISTINCT pm.id) as milestone_count,
                   COUNT(DISTINCT CASE WHEN pm.status = 'completed' THEN pm.id END) as completed_milestones
            FROM projects p
            LEFT JOIN project_milestones pm ON p.id = pm.project_id
            WHERE p.lead_id = $1
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `, [clientId]);
        
        res.json({
            success: true,
            projects: result.rows
        });
    } catch (error) {
        console.error('Get client projects error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load projects' 
        });
    }
});

// Create new project (admin)
app.post('/api/projects', authenticateToken, async (req, res) => {
    try {
        const { lead_id, name, description, status, start_date, end_date, budget } = req.body;
        
        const result = await pool.query(`
            INSERT INTO projects (lead_id, name, description, status, start_date, end_date, budget)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [lead_id, name, description, status || 'active', start_date, end_date, budget]);
        
        res.json({
            success: true,
            project: result.rows[0]
        });
    } catch (error) {
        console.error('Create project error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to create project' 
        });
    }
});

// Update project (admin)
app.put('/api/projects/:id', authenticateToken, async (req, res) => {
    try {
        const projectId = req.params.id;
        const { name, description, status, start_date, end_date, budget } = req.body;
        
        const result = await pool.query(`
            UPDATE projects 
            SET name = $1, description = $2, status = $3, 
                start_date = $4, end_date = $5, budget = $6,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $7
            RETURNING *
        `, [name, description, status, start_date, end_date, budget, projectId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Project not found' 
            });
        }
        
        res.json({
            success: true,
            project: result.rows[0]
        });
    } catch (error) {
        console.error('Update project error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to update project' 
        });
    }
});

// Create milestone (admin)
app.post('/api/projects/:projectId/milestones', authenticateToken, async (req, res) => {
    try {
        const projectId = req.params.projectId;
        const { name, description, due_date, status, completion_percentage } = req.body;
        
        const result = await pool.query(`
            INSERT INTO project_milestones (project_id, name, description, due_date, status, completion_percentage)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [projectId, name, description, due_date, status || 'pending', completion_percentage || 0]);
        
        res.json({
            success: true,
            milestone: result.rows[0]
        });
    } catch (error) {
        console.error('Create milestone error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to create milestone' 
        });
    }
});

// Update milestone (admin)
app.put('/api/milestones/:id', authenticateToken, async (req, res) => {
    try {
        const milestoneId = req.params.id;
        const { name, description, due_date, status, completion_percentage } = req.body;
        
        const result = await pool.query(`
            UPDATE project_milestones 
            SET name = $1, description = $2, due_date = $3, 
                status = $4, completion_percentage = $5,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $6
            RETURNING *
        `, [name, description, due_date, status, completion_percentage, milestoneId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Milestone not found' 
            });
        }
        
        res.json({
            success: true,
            milestone: result.rows[0]
        });
    } catch (error) {
        console.error('Update milestone error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to update milestone' 
        });
    }
});

// Delete milestone (admin)
app.delete('/api/milestones/:id', authenticateToken, async (req, res) => {
    try {
        const milestoneId = req.params.id;
        
        const result = await pool.query(
            'DELETE FROM project_milestones WHERE id = $1 RETURNING *',
            [milestoneId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Milestone not found' 
            });
        }
        
        res.json({
            success: true,
            message: 'Milestone deleted successfully'
        });
    } catch (error) {
        console.error('Delete milestone error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to delete milestone' 
        });
    }
});

// Get milestones for a project (admin)
app.get('/api/projects/:projectId/milestones', authenticateToken, async (req, res) => {
    try {
        const projectId = req.params.projectId;
        
        const result = await pool.query(`
            SELECT * FROM project_milestones
            WHERE project_id = $1
            ORDER BY order_index ASC, due_date ASC
        `, [projectId]);
        
        res.json({
            success: true,
            milestones: result.rows
        });
    } catch (error) {
        console.error('Get project milestones error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load milestones' 
        });
    }
});

// Find your existing file upload endpoint and update it:

// Get client's uploaded files
app.get('/api/client/files', authenticateClient, async (req, res) => {
    try {
        const clientId = req.user.id;
        
        console.log('[CLIENT FILES] Getting files for client:', clientId);
        
        const result = await pool.query(`
            SELECT 
                id,
                original_filename as filename,
                original_filename,
                file_size,
                mime_type,
                created_at
            FROM documents
            WHERE lead_id = $1
            ORDER BY created_at DESC
        `, [clientId]);
        
        console.log('[CLIENT FILES] Found', result.rows.length, 'files');
        
        res.json({
            success: true,
            files: result.rows
        });
    } catch (error) {
        console.error('[CLIENT FILES] Get error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load files'
        });
    }
});

app.post('/api/client/files/upload', authenticateClient, upload.single('file'), async (req, res) => {
    try {
        const clientId = req.user.id;
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ 
                success: false, 
                message: 'No file uploaded' 
            });
        }
        
        console.log('[CLIENT UPLOAD] File received:', file.originalname, 'Size:', file.size);
        
        // IMPORTANT: Set proper file permissions
        const fs = require('fs');
        const filePath = file.path;
        
        try {
            // Make file readable by everyone (but only writable by owner)
            fs.chmodSync(filePath, 0o644);
            console.log('[CLIENT UPLOAD] File permissions set successfully');
        } catch (permError) {
            console.error('[CLIENT UPLOAD] Permission error:', permError);
        }
        
        // Store in documents table with proper access control
        const result = await pool.query(`
            INSERT INTO documents (
                lead_id, 
                filename, 
                original_filename, 
                file_path, 
                file_size, 
                mime_type, 
                document_type,
                uploaded_by,
                created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, CURRENT_TIMESTAMP)
            RETURNING *
        `, [
            clientId,
            file.filename,
            file.originalname,
            file.path,
            file.size,
            file.mimetype,
            'client_upload'
        ]);
        
        console.log('[CLIENT UPLOAD] Document saved to database, ID:', result.rows[0].id);
        
        res.json({
            success: true,
            message: 'File uploaded successfully',
            file: {
                id: result.rows[0].id,
                filename: result.rows[0].original_filename,
                size: result.rows[0].file_size
            }
        });
    } catch (error) {
        console.error('[CLIENT UPLOAD] Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to upload file',
            error: error.message
        });
    }
});

// Download file - works for both admin and client
app.get('/api/files/:fileId/download', async (req, res) => {
    try {
        const fileId = req.params.fileId;
        const authHeader = req.headers.authorization;
        
        console.log('[FILE DOWNLOAD] Request for file ID:', fileId);
        
        if (!authHeader) {
            return res.status(401).json({ 
                success: false, 
                message: 'No authorization token provided' 
            });
        }
        
        const token = authHeader.replace('Bearer ', '');
        let userId = null;
        let userType = null;
        
        // Try to decode as admin token
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userId = decoded.id;
            userType = 'admin';
            console.log('[FILE DOWNLOAD] Admin user:', userId);
        } catch (adminErr) {
            // Try as client token
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                userId = decoded.id;
                userType = 'client';
                console.log('[FILE DOWNLOAD] Client user:', userId);
            } catch (clientErr) {
                return res.status(401).json({ 
                    success: false, 
                    message: 'Invalid token' 
                });
            }
        }
        
        // Get file info from documents table
        const result = await pool.query(
            'SELECT * FROM documents WHERE id = $1',
            [fileId]
        );
        
        if (result.rows.length === 0) {
            console.log('[FILE DOWNLOAD] File not found in database');
            return res.status(404).json({ 
                success: false, 
                message: 'File not found' 
            });
        }
        
        const file = result.rows[0];
        
        // Check access permissions
        // Admin can access all files
        // Client can only access their own files
        if (userType === 'client' && file.lead_id !== userId) {
            console.log('[FILE DOWNLOAD] Access denied - file belongs to different client');
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied' 
            });
        }
        
        console.log('[FILE DOWNLOAD] Access granted, file path:', file.file_path);
        
        // Check if file exists on disk
        const fs = require('fs');
        if (!fs.existsSync(file.file_path)) {
            console.log('[FILE DOWNLOAD] File not found on disk:', file.file_path);
            return res.status(404).json({ 
                success: false, 
                message: 'File not found on disk' 
            });
        }
        
        // Set proper headers
        res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${file.original_filename}"`);
        res.setHeader('Content-Length', file.file_size);
        
        // Stream the file
        const fileStream = fs.createReadStream(file.file_path);
        fileStream.on('error', (error) => {
            console.error('[FILE DOWNLOAD] Stream error:', error);
            if (!res.headersSent) {
                res.status(500).json({ 
                    success: false, 
                    message: 'Error streaming file' 
                });
            }
        });
        
        fileStream.pipe(res);
        console.log('[FILE DOWNLOAD] File streaming started');
        
    } catch (error) {
        console.error('[FILE DOWNLOAD] Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false, 
                message: 'Failed to download file',
                error: error.message
            });
        }
    }
});

// Also add a file view endpoint (for viewing in browser):
app.get('/api/files/:fileId/view', authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.fileId;
        
        const result = await pool.query(
            'SELECT * FROM files WHERE id = $1',
            [fileId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'File not found' 
            });
        }
        
        const file = result.rows[0];
        
        const fs = require('fs');
        if (!fs.existsSync(file.file_path)) {
            return res.status(404).json({ 
                success: false, 
                message: 'File not found on disk' 
            });
        }
        
        // For viewing, use inline disposition
        res.setHeader('Content-Type', file.mime_type);
        res.setHeader('Content-Disposition', `inline; filename="${file.original_filename}"`);
        
        const fileStream = fs.createReadStream(file.file_path);
        fileStream.pipe(res);
        
    } catch (error) {
        console.error('File view error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to view file' 
        });
    }
});

// Upload File
app.post('/api/client/upload', authenticateClient, upload.single('file'), async (req, res) => {
    try {
        const { projectId, description } = req.body;
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }
        
        const result = await pool.query(`
            INSERT INTO client_uploads (
                lead_id, 
                project_id, 
                filename, 
                filepath, 
                file_size, 
                mime_type, 
                description, 
                created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            RETURNING *
        `, [
            req.user.id,
            projectId || null,
            file.originalname,
            file.path,
            file.size,
            file.mimetype,
            description || null
        ]);
        
        res.json({
            success: true,
            message: 'File uploaded successfully',
            fileId: result.rows[0].id
        });
    } catch (error) {
        console.error('[ERROR] Upload failed:', error);
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// Get all client accounts
app.get('/api/admin/client-accounts', authenticateToken, async (req, res) => {
    try {
        const clients = await pool.query(`
            SELECT 
                l.id,
                l.name,
                l.email,
                l.company,
                l.created_at,
                l.client_last_login as last_login,
                CASE WHEN l.client_password IS NOT NULL THEN TRUE ELSE FALSE END as is_active
            FROM leads l
            WHERE l.is_customer = TRUE
            ORDER BY l.created_at DESC
        `);
        
        res.json({ success: true, clients: clients.rows });
    } catch (error) {
        console.error('Failed to load client accounts:', error);
        res.status(500).json({ success: false, message: 'Failed to load accounts' });
    }
});

// Create client account
app.post('/api/admin/client-accounts', authenticateToken, async (req, res) => {
    const { leadId, email, temporaryPassword, sendWelcomeEmail } = req.body;
    
    try {
        // First, check if the lead is actually a customer
        const leadCheck = await pool.query(
            'SELECT id, name, email, is_customer, client_password FROM leads WHERE id = $1',
            [leadId]
        );

        if (leadCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Lead not found.'
            });
        }

        const lead = leadCheck.rows[0];

        // CRITICAL: Only allow client portal creation for customers
        if (!lead.is_customer) {
            return res.status(403).json({
                success: false,
                message: 'Client portals can only be created for customers. Please convert this lead to a customer first before creating a portal account.'
            });
        }

        // Check if portal already exists
        if (lead.client_password) {
            return res.status(409).json({
                success: false,
                message: 'A client portal already exists for this customer. Use the reset password function to change credentials.'
            });
        }
        
        // Hash the password
        const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
        
        // Update the lead with client credentials
        await pool.query(`
            UPDATE leads 
            SET email = $1, 
                client_password = $2,
                client_account_created_at = CURRENT_TIMESTAMP
            WHERE id = $3
        `, [email, hashedPassword, leadId]);
        
        // Get updated lead details for email
        const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
        const updatedLead = leadResult.rows[0];
        
        // Send welcome email if requested
        if (sendWelcomeEmail && updatedLead) {
            await sendClientWelcomeEmail(updatedLead.email, updatedLead.name, temporaryPassword);
        }
        
        console.log(`✅ Client portal created for customer: ${updatedLead.name} (${updatedLead.email})`);
        
        res.json({ 
            success: true, 
            message: 'Client portal created successfully for customer.',
            credentials: {
                email: email,
                temporaryPassword: temporaryPassword
            }
        });
    } catch (error) {
        console.error('Failed to create client account:', error);
        res.status(500).json({ success: false, message: 'Failed to create account: ' + error.message });
    }
});

// Reset client password
app.post('/api/admin/client-accounts/:id/reset-password', authenticateToken, async (req, res) => {
    const { newPassword } = req.body;
    
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        await db.run(`
            UPDATE leads 
            SET client_password = ?,
                password_reset_required = 1
            WHERE id = ?
        `, [hashedPassword, req.params.id]);
        
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Failed to reset password:', error);
        res.status(500).json({ success: false, message: 'Failed to reset password' });
    }
});

// Toggle client account status
app.post('/api/admin/client-accounts/:id/toggle-status', authenticateToken, async (req, res) => {
    const { isActive } = req.body;
    
    try {
        if (isActive) {
            // Activate account (ensure they have a password)
            const lead = await db.get('SELECT client_password FROM leads WHERE id = ?', [req.params.id]);
            if (!lead.client_password) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Cannot activate - no password set' 
                });
            }
        } else {
            // Deactivate by clearing password (or add an is_active flag)
            await db.run('UPDATE leads SET client_password = NULL WHERE id = ?', [req.params.id]);
        }
        
        res.json({ success: true, message: 'Status updated successfully' });
    } catch (error) {
        console.error('Failed to toggle status:', error);
        res.status(500).json({ success: false, message: 'Failed to update status' });
    }
});

// Get all client uploads (admin view)
app.get('/api/admin/client-uploads', authenticateToken, async (req, res) => {
    const { clientId } = req.query;
    
    try {
        let query = `
            SELECT 
                cu.*,
                l.name as client_name,
                l.company as client_company
            FROM client_uploads cu
            JOIN leads l ON cu.lead_id = l.id
        `;
        
        const params = [];
        if (clientId) {
            query += ' WHERE cu.lead_id = $1';
            params.push(clientId);
        }
        
        query += ' ORDER BY cu.created_at DESC';
        
        const result = await pool.query(query, params);
        
        res.json({ success: true, uploads: result.rows });
    } catch (error) {
        console.error('Failed to load uploads:', error);
        res.status(500).json({ success: false, message: 'Failed to load uploads' });
    }
});

// Download client upload
app.get('/api/admin/client-uploads/:id/download', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM client_uploads WHERE id = $1', 
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'File not found' });
        }
        
        const upload = result.rows[0];
        res.download(upload.filepath, upload.filename);
    } catch (error) {
        console.error('Download failed:', error);
        res.status(500).json({ success: false, message: 'Download failed' });
    }
});

// Create project for client
app.post('/api/admin/projects', authenticateToken, async (req, res) => {
    const { leadId, projectName, description, startDate, endDate, status } = req.body;
    
    try {
        const result = await pool.query(`
            INSERT INTO client_projects (
                lead_id, 
                project_name, 
                description, 
                start_date, 
                end_date,
                status,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `, [leadId, projectName, description, startDate, endDate, status || 'in_progress']);
        
        res.json({ 
            success: true, 
            message: 'Project created successfully',
            projectId: result.lastID
        });
    } catch (error) {
        console.error('Failed to create project:', error);
        res.status(500).json({ success: false, message: 'Failed to create project' });
    }
});

// Get projects for a client (admin view)
app.get('/api/admin/client/:id/projects', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT cp.*,
                   (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id) as total_milestones,
                   (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id AND status = 'completed') as completed_milestones
            FROM client_projects cp
            WHERE cp.lead_id = $1
            ORDER BY cp.created_at DESC
        `, [req.params.id]);
        
        res.json({ success: true, projects: result.rows });
    } catch (error) {
        console.error('Failed to load projects:', error);
        res.status(500).json({ success: false, message: 'Failed to load projects' });
    }
});

// Add milestone to project
app.post('/api/admin/milestones', authenticateToken, async (req, res) => {
    const { projectId, title, description, dueDate, orderIndex, requiresApproval } = req.body;
    
    try {
        const result = await pool.query(`
            INSERT INTO project_milestones (
                project_id,
                title,
                description,
                due_date,
                order_index,
                approval_required,
                status,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
        `, [projectId, title, description, dueDate, orderIndex || 0, requiresApproval ? 1 : 0]);
        
        res.json({ 
            success: true, 
            message: 'Milestone created successfully',
            milestoneId: result.lastID
        });
    } catch (error) {
        console.error('Failed to create milestone:', error);
        res.status(500).json({ success: false, message: 'Failed to create milestone' });
    }
});

// Update milestone status
app.patch('/api/admin/milestones/:id', authenticateToken, async (req, res) => {
    const { status } = req.body;
    
    try {
        const updateData = { status };
        if (status === 'completed') {
            updateData.completed_at = 'datetime("now")';
        }
        
        await db.run(`
            UPDATE project_milestones 
            SET status = ?, 
                completed_at = ${status === 'completed' ? 'datetime("now")' : 'completed_at'}
            WHERE id = ?
        `, [status, req.params.id]);
        
        res.json({ success: true, message: 'Milestone updated successfully' });
    } catch (error) {
        console.error('Failed to update milestone:', error);
        res.status(500).json({ success: false, message: 'Failed to update milestone' });
    }
});

// Share file with client (make admin file visible to client)
app.post('/api/admin/files/share', authenticateToken, async (req, res) => {
    const { fileId, clientId } = req.body;
    
    try {
        // This assumes you have an admin files table
        // You'll need to either copy the file or create a reference
        await db.run(`
            INSERT INTO client_uploads (
                lead_id,
                filename,
                filepath,
                file_size,
                mime_type,
                description,
                shared_by_admin,
                created_at
            )
            SELECT 
                ? as lead_id,
                filename,
                filepath,
                file_size,
                mime_type,
                'Shared by admin' as description,
                1 as shared_by_admin,
                datetime('now') as created_at
            FROM admin_files
            WHERE id = ?
        `, [clientId, fileId]);
        
        res.json({ success: true, message: 'File shared with client' });
    } catch (error) {
        console.error('Failed to share file:', error);
        res.status(500).json({ success: false, message: 'Failed to share file' });
    }
});

// Project Milestones
app.get('/api/client/project/:id/milestones', authenticateClient, async (req, res) => {
    try {
        const projectResult = await pool.query(
            'SELECT * FROM client_projects WHERE id = $1 AND lead_id = $2',
            [req.params.id, req.user.id]
        );
        
        if (projectResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }
        
        const milestonesResult = await pool.query(
            'SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY order_index ASC',
            [req.params.id]
        );
        
        res.json({ success: true, milestones: milestonesResult.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to load milestones' });
    }
});

// Approve Milestone
app.post('/api/client/milestone/:id/approve', authenticateClient, async (req, res) => {
    const { feedback } = req.body;
    
    try {
        const milestoneResult = await pool.query(`
            SELECT pm.* FROM project_milestones pm
            JOIN client_projects cp ON pm.project_id = cp.id
            WHERE pm.id = $1 AND cp.lead_id = $2
        `, [req.params.id, req.user.id]);
        
        if (milestoneResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Milestone not found' });
        }
        
        await pool.query(`
            UPDATE project_milestones 
            SET status = 'approved', 
                client_feedback = $1, 
                approved_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `, [feedback || null, req.params.id]);
        
        res.json({ success: true, message: 'Milestone approved' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Approval failed' });
    }
});

console.log('[SYSTEM] Client portal routes loaded');

// Client Invoices
app.get('/api/client/invoices', authenticateClient, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM invoices WHERE lead_id = $1 ORDER BY created_at DESC',
            [req.user.id]
        );
        
        res.json({ success: true, invoices: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to load invoices' });
    }
});

// Submit Support Ticket
app.post('/api/client/support/ticket', authenticateClient, async (req, res) => {
    const { subject, message, priority, category } = req.body;
    
    try {
        // Get client info for the ticket
        const clientResult = await pool.query(
            'SELECT name, email, company FROM leads WHERE id = $1',
            [req.user.id]
        );
        
        const client = clientResult.rows[0] || {};
        
        const result = await pool.query(`
            INSERT INTO support_tickets (
                lead_id, 
                client_name,
                client_email,
                subject, 
                message, 
                priority, 
                category, 
                status, 
                created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', CURRENT_TIMESTAMP)
            RETURNING *
        `, [
            req.user.id, 
            client.name || 'Unknown',
            client.email || '',
            subject, 
            message, 
            priority || 'medium', 
            category || 'general'
        ]);
        
        res.json({
            success: true,
            message: 'Support ticket created',
            ticket: result.rows[0]
        });
    } catch (error) {
        console.error('[TICKET] Create error:', error);
        res.status(500).json({ success: false, message: 'Failed to create ticket' });
    }
});

// ==================== ADMIN TICKET ENDPOINTS ====================

// Get all tickets (admin)
app.get('/api/tickets', authenticateToken, async (req, res) => {
    try {
        const { status, priority } = req.query;
        
        let query = `
            SELECT 
                st.*,
                l.name as client_name,
                l.email as client_email,
                l.company,
                (SELECT COUNT(*) FROM ticket_responses WHERE ticket_id = st.id) as response_count,
                (SELECT MAX(created_at) FROM ticket_responses WHERE ticket_id = st.id) as last_response_at
            FROM support_tickets st
            LEFT JOIN leads l ON st.lead_id = l.id
            WHERE 1=1
        `;
        
        const params = [];
        let paramCount = 1;
        
        if (status) {
            query += ` AND st.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }
        
        if (priority) {
            query += ` AND st.priority = $${paramCount}`;
            params.push(priority);
            paramCount++;
        }
        
        query += ' ORDER BY st.created_at DESC';
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            tickets: result.rows
        });
    } catch (error) {
        console.error('[TICKETS] Get all error:', error);
        res.status(500).json({ success: false, message: 'Failed to load tickets' });
    }
});

// Get single ticket with responses (admin)
app.get('/api/tickets/:id', authenticateToken, async (req, res) => {
    try {
        const ticketId = req.params.id;
        
        const ticketResult = await pool.query(`
            SELECT 
                st.*,
                l.name as client_name,
                l.email as client_email,
                l.company
            FROM support_tickets st
            LEFT JOIN leads l ON st.lead_id = l.id
            WHERE st.id = $1
        `, [ticketId]);
        
        if (ticketResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        
        // Get responses
        const responsesResult = await pool.query(`
            SELECT * FROM ticket_responses 
            WHERE ticket_id = $1 
            ORDER BY created_at ASC
        `, [ticketId]);
        
        res.json({
            success: true,
            ticket: ticketResult.rows[0],
            responses: responsesResult.rows
        });
    } catch (error) {
        console.error('[TICKET] Get single error:', error);
        res.status(500).json({ success: false, message: 'Failed to load ticket' });
    }
});

// Get ticket responses (admin)
app.get('/api/tickets/:id/responses', authenticateToken, async (req, res) => {
    try {
        const ticketId = req.params.id;
        
        const result = await pool.query(`
            SELECT * FROM ticket_responses 
            WHERE ticket_id = $1 
            ORDER BY created_at ASC
        `, [ticketId]);
        
        res.json({
            success: true,
            responses: result.rows
        });
    } catch (error) {
        console.error('[TICKET] Get responses error:', error);
        res.status(500).json({ success: false, message: 'Failed to load responses' });
    }
});

// Add response to ticket (admin)
app.post('/api/tickets/:id/responses', authenticateToken, async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { message } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, message: 'Message is required' });
        }
        
        const result = await pool.query(`
            INSERT INTO ticket_responses (
                ticket_id,
                user_id,
                user_type,
                user_name,
                message,
                created_at
            )
            VALUES ($1, $2, 'admin', 'Admin', $3, CURRENT_TIMESTAMP)
            RETURNING *
        `, [ticketId, req.user.id, message.trim()]);
        
        // Update ticket's updated_at
        await pool.query(
            'UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [ticketId]
        );
        
        res.json({
            success: true,
            response: result.rows[0]
        });
    } catch (error) {
        console.error('[TICKET] Add response error:', error);
        res.status(500).json({ success: false, message: 'Failed to add response' });
    }
});

// Update ticket status (admin)
app.put('/api/tickets/:id/status', authenticateToken, async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { status } = req.body;
        
        const validStatuses = ['open', 'in-progress', 'resolved', 'closed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }
        
        await pool.query(
            'UPDATE support_tickets SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [status, ticketId]
        );
        
        res.json({
            success: true,
            message: 'Ticket status updated'
        });
    } catch (error) {
        console.error('[TICKET] Update status error:', error);
        res.status(500).json({ success: false, message: 'Failed to update status' });
    }
});

// Update ticket (admin)
app.put('/api/tickets/:id', authenticateToken, async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { status, priority, assigned_to } = req.body;
        
        const updates = [];
        const params = [];
        let paramCount = 1;
        
        if (status) {
            updates.push(`status = $${paramCount}`);
            params.push(status);
            paramCount++;
        }
        
        if (priority) {
            updates.push(`priority = $${paramCount}`);
            params.push(priority);
            paramCount++;
        }
        
        if (assigned_to !== undefined) {
            updates.push(`assigned_to = $${paramCount}`);
            params.push(assigned_to);
            paramCount++;
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'No updates provided' });
        }
        
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(ticketId);
        
        const query = `
            UPDATE support_tickets 
            SET ${updates.join(', ')}
            WHERE id = $${paramCount}
            RETURNING *
        `;
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            ticket: result.rows[0]
        });
    } catch (error) {
        console.error('[TICKET] Update error:', error);
        res.status(500).json({ success: false, message: 'Failed to update ticket' });
    }
});

// Delete ticket (admin)
app.delete('/api/tickets/:id', authenticateToken, async (req, res) => {
    try {
        const ticketId = req.params.id;
        
        // Delete responses first
        await pool.query('DELETE FROM ticket_responses WHERE ticket_id = $1', [ticketId]);
        
        // Delete ticket
        await pool.query('DELETE FROM support_tickets WHERE id = $1', [ticketId]);
        
        res.json({
            success: true,
            message: 'Ticket deleted'
        });
    } catch (error) {
        console.error('[TICKET] Delete error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete ticket' });
    }
});

// ==================== CLIENT TICKET ENDPOINTS ====================

// Get client's tickets
app.get('/api/client/tickets', authenticateClient, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                st.*,
                (SELECT COUNT(*) FROM ticket_responses WHERE ticket_id = st.id) as response_count,
                (SELECT MAX(created_at) FROM ticket_responses WHERE ticket_id = st.id) as last_response_at
            FROM support_tickets st
            WHERE st.lead_id = $1
            ORDER BY st.created_at DESC
        `, [req.user.id]);
        
        res.json({
            success: true,
            tickets: result.rows
        });
    } catch (error) {
        console.error('[CLIENT] Get tickets error:', error);
        res.status(500).json({ success: false, message: 'Failed to load tickets' });
    }
});

// Get single ticket with responses (client)
app.get('/api/client/tickets/:id', authenticateClient, async (req, res) => {
    try {
        const ticketId = req.params.id;
        
        const ticketResult = await pool.query(
            'SELECT * FROM support_tickets WHERE id = $1 AND lead_id = $2',
            [ticketId, req.user.id]
        );
        
        if (ticketResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        
        // Get responses
        const responsesResult = await pool.query(`
            SELECT * FROM ticket_responses 
            WHERE ticket_id = $1 
            ORDER BY created_at ASC
        `, [ticketId]);
        
        res.json({
            success: true,
            ticket: ticketResult.rows[0],
            responses: responsesResult.rows
        });
    } catch (error) {
        console.error('[CLIENT] Get ticket error:', error);
        res.status(500).json({ success: false, message: 'Failed to load ticket' });
    }
});

// Add response to ticket (client)
app.post('/api/client/tickets/:id/responses', authenticateClient, async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { message } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, message: 'Message is required' });
        }
        
        // Verify ticket belongs to client
        const ticketCheck = await pool.query(
            'SELECT id, lead_id FROM support_tickets WHERE id = $1 AND lead_id = $2',
            [ticketId, req.user.id]
        );
        
        if (ticketCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        
        // Get client name
        const clientResult = await pool.query(
            'SELECT name FROM leads WHERE id = $1',
            [req.user.id]
        );
        
        const clientName = clientResult.rows[0]?.name || 'Client';
        
        const result = await pool.query(`
            INSERT INTO ticket_responses (
                ticket_id,
                user_id,
                user_type,
                user_name,
                message,
                created_at
            )
            VALUES ($1, $2, 'client', $3, $4, CURRENT_TIMESTAMP)
            RETURNING *
        `, [ticketId, req.user.id, clientName, message.trim()]);
        
        // Update ticket's updated_at and potentially status
        await pool.query(`
            UPDATE support_tickets 
            SET updated_at = CURRENT_TIMESTAMP,
                status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END
            WHERE id = $1
        `, [ticketId]);
        
        res.json({
            success: true,
            response: result.rows[0]
        });
    } catch (error) {
        console.error('[CLIENT] Add response error:', error);
        res.status(500).json({ success: false, message: 'Failed to add response' });
    }
});

// Client Login
app.post('/api/client/login', async (req, res) => {
    const { email, password } = req.body;
    
    console.log('[CLIENT] Login attempt:', email);
    
    try {
        // Get client from database
        const result = await pool.query(
            'SELECT * FROM leads WHERE email = $1 AND is_customer = TRUE',
            [email]
        );
        
        console.log('[DATABASE] Query result:', {
            found: result.rows.length > 0,
            email: email
        });
        
        if (result.rows.length === 0) {
            console.log('[AUTH] No client found with email:', email);
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid email or password. Contact support if you need access.' 
            });
        }
        
        const lead = result.rows[0];
        
        // Check if client has a password set
        if (!lead.client_password) {
            console.log('[AUTH] Client exists but no password set for:', email);
            return res.status(401).json({ 
                success: false, 
                message: 'Your account is not activated. Please contact your project manager.' 
            });
        }
        
        // Verify password with bcrypt
        console.log('[AUTH] Verifying password for:', email);
        const passwordMatch = await bcrypt.compare(password, lead.client_password);
        
        if (!passwordMatch) {
            console.log('[AUTH] Password mismatch for:', email);
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid email or password.' 
            });
        }
        
        console.log('[AUTH] Password verified successfully for:', email);
        
        // Update last login timestamp
        await pool.query(
            'UPDATE leads SET client_last_login = CURRENT_TIMESTAMP WHERE id = $1',
            [lead.id]
        );
        
        // Generate JWT token
        const token = jwt.sign(
            { id: lead.id, email: lead.email, type: 'client' },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        console.log('[SUCCESS] Client login successful:', lead.name);
        
        res.json({
            success: true,
            token,
            client: {
                id: lead.id,
                name: lead.name,
                email: lead.email,
                company: lead.company
            }
        });
        
    } catch (error) {
        console.error('[ERROR] Client login error:', error);
        console.error('[ERROR] Stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during login. Please try again.' 
        });
    }
});

// ==================== AUTHENTICATION MIDDLEWARE ====================

function authenticateClient(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        console.log('[AUTH] No token provided');
        return res.status(401).json({ 
            success: false, 
            message: 'Access denied. Please log in.' 
        });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (decoded.type !== 'client') {
            console.log('[AUTH] Invalid token type:', decoded.type);
            return res.status(403).json({ 
                success: false, 
                message: 'Invalid access token.' 
            });
        }
        
        req.user = decoded;
        console.log('[AUTH] Client authenticated:', decoded.email);
        next();
        
    } catch (error) {
        console.error('[AUTH] Token verification failed:', error.message);
        return res.status(401).json({ 
            success: false, 
            message: 'Session expired. Please log in again.' 
        });
    }
}

// Mark a lead as contacted (updates last_contact_date)
// ========================================
// LEAD TEMPERATURE & ENGAGEMENT TRACKING
// ========================================

// Function to calculate next follow-up date based on temperature
function calculateNextFollowUpDate(lastContactDate, leadTemperature) {
    if (!lastContactDate) {
        return new Date(); // If never contacted, follow up immediately
    }
    
    const last = new Date(lastContactDate);
    const daysSinceContact = Math.floor((new Date() - last) / (1000 * 60 * 60 * 24));
    
    if (leadTemperature === 'hot') {
        // Hot leads: Fixed 3.5 day intervals (twice per week)
        return new Date(last.getTime() + 3.5 * 24 * 60 * 60 * 1000);
    } else {
        // Cold leads: Days 0, 3, 7, then weekly
        if (daysSinceContact === 0) return new Date(last.getTime() + 3 * 24 * 60 * 60 * 1000); // Day 3
        if (daysSinceContact === 3) return new Date(last.getTime() + 7 * 24 * 60 * 60 * 1000); // Day 7
        // After day 7: weekly
        return new Date(last.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
}

// Function to add engagement event to lead
async function trackEngagement(leadId, engagementType, details = '') {
    try {
        console.log(`\n========================================`);
        console.log(`[ENGAGEMENT] 🔍 TRACKING ENGAGEMENT`);
        console.log(`[ENGAGEMENT] Lead ID: ${leadId}`);
        console.log(`[ENGAGEMENT] Type: ${engagementType}`);
        console.log(`[ENGAGEMENT] Details: ${details}`);
        console.log(`========================================\n`);
        
        const engagementEvent = {
            type: engagementType, // 'form_fill', 'email_click', 'email_reply', 'website_visit'
            details: details,
            timestamp: new Date().toISOString()
        };
        
        // Get current engagement history
        const leadResult = await pool.query(
            'SELECT id, name, email, engagement_history, engagement_score, lead_temperature, follow_up_count, last_contact_date FROM leads WHERE id = $1',
            [leadId]
        );
        
        if (leadResult.rows.length === 0) {
            console.log(`[ENGAGEMENT] ❌ ERROR: Lead ${leadId} not found!`);
            return;
        }
        
        console.log(`[ENGAGEMENT] 📊 CURRENT STATE:`, {
            name: leadResult.rows[0].name,
            email: leadResult.rows[0].email,
            temperature: leadResult.rows[0].lead_temperature,
            score: leadResult.rows[0].engagement_score,
            followUpCount: leadResult.rows[0].follow_up_count,
            lastContactDate: leadResult.rows[0].last_contact_date
        });
        
        const lead = leadResult.rows[0];
        let history = lead.engagement_history || [];
        let score = lead.engagement_score || 0;
        
        // Add new event to history
        history.push(engagementEvent);
        
        // Update engagement score based on type
        const scoreMap = {
            'form_fill': 30,
            'email_click': 10,
            'email_reply': 25,
            'website_visit': 15,
            'email_open': 5
        };
        score += scoreMap[engagementType] || 5;
        
        console.log(`[ENGAGEMENT] 💯 NEW SCORE: ${score} (added ${scoreMap[engagementType] || 5} points for ${engagementType})`);
        
        // CRITICAL FIX: Leads should ONLY become hot through:
        // 1. Accumulating 20+ engagement points naturally
        // 2. Filling out a form (form_fill)
        // 3. Replying to an email (email_reply)
        // 
        // Email opens (5pts each) and link clicks (10pts each) should NOT instantly make leads hot
        // They need to accumulate points OR do a meaningful action
        const shouldBeHot = lead.lead_temperature === 'hot' || score >= 20 || engagementType === 'form_fill' || engagementType === 'email_reply';
        const newTemperature = shouldBeHot ? 'hot' : 'cold';
        
        console.log(`[ENGAGEMENT] 🌡️  TEMPERATURE DECISION:`);
        console.log(`   - Current: ${lead.lead_temperature || 'null'}`);
        console.log(`   - New: ${newTemperature}`);
        console.log(`   - Should be hot? ${shouldBeHot}`);
        console.log(`   - Reasons: score >= 20? ${score >= 20}, form_fill? ${engagementType === 'form_fill'}, email_reply? ${engagementType === 'email_reply'}`);
        console.log(`   - Note: email_click and email_open do NOT instantly make leads hot - they accumulate points`);
        
        // If lead just became hot (cold -> hot transition)
        if (newTemperature === 'hot' && lead.lead_temperature !== 'hot') {
            console.log(`[ENGAGEMENT] 🔥 Lead ${leadId} became HOT! Cancelling auto-campaigns...`);
            
            // Cancel any active auto-campaigns for this lead
            await pool.query(
                `UPDATE auto_campaigns 
                 SET is_active = FALSE, 
                     stopped_at = CURRENT_TIMESTAMP,
                     stop_reason = 'Lead became hot - engagement detected'
                 WHERE lead_id = $1 AND is_active = TRUE`,
                [leadId]
            );
            
            // CRITICAL FIX: For email_open/email_click, do NOT reset follow-up tracking
            // The tracking pixel endpoint already handled advancing the lead
            // Only reset for form_fill or other non-email engagements
            if (engagementType === 'email_open' || engagementType === 'email_click') {
                // Just update temperature and engagement data, preserve follow-up tracking
                await pool.query(
                    `UPDATE leads 
                     SET engagement_history = $1,
                         engagement_score = $2,
                         lead_temperature = $3,
                         became_hot_at = CURRENT_TIMESTAMP,
                         last_engagement_at = CURRENT_TIMESTAMP
                     WHERE id = $4`,
                    [JSON.stringify(history), score, newTemperature, leadId]
                );
                console.log(`[ENGAGEMENT] ✅ Lead ${leadId} became HOT via ${engagementType} - follow-up tracking preserved`);
            } else {
                // For form fills etc, reset timeline so they show up immediately
                await pool.query(
                    `UPDATE leads 
                     SET engagement_history = $1,
                         engagement_score = $2,
                         lead_temperature = $3,
                         became_hot_at = CURRENT_TIMESTAMP,
                         last_engagement_at = CURRENT_TIMESTAMP,
                         last_contact_date = NULL,
                         follow_up_count = 0
                     WHERE id = $4`,
                    [JSON.stringify(history), score, newTemperature, leadId]
                );
                console.log(`[ENGAGEMENT] ✅ Lead ${leadId} became HOT via ${engagementType} - timeline reset to show immediately`);
            }
        } else {
            // Normal update (not becoming hot)
            // For hot leads, only reset timeline if they've NEVER been contacted before
            // Once contacted, they stay in the normal hot lead follow-up cycle
            if (newTemperature === 'hot') {
                // Check if this hot lead has been contacted before
                if (lead.follow_up_count === 0 || lead.last_contact_date === null) {
                    // Never contacted - reset timeline to show them immediately
                    await pool.query(
                        `UPDATE leads 
                         SET engagement_history = $1,
                             engagement_score = $2,
                             lead_temperature = $3,
                             became_hot_at = COALESCE(became_hot_at, CURRENT_TIMESTAMP),
                             last_engagement_at = CURRENT_TIMESTAMP,
                             last_contact_date = NULL,
                             follow_up_count = 0
                         WHERE id = $4`,
                        [JSON.stringify(history), score, newTemperature, leadId]
                    );
                    console.log(`[ENGAGEMENT] 🔥 Hot lead ${leadId} engaged (never contacted) - showing in queue`);
                } else {
                    // Already contacted - DO NOT reset timeline
                    // Just update engagement data, keep their follow-up schedule intact
                    await pool.query(
                        `UPDATE leads 
                         SET engagement_history = $1,
                             engagement_score = $2,
                             lead_temperature = $3,
                             became_hot_at = COALESCE(became_hot_at, CURRENT_TIMESTAMP),
                             last_engagement_at = CURRENT_TIMESTAMP
                         WHERE id = $4`,
                        [JSON.stringify(history), score, newTemperature, leadId]
                    );
                    console.log(`[ENGAGEMENT] 🔥 Hot lead ${leadId} engaged (already contacted) - maintaining follow-up schedule`);
                }
            } else {
                // Cold lead - standard update
                await pool.query(
                    `UPDATE leads 
                     SET engagement_history = $1,
                         engagement_score = $2,
                         lead_temperature = $3,
                         last_engagement_at = CURRENT_TIMESTAMP
                     WHERE id = $4`,
                    [JSON.stringify(history), score, newTemperature, leadId]
                );
            }
        }
        
        console.log(`[ENGAGEMENT] ✅ Tracked ${engagementType} for lead ${leadId}`);
        console.log(`[ENGAGEMENT] 📊 FINAL STATE: Score: ${score} | Temp: ${newTemperature}`);
        console.log(`========================================\n`);
        
        return { success: true, temperature: newTemperature, score };
    } catch (error) {
        console.error('[ENGAGEMENT] Error tracking engagement:', error);
        return { success: false };
    }
}

// Function removed - hot leads stay hot forever
// Once a lead becomes hot through any engagement, they remain hot permanently

// Run the stale lead check every 6 hours - DISABLED since hot leads stay hot forever
// setInterval(checkAndDemoteStaleHotLeads, 6 * 60 * 60 * 1000);

// Track email link clicks
app.get('/api/track/click/:leadId', async (req, res) => {
    try {
        const leadId = req.params.leadId;
        const { url } = req.query;
        
        console.log(`\n========================================`);
        console.log(`[TRACKING] 🖱️  LINK CLICKED!`);
        console.log(`[TRACKING] Lead ID: ${leadId}`);
        console.log(`[TRACKING] URL: ${url}`);
        console.log(`========================================\n`);
        
        // Track the click engagement - this makes them hot
        const trackResult = await trackEngagement(leadId, 'email_click', `Clicked link: ${url || 'unknown'}`);
        console.log(`[TRACKING] Track result:`, trackResult);
        
        console.log(`[TRACKING] ✅ Lead ${leadId} engagement tracked, redirecting to: ${url || BASE_URL}\n`);
        
        // Redirect to the actual URL
        const redirectUrl = url || BASE_URL;
        res.redirect(redirectUrl);
    } catch (error) {
        console.error('[TRACKING] Error tracking click:', error);
        res.redirect(BASE_URL);
    }
});

// ========================================
// FOLLOW-UP SYSTEM ROUTES
// ========================================

// Mark a lead as contacted (updates last_contact_date)
app.post('/api/leads/:id/contacted', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        
        console.log(`[FOLLOW-UP] Marking lead ${leadId} as contacted`);
        
        const result = await pool.query(
            `UPDATE leads 
             SET last_contact_date = CURRENT_DATE,
                 follow_up_count = COALESCE(follow_up_count, 0) + 1,
                 status = CASE 
                     WHEN status = 'new' THEN 'contacted'
                     ELSE status
                 END,
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1
             RETURNING *`,
            [leadId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }
        
        console.log(`[FOLLOW-UP] ✅ Lead ${leadId} marked as contacted (follow-up count: ${result.rows[0].follow_up_count})`);
        
        res.json({
            success: true,
            message: 'Lead marked as contacted successfully',
            lead: result.rows[0]
        });
    } catch (error) {
        console.error('[FOLLOW-UP] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating lead',
            error: error.message
        });
    }
});

// Reset all COLD leads back to "Never Contacted" state
app.post('/api/admin/reset-cold-leads', authenticateToken, async (req, res) => {
    try {
        console.log('[ADMIN] Resetting all COLD leads to "Never Contacted" state...');
        
        // Reset ONLY cold leads (not hot, not dead/closed)
        const result = await pool.query(
            `UPDATE leads 
             SET follow_up_count = 0,
                 last_contact_date = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE is_customer = FALSE
             AND COALESCE(lead_temperature, 'cold') != 'hot'
             AND status NOT IN ('dead', 'closed', 'lost')
             RETURNING id, name, email`,
            []
        );
        
        console.log(`[ADMIN] ✅ Reset ${result.rows.length} cold leads to "Never Contacted"`);
        
        res.json({
            success: true,
            message: `Successfully reset ${result.rows.length} cold leads`,
            count: result.rows.length,
            leads: result.rows
        });
    } catch (error) {
        console.error('[ADMIN] Error resetting cold leads:', error);
        res.status(500).json({
            success: false,
            message: 'Error resetting cold leads',
            error: error.message
        });
    }
});

// Reset ALL leads (hot + cold) to "Never Contacted" - DESTRUCTIVE ACTION
app.post('/api/admin/reset-all-leads', authenticateToken, async (req, res) => {
    try {
        console.log('[ADMIN] 🚨 RESETTING ALL LEADS (HOT + COLD) TO "NEVER CONTACTED" STATE 🚨');
        
        // First, count how many hot leads will be affected
        const hotCountResult = await pool.query(
            `SELECT COUNT(*) as hot_count
             FROM leads 
             WHERE is_customer = FALSE
             AND lead_temperature = 'hot'
             AND status NOT IN ('dead', 'closed', 'lost')`,
            []
        );
        
        const hotCount = parseInt(hotCountResult.rows[0].hot_count);
        
        // Get list of lead IDs that will be reset
        const leadIdsResult = await pool.query(
            `SELECT id FROM leads 
             WHERE is_customer = FALSE
             AND status NOT IN ('dead', 'closed', 'lost')`,
            []
        );
        
        const leadIds = leadIdsResult.rows.map(r => r.id);
        
        // DELETE all email_log entries for these leads (so analytics reset too)
        if (leadIds.length > 0) {
            const deleteResult = await pool.query(
                `DELETE FROM email_log WHERE lead_id = ANY($1::int[])`,
                [leadIds]
            );
            console.log(`[ADMIN] 🗑️  Deleted ${deleteResult.rowCount} email_log records`);
        }
        
        // Reset ALL leads (hot + cold) but NOT dead/closed leads
        const result = await pool.query(
            `UPDATE leads 
             SET follow_up_count = 0,
                 last_contact_date = NULL,
                 lead_temperature = 'cold',
                 became_hot_at = NULL,
                 engagement_score = 0,
                 engagement_history = '[]'::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE is_customer = FALSE
             AND status NOT IN ('dead', 'closed', 'lost')
             RETURNING id, name, email, lead_temperature`,
            []
        );
        
        console.log(`[ADMIN] ✅ Reset ${result.rows.length} leads to "Never Contacted" (including ${hotCount} hot leads)`);
        console.log(`[ADMIN] ✅ Cleared all engagement scores and email history`);
        
        res.json({
            success: true,
            message: `Successfully reset ${result.rows.length} leads (including ${hotCount} hot leads) and cleared all email analytics`,
            count: result.rows.length,
            hotCount: hotCount,
            emailsDeleted: leadIds.length > 0 ? true : false,
            leads: result.rows
        });
    } catch (error) {
        console.error('[ADMIN] Error resetting all leads:', error);
        res.status(500).json({
            success: false,
            message: 'Error resetting all leads',
            error: error.message
        });
    }
});

// Get follow-up statistics
app.get('/api/follow-ups/stats', authenticateToken, async (req, res) => {
    try {
        console.log('[FOLLOW-UP STATS] Getting statistics');
        
        const stats = await pool.query(`
            SELECT 
                COUNT(*) FILTER (
                    WHERE last_contact_date IS NULL 
                    OR last_contact_date <= CURRENT_DATE - INTERVAL '3 days'
                ) as pending_followups,
                COUNT(*) FILTER (
                    WHERE last_contact_date IS NULL
                ) as never_contacted,
                COUNT(*) FILTER (
                    WHERE last_contact_date <= CURRENT_DATE - INTERVAL '7 days'
                    AND last_contact_date IS NOT NULL
                ) as overdue_followups,
                COUNT(*) FILTER (
                    WHERE last_contact_date >= CURRENT_DATE - INTERVAL '3 days'
                ) as recently_contacted
            FROM leads
            WHERE status IN ('new', 'contacted', 'qualified', 'pending')
            AND is_customer = FALSE
            AND unsubscribed = FALSE
        `);
        
        console.log('[FOLLOW-UP STATS] ✅ Stats retrieved:', stats.rows[0]);
        
        res.json({
            success: true,
            stats: stats.rows[0]
        });
    } catch (error) {
        console.error('[FOLLOW-UP STATS] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching stats'
        });
    }
});

// Get leads needing follow-up
app.get('/api/follow-ups', authenticateToken, async (req, res) => {
    try {
        console.log('[FOLLOW-UPS] Getting leads needing follow-up');
        
        const query = `
            SELECT 
                l.*,
                CASE 
                    WHEN l.last_contact_date IS NULL THEN 0
                    WHEN (CURRENT_DATE - l.last_contact_date) >= 15 THEN 6
                    WHEN (CURRENT_DATE - l.last_contact_date) >= 10 THEN 5
                    WHEN (CURRENT_DATE - l.last_contact_date) >= 8 THEN 4
                    WHEN (CURRENT_DATE - l.last_contact_date) >= 7 THEN 3
                    WHEN (CURRENT_DATE - l.last_contact_date) >= 3 THEN 2
                    WHEN (CURRENT_DATE - l.last_contact_date) >= 1 THEN 1
                    ELSE 0
                END as follow_up_step,
                COALESCE(CURRENT_DATE - l.last_contact_date, 0) as days_since_contact
            FROM leads l
            WHERE l.status IN ('new', 'contacted', 'qualified', 'pending')
            AND l.is_customer = FALSE
            AND l.unsubscribed = FALSE
            AND (
                l.last_contact_date IS NULL
                OR l.last_contact_date <= CURRENT_DATE - INTERVAL '3 days'
            )
            ORDER BY 
                CASE 
                    WHEN l.last_contact_date IS NULL THEN 999999
                    ELSE (CURRENT_DATE - l.last_contact_date)
                END DESC
        `;
        
        const result = await pool.query(query);
        
        console.log(`[FOLLOW-UPS] ✅ Found ${result.rows.length} leads needing follow-up`);
        
        res.json({
            success: true,
            leads: result.rows
        });
    } catch (error) {
        console.error('[FOLLOW-UPS] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching follow-ups',
            error: error.message
        });
    }
});

// TEST ENDPOINT - NO AUTH REQUIRED FOR TESTING
app.get('/api/follow-ups/test', authenticateToken, async (req, res) => {
    try {
        console.log('[TEST] ============================================');
        console.log('[TEST] Follow-up system diagnostic started');
        console.log('[TEST] ============================================');
        
        const results = {
            timestamp: new Date().toISOString(),
            tests: {}
        };
        
        // Test 1: Database connection
        try {
            const dbTest = await pool.query('SELECT NOW() as time, version() as pg_version');
            results.tests.database = {
                status: 'PASS',
                message: 'Database connected successfully',
                time: dbTest.rows[0].time,
                version: dbTest.rows[0].pg_version
            };
            console.log('[TEST] ✅ Database connected');
        } catch (error) {
            results.tests.database = {
                status: 'FAIL',
                error: error.message
            };
            console.log('[TEST] ❌ Database connection failed');
        }
        
        // Test 2: Check leads table schema
        try {
            const schemaCheck = await pool.query(`
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_name = 'leads'
                AND column_name IN ('last_contact_date', 'follow_up_step')
                ORDER BY column_name
            `);
            
            results.tests.schema = {
                status: schemaCheck.rows.length >= 1 ? 'PASS' : 'FAIL',
                columns: schemaCheck.rows,
                message: schemaCheck.rows.length >= 1 
                    ? 'Required columns exist' 
                    : 'Missing required columns'
            };
            console.log('[TEST] ✅ Schema check complete');
        } catch (error) {
            results.tests.schema = {
                status: 'FAIL',
                error: error.message
            };
            console.log('[TEST] ❌ Schema check failed');
        }
        
        // Test 3: Count leads
        try {
            const leadData = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE is_customer = FALSE) as active_leads,
                    COUNT(*) FILTER (WHERE last_contact_date IS NOT NULL) as with_contact_date,
                    COUNT(*) FILTER (WHERE last_contact_date IS NULL) as without_contact_date
                FROM leads
            `);
            
            results.tests.data = {
                status: 'PASS',
                stats: leadData.rows[0]
            };
            console.log('[TEST] ✅ Lead data retrieved');
        } catch (error) {
            results.tests.data = {
                status: 'FAIL',
                error: error.message
            };
            console.log('[TEST] ❌ Lead data failed');
        }
        
        // Test 4: Test follow-up query
        try {
            const followUps = await pool.query(`
                SELECT 
                    id,
                    name,
                    email,
                    status,
                    last_contact_date,
                    CURRENT_DATE - last_contact_date as days_since_contact
                FROM leads
                WHERE status IN ('new', 'contacted', 'qualified', 'pending')
                AND is_customer = FALSE
                AND (
                    last_contact_date IS NULL
                    OR last_contact_date <= CURRENT_DATE - INTERVAL '3 days'
                )
                LIMIT 5
            `);
            
            results.tests.query = {
                status: 'PASS',
                message: `Found ${followUps.rows.length} leads needing follow-up`,
                sample: followUps.rows
            };
            console.log('[TEST] ✅ Follow-up query successful');
        } catch (error) {
            results.tests.query = {
                status: 'FAIL',
                error: error.message
            };
            console.log('[TEST] ❌ Follow-up query failed');
        }
        
        // Test 5: Stats query
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (
                        WHERE last_contact_date IS NULL 
                        OR last_contact_date <= CURRENT_DATE - INTERVAL '3 days'
                    ) as pending_followups,
                    COUNT(*) FILTER (
                        WHERE last_contact_date IS NULL
                    ) as never_contacted
                FROM leads
                WHERE status IN ('new', 'contacted', 'qualified', 'pending')
                AND is_customer = FALSE
            `);
            
            results.tests.stats = {
                status: 'PASS',
                data: stats.rows[0]
            };
            console.log('[TEST] ✅ Stats query successful');
        } catch (error) {
            results.tests.stats = {
                status: 'FAIL',
                error: error.message
            };
            console.log('[TEST] ❌ Stats query failed');
        }
        
        console.log('[TEST] ============================================');
        console.log('[TEST] Follow-up system diagnostic complete');
        console.log('[TEST] ============================================');
        
        res.json({
            success: true,
            message: 'Follow-up system diagnostic complete',
            results: results
        });
        
    } catch (error) {
        console.error('[TEST] ❌ Test failed:', error);
        res.status(500).json({
            success: false,
            message: 'Test failed',
            error: error.message,
            stack: error.stack
        });
    }
});

console.log('[SERVER] ✅ Follow-up routes registered');

// Get payment link for client invoice (CLIENT AUTH)
app.get('/api/client/invoice/:id/payment-link', authenticateClient, async (req, res) => {
    try {
        const invoiceId = req.params.id;
        const clientId = req.user.id;
        
        console.log(`[PAYMENT] Client ${clientId} requesting payment link for invoice ${invoiceId}`);
        
        // Verify invoice belongs to this client
        const invoiceResult = await pool.query(`
            SELECT i.*, l.name, l.email, l.company,
                   l.address_line1, l.address_line2, l.city, l.state, l.zip_code, l.country
            FROM invoices i
            LEFT JOIN leads l ON i.lead_id = l.id
            WHERE i.id = $1 AND i.lead_id = $2
        `, [invoiceId, clientId]);
        
        if (invoiceResult.rows.length === 0) {
            console.log(`[PAYMENT] Invoice ${invoiceId} not found for client ${clientId}`);
            return res.status(404).json({ 
                success: false, 
                message: 'Invoice not found' 
            });
        }
        
        const invoice = invoiceResult.rows[0];
        
        // If already paid, return message
        if (invoice.status === 'paid') {
            console.log(`[PAYMENT] Invoice ${invoice.invoice_number} already paid`);
            return res.json({
                success: true,
                message: 'Invoice already paid',
                isPaid: true
            });
        }
        
        // If payment link exists, return it
        if (invoice.stripe_payment_link) {
            console.log(`[PAYMENT] Returning existing payment link for ${invoice.invoice_number}`);
            return res.json({
                success: true,
                paymentLink: invoice.stripe_payment_link
            });
        }
        
        // Otherwise, create payment link
        console.log(`[PAYMENT] Creating new Stripe payment link for ${invoice.invoice_number}`);
        
        const description = invoice.short_description || `Invoice ${invoice.invoice_number}`;
        
        // Create Stripe Price
        const price = await stripe.prices.create({
            unit_amount: Math.round(parseFloat(invoice.total_amount) * 100),
            currency: 'usd',
            product_data: {
                name: `Invoice ${invoice.invoice_number} — ${description}`,
                metadata: {
                    invoice_id: invoiceId.toString(),
                    invoice_number: invoice.invoice_number
                }
            },
        });
        
        console.log(`[PAYMENT] Stripe price created: ${price.id}`);
        
        // Determine redirect URL (handle both dev and production)
        const hostname = req.get('host');
        const protocol = req.protocol;
        let redirectUrl;
        
        if (hostname.includes('localhost')) {
            redirectUrl = `${protocol}://${hostname}/client_portal.html?payment=success&invoice=${invoiceId}`;
        } else {
            redirectUrl = `https://${hostname}/client_portal.html?payment=success&invoice=${invoiceId}`;
        }
        
        console.log(`[PAYMENT] Redirect URL: ${redirectUrl}`);
        
        // Create Payment Link
        const paymentLink = await stripe.paymentLinks.create({
            line_items: [{
                price: price.id,
                quantity: 1,
            }],
            after_completion: {
                type: 'redirect',
                redirect: {
                    url: redirectUrl
                }
            },
            metadata: {
                invoice_id: invoiceId.toString(),
                invoice_number: invoice.invoice_number,
                customer_name: invoice.name || '',
                customer_email: invoice.email || '',
                source: 'client_portal'
            },
            customer_creation: 'always',
            invoice_creation: {
                enabled: true,
                invoice_data: {
                    description: `Invoice ${invoice.invoice_number} - ${description}`,
                    metadata: {
                        invoice_id: invoiceId.toString(),
                        invoice_number: invoice.invoice_number
                    },
                    footer: 'Thank you for your business!'
                }
            },
            phone_number_collection: {
                enabled: true
            },
            billing_address_collection: 'auto'
        });
        
        console.log(`[PAYMENT] Payment link created: ${paymentLink.url}`);
        
        // Save payment link to database
        await pool.query(
            'UPDATE invoices SET stripe_payment_link = $1 WHERE id = $2',
            [paymentLink.url, invoiceId]
        );
        
        console.log(`[PAYMENT] Payment link saved to database`);
        
        res.json({
            success: true,
            paymentLink: paymentLink.url
        });
        
    } catch (error) {
        console.error('[PAYMENT ERROR]', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to get payment link: ' + error.message
        });
    }
});

// ==================== EMAIL HELPER (NO EMOJIS) ====================

async function sendClientWelcomeEmail(email, name, temporaryPassword) {
    const mailOptions = {
        from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Welcome to Diamondback Coding Client Portal',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
                    .container { max-width: 600px; margin: 0 auto; background: white; }
                    .header { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: white; padding: 40px 30px; text-align: center; }
                    .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
                    .header p { margin: 10px 0 0 0; opacity: 0.9; font-size: 14px; }
                    .content { padding: 40px 30px; }
                    .content h2 { color: #1f2937; font-size: 20px; margin: 0 0 20px 0; }
                    .content p { color: #6b7280; line-height: 1.6; margin: 0 0 16px 0; }
                    .credentials-box { background: #f9fafb; border-left: 4px solid #22c55e; padding: 24px; margin: 30px 0; border-radius: 8px; }
                    .credentials-box h3 { margin: 0 0 20px 0; color: #22c55e; font-size: 16px; font-weight: 600; }
                    .credential-item { margin: 0 0 16px 0; }
                    .credential-item:last-child { margin-bottom: 0; }
                    .credential-label { display: block; font-weight: 600; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
                    .credential-value { display: block; font-size: 15px; color: #111827; font-family: 'Courier New', Courier, monospace; background: white; padding: 10px 14px; border-radius: 6px; border: 1px solid #e5e7eb; }
                    .warning-box { background: #fef3c7; border: 1px solid #f59e0b; color: #92400e; padding: 16px; border-radius: 8px; margin: 24px 0; }
                    .warning-box strong { color: #78350f; }
                    .btn-container { text-align: center; margin: 30px 0; }
                    .btn { display: inline-block; background: #22c55e; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; }
                    .btn:hover { background: #16a34a; }
                    .features { margin: 30px 0; }
                    .features h3 { color: #1f2937; font-size: 18px; margin: 0 0 16px 0; }
                    .features ul { margin: 0; padding: 0; list-style: none; }
                    .features li { color: #6b7280; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
                    .features li:last-child { border-bottom: none; }
                    .features li strong { color: #1f2937; }
                    .footer { background: #1f2937; color: #9ca3af; padding: 30px; text-align: center; font-size: 13px; }
                    .footer p { margin: 0 0 8px 0; }
                    .footer a { color: #22c55e; text-decoration: none; }
                    .footer a:hover { text-decoration: underline; }
                    .footer-copy { font-size: 11px; opacity: 0.7; margin-top: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>Welcome to Your Client Portal</h1>
                        <p>Diamondback Coding</p>
                    </div>
                    
                    <div class="content">
                        <h2>Hi ${name},</h2>
                        
                        <p>
                            Your client portal account has been successfully created. You can now track your projects, 
                            view invoices, upload files, and communicate with our team through a secure online portal.
                        </p>
                        
                        <div class="credentials-box">
                            <h3>Login Credentials</h3>
                            
                            <div class="credential-item">
                                <span class="credential-label">Portal URL</span>
                                <span class="credential-value">https://diamondbackcoding.com/client_portal.html</span>
                            </div>
                            
                            <div class="credential-item">
                                <span class="credential-label">Email Address</span>
                                <span class="credential-value">${email}</span>
                            </div>
                            
                            <div class="credential-item">
                                <span class="credential-label">Temporary Password</span>
                                <span class="credential-value">${temporaryPassword}</span>
                            </div>
                        </div>
                        
                        <div class="warning-box">
                            <strong>Important Security Notice</strong><br>
                            Please change your password immediately after logging in for the first time. 
                            Never share your login credentials with anyone.
                        </div>
                        
                        <div class="btn-container">
                            <a href="https://diamondbackcoding.com/client_portal.html" class="btn">
                                Access Your Portal
                            </a>
                        </div>
                        
                        <div class="features">
                            <h3>Portal Features</h3>
                            <ul>
                                <li><strong>Project Tracking</strong> — View real-time progress on your projects</li>
                                <li><strong>Milestone Approvals</strong> — Review and approve completed work</li>
                                <li><strong>Invoice Management</strong> — Access and download all your invoices</li>
                                <li><strong>File Sharing</strong> — Upload and download project files securely</li>
                                <li><strong>Support Tickets</strong> — Submit support requests directly</li>
                            </ul>
                        </div>
                        
                        <p style="margin-top: 30px;">
                            If you have any questions or need assistance accessing your portal, 
                            please don't hesitate to contact us.
                        </p>
                        
                        <p style="margin-top: 24px;">
                            <strong>Best regards,</strong><br>
                            The Diamondback Coding Team
                        </p>
                    </div>
                    
                    <div class="footer">
                        <p><strong>Diamondback Coding</strong></p>
                        <p>15709 Spillman Ranch Loop, Austin, TX 78738</p>
                        <p>
                            <a href="mailto:contact@diamondbackcoding.com">contact@diamondbackcoding.com</a> | 
                            <a href="tel:+19402178680">(940) 217-8680</a>
                        </p>
                        <p class="footer-copy">
                            &copy; ${new Date().getFullYear()} Diamondback Coding. All rights reserved.
                        </p>
                    </div>
                </div>
            </body>
            </html>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('[EMAIL] Welcome email sent to:', email);
    } catch (error) {
        console.error('[EMAIL] Failed to send welcome email:', error);
        // Don't throw error - account creation should succeed even if email fails
    }
}

// ========================================
// MISSING ENDPOINT: Send Follow-Up Email
// ========================================

// Send follow-up email to a lead
app.post('/api/follow-ups/:leadId/send-email', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.leadId;
        const { subject, message, template } = req.body;
        
        console.log(`[FOLLOW-UP] Sending email to lead ${leadId}`);
        
        // Get lead info
        const leadResult = await pool.query(
            'SELECT * FROM leads WHERE id = $1',
            [leadId]
        );
        
        if (leadResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }
        
        const lead = leadResult.rows[0];
        
        if (!lead.email) {
            return res.status(400).json({
                success: false,
                message: 'Lead has no email address'
            });
        }

        if (lead.unsubscribed) {
            return res.status(400).json({
                success: false,
                message: 'This lead has unsubscribed from emails'
            });
        }
        
        // Determine email content
        let emailSubject = subject;
        let emailBody = message;
        
        // Use template if provided
        if (template === 'initial') {
            let unsubToken = lead.unsubscribe_token;
            if (!unsubToken) {
                unsubToken = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, leadId]);
            }
            const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;
            
            emailHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to Diamondback Coding</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F5;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F5F5">
<tr><td align="center" style="padding:40px 20px">

<table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;max-width:600px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

<!-- Curved Header Section -->
<tr><td style="background-color:#2C3E50;padding:60px 40px 70px 40px;text-align:center">
<span style="color:#F59E0B;font-size:11px;font-weight:600;letter-spacing:2px;font-family:Arial,sans-serif;text-transform:uppercase;display:block;margin-bottom:12px">YOUR VISION. OUR CODE. ENDLESS POSSIBILITIES.</span>
<span style="color:#F59E0B;font-size:12px;font-weight:600;letter-spacing:2.5px;font-family:Arial,sans-serif;text-transform:uppercase;display:block;margin-bottom:20px">Premium Web Development & CRM Solutions</span>
<span style="color:#ffffff;font-size:36px;font-weight:300;letter-spacing:3px;font-family:Georgia,serif;font-style:italic;display:block">Diamondback Coding®</span>
</td></tr>

<!-- White curve overlap -->
<tr><td style="background-color:#F5F5F5;padding:0">
<div style="background-color:#ffffff;border-radius:50% 50% 0 0 / 30px 30px 0 0;height:30px;margin-top:-30px"></div>
</td></tr>

<!-- About Us Section -->
<tr><td style="background-color:#ffffff;padding:40px 50px 50px 50px">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding-bottom:25px">
<span style="color:#2C3E50;font-size:32px;font-weight:700;font-family:Arial,sans-serif;letter-spacing:-0.5px">Dear ${lead.name},</span>
</td></tr>
<tr><td align="center" style="padding-bottom:20px">
<span style="color:#6B7280;font-size:15px;font-family:Arial,sans-serif;line-height:1.8;display:block;max-width:520px;margin:0 auto">
My name is Taylor and I am the founder of Diamondback Coding, LLC, offering business solutions for custom website development, custom CRM (Customer Relationship Management) platforms, and search optimization to enhance online business communications and customer relationships.
</span>
</td></tr>
<tr><td align="center" style="padding-bottom:20px">
<span style="color:#6B7280;font-size:15px;font-family:Arial,sans-serif;line-height:1.8;display:block;max-width:520px;margin:0 auto">
Our areas of focus include standardized packages and custom programming for websites, landing pages, CRMs, SEO (Search Engine Optimization), and monthly maintenance programs within a cloud-based environment.
</span>
</td></tr>
<tr><td align="center" style="padding-bottom:35px">
<span style="color:#6B7280;font-size:15px;font-family:Arial,sans-serif;line-height:1.8;display:block;max-width:520px;margin:0 auto">
Our objective is to provide businesses with the best and most cost-effective website presentations to communicate your business services and/or products to grow your business, as well as CRM systems to manage customer leads and relationships.
</span>
</td></tr>

<!-- Feature Cards in About Section -->
<tr><td style="padding:20px 0">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding-bottom:15px">
<span style="color:#F59E0B;font-size:14px;font-weight:700;font-family:Arial,sans-serif;letter-spacing:0.5px;text-transform:uppercase;display:block;margin-bottom:8px">Our Focus</span>
<span style="color:#2C3E50;font-size:18px;font-weight:600;font-family:Arial,sans-serif;display:block">Innovate Your Business</span>
</td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px">
<!-- Feature Row 1 -->
<tr><td style="padding:12px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="40" valign="top">
<div style="width:32px;height:32px;background-color:#F3F4F6;border-radius:50%;display:flex;align-items:center;justify-content:center">
<span style="color:#F59E0B;font-size:18px;font-weight:700">✓</span>
</div>
</td>
<td valign="middle" style="padding-left:15px">
<span style="font-size:15px;color:#2C3E50;font-family:Arial,sans-serif;line-height:1.6">
<strong>100% Ownership</strong> - You own your website and customer system with zero transaction fees
</span>
</td>
</tr>
</table>
</td></tr>

<!-- Feature Row 2 -->
<tr><td style="padding:12px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="40" valign="top">
<div style="width:32px;height:32px;background-color:#F3F4F6;border-radius:50%;display:flex;align-items:center;justify-content:center">
<span style="color:#F59E0B;font-size:18px;font-weight:700">✓</span>
</div>
</td>
<td valign="middle" style="padding-left:15px">
<span style="font-size:15px;color:#2C3E50;font-family:Arial,sans-serif;line-height:1.6">
<strong>Custom Solutions</strong> - Built specifically for how your business operates
</span>
</td>
</tr>
</table>
</td></tr>

<!-- Feature Row 3 -->
<tr><td style="padding:12px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="40" valign="top">
<div style="width:32px;height:32px;background-color:#F3F4F6;border-radius:50%;display:flex;align-items:center;justify-content:center">
<span style="color:#F59E0B;font-size:18px;font-weight:700">✓</span>
</div>
</td>
<td valign="middle" style="padding-left:15px">
<span style="font-size:15px;color:#2C3E50;font-family:Arial,sans-serif;line-height:1.6">
<strong>Local Support</strong> - We're right here in your area when you need us
</span>
</td>
</tr>
</table>
</td></tr>

<!-- Feature Row 4 -->
<tr><td style="padding:12px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="40" valign="top">
<div style="width:32px;height:32px;background-color:#F3F4F6;border-radius:50%;display:flex;align-items:center;justify-content:center">
<span style="color:#F59E0B;font-size:18px;font-weight:700">✓</span>
</div>
</td>
<td valign="middle" style="padding-left:15px">
<span style="font-size:15px;color:#2C3E50;font-family:Arial,sans-serif;line-height:1.6">
<strong>No Transaction Fees</strong> - Stop losing up to 6% on every sale to your platform
</span>
</td>
</tr>
</table>
</td></tr>
</table>

</td></tr>
</table>
</td></tr>

<!-- Curved transition to services -->
<tr><td style="background-color:#ffffff;padding:0">
<div style="background-color:#F5F5F5;border-radius:50% 50% 0 0 / 30px 30px 0 0;height:30px"></div>
</td></tr>

<!-- Our Services Section -->
<tr><td style="background-color:#F5F5F5;padding:30px 50px 50px 50px">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding-bottom:40px">
<span style="color:#2C3E50;font-size:32px;font-weight:700;font-family:Arial,sans-serif;letter-spacing:-0.5px">Our Services</span>
</td></tr>
</table>

<!-- Service Cards -->
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<!-- Service 1 -->
<td width="33.33%" valign="top" style="padding:0 8px">
<table cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,0.06);border-top:4px solid #F59E0B">
<tr><td style="padding:30px 20px;text-align:center">
<div style="width:60px;height:60px;background-color:#F59E0B;border-radius:50%;margin:0 auto 20px auto;line-height:60px;text-align:center">
<span style="color:#ffffff;font-size:28px;font-weight:900;font-family:Arial,sans-serif">1</span>
</div>
<span style="color:#2C3E50;font-size:16px;font-weight:700;font-family:Arial,sans-serif;display:block;margin-bottom:10px">Web Development</span>
<span style="color:#6B7280;font-size:13px;font-family:Arial,sans-serif;line-height:1.6;display:block">Custom websites and landing pages built to convert</span>
</td></tr>
</table>
</td>

<!-- Service 2 -->
<td width="33.33%" valign="top" style="padding:0 8px">
<table cellpadding="0" cellspacing="0" border="0" style="background-color:#F59E0B;border-radius:12px;width:100%;box-shadow:0 4px 12px rgba(245,158,11,0.4)">
<tr><td style="padding:30px 20px;text-align:center">
<div style="width:60px;height:60px;background-color:#ffffff;border-radius:50%;margin:0 auto 20px auto;line-height:60px;text-align:center">
<span style="color:#F59E0B;font-size:28px;font-weight:900;font-family:Arial,sans-serif">2</span>
</div>
<span style="color:#ffffff;font-size:16px;font-weight:700;font-family:Arial,sans-serif;display:block;margin-bottom:10px">CRM Solutions</span>
<span style="color:#ffffff;font-size:13px;font-family:Arial,sans-serif;line-height:1.6;display:block">Track leads and manage customer relationships</span>
</td></tr>
</table>
</td>

<!-- Service 3 -->
<td width="33.33%" valign="top" style="padding:0 8px">
<table cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,0.06);border-top:4px solid #F59E0B">
<tr><td style="padding:30px 20px;text-align:center">
<div style="width:60px;height:60px;background-color:#F59E0B;border-radius:50%;margin:0 auto 20px auto;line-height:60px;text-align:center">
<span style="color:#ffffff;font-size:28px;font-weight:900;font-family:Arial,sans-serif">3</span>
</div>
<span style="color:#2C3E50;font-size:16px;font-weight:700;font-family:Arial,sans-serif;display:block;margin-bottom:10px">SEO & Support</span>
<span style="color:#6B7280;font-size:13px;font-family:Arial,sans-serif;line-height:1.6;display:block">Rank higher and keep your site running smooth</span>
</td></tr>
</table>
</td>
</tr>
</table>

</td></tr>

<!-- CTA Section -->
<tr><td style="background-color:#F5F5F5;padding:40px 50px">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#2C3E50;border-radius:12px">
<tr><td style="padding:40px 35px;text-align:center">
<span style="color:#ffffff;font-size:24px;font-weight:700;font-family:Arial,sans-serif;display:block;margin-bottom:15px;line-height:1.3">Ready to Transform Your Business?</span>
<span style="color:#E5E7EB;font-size:15px;font-family:Arial,sans-serif;display:block;margin-bottom:25px;line-height:1.6">Let's discuss how we can help you grow with a custom web solution</span>
<table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">
<tr><td style="background-color:#F59E0B;border-radius:6px;padding:14px 40px">
<a href="https://diamondbackcoding.com/contact.html" style="color:#000000;font-size:15px;font-weight:700;text-decoration:none;font-family:Arial,sans-serif;display:block">Get Started</a>
</td></tr>
</table>
</td></tr>
</table>
</td></tr>

<!-- Contact Info -->
<tr><td style="background-color:#F5F5F5;padding:30px 50px 40px 50px">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px">
<tr><td style="padding:30px;text-align:center">
<span style="color:#2C3E50;font-size:16px;font-weight:700;font-family:Arial,sans-serif;display:block;margin-bottom:15px">Contact Us</span>
<span style="color:#6B7280;font-size:14px;font-family:Arial,sans-serif;line-height:2;display:block">
<strong>Phone:</strong> <a href="tel:+15129800393" style="color:#F59E0B;text-decoration:none">(512) 980-0393</a><br>
<strong>Email:</strong> <a href="mailto:contact@diamondbackcoding.com" style="color:#F59E0B;text-decoration:none">contact@diamondbackcoding.com</a><br>
<strong>Web:</strong> <a href="https://www.diamondbackcoding.com" style="color:#F59E0B;text-decoration:none">www.diamondbackcoding.com</a><br>
<strong>Address:</strong> 5000 Plaza on the Lake, Suite 100 PMB 2017<br>Austin, TX 78746
</span>
</td></tr>
</table>
</td></tr>

<!-- Footer -->
<tr><td style="background-color:#2C3E50;padding:35px 40px">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding-bottom:20px">
<table cellpadding="0" cellspacing="0" border="0" style="display:inline-block">
<tr>
<td style="padding:0 15px">
<a href="https://instagram.com/diamondbackcoding" style="color:#F59E0B;font-size:13px;font-weight:600;text-decoration:none;font-family:Arial,sans-serif">Instagram</a>
</td>
<td style="padding:0 15px;color:#6B7280">|</td>
<td style="padding:0 15px">
<a href="https://facebook.com/diamondbackcoding" style="color:#F59E0B;font-size:13px;font-weight:600;text-decoration:none;font-family:Arial,sans-serif">Facebook</a>
</td>
<td style="padding:0 15px;color:#6B7280">|</td>
<td style="padding:0 15px">
<a href="https://twitter.com/diamondbackcoding" style="color:#F59E0B;font-size:13px;font-weight:600;text-decoration:none;font-family:Arial,sans-serif">Twitter</a>
</td>
</tr>
</table>
</td></tr>
<tr><td align="center" style="font-size:11px;color:#9CA3AF;padding:0 0 12px 0;font-family:Arial,sans-serif">
<a href="${unsubUrl}" style="color:#9CA3AF;text-decoration:underline">Unsubscribe</a> | <a href="https://diamondbackcoding.com/preferences" style="color:#9CA3AF;text-decoration:underline">Update Preferences</a>
</td></tr>
<tr><td align="center" style="font-size:11px;color:#E5E7EB;font-family:Arial,sans-serif;line-height:1.8">
<strong>Diamondback Coding, LLC</strong><br>
5000 Plaza on the Lake, Suite 100 PMB 2017 · Austin, TX 78746
</td></tr>
</table>
</td></tr>

</table>

</td></tr>
</table>

</body>
</html>`;
        
        // For valentinessale template (PINK), use complete standalone HTML
        } else if (template === 'valentinessale') {
            let unsubToken = lead.unsubscribe_token;
            if (!unsubToken) {
                unsubToken = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, leadId]);
            }
            const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;
            
            emailHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>25% OFF Valentine's Day Sale</title>
</head>
<body style="margin:0;padding:0;background-color:#FF6B9D">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FF6B9D">
<tr><td align="center" style="padding:0">

<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#FF6B9D;max-width:600px">

<tr><td align="center" style="padding:20px 30px 10px 30px;background:#FF6B9D">
<span style="color:#ffffff;font-size:28px;font-weight:400;letter-spacing:1px;font-family:Georgia,serif;font-style:italic">Diamondback Coding®</span>
</td></tr>

<tr><td align="center" style="padding:0 30px 15px 30px;background:#FF6B9D">
<table cellpadding="0" cellspacing="0" border="0" style="background:#FFD93D;border-radius:25px">
<tr><td style="padding:10px 30px">
<span style="color:#FF6B9D;font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:1.2px;font-family:Arial,sans-serif">OUR BIGGEST SALE OF THE YEAR</span>
</td></tr>
</table>
</td></tr>

<tr><td style="padding:15px 15px;background:#FF6B9D">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="12%" valign="top" style="padding-top:10px" align="center">
<div style="width:30px;height:30px;background:#FFD93D;opacity:0.4;border-radius:50%"></div>
</td>
<td width="76%" align="center">
<div style="font-size:90px;font-weight:900;font-family:Arial Black,Arial,sans-serif;letter-spacing:-3px;color:#ffffff;line-height:0.85;text-align:center;margin:0;padding:0">25% OFF</div>
</td>
<td width="12%" valign="top" style="padding-top:10px" align="center">
<div style="width:30px;height:30px;background:#6BCFFF;opacity:0.4;border-radius:50%"></div>
</td>
</tr>
<tr>
<td width="12%" valign="middle" align="center">
<div style="width:32px;height:32px;background:#A0E7E5;opacity:0.4;border-radius:50%"></div>
</td>
<td width="76%" align="center">
<div style="font-size:90px;font-weight:900;font-family:Arial Black,Arial,sans-serif;letter-spacing:-3px;color:#ffffff;line-height:0.85;text-align:center;margin:0;padding:0">25% OFF</div>
</td>
<td width="12%" valign="middle" align="center">
<div style="width:30px;height:30px;background:#FFABAB;opacity:0.4;border-radius:50%"></div>
</td>
</tr>
<tr>
<td width="12%" valign="middle" align="center">
<div style="width:32px;height:32px;background:#FFD93D;opacity:0.35;border-radius:50%"></div>
</td>
<td width="76%" align="center">
<div style="font-size:90px;font-weight:900;font-family:Arial Black,Arial,sans-serif;letter-spacing:-3px;color:#ffffff;line-height:0.85;text-align:center;margin:0;padding:0">25% OFF</div>
</td>
<td width="12%" valign="middle" align="center">
<div style="width:32px;height:32px;background:#B4F8C8;opacity:0.4;border-radius:50%"></div>
</td>
</tr>
<tr>
<td width="12%" valign="bottom" style="padding-bottom:10px" align="center">
<div style="width:34px;height:34px;background:#FFA8E2;opacity:0.4;border-radius:50%"></div>
</td>
<td width="76%" align="center">
<div style="font-size:90px;font-weight:900;font-family:Arial Black,Arial,sans-serif;letter-spacing:-3px;color:#ffffff;line-height:0.85;text-align:center;margin:0;padding:0">25% OFF</div>
</td>
<td width="12%" valign="bottom" style="padding-bottom:10px" align="center">
<div style="width:30px;height:30px;background:#6BCFFF;opacity:0.35;border-radius:50%"></div>
</td>
</tr>
</table>
</td></tr>

<tr><td style="padding:20px 40px 12px 40px;background:#FF6B9D">
<span style="color:#ffffff;font-size:20px;font-weight:900;text-transform:uppercase;letter-spacing:1px;font-family:Arial Black,Arial,sans-serif;display:block;line-height:1.2;text-align:center">EVERYTHING 25% OFF</span>
<span style="color:#ffffff;font-size:20px;font-weight:900;text-transform:uppercase;letter-spacing:1px;font-family:Arial Black,Arial,sans-serif;display:block;line-height:1.2;text-align:center">FOR VALENTINE'S DAY!</span>
</td></tr>

<tr><td style="padding:0 40px 12px 40px;background:#FF6B9D">
<span style="color:#ffffff;font-size:12px;font-family:Arial,sans-serif;display:block;line-height:1.4;text-align:center">Show your business some love:</span>
<span style="color:#ffffff;font-size:12px;font-family:Arial,sans-serif;display:block;line-height:1.4;text-align:center">Our <strong style="font-weight:700">biggest sale of the year</strong> is here.</span>
</td></tr>

<tr><td style="padding:0 40px 15px 40px;background:#FF6B9D">
<span style="color:#ffffff;font-size:12px;font-weight:400;font-family:Arial,sans-serif;letter-spacing:0.5px;text-align:center;display:block">USE CODE <strong style="font-weight:900;font-size:14px;letter-spacing:1px">VALENTINE25</strong></span>
</td></tr>

<tr><td align="center" style="padding:0 40px 30px 40px;background:#FF6B9D">
<table cellpadding="0" cellspacing="0" border="0" style="background:#FFD93D;border-radius:40px;border:3px solid #ffffff">
<tr><td style="padding:14px 50px">
<a href="https://diamondbackcoding.com/contact.html" style="color:#FF6B9D;font-size:15px;font-weight:900;text-decoration:none;text-transform:uppercase;letter-spacing:1.3px;font-family:Arial Black,Arial,sans-serif;display:block">SHOP NOW</a>
</td></tr>
</table>
</td></tr>

<tr><td style="padding:0;background:#6BCFFF;height:30px"></td></tr>

<tr><td style="background:#6BCFFF;padding:25px 40px 30px 40px">
<table width="100%" cellpadding="0" cellspacing="0" border="0">

<tr><td align="center" style="font-size:11px;line-height:1.5;color:#ffffff;padding:0 0 18px 0;font-family:Arial,sans-serif">
Not valid on subscribe & save orders. Offer applies 2/1 - 2/14, 2026 only.<br>
New clients only. 25% discount applies to initial project quote.
</td></tr>

<tr><td align="center" style="padding:0 0 18px 0">
<table cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="padding:0 15px">
<a href="https://instagram.com/diamondbackcoding" style="color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;font-family:Arial,sans-serif">Instagram</a>
</td>
<td style="padding:0 15px;border-left:2px solid #ffffff">
<a href="https://facebook.com/diamondbackcoding" style="color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;font-family:Arial,sans-serif">Facebook</a>
</td>
<td style="padding:0 15px;border-left:2px solid #ffffff">
<a href="https://twitter.com/diamondbackcoding" style="color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;font-family:Arial,sans-serif">Twitter</a>
</td>
</tr>
</table>
</td></tr>

<tr><td align="center" style="font-size:10px;color:#ffffff;padding:0 0 6px 0;font-family:Arial,sans-serif">
No longer want to receive these emails? <a href="${unsubUrl}" style="color:#ffffff;text-decoration:underline;font-weight:400">Unsubscribe</a>
</td></tr>

<tr><td align="center" style="font-size:10px;color:#ffffff;padding:0;font-family:Arial,sans-serif;line-height:1.5">
<strong>Diamondback Coding</strong> · 15709 Spillman Ranch Loop, Austin, TX 78738<br>
<a href="tel:+19402178680" style="color:#ffffff;text-decoration:none">940-217-8680</a> | <a href="mailto:hello@diamondbackcoding.com" style="color:#ffffff;text-decoration:none">hello@diamondbackcoding.com</a>
</td></tr>

</table>
</td></tr>

</table>

</td></tr>
</table>

</body>
</html>`;
        // For springsale template, use complete standalone HTML
        } else if (template === 'springsale') {
            let unsubToken = lead.unsubscribe_token;
            if (!unsubToken) {
                unsubToken = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, leadId]);
            }
            const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;
            
            emailHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Spring Sale - 25% OFF</title>
</head>
<body style="margin:0;padding:0;background-color:#FFF8E7">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFF8E7">
<tr><td align="center" style="padding:0">

<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#FFF8E7;max-width:600px">

<tr><td align="center" style="padding:20px 30px 15px 30px;background:#FFF8E7">
<span style="color:#2D5F5D;font-size:30px;font-weight:600;letter-spacing:2px;font-family:Georgia,serif;font-style:italic">Diamondback Coding®</span>
</td></tr>

<tr><td align="center" style="padding:0 30px 18px 30px;background:#FFF8E7">
<table cellpadding="0" cellspacing="0" border="0" style="background:#2D5F5D;border-radius:25px">
<tr><td style="padding:9px 28px">
<span style="color:#FFD93D;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:1.8px;font-family:Arial,sans-serif">✦ Spring Event ✦</span>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:10px 30px 18px 30px;background:#FFF8E7">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#98D8C8;border-radius:20px">
<tr><td style="padding:25px 20px">

<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="15%" align="center" valign="middle">
<span style="font-size:35px">🌸</span>
</td>
<td width="70%" align="center" valign="middle">
<div style="text-align:center">
<div style="font-size:72px;font-weight:900;font-family:Arial Black,Arial,sans-serif;letter-spacing:-3px;color:#2D5F5D;line-height:0.85;margin:0;padding:0">25%</div>
<div style="font-size:44px;font-weight:900;font-family:Arial Black,Arial,sans-serif;letter-spacing:6px;color:#ffffff;line-height:1;margin:5px 0 0 0">OFF</div>
</div>
</td>
<td width="15%" align="center" valign="middle">
<span style="font-size:35px">🌺</span>
</td>
</tr>
</table>

<div style="margin:12px auto 10px auto;width:150px;height:2px;background:#ffffff;border-radius:2px;opacity:0.7"></div>

<div style="text-align:center">
<span style="font-size:14px;font-weight:700;color:#2D5F5D;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1.2px">Everything Spring</span>
</div>

</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:18px 40px 18px 40px;background:#FFF8E7">
<span style="color:#2D5F5D;font-size:22px;font-weight:900;text-transform:uppercase;letter-spacing:1.2px;font-family:Arial Black,Arial,sans-serif;display:block;line-height:1.3;margin-bottom:8px">Celebrate The Season!</span>
<span style="color:#5A7C7A;font-size:14px;font-family:Arial,sans-serif;line-height:1.5;display:block">Fresh solutions are blooming! Enjoy <strong style="font-weight:700">25% off everything</strong> in our collection.</span>
</td></tr>

<tr><td align="center" style="padding:0 30px 20px 30px;background:#FFF8E7">
<table cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:15px;width:90%">
<tr><td style="padding:20px 25px">

<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td align="center" style="padding-bottom:10px">
<span style="color:#2D5F5D;font-size:13px;font-weight:900;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1.5px">🌸 Pick Your Solution Vibe 🌸</span>
</td></tr>
<tr>
<td style="padding:8px 12px" align="center" width="25%">
<div style="text-align:center">
<span style="font-size:40px">🌺</span>
<div style="margin-top:5px">
<span style="font-size:11px;font-weight:700;color:#F7B5CA;font-family:Arial,sans-serif;text-transform:uppercase">Web Dev</span>
</div>
</div>
</td>

<td style="padding:8px 12px" align="center" width="25%">
<div style="text-align:center">
<span style="font-size:40px">🍋</span>
<div style="margin-top:5px">
<span style="font-size:11px;font-weight:700;color:#FFD93D;font-family:Arial,sans-serif;text-transform:uppercase">CRM</span>
</div>
</div>
</td>

<td style="padding:8px 12px" align="center" width="25%">
<div style="text-align:center">
<span style="font-size:40px">🌿</span>
<div style="margin-top:5px">
<span style="font-size:11px;font-weight:700;color:#98D8C8;font-family:Arial,sans-serif;text-transform:uppercase">Mobile</span>
</div>
</div>
</td>

<td style="padding:8px 12px" align="center" width="25%">
<div style="text-align:center">
<span style="font-size:40px">🌸</span>
<div style="margin-top:5px">
<span style="font-size:11px;font-weight:700;color:#E6B8D5;font-family:Arial,sans-serif;text-transform:uppercase">Speed</span>
</div>
</div>
</td>
</tr>
</table>

</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:0 40px 22px 40px;background:#FFF8E7">
<table cellpadding="0" cellspacing="0" border="0" style="background:#F7B5CA;border-radius:50px">
<tr><td style="padding:15px 55px">
<a href="https://diamondbackcoding.com/contact.html" style="color:#ffffff;font-size:15px;font-weight:900;text-decoration:none;text-transform:uppercase;letter-spacing:1.8px;font-family:Arial Black,Arial,sans-serif;display:block">Shop Spring Sale</a>
</td></tr>
</table>
</td></tr>

<tr><td style="background:#98D8C8;padding:22px 35px">
<table width="100%" cellpadding="0" cellspacing="0" border="0">

<tr><td align="center" style="font-size:10px;line-height:1.5;color:#2D5F5D;padding:0 0 16px 0;font-family:Arial,sans-serif">
Not valid on subscribe & save orders. Offer applies 3/1 - 4/15, 2026 only.<br>
New clients only. 25% discount applies to initial project quote.
</td></tr>

<tr><td align="center" style="padding:0 0 16px 0">
<table cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="padding:0 15px">
<a href="https://instagram.com/diamondbackcoding" style="color:#2D5F5D;text-decoration:none;font-size:13px;font-weight:700;font-family:Arial,sans-serif">Instagram</a>
</td>
<td style="padding:0 15px;border-left:2px solid #2D5F5D">
<a href="https://facebook.com/diamondbackcoding" style="color:#2D5F5D;text-decoration:none;font-size:13px;font-weight:700;font-family:Arial,sans-serif">Facebook</a>
</td>
<td style="padding:0 15px;border-left:2px solid #2D5F5D">
<a href="https://twitter.com/diamondbackcoding" style="color:#2D5F5D;text-decoration:none;font-size:13px;font-weight:700;font-family:Arial,sans-serif">Twitter</a>
</td>
</tr>
</table>
</td></tr>

<tr><td align="center" style="font-size:10px;color:#2D5F5D;padding:0 0 6px 0;font-family:Arial,sans-serif">
<a href="${unsubUrl}" style="color:#2D5F5D;text-decoration:underline;font-weight:600">Unsubscribe</a>
</td></tr>

<tr><td align="center" style="font-size:10px;color:#2D5F5D;padding:0;font-family:Arial,sans-serif;line-height:1.5">
<strong>Diamondback Coding</strong> · 15709 Spillman Ranch Loop, Austin, TX 78738<br>
<a href="tel:+19402178680" style="color:#2D5F5D;text-decoration:none">940-217-8680</a> | <a href="mailto:hello@diamondbackcoding.com" style="color:#2D5F5D;text-decoration:none">hello@diamondbackcoding.com</a>
</td></tr>

</table>
</td></tr>

</table>

</td></tr>
</table>

</body>
</html>`;
        
        // For blackfriday template, use complete standalone HTML
        } else if (template === 'blackfriday') {
            let unsubToken = lead.unsubscribe_token;
            if (!unsubToken) {
                unsubToken = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, leadId]);
            }
            const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;
            const year = new Date().getFullYear();
            
            emailHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>25% OFF Black Friday Sale</title>
</head>
<body style="margin:0;padding:0;background-color:#000000">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#000000">
<tr><td align="center" style="padding:0">

<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#000000;max-width:600px">

<tr><td align="center" style="padding:40px 20px 20px 20px">
<span style="color:#fff;font-size:36px;font-weight:400;letter-spacing:1px;font-family:Georgia,serif;font-style:italic">Diamondback Coding®</span>
</td></tr>

<tr><td align="center" style="padding:0 20px 30px 20px">
<table cellpadding="0" cellspacing="0" border="0" style="background:#DBEAFE;border-radius:35px">
<tr><td style="padding:15px 45px">
<span style="color:#1E40AF;font-size:16px;font-weight:900;text-transform:uppercase;letter-spacing:1.5px;font-family:Arial,sans-serif">OUR BIGGEST SALE OF THE YEAR</span>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:20px 20px">
<table cellpadding="0" cellspacing="0" border="0">
<tr><td align="center">
<div style="text-align:center;line-height:0.85">
<div style="font-size:130px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;letter-spacing:-3px;white-space:nowrap;color:#fff">25% OFF</div>
<div style="font-size:130px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;letter-spacing:-3px;white-space:nowrap;color:transparent;-webkit-text-stroke:3px #fff;-moz-text-stroke:3px #fff;text-stroke:3px #fff">25% OFF</div>
<div style="font-size:130px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;letter-spacing:-3px;white-space:nowrap;color:transparent;-webkit-text-stroke:3px #fff;-moz-text-stroke:3px #fff;text-stroke:3px #fff">25% OFF</div>
<div style="font-size:130px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;letter-spacing:-3px;white-space:nowrap;color:transparent;-webkit-text-stroke:3px #fff;-moz-text-stroke:3px #fff;text-stroke:3px #fff">25% OFF</div>
</div>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:40px 30px 20px 30px">
<span style="color:#fff;font-size:26px;font-weight:900;text-transform:uppercase;letter-spacing:1.5px;font-family:'Arial Black',Arial,sans-serif;display:block;line-height:1.2">EVERYTHING 25% OFF</span>
<span style="color:#fff;font-size:26px;font-weight:900;text-transform:uppercase;letter-spacing:1.5px;font-family:'Arial Black',Arial,sans-serif;display:block;line-height:1.2">FOR BLACK FRIDAY!</span>
</td></tr>

<tr><td align="center" style="padding:0 40px 20px 40px">
<span style="color:#fff;font-size:14px;font-family:Arial,sans-serif;display:block;line-height:1.6">Time to upgrade your business:</span>
<span style="color:#fff;font-size:14px;font-family:Arial,sans-serif;display:block;line-height:1.6">Our <strong style="font-weight:700">biggest sale of the year</strong> is here.</span>
</td></tr>

<tr><td align="center" style="padding:0 0 25px 0">
<span style="color:#fff;font-size:14px;font-weight:400;font-family:Arial,sans-serif;letter-spacing:0.5px">USE CODE <strong style="font-weight:900;font-size:16px;letter-spacing:1.5px">BLACKFRIDAY25</strong></span>
</td></tr>

<tr><td align="center" style="padding:0 0 60px 0">
<table cellpadding="0" cellspacing="0" border="0" style="background:#FF4057;border-radius:45px;border:5px solid #fff">
<tr><td style="padding:16px 60px">
<a href="https://diamondbackcoding.com/contact.html" style="color:#fff;font-size:18px;font-weight:900;text-decoration:none;text-transform:uppercase;letter-spacing:2px;font-family:'Arial Black',Arial,sans-serif">SHOP NOW</a>
</td></tr>
</table>
</td></tr>

<tr><td style="padding:0;line-height:0;margin:0">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="background:#000000;height:80px">
<svg width="600" height="80" viewBox="0 0 600 80" preserveAspectRatio="none" style="display:block;width:100%">
<path d="M 0,40 Q 150,10 300,40 Q 450,70 600,40 L 600,80 L 0,80 Z" fill="#FFEB3B"/>
</svg>
</td></tr>
</table>
</td></tr>

<tr><td style="background:#FFEB3B;padding:35px 40px 40px 40px">
<table width="100%" cellpadding="0" cellspacing="0" border="0">

<tr><td align="center" style="font-size:13px;line-height:1.7;color:#000;padding:0 0 25px 0;font-family:Arial,sans-serif">
Not valid on subscribe & save orders. Offer applies 11/20 - 12/3, 2026 only.<br>
New clients only. 25% discount applies to initial project quote.
</td></tr>

<tr><td align="center" style="padding:0 0 20px 0">
<table cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="padding:0 15px">
<a href="https://instagram.com/diamondbackcoding" style="color:#000;text-decoration:none;font-size:14px;font-weight:700;font-family:Arial,sans-serif">Instagram</a>
</td>
<td style="padding:0 15px;border-left:2px solid #000">
<a href="https://facebook.com/diamondbackcoding" style="color:#000;text-decoration:none;font-size:14px;font-weight:700;font-family:Arial,sans-serif">Facebook</a>
</td>
<td style="padding:0 15px;border-left:2px solid #000">
<a href="https://twitter.com/diamondbackcoding" style="color:#000;text-decoration:none;font-size:14px;font-weight:700;font-family:Arial,sans-serif">Twitter</a>
</td>
</tr>
</table>
</td></tr>

<tr><td align="center" style="font-size:13px;color:#000;padding:0 0 8px 0;font-family:Arial,sans-serif">
No longer want to receive these emails? <a href="${unsubUrl}" style="color:#000;text-decoration:underline;font-weight:700">Unsubscribe</a>
</td></tr>

<tr><td align="center" style="font-size:13px;color:#000;padding:0;font-family:Arial,sans-serif;line-height:1.6">
<strong>Diamondback Coding</strong> · 15709 Spillman Ranch Loop, Austin, TX 78738<br>
<a href="tel:+19402178680" style="color:#000;text-decoration:none">940-217-8680</a> | <a href="mailto:hello@diamondbackcoding.com" style="color:#000;text-decoration:none">hello@diamondbackcoding.com</a>
</td></tr>

</table>
</td></tr>

</table>

</td></tr>
</table>

</body>
</html>`;
        
        // For initialsale template, use complete standalone HTML
        } else if (template === 'initialsale') {
            let unsubToken = lead.unsubscribe_token;
            if (!unsubToken) {
                unsubToken = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, leadId]);
            }
            const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;
            const year = new Date().getFullYear();
            
            emailHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Spring Sale - 25% OFF All Services | Diamondback Coding</title>
</head>
<body style="margin:0;padding:0;background-color:#06B6D4">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#06B6D4">
<tr><td align="center" style="padding:15px 0">

<table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#06B6D4;max-width:600px">

<tr><td align="center" style="padding:30px 30px 15px 30px;background-color:#06B6D4">
<span style="color:#ffffff;font-size:36px;font-weight:400;letter-spacing:1.5px;font-family:Georgia,serif;font-style:italic">Diamondback Coding®</span>
</td></tr>

<tr><td align="center" style="padding:0 30px 25px 30px;background-color:#06B6D4">
<table cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="padding-right:15px">
<div style="width:100px;height:2px;background-color:#FEF3C7"></div>
</td>
<td>
<span style="color:#ffffff;font-size:11px;font-weight:600;letter-spacing:2.5px;font-family:Arial,sans-serif;text-transform:uppercase">Web Development • CRM Solutions</span>
</td>
<td style="padding-left:15px">
<div style="width:100px;height:2px;background-color:#FEF3C7"></div>
</td>
</tr>
</table>
</td></tr>

<tr><td align="center" style="padding:0 30px 25px 30px;background-color:#06B6D4">
<table cellpadding="0" cellspacing="0" border="0" style="background-color:#EC4899;border-radius:35px;border:4px solid #FEF3C7">
<tr><td style="padding:14px 40px">
<span style="color:#FEF3C7;font-size:14px;font-weight:900;text-transform:uppercase;letter-spacing:2.2px;font-family:Arial,sans-serif">Limited Time: Ends April 30</span>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:25px 30px;background-color:#06B6D4">
<div style="font-size:90px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;letter-spacing:-3px;color:#ffffff;line-height:1;text-align:center;text-shadow:6px 6px 0px rgba(251,113,133,0.65)">25% OFF</div>
</td></tr>

<tr><td align="center" style="padding:20px 40px 10px 40px;background-color:#06B6D4">
<span style="color:#ffffff;font-size:26px;font-weight:900;text-transform:uppercase;letter-spacing:1.4px;font-family:'Arial Black',Arial,sans-serif;display:block;line-height:1.4">Save Big on Premium Solutions</span>
</td></tr>

<tr><td align="center" style="padding:0 45px 15px 45px;background-color:#06B6D4">
<span style="color:#ffffff;font-size:15px;font-family:Arial,sans-serif;line-height:1.7;display:block">
Transform your business with cutting-edge development and CRM solutions. <strong style="font-weight:900;color:#FEF3C7">Save 25% on all new projects</strong> started before April 30, 2026.
</span>
</td></tr>

<tr><td align="center" style="padding:0 50px 30px 50px;background-color:#06B6D4">
<table cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;width:100%;max-width:480px">
<tr><td style="padding:15px 25px">
<span style="color:#1F2937;font-size:11px;font-family:Arial,sans-serif;line-height:1.6;display:block;text-align:center">
<strong>Discount applies to one service:</strong><br>
25% off per user for CRM Solution <em>OR</em> 25% off Website Development<br>
Valid for all packages. Choose one option per customer.
</span>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:0 30px 30px 30px;background-color:#06B6D4">
<table cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:20px;width:100%;max-width:530px">
<tr><td style="padding:30px 35px">

<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td align="center" style="padding-bottom:22px">
<span style="color:#EC4899;font-size:15px;font-weight:900;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:2px">Why Choose Us</span>
</td></tr>

<tr><td style="padding:15px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="70" valign="top" align="center">
<table cellpadding="0" cellspacing="0" border="0" style="width:55px;height:55px;background-color:#A5F3FC;border-radius:50%">
<tr><td align="center" valign="middle">
<span style="font-size:28px;color:#0891B2">✓</span>
</td></tr>
</table>
</td>
<td valign="middle" style="padding-left:18px">
<span style="font-size:17px;font-weight:700;color:#1F2937;font-family:Arial,sans-serif;display:block;line-height:1.5">Fast Project Kickoff</span>
<span style="font-size:14px;color:#6B7280;font-family:Arial,sans-serif;display:block;line-height:1.5;margin-top:5px">Get started with our streamlined onboarding process</span>
</td>
</tr>
</table>
</td></tr>

<tr><td style="padding:15px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="70" valign="top" align="center">
<table cellpadding="0" cellspacing="0" border="0" style="width:55px;height:55px;background-color:#FBCFE8;border-radius:50%">
<tr><td align="center" valign="middle">
<span style="font-size:28px;color:#BE185D">✓</span>
</td></tr>
</table>
</td>
<td valign="middle" style="padding-left:18px">
<span style="font-size:17px;font-weight:700;color:#1F2937;font-family:Arial,sans-serif;display:block;line-height:1.5">Dedicated Support Team</span>
<span style="font-size:14px;color:#6B7280;font-family:Arial,sans-serif;display:block;line-height:1.5;margin-top:5px">Direct access to developers and account managers</span>
</td>
</tr>
</table>
</td></tr>

<tr><td style="padding:15px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="70" valign="top" align="center">
<table cellpadding="0" cellspacing="0" border="0" style="width:55px;height:55px;background-color:#FED7AA;border-radius:50%">
<tr><td align="center" valign="middle">
<span style="font-size:28px;color:#C2410C">✓</span>
</td></tr>
</table>
</td>
<td valign="middle" style="padding-left:18px">
<span style="font-size:17px;font-weight:700;color:#1F2937;font-family:Arial,sans-serif;display:block;line-height:1.5">Professional Results</span>
<span style="font-size:14px;color:#6B7280;font-family:Arial,sans-serif;display:block;line-height:1.5;margin-top:5px">Cutting-edge solutions built to scale with your business</span>
</td>
</tr>
</table>
</td></tr>

</table>

</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:0 30px 30px 30px;background-color:#06B6D4">
<table cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:20px;width:100%;max-width:530px">
<tr><td style="padding:30px 30px">

<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td align="center" style="padding-bottom:22px" colspan="4">
<span style="color:#EC4899;font-size:15px;font-weight:900;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:2px">All Services 25% Off</span>
</td></tr>
<tr>
<td style="padding:12px 15px" align="center" width="25%">
<table cellpadding="0" cellspacing="0" border="0" style="width:65px;height:65px;background-color:#A5F3FC;border-radius:16px">
<tr><td align="center" valign="middle">
<span style="font-size:32px">💻</span>
</td></tr>
</table>
<div style="margin-top:12px">
<span style="font-size:11px;font-weight:700;color:#0891B2;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:0.6px">Web Dev</span>
</div>
</td>

<td style="padding:12px 15px" align="center" width="25%">
<table cellpadding="0" cellspacing="0" border="0" style="width:65px;height:65px;background-color:#FBCFE8;border-radius:16px">
<tr><td align="center" valign="middle">
<span style="font-size:32px">📊</span>
</td></tr>
</table>
<div style="margin-top:12px">
<span style="font-size:11px;font-weight:700;color:#BE185D;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:0.6px">CRM</span>
</div>
</td>

<td style="padding:12px 15px" align="center" width="25%">
<table cellpadding="0" cellspacing="0" border="0" style="width:65px;height:65px;background-color:#FED7AA;border-radius:16px">
<tr><td align="center" valign="middle">
<span style="font-size:32px">📱</span>
</td></tr>
</table>
<div style="margin-top:12px">
<span style="font-size:11px;font-weight:700;color:#C2410C;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:0.6px">Mobile</span>
</div>
</td>

<td style="padding:12px 15px" align="center" width="25%">
<table cellpadding="0" cellspacing="0" border="0" style="width:65px;height:65px;background-color:#FEF9C3;border-radius:16px">
<tr><td align="center" valign="middle">
<span style="font-size:32px">⚡</span>
</td></tr>
</table>
<div style="margin-top:12px">
<span style="font-size:11px;font-weight:700;color:#CA8A04;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:0.6px">Speed</span>
</div>
</td>
</tr>
</table>

</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:0 30px 25px 30px;background-color:#06B6D4">
<table cellpadding="0" cellspacing="0" border="0" style="background-color:#EC4899;border-radius:50px">
<tr><td style="padding:22px 75px">
<a href="https://diamondbackcoding.com/contact.html" style="color:#ffffff;font-size:18px;font-weight:900;text-decoration:none;text-transform:uppercase;letter-spacing:2.2px;font-family:'Arial Black',Arial,sans-serif;display:block">Claim Your 25% Discount</a>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:0 40px 30px 40px;background-color:#06B6D4">
<span style="color:#ffffff;font-size:13px;font-family:Arial,sans-serif;line-height:1.6">
Not ready yet? <a href="https://diamondbackcoding.com/contact.html" style="color:#FEF3C7;font-weight:700;text-decoration:underline">Schedule a free consultation</a>
</span>
</td></tr>

<tr><td style="background-color:#FB923C;padding:35px 45px">
<table width="100%" cellpadding="0" cellspacing="0" border="0">

<tr><td align="center" style="font-size:11px;line-height:1.7;color:#ffffff;padding:0 0 25px 0;font-family:Arial,sans-serif;font-weight:600">
Limited Time Offer: Valid February 9 - April 30, 2026<br>
New clients only. 25% discount applies to initial project quote. Terms apply.
</td></tr>

<tr><td align="center" style="padding:0 0 25px 0">
<table cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="padding:0 15px">
<a href="https://instagram.com/diamondbackcoding" style="color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;font-family:Arial,sans-serif">Instagram</a>
</td>
<td style="padding:0 15px;border-left:2px solid #ffffff">
<a href="https://facebook.com/diamondbackcoding" style="color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;font-family:Arial,sans-serif">Facebook</a>
</td>
<td style="padding:0 15px;border-left:2px solid #ffffff">
<a href="https://twitter.com/diamondbackcoding" style="color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;font-family:Arial,sans-serif">Twitter</a>
</td>
</tr>
</table>
</td></tr>

<tr><td align="center" style="font-size:10px;color:#ffffff;padding:0 0 12px 0;font-family:Arial,sans-serif">
No longer want to receive these emails? <a href="${unsubUrl}" style="color:#ffffff;text-decoration:underline">Unsubscribe</a> | <a href="https://diamondbackcoding.com/preferences" style="color:#ffffff;text-decoration:underline">Update Preferences</a>
</td></tr>

<tr><td align="center" style="font-size:10px;color:#ffffff;padding:0;font-family:Arial,sans-serif;line-height:1.7">
<strong>Diamondback Coding</strong> · Web Development & CRM Solutions<br>
15709 Spillman Ranch Loop · Austin, TX 78738<br>
<a href="tel:+19402178680" style="color:#ffffff;text-decoration:none">940-217-8680</a> | <a href="mailto:hello@diamondbackcoding.com" style="color:#ffffff;text-decoration:none">hello@diamondbackcoding.com</a>
</td></tr>

</table>
</td></tr>

</table>

</td></tr>
</table>

</body>
</html>`;
        
        // For valentines14 (original 14% promo) template
        } else if (template === 'valentines14') {
            // Generate unsubscribe token
            let unsubToken = lead.unsubscribe_token;
            if (!unsubToken) {
                unsubToken = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, leadId]);
            }
            const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;
            const year = new Date().getFullYear();
            
            
            // Valentine's Day email - WITH WAVE FOOTER + GLOWING BUTTON
            emailHTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Spring Sale - 25% OFF All Services | Diamondbackcoding</title>
<style type="text/css">
/* Mobile Styles */
@media only screen and (max-width: 600px) {
  .main-table {
    width: 100% !important;
  }
  .big-text {
    font-size: 48px !important;
    letter-spacing: -1px !important;
  }
  .headline {
    font-size: 17px !important;
  }
  .brand {
    font-size: 22px !important;
  }
  .badge-text {
    font-size: 10px !important;
    padding: 8px 16px !important;
  }
  .mobile-padding {
    padding-left: 15px !important;
    padding-right: 15px !important;
  }
  .service-icon {
    width: 45px !important;
    height: 45px !important;
  }
  .pattern-column {
    display: none !important;
  }
  .urgency-text {
    font-size: 11px !important;
  }
  .benefit-text {
    font-size: 13px !important;
  }
  .cta-button {
    padding: 15px 35px !important;
    font-size: 13px !important;
  }
  .social-icon {
    width: 32px !important;
    height: 32px !important;
  }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#06B6D4">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#06B6D4">
<tr><td align="center" style="padding:0">

<table width="600" cellpadding="0" cellspacing="0" border="0" class="main-table" style="background:#06B6D4;max-width:600px">

<!-- Wavy Top Border with Enhanced Geometric Patterns -->
<tr><td style="padding:0;background:#06B6D4;position:relative">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<!-- Left decorative patterns -->
<td width="15%" style="padding:15px 0 0 10px" valign="top" class="pattern-column">
<svg width="70" height="100" viewBox="0 0 70 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="20" cy="15" r="14" fill="#FCD34D" opacity="0.5"/>
  <rect x="40" y="5" width="20" height="20" rx="4" fill="#FB923C" opacity="0.4"/>
  <polygon points="15,40 25,55 5,55" fill="#F472B6" opacity="0.45"/>
  <circle cx="50" cy="55" r="10" fill="#FDE047" opacity="0.4"/>
  <rect x="10" y="65" width="18" height="18" rx="3" fill="#22D3EE" opacity="0.35"/>
  <circle cx="45" cy="85" r="8" fill="#FB7185" opacity="0.4"/>
  <polygon points="25,90 35,100 15,100" fill="#FCD34D" opacity="0.35"/>
</svg>
</td>
<!-- Center wave SVG -->
<td width="70%" style="padding:0">
<svg width="100%" height="40" viewBox="0 0 600 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto" preserveAspectRatio="none">
  <path d="M0 20C100 5 200 35 300 20C400 5 500 35 600 20V0H0V20Z" fill="#FB7185"/>
  <path d="M0 30C100 15 200 40 300 28C400 16 500 40 600 30V0H0V30Z" fill="#FCD34D" opacity="0.6"/>
</svg>
</td>
<!-- Right decorative patterns -->
<td width="15%" style="padding:15px 10px 0 0" valign="top" align="right" class="pattern-column">
<svg width="70" height="100" viewBox="0 0 70 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="35" y="5" width="22" height="22" rx="4" fill="#F472B6" opacity="0.5"/>
  <circle cx="15" cy="20" r="12" fill="#FDE047" opacity="0.45"/>
  <polygon points="45,45 55,60 35,60" fill="#FB923C" opacity="0.5"/>
  <rect x="10" y="60" width="18" height="18" rx="2" fill="#FCD34D" opacity="0.4"/>
  <circle cx="50" cy="75" r="10" fill="#22D3EE" opacity="0.45"/>
  <polygon points="20,90 30,100 10,100" fill="#FB7185" opacity="0.4"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- Brand Section with Enhanced Background Patterns -->
<tr><td style="padding:0;background:#06B6D4;position:relative">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<!-- Left pattern column -->
<td width="18%" valign="top" style="padding:15px 0 0 8px" class="pattern-column">
<svg width="90" height="150" viewBox="0 0 90 150" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="12" y="8" width="28" height="28" rx="5" fill="#FCD34D" opacity="0.35"/>
  <circle cx="60" cy="25" r="16" fill="#FB923C" opacity="0.3"/>
  <polygon points="20,50 35,68 5,68" fill="#F472B6" opacity="0.35"/>
  <rect x="50" y="60" width="22" height="22" rx="3" fill="#FDE047" opacity="0.3"/>
  <circle cx="25" cy="90" r="14" fill="#22D3EE" opacity="0.35"/>
  <polygon points="55,95 70,110 40,110" fill="#FB7185" opacity="0.3"/>
  <rect x="15" y="120" width="20" height="20" rx="2" fill="#FB923C" opacity="0.35"/>
  <circle cx="60" cy="135" r="12" fill="#F472B6" opacity="0.3"/>
</svg>
</td>

<!-- Center content -->
<td width="64%" align="center" style="padding:20px 10px 10px 10px" class="mobile-padding">
<span class="brand" style="color:#ffffff;font-size:30px;font-weight:400;letter-spacing:1px;font-family:Georgia,serif;font-style:italic">Diamondbackcoding®</span>
<br>
<span style="color:#ffffff;font-size:11px;font-weight:600;letter-spacing:2px;font-family:Arial,sans-serif;text-transform:uppercase;margin-top:8px;display:inline-block">Web Development • CRM Solutions</span>
</td>

<!-- Right pattern column -->
<td width="18%" valign="top" style="padding:15px 8px 0 0" align="right" class="pattern-column">
<svg width="90" height="150" viewBox="0 0 90 150" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="30" cy="20" r="15" fill="#F472B6" opacity="0.35"/>
  <rect x="55" y="10" width="25" height="25" rx="4" fill="#FB923C" opacity="0.3"/>
  <polygon points="65,50 80,65 50,65" fill="#FCD34D" opacity="0.35"/>
  <circle cx="25" cy="70" r="14" fill="#FDE047" opacity="0.3"/>
  <rect x="20" y="95" width="22" height="22" rx="4" fill="#22D3EE" opacity="0.35"/>
  <polygon points="60,100 75,115 45,115" fill="#FB7185" opacity="0.3"/>
  <circle cx="60" cy="135" r="13" fill="#FB923C" opacity="0.3"/>
  <rect x="15" y="125" width="18" height="18" rx="2" fill="#F472B6" opacity="0.35"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- URGENCY TIMER Badge with enhanced geometric background -->
<tr><td style="padding:0;background:#06B6D4">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="15%" valign="middle" class="pattern-column">
<svg width="80" height="70" viewBox="0 0 80 70" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="12" width="22" height="22" rx="3" fill="#FB923C" opacity="0.35"/>
  <circle cx="55" cy="38" r="12" fill="#FCD34D" opacity="0.3"/>
  <polygon points="25,55 40,68 10,68" fill="#F472B6" opacity="0.35"/>
</svg>
</td>
<td width="70%" align="center" style="padding:18px 10px">
<table cellpadding="0" cellspacing="0" border="0" style="background:#EC4899;border-radius:25px;display:inline-block;border:2px solid #FEF3C7">
<tr><td class="badge-text" style="padding:10px 30px">
<span class="urgency-text" style="color:#FEF3C7;font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:1.8px;font-family:Arial,sans-serif">Limited Time: Ends April 30</span>
</td></tr>
</table>
</td>
<td width="15%" valign="middle" align="right" class="pattern-column">
<svg width="80" height="70" viewBox="0 0 80 70" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="25" cy="28" r="13" fill="#F472B6" opacity="0.35"/>
  <rect x="45" y="18" width="20" height="20" rx="2" fill="#FDE047" opacity="0.3"/>
  <polygon points="50,55 65,68 35,68" fill="#22D3EE" opacity="0.35"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- Main 25% OFF Section with enhanced geometric patterns -->
<tr><td style="padding:12px 0;background:#06B6D4">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<!-- Left pattern -->
<td width="15%" valign="middle" class="pattern-column">
<svg width="85" height="120" viewBox="0 0 85 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="45" cy="20" r="16" fill="#FCD34D" opacity="0.4"/>
  <rect x="28" y="48" width="24" height="24" rx="3" fill="#FB923C" opacity="0.35"/>
  <polygon points="40,80 55,95 25,95" fill="#F472B6" opacity="0.4"/>
  <circle cx="50" cy="108" r="10" fill="#FDE047" opacity="0.35"/>
</svg>
</td>

<!-- Center 25% OFF -->
<td width="70%" align="center">
<div class="big-text" style="font-size:82px;font-weight:900;font-family:Arial Black,Arial Bold,Arial,sans-serif;letter-spacing:-3px;color:#ffffff;line-height:1.05;text-align:center;margin:0;padding:8px 0;text-shadow:5px 5px 0px rgba(251,113,133,0.5)">25% OFF</div>
</td>

<!-- Right pattern -->
<td width="15%" valign="middle" align="right" class="pattern-column">
<svg width="85" height="120" viewBox="0 0 85 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="35" y="10" width="26" height="26" rx="4" fill="#FDE047" opacity="0.4"/>
  <circle cx="50" cy="55" r="15" fill="#22D3EE" opacity="0.35"/>
  <polygon points="30,85 45,100 15,100" fill="#FB7185" opacity="0.4"/>
  <rect x="40" y="105" width="18" height="18" rx="2" fill="#FB923C" opacity="0.35"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- VALUE PROPOSITION with enhanced patterns -->
<tr><td style="padding:18px 25px 12px 25px;background:#06B6D4" class="mobile-padding">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="12%" valign="middle" class="pattern-column">
<svg width="65" height="60" viewBox="0 0 65 60" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="35" cy="25" r="14" fill="#FDE047" opacity="0.4"/>
  <rect x="18" y="12" width="12" height="12" rx="2" fill="#FCD34D" opacity="0.3"/>
  <polygon points="25,45 40,58 10,58" fill="#F472B6" opacity="0.35"/>
</svg>
</td>
<td width="76%" align="center">
<span class="headline" style="color:#ffffff;font-size:22px;font-weight:900;text-transform:uppercase;letter-spacing:1.2px;font-family:Arial Black,Arial,sans-serif;display:block;line-height:1.3;margin-bottom:8px">Save Big on Premium Solutions</span>
</td>
<td width="12%" valign="middle" align="right" class="pattern-column">
<svg width="65" height="60" viewBox="0 0 65 60" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="38" y="18" width="14" height="14" rx="2" fill="#FB923C" opacity="0.4"/>
  <circle cx="25" cy="28" r="13" fill="#F472B6" opacity="0.35"/>
  <polygon points="45,48 30,60 60,60" fill="#22D3EE" opacity="0.35"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- Enhanced subtext with geometric accents -->
<tr><td style="padding:0 35px 22px 35px;background:#06B6D4" class="mobile-padding">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="10%" valign="top" style="padding-top:5px" class="pattern-column">
<svg width="55" height="70" viewBox="0 0 55 70" fill="none" xmlns="http://www.w3.org/2000/svg">
  <polygon points="28,5 38,20 18,20" fill="#FCD34D" opacity="0.35"/>
  <rect x="18" y="32" width="16" height="16" rx="2" fill="#22D3EE" opacity="0.3"/>
  <circle cx="30" cy="62" r="8" fill="#FB923C" opacity="0.35"/>
</svg>
</td>
<td width="80%" align="center">
<span class="benefit-text" style="color:#ffffff;font-size:15px;font-family:Arial,sans-serif;line-height:1.6;display:block">
Transform your business with cutting-edge development and CRM solutions. <strong style="font-weight:900;color:#FEF3C7">Save 25% on all new projects</strong> started before April 30, 2026.
</span>
</td>
<td width="10%" valign="top" style="padding-top:5px" align="right" class="pattern-column">
<svg width="55" height="70" viewBox="0 0 55 70" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="28" cy="15" r="11" fill="#FB7185" opacity="0.35"/>
  <polygon points="38,42 28,57 18,42" fill="#FDE047" opacity="0.3"/>
  <rect x="20" y="60" width="14" height="14" rx="2" fill="#F472B6" opacity="0.35"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- Key Benefits Section with enhanced pattern borders -->
<tr><td style="padding:0;background:#06B6D4">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="12%" valign="top" style="padding:20px 0 0 8px" class="pattern-column">
<svg width="70" height="250" viewBox="0 0 70 250" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="25" y="10" width="20" height="20" rx="3" fill="#F472B6" opacity="0.3"/>
  <circle cx="40" cy="50" r="14" fill="#FCD34D" opacity="0.35"/>
  <polygon points="30,80 45,95 15,95" fill="#FB923C" opacity="0.3"/>
  <rect x="20" y="110" width="22" height="22" rx="2" fill="#FDE047" opacity="0.35"/>
  <circle cx="35" cy="155" r="12" fill="#22D3EE" opacity="0.3"/>
  <polygon points="38,180 53,195 23,195" fill="#FB7185" opacity="0.35"/>
  <rect x="22" y="210" width="18" height="18" rx="3" fill="#F472B6" opacity="0.3"/>
  <circle cx="42" cy="240" r="10" fill="#FCD34D" opacity="0.35"/>
</svg>
</td>
<td width="76%" align="center" style="padding:20px 10px" class="mobile-padding">
<table cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:15px;box-shadow:0 6px 25px rgba(251,113,133,0.3);display:inline-block;width:100%;max-width:480px">
<tr><td style="padding:22px 28px">

<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td align="center" style="padding-bottom:16px">
<span style="color:#EC4899;font-size:14px;font-weight:900;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1.5px">Why Choose Us</span>
</td></tr>

<!-- Benefit 1 -->
<tr><td style="padding:10px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="60" valign="top" align="center">
<svg width="50" height="50" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="25" cy="25" r="23" fill="#06B6D4" opacity="0.15"/>
  <path d="M15 25L22 32L35 18" stroke="#06B6D4" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
</td>
<td valign="middle" style="padding-left:12px">
<span style="font-size:14px;font-weight:700;color:#1F2937;font-family:Arial,sans-serif;display:block;line-height:1.4">Fast Project Kickoff</span>
<span style="font-size:12px;color:#6B7280;font-family:Arial,sans-serif;display:block;line-height:1.4;margin-top:2px">Get started with our streamlined onboarding process</span>
</td>
</tr>
</table>
</td></tr>

<!-- Benefit 2 -->
<tr><td style="padding:10px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="60" valign="top" align="center">
<svg width="50" height="50" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="25" cy="25" r="23" fill="#F472B6" opacity="0.15"/>
  <path d="M25 15V25L32 29" stroke="#F472B6" stroke-width="3.5" stroke-linecap="round"/>
  <circle cx="25" cy="25" r="12" stroke="#F472B6" stroke-width="3"/>
</svg>
</td>
<td valign="middle" style="padding-left:12px">
<span style="font-size:14px;font-weight:700;color:#1F2937;font-family:Arial,sans-serif;display:block;line-height:1.4">Dedicated Support Team</span>
<span style="font-size:12px;color:#6B7280;font-family:Arial,sans-serif;display:block;line-height:1.4;margin-top:2px">Direct access to developers and account managers</span>
</td>
</tr>
</table>
</td></tr>

<!-- Benefit 3 -->
<tr><td style="padding:10px 0">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td width="60" valign="top" align="center">
<svg width="50" height="50" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="25" cy="25" r="23" fill="#FB923C" opacity="0.15"/>
  <rect x="15" y="15" width="20" height="20" rx="2" stroke="#FB923C" stroke-width="3"/>
  <path d="M20 25L23 28L30 20" stroke="#FB923C" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
</td>
<td valign="middle" style="padding-left:12px">
<span style="font-size:14px;font-weight:700;color:#1F2937;font-family:Arial,sans-serif;display:block;line-height:1.4">Professional Results</span>
<span style="font-size:12px;color:#6B7280;font-family:Arial,sans-serif;display:block;line-height:1.4;margin-top:2px">Cutting-edge solutions built to scale with your business</span>
</td>
</tr>
</table>
</td></tr>

</table>

</td></tr>
</table>
</td>
<td width="12%" valign="top" style="padding:20px 8px 0 0" align="right" class="pattern-column">
<svg width="70" height="250" viewBox="0 0 70 250" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="35" cy="18" r="13" fill="#FB7185" opacity="0.35"/>
  <rect x="25" y="55" width="22" height="22" rx="3" fill="#FCD34D" opacity="0.3"/>
  <polygon points="50,95 35,110 20,95" fill="#22D3EE" opacity="0.35"/>
  <circle cx="40" cy="135" r="15" fill="#FDE047" opacity="0.3"/>
  <rect x="20" y="165" width="20" height="20" rx="2" fill="#F472B6" opacity="0.35"/>
  <polygon points="45,200 30,215 60,215" fill="#FB923C" opacity="0.3"/>
  <circle cx="38" cy="238" r="11" fill="#22D3EE" opacity="0.35"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- Our Solutions Grid with enhanced decorative background -->
<tr><td style="padding:20px 0;background:#06B6D4">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="12%" valign="middle" class="pattern-column">
<svg width="70" height="140" viewBox="0 0 70 140" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="18" width="20" height="20" rx="2" fill="#FCD34D" opacity="0.35"/>
  <circle cx="40" cy="60" r="14" fill="#F472B6" opacity="0.3"/>
  <polygon points="30,95 45,110 15,110" fill="#FB923C" opacity="0.35"/>
  <rect x="25" y="120" width="18" height="18" rx="3" fill="#FDE047" opacity="0.3"/>
</svg>
</td>
<td width="76%" align="center" style="padding:0 10px" class="mobile-padding">
<table cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:15px;box-shadow:0 6px 25px rgba(251,113,133,0.3);display:inline-block;width:100%;max-width:480px">
<tr><td style="padding:20px 20px">

<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td align="center" style="padding-bottom:14px" colspan="4">
<span style="color:#EC4899;font-size:13px;font-weight:900;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1.5px">All Services 25% Off</span>
</td></tr>
<tr>
<!-- Web Development -->
<td style="padding:8px 10px" align="center">
<div style="text-align:center">
<svg width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" class="service-icon">
  <rect x="8" y="12" width="44" height="36" rx="3" fill="#A5F3FC" opacity="0.3"/>
  <rect x="10" y="14" width="40" height="32" rx="2" fill="#22D3EE" opacity="0.6"/>
  <rect x="12" y="16" width="36" height="28" rx="2" fill="#0891B2"/>
  <path d="M20 26L24 30L20 34" stroke="#E0F2FE" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="28" y1="26" x2="28" y2="34" stroke="#E0F2FE" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M32 30L40 30" stroke="#E0F2FE" stroke-width="2.5" stroke-linecap="round"/>
</svg>
<div style="margin-top:5px">
<span style="font-size:11px;font-weight:700;color:#0891B2;font-family:Arial,sans-serif;text-transform:uppercase">Web Dev</span>
</div>
</div>
</td>

<!-- CRM Solutions -->
<td style="padding:8px 10px" align="center">
<div style="text-align:center">
<svg width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" class="service-icon">
  <circle cx="30" cy="30" r="24" fill="#FBCFE8" opacity="0.3"/>
  <circle cx="30" cy="30" r="18" fill="#F472B6" opacity="0.5"/>
  <rect x="18" y="20" width="24" height="20" rx="2" fill="#BE185D"/>
  <line x1="22" y1="26" x2="36" y2="26" stroke="#FCE7F3" stroke-width="2" stroke-linecap="round"/>
  <line x1="22" y1="30" x2="36" y2="30" stroke="#FCE7F3" stroke-width="2" stroke-linecap="round"/>
  <line x1="22" y1="34" x2="32" y2="34" stroke="#FCE7F3" stroke-width="2" stroke-linecap="round"/>
</svg>
<div style="margin-top:5px">
<span style="font-size:11px;font-weight:700;color:#BE185D;font-family:Arial,sans-serif;text-transform:uppercase">CRM</span>
</div>
</div>
</td>

<!-- Mobile Design -->
<td style="padding:8px 10px" align="center">
<div style="text-align:center">
<svg width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" class="service-icon">
  <rect x="20" y="10" width="20" height="40" rx="3" fill="#FED7AA" opacity="0.3"/>
  <rect x="21" y="11" width="18" height="38" rx="2.5" fill="#FB923C" opacity="0.5"/>
  <rect x="22" y="12" width="16" height="36" rx="2" fill="#C2410C"/>
  <rect x="24" y="16" width="12" height="24" rx="1" fill="#FFF7ED"/>
  <circle cx="30" cy="43" r="1.5" fill="#FFF7ED"/>
</svg>
<div style="margin-top:5px">
<span style="font-size:11px;font-weight:700;color:#C2410C;font-family:Arial,sans-serif;text-transform:uppercase">Mobile</span>
</div>
</div>
</td>

<!-- Performance -->
<td style="padding:8px 10px" align="center">
<div style="text-align:center">
<svg width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" class="service-icon">
  <circle cx="30" cy="30" r="24" fill="#FEF9C3" opacity="0.3"/>
  <circle cx="30" cy="30" r="18" fill="#FCD34D" opacity="0.4"/>
  <path d="M30 12L34 24L46 26L36 34L39 46L30 40L21 46L24 34L14 26L26 24L30 12Z" fill="#CA8A04"/>
  <circle cx="30" cy="30" r="6" fill="#FEF3C7"/>
</svg>
<div style="margin-top:5px">
<span style="font-size:11px;font-weight:700;color:#CA8A04;font-family:Arial,sans-serif;text-transform:uppercase">Speed</span>
</div>
</div>
</td>
</tr>
</table>

</td></tr>
</table>
</td>
<td width="12%" valign="middle" align="right" class="pattern-column">
<svg width="70" height="140" viewBox="0 0 70 140" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="35" cy="22" r="13" fill="#FDE047" opacity="0.35"/>
  <rect x="25" y="58" width="22" height="22" rx="3" fill="#22D3EE" opacity="0.3"/>
  <polygon points="20,100 35,115 50,100" fill="#FB7185" opacity="0.35"/>
  <circle cx="40" cy="130" r="10" fill="#FB923C" opacity="0.3"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- Primary CTA Button with geometric accents -->
<tr><td style="padding:20px 25px 18px 25px;background:#06B6D4" class="mobile-padding">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="12%" valign="middle" class="pattern-column">
<svg width="70" height="80" viewBox="0 0 70 80" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="25" y="18" width="18" height="18" rx="2" fill="#FDE047" opacity="0.4"/>
  <circle cx="35" cy="55" r="12" fill="#FCD34D" opacity="0.35"/>
</svg>
</td>
<td width="76%" align="center">
<table cellpadding="0" cellspacing="0" border="0" style="background:#EC4899;border-radius:50px;box-shadow:0 8px 25px rgba(251,113,133,0.5);display:inline-block">
<tr><td class="cta-button" style="padding:18px 60px">
<a href="https://diamondbackcoding.com?utm_source=email&utm_medium=spring-sale&utm_campaign=25off" style="color:#ffffff;font-size:16px;font-weight:900;text-decoration:none;text-transform:uppercase;letter-spacing:1.8px;font-family:Arial Black,Arial,sans-serif;display:block">Claim Your 25% Discount</a>
</td></tr>
</table>
</td>
<td width="12%" valign="middle" align="right" class="pattern-column">
<svg width="70" height="80" viewBox="0 0 70 80" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="35" cy="22" r="13" fill="#22D3EE" opacity="0.4"/>
  <rect x="27" y="50" width="20" height="20" rx="3" fill="#F472B6" opacity="0.35"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- Secondary CTA Text Link -->
<tr><td align="center" style="padding:0 35px 20px 35px;background:#06B6D4" class="mobile-padding">
<span style="color:#ffffff;font-size:13px;font-family:Arial,sans-serif;line-height:1.5">
Not ready yet? <a href="https://diamondbackcoding.com/schedule?utm_source=email&utm_medium=spring-sale&utm_campaign=25off" style="color:#FEF3C7;font-weight:700;text-decoration:underline">Schedule a free consultation</a>
</span>
</td></tr>

<!-- Bottom Decorative Spring Icons with enhanced patterns -->
<tr><td style="padding:15px 0 20px 0;background:#06B6D4">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="15%" valign="bottom" style="padding:0 0 10px 8px" class="pattern-column">
<svg width="80" height="100" viewBox="0 0 80 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="15" y="12" width="22" height="22" rx="3" fill="#FB923C" opacity="0.35"/>
  <circle cx="55" cy="50" r="14" fill="#FCD34D" opacity="0.3"/>
  <polygon points="25,75 40,90 10,90" fill="#F472B6" opacity="0.35"/>
</svg>
</td>
<td width="70%" align="center" style="padding:0 10px">
<table cellpadding="0" cellspacing="0" border="0" style="display:inline-block">
<tr>
<td style="padding:0 6px">
<svg width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 6C19 6 13 10 13 19C13 28 16 32 19 32V6Z" fill="#FCD34D" opacity="0.8"/>
  <path d="M19 6C19 6 25 10 25 19C25 28 22 32 19 32V6Z" fill="#FCD34D" opacity="0.5"/>
</svg>
</td>
<td style="padding:0 6px">
<svg width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="19" cy="19" r="17" stroke="#FB7185" stroke-width="2.5" opacity="0.8"/>
  <circle cx="19" cy="19" r="10" fill="#FDE047" opacity="0.9"/>
</svg>
</td>
<td style="padding:0 6px">
<svg width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="15.5" width="22" height="7" rx="3.5" fill="#F472B6" opacity="0.7"/>
  <rect x="15.5" y="8" width="7" height="22" rx="3.5" fill="#F472B6" opacity="0.7"/>
</svg>
</td>
<td style="padding:0 6px">
<svg width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="19" cy="10" r="4" fill="#FB923C" opacity="0.8"/>
  <circle cx="28" cy="19" r="4" fill="#FB923C" opacity="0.8"/>
  <circle cx="19" cy="28" r="4" fill="#FB923C" opacity="0.8"/>
  <circle cx="10" cy="19" r="4" fill="#FB923C" opacity="0.8"/>
  <circle cx="19" cy="19" r="5" fill="#FDE047" opacity="0.9"/>
</svg>
</td>
<td style="padding:0 6px">
<svg width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 6C19 6 25 10 25 19C25 28 22 32 19 32V6Z" fill="#22D3EE" opacity="0.7"/>
  <path d="M19 6C19 6 13 10 13 19C13 28 16 32 19 32V6Z" fill="#22D3EE" opacity="0.5"/>
</svg>
</td>
</tr>
</table>
</td>
<td width="15%" valign="bottom" style="padding:0 8px 10px 0" align="right" class="pattern-column">
<svg width="80" height="100" viewBox="0 0 80 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="25" cy="22" r="15" fill="#FDE047" opacity="0.35"/>
  <rect x="45" y="40" width="24" height="24" rx="3" fill="#22D3EE" opacity="0.3"/>
  <polygon points="40,80 25,95 55,95" fill="#FB7185" opacity="0.35"/>
</svg>
</td>
</tr>
</table>
</td></tr>

<!-- Wavy Bottom Border -->
<tr><td style="padding:0;background:#06B6D4">
<svg width="600" height="35" viewBox="0 0 600 35" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto">
  <path d="M0 10C100 3 200 18 300 10C400 3 500 18 600 10V35H0V10Z" fill="#FB923C"/>
  <path d="M0 3C100 10 200 0 300 7C400 14 500 3 600 10V35H0V3Z" fill="#FCD34D" opacity="0.6"/>
</svg>
</td></tr>

<!-- Footer -->
<tr><td style="background:#FB923C;padding:25px 35px 30px 35px" class="mobile-padding">
<table width="100%" cellpadding="0" cellspacing="0" border="0">

<!-- Offer Details -->
<tr><td align="center" style="font-size:11px;line-height:1.5;color:#ffffff;padding:0 0 18px 0;font-family:Arial,sans-serif;font-weight:600">
Limited Time Offer: Valid February 9 - April 30, 2026<br>
New clients only. 25% discount applies to initial project quote. Terms apply.
</td></tr>

<!-- Social Media Icons - PROVEN EMAIL-COMPATIBLE APPROACH -->
<tr><td align="center" style="padding:0 0 18px 0">
<table cellpadding="0" cellspacing="0" border="0" style="display:inline-block">
<tr>
<!-- Instagram -->
<td style="padding:0 10px">
<a href="https://instagram.com/diamondbackcoding" style="display:block;text-decoration:none;line-height:0">
<table cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:8px;width:40px;height:40px">
<tr><td align="center" valign="middle">
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="2" y="2" width="20" height="20" rx="5" stroke="#FB923C" stroke-width="1.8"/>
<circle cx="12" cy="12" r="4" stroke="#FB923C" stroke-width="1.8"/>
<circle cx="18.5" cy="5.5" r="1.2" fill="#FB923C"/>
</svg>
</td></tr>
</table>
</a>
</td>
<!-- TikTok -->
<td style="padding:0 10px">
<a href="https://tiktok.com/@diamondbackcoding" style="display:block;text-decoration:none;line-height:0">
<table cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:8px;width:40px;height:40px">
<tr><td align="center" valign="middle">
<svg width="20" height="24" viewBox="0 0 20 24" fill="#FB923C" xmlns="http://www.w3.org/2000/svg">
<path d="M16.6 5.82s.51.5 0 0A4.278 4.278 0 0 1 15.54 3h-3.09v12.4a2.592 2.592 0 0 1-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6 0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64 0 3.33 2.76 5.7 5.69 5.7 3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3s-1.88.09-3.24-1.48z"/>
</svg>
</td></tr>
</table>
</a>
</td>
<!-- Facebook -->
<td style="padding:0 10px">
<a href="https://facebook.com/diamondbackcoding" style="display:block;text-decoration:none;line-height:0">
<table cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:8px;width:40px;height:40px">
<tr><td align="center" valign="middle">
<svg width="12" height="24" viewBox="0 0 12 24" fill="#FB923C" xmlns="http://www.w3.org/2000/svg">
<path d="M11.25 0.104C11.25 0.104 8.36 0 7.28 0c-1.583 0-3.296 0.595-3.296 2.641 0 2.14 0 3.131 0 3.131H2.25v3.484h1.734V24h4.031V9.256h2.729l0.356-3.484H8.015c0 0 0-1.308 0-2.011 0-0.705 0.73-0.661 0.773-0.661 0.62 0 1.984 0 1.984 0V0.104h-0.522z"/>
</svg>
</td></tr>
</table>
</a>
</td>
</tr>
</table>
</td></tr>

<!-- Unsubscribe -->
<tr><td align="center" style="font-size:10px;color:#ffffff;padding:0 0 6px 0;font-family:Arial,sans-serif">
No longer want to receive these emails? <a href="https://diamondbackcoding.com/unsubscribe?email={{EMAIL}}" style="color:#ffffff;text-decoration:underline;font-weight:400">Unsubscribe</a> | <a href="https://diamondbackcoding.com/preferences?email={{EMAIL}}" style="color:#ffffff;text-decoration:underline;font-weight:400">Update Preferences</a>
</td></tr>

<!-- Company Info -->
<tr><td align="center" style="font-size:10px;color:#ffffff;padding:0;font-family:Arial,sans-serif;line-height:1.5">
<strong>Diamondbackcoding</strong> · Web Development & CRM Solutions<br>
15709 Spillman Ranch Loop · Austin, TX 78738<br>
<a href="tel:+15125121234" style="color:#ffffff;text-decoration:none">512-512-1234</a> | <a href="mailto:hello@diamondbackcoding.com" style="color:#ffffff;text-decoration:none">hello@diamondbackcoding.com</a>
</td></tr>

</table>
</td></tr>

</table>

</td></tr>
</table>

</body>
</html>`;
            
        } else if (template === 'zerotransactionfees') {
            // Generate unsubscribe token
            let unsubToken = lead.unsubscribe_token;
            if (!unsubToken) {
                unsubToken = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, leadId]);
            }
            const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;
            
            emailHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zero Transaction Fees | Diamondback Coding</title>
<style>
@media only screen and (max-width: 620px) {
  .wrap { width: 100% !important; }
  .hero-num { font-size: 64px !important; }
  .hero-label { font-size: 10px !important; }
  .stat-cell { padding: 22px 8px !important; }
  .section-pad { padding: 36px 24px !important; }
  .diff-icon-cell { display: none !important; }
  .diff-text { padding-left: 0 !important; }
  .cta-btn a { font-size: 15px !important; padding: 16px 28px !important; }
  .brand-size { font-size: 14px !important; letter-spacing: 2px !important; }
  .compare-col { display: block !important; width: 100% !important; }
  .compare-vs { display: none !important; }
  .save-amount { font-size: 36px !important; }
  .row-revenue { font-size: 18px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#F7F9FB;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F9FB;">
<tr><td align="center" style="padding:32px 16px 48px;">

<table class="wrap" width="620" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;">

<!-- HEADER -->
<tr><td style="background:#FFFFFF;border-radius:3px 3px 0 0;padding:26px 40px 26px;" class="section-pad">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td valign="middle">
      <span class="brand-size" style="font-size:12px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:#111111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">DIAMONDBACK CODING</span>
    </td>
    <td align="right" valign="middle">
      <table cellpadding="0" cellspacing="0" border="0" style="background:#FF6B35;border-radius:2px;">
      <tr><td style="padding:6px 14px;">
        <span style="color:#FFFFFF;font-size:9px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">NATIONWIDE</span>
      </td></tr>
      </table>
    </td>
  </tr>
  </table>
</td></tr>

<!-- SEPARATOR -->
<tr><td style="background:#FFFFFF;padding:0;height:1px;"></td></tr>

<!-- HERO -->
<tr><td style="background:#FFFFFF;padding:48px 40px 56px;" class="section-pad">
  <p style="margin:0 0 18px;font-size:10px;font-weight:800;letter-spacing:3.5px;text-transform:uppercase;color:#FF6B35;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">A message for business owners nationwide</p>
  <p style="margin:0 0 22px;font-size:48px;font-weight:800;color:#2D3142;line-height:1.02;letter-spacing:-1.8px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Every sale you make,<br>they take a cut.</p>
  <p style="margin:0;font-size:16px;font-weight:400;color:#666666;line-height:1.7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Shopify. Squarespace. Wix. They all charge 2–5% on every transaction you process. On $200K in annual sales, that's up to <span style="color:#2D3142;font-weight:600;">$10,000 quietly disappearing</span> every single year. We don't do that.</p>
</td></tr>

<!-- STAT BAR -->
<tr><td style="background:#FFC15E;padding:0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td class="stat-cell" width="33%" align="center" style="padding:30px 16px;border-right:1px solid rgba(0,0,0,0.08);">
      <p class="hero-num" style="margin:0;font-size:48px;font-weight:900;color:#2D3142;line-height:1;letter-spacing:-2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">$0</p>
      <p class="hero-label" style="margin:7px 0 0;font-size:9px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;color:#664D00;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Transaction Fees</p>
    </td>
    <td class="stat-cell" width="33%" align="center" style="padding:30px 16px;border-right:1px solid rgba(0,0,0,0.08);">
      <p class="hero-num" style="margin:0;font-size:48px;font-weight:900;color:#2D3142;line-height:1;letter-spacing:-2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">0%</p>
      <p class="hero-label" style="margin:7px 0 0;font-size:9px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;color:#664D00;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Revenue Cut</p>
    </td>
    <td class="stat-cell" width="33%" align="center" style="padding:30px 16px;">
      <p class="hero-num" style="margin:0;font-size:48px;font-weight:900;color:#2D3142;line-height:1;letter-spacing:-2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">100%</p>
      <p class="hero-label" style="margin:7px 0 0;font-size:9px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;color:#664D00;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Stays Yours</p>
    </td>
  </tr>
  </table>
</td></tr>

<!-- SAVINGS COMPARISON -->
<tr><td style="background:#FFFFFF;padding:52px 40px 48px;" class="section-pad">

  <p style="margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:3.5px;text-transform:uppercase;color:#FF6B35;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Run the numbers</p>
  <p style="margin:0 0 10px;font-size:30px;font-weight:800;color:#111111;letter-spacing:-1px;line-height:1.1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Here's what you're<br>handing over every year</p>
  <p style="margin:0 0 36px;font-size:14px;color:#888888;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Based on a 3% platform transaction fee — many charge more.</p>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;">
  <tr>
    <td width="34%" style="padding-bottom:10px;font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#AAAAAA;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Your Sales</td>
    <td width="33%" align="center" style="padding-bottom:10px;font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#CC2222;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Other Platforms</td>
    <td width="33%" align="center" style="padding-bottom:10px;font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#1A7A3A;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Diamondback</td>
  </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
  <tr>
    <td width="34%" valign="middle" style="padding:20px 16px 20px 0;">
      <p class="row-revenue" style="margin:0;font-size:20px;font-weight:800;color:#111111;letter-spacing:-0.5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">$75K<span style="font-size:13px;font-weight:500;color:#AAAAAA;letter-spacing:0;">/yr</span></p>
    </td>
    <td width="33%" valign="middle" align="center" style="padding:4px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFF0F0;border:1.5px solid #FFCCCC;border-radius:4px;">
      <tr><td align="center" style="padding:16px 8px;">
        <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#CC2222;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">You Lose</p>
        <p style="margin:4px 0 0;font-size:26px;font-weight:900;color:#CC2222;letter-spacing:-1px;line-height:1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">−$2,250</p>
      </td></tr>
      </table>
    </td>
    <td width="33%" valign="middle" align="center" style="padding:4px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F0FAF3;border:1.5px solid #AADCBB;border-radius:4px;">
      <tr><td align="center" style="padding:16px 8px;">
        <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#1A7A3A;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">You Keep</p>
        <p style="margin:4px 0 0;font-size:26px;font-weight:900;color:#1A7A3A;letter-spacing:-1px;line-height:1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">$2,250</p>
      </td></tr>
      </table>
    </td>
  </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
  <tr>
    <td width="34%" valign="middle" style="padding:20px 16px 20px 0;">
      <p class="row-revenue" style="margin:0;font-size:20px;font-weight:800;color:#111111;letter-spacing:-0.5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">$200K<span style="font-size:13px;font-weight:500;color:#AAAAAA;letter-spacing:0;">/yr</span></p>
    </td>
    <td width="33%" valign="middle" align="center" style="padding:4px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFF0F0;border:1.5px solid #FFCCCC;border-radius:4px;">
      <tr><td align="center" style="padding:16px 8px;">
        <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#CC2222;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">You Lose</p>
        <p style="margin:4px 0 0;font-size:26px;font-weight:900;color:#CC2222;letter-spacing:-1px;line-height:1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">−$6,000</p>
      </td></tr>
      </table>
    </td>
    <td width="33%" valign="middle" align="center" style="padding:4px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F0FAF3;border:1.5px solid #AADCBB;border-radius:4px;">
      <tr><td align="center" style="padding:16px 8px;">
        <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#1A7A3A;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">You Keep</p>
        <p style="margin:4px 0 0;font-size:26px;font-weight:900;color:#1A7A3A;letter-spacing:-1px;line-height:1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">$6,000</p>
      </td></tr>
      </table>
    </td>
  </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;background:#FAFAFA;border-radius:4px;">
  <tr>
    <td width="34%" valign="middle" style="padding:22px 16px;">
      <p class="row-revenue" style="margin:0 0 2px;font-size:20px;font-weight:800;color:#111111;letter-spacing:-0.5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">$500K<span style="font-size:13px;font-weight:500;color:#AAAAAA;letter-spacing:0;">/yr</span></p>
      <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#D4A847;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Biggest impact</p>
    </td>
    <td width="33%" valign="middle" align="center" style="padding:4px 4px 4px 0;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFF0F0;border:2px solid #FF9999;border-radius:4px;">
      <tr><td align="center" style="padding:18px 8px;">
        <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#CC2222;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">You Lose</p>
        <p class="save-amount" style="margin:4px 0 0;font-size:32px;font-weight:900;color:#CC2222;letter-spacing:-1px;line-height:1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">−$15,000</p>
      </td></tr>
      </table>
    </td>
    <td width="33%" valign="middle" align="center" style="padding:4px 0 4px 4px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1A7A3A;border:2px solid #1A7A3A;border-radius:4px;">
      <tr><td align="center" style="padding:18px 8px;">
        <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#7ADDA0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">You Keep</p>
        <p class="save-amount" style="margin:4px 0 0;font-size:32px;font-weight:900;color:#FFFFFF;letter-spacing:-1px;line-height:1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">$15,000</p>
      </td></tr>
      </table>
    </td>
  </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#111111;border-radius:3px;">
  <tr><td style="padding:18px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td valign="middle">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:10px;">
          <circle cx="10" cy="10" r="9" stroke="#D4A847" stroke-width="1.5"/>
          <polyline points="5.5,10.5 8.5,13.5 14.5,7.5" stroke="#D4A847" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span style="font-size:14px;font-weight:600;color:#FFFFFF;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;vertical-align:middle;">With Diamondback, every dollar in that green column stays in your pocket.</span>
      </td>
    </tr>
    </table>
  </td></tr>
  </table>

</td></tr>

<!-- WHY WE'RE DIFFERENT -->
<tr><td style="background:#F8F8F8;padding:52px 40px 48px;" class="section-pad">
  <p style="margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:3.5px;text-transform:uppercase;color:#FF6B35;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">What sets us apart</p>
  <p style="margin:0 0 32px;font-size:30px;font-weight:800;color:#111111;letter-spacing:-1px;line-height:1.1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Built different.<br>For businesses like yours.</p>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border-radius:3px;margin-bottom:10px;">
  <tr>
    <td class="diff-icon-cell" width="64" valign="top" style="padding:28px 0 28px 28px;">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="14" cy="11" r="4" stroke="#FFC15E" stroke-width="1.8"/>
        <path d="M14 3C8.477 3 4 7.477 4 13c0 6.5 10 15 10 15s10-8.5 10-15C24 7.477 19.523 3 14 3z" stroke="#FFC15E" stroke-width="1.8" fill="none"/>
      </svg>
    </td>
    <td class="diff-text" valign="middle" style="padding:26px 26px 26px 16px;">
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#111111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Serving businesses nationwide</p>
      <p style="margin:0;font-size:13px;color:#777777;line-height:1.65;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Real people, real conversations. No support tickets. Just a dedicated team that picks up the phone wherever you are.</p>
    </td>
  </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border-radius:3px;margin-bottom:10px;">
  <tr>
    <td class="diff-icon-cell" width="64" valign="top" style="padding:24px 0 24px 24px;">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polyline points="9,9 3,14 9,19" stroke="#FFC15E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="19,9 25,14 19,19" stroke="#FFC15E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="17" y1="6" x2="11" y2="22" stroke="#FFC15E" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </td>
    <td class="diff-text" valign="middle" style="padding:22px 22px 22px 14px;">
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#111111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Custom-built, not templated</p>
      <p style="margin:0;font-size:13px;color:#777777;line-height:1.65;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Your business isn't generic. Your site shouldn't be either. Every build starts from scratch — not a $12 theme 10,000 others are using.</p>
    </td>
  </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFF5E6;border-radius:3px;margin-bottom:10px;border:1.5px solid #FFC15E;">
  <tr>
    <td class="diff-icon-cell" width="64" valign="top" style="padding:24px 0 24px 24px;">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="8" width="18" height="13" rx="2" stroke="#FF6B35" stroke-width="1.8"/>
        <line x1="5" y1="13" x2="23" y2="13" stroke="#FF6B35" stroke-width="1.8"/>
        <line x1="10" y1="17.5" x2="14" y2="17.5" stroke="#FF6B35" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="14" cy="5" r="2" stroke="#FF6B35" stroke-width="1.5"/>
        <line x1="14" y1="7" x2="14" y2="8" stroke="#FF6B35" stroke-width="1.5"/>
        <line x1="8" y1="5" x2="5" y2="5" stroke="#FF6B35" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="20" y1="5" x2="23" y2="5" stroke="#FF6B35" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </td>
    <td class="diff-text" valign="middle" style="padding:22px 22px 22px 14px;">
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#111111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Zero transaction fees — ever</p>
      <p style="margin:0;font-size:13px;color:#555555;line-height:1.65;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">We charge once for the work. After that, every dollar you earn is yours — not split with a platform that didn't do anything.</p>
    </td>
  </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border-radius:3px;">
  <tr>
    <td class="diff-icon-cell" width="64" valign="top" style="padding:24px 0 24px 24px;">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polygon points="14,3 25,8.5 25,19.5 14,25 3,19.5 3,8.5" stroke="#FFC15E" stroke-width="1.8" stroke-linejoin="round" fill="none"/>
        <circle cx="14" cy="14" r="4" stroke="#FFC15E" stroke-width="1.8"/>
      </svg>
    </td>
    <td class="diff-text" valign="middle" style="padding:22px 22px 22px 14px;">
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#111111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Website + CRM + SEO — one team</p>
      <p style="margin:0;font-size:13px;color:#777777;line-height:1.65;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Stop managing three different vendors. We handle your full digital stack — built to work together from day one.</p>
    </td>
  </tr>
  </table>

</td></tr>

<!-- CTA -->
<tr><td style="background:#FFC15E;padding:56px 40px;" class="section-pad">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center">
    <p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:3.5px;text-transform:uppercase;color:#664D00;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">No obligation. No pitch deck.</p>
    <p style="margin:0 0 28px;font-size:36px;font-weight:800;color:#2D3142;line-height:1.05;letter-spacing:-1.2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">15 minutes.<br>Find out what you're losing.</p>
    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;" class="cta-btn">
    <tr><td style="background:#FF6B35;border-radius:2px;">
      <a href="https://diamondbackcoding.com/contact.html" style="display:block;padding:18px 52px;font-size:15px;font-weight:800;color:#FFFFFF;text-decoration:none;letter-spacing:1px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Schedule a Call</a>
    </td></tr>
    </table>
    <p style="margin:20px 0 0;font-size:13px;color:#664D00;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Or call us directly: <a href="tel:+15129800393" style="color:#2D3142;font-weight:700;text-decoration:none;">(512) 980-0393</a></p>
  </td></tr>
  </table>
</td></tr>

<!-- FOOTER -->
<tr><td style="background:#2D3142;padding:32px 40px;border-radius:0 0 3px 3px;" class="section-pad">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td valign="top">
      <p style="margin:0 0 6px;font-size:11px;font-weight:800;color:#FFFFFF;letter-spacing:2.5px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Diamondback Coding</p>
      <p style="margin:0;font-size:12px;color:#B8B8B8;line-height:1.8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        5000 Plaza on the Lake, Suite 100 PMB 2017<br>
        Austin, TX 78746<br>
        <a href="tel:+15129800393" style="color:#FF6B35;text-decoration:none;">(512) 980-0393</a>
      </p>
    </td>
    <td align="right" valign="top">
      <p style="margin:0 0 8px;"><a href="https://diamondbackcoding.com" style="color:#B8B8B8;font-size:11px;text-decoration:none;letter-spacing:1.5px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Website</a></p>
      <p style="margin:0;"><a href="https://instagram.com/diamondbackcoding" style="color:#B8B8B8;font-size:11px;text-decoration:none;letter-spacing:1.5px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Instagram</a></p>
    </td>
  </tr>
  <tr><td colspan="2" style="padding-top:22px;border-top:1px solid #454B5F;">
    <p style="margin:0;font-size:11px;color:#7A7F8F;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      You received this because you previously connected with Diamondback Coding. &nbsp;
      <a href="${unsubUrl}" style="color:#7A7F8F;text-decoration:underline;">Unsubscribe</a>
    </p>
  </td></tr>
  </table>
</td></tr>

</table>
</td></tr>
</table>

</body>
</html>`;
            
        } else if (template === 'followup1' || template === 'followup2' || template === 'followup3' || template === 'followupindefinite') {
            // ── FOLLOW-UP SEQUENCE TEMPLATES ──────────────────────────────
            // All share the same clean design language as Zero Transaction Fees
            // but with follow-up-specific headlines and CTAs.

            let unsubToken = lead.unsubscribe_token;
            if (!unsubToken) {
                unsubToken = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, leadId]);
            }
            const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;

            const followupContent = {
                followup1: {
                    eyebrow: 'Just a quick note',
                    headline: 'Still thinking it over?',
                    subhead: `Hi ${lead.name || 'there'} — I wanted to check in on my previous message.`,
                    body: `We help businesses like yours build custom websites and CRM platforms — owned by you, no subscriptions, no transaction fees. If you haven't had a chance to look us over, I'd love just five minutes of your time.`,
                    ctaLabel: 'Schedule a Quick Call',
                    ctaUrl: 'https://diamondbackcoding.com/contact.html',
                    accentColor: '#FF6B35',
                    tagline: 'YOUR VISION. OUR CODE.',
                },
                followup2: {
                    eyebrow: 'Following up again',
                    headline: 'You keep 100% of your revenue.',
                    subhead: `Hi ${lead.name || 'there'} — just circling back one more time.`,
                    body: `Platforms like Shopify and Squarespace quietly take 2–5% of every sale you make. With a custom Diamondback site, that money stays in your pocket — forever. For a business doing $200K/year, that's up to $10,000 back in your pocket annually.`,
                    ctaLabel: 'See How Much You Could Save',
                    ctaUrl: 'https://diamondbackcoding.com/contact.html',
                    accentColor: '#1A7A3A',
                    tagline: 'ZERO TRANSACTION FEES.',
                },
                followup3: {
                    eyebrow: 'One last thing',
                    headline: 'No pressure — just wanted you to have this.',
                    subhead: `Hi ${lead.name || 'there'},`,
                    body: `I won't keep filling your inbox. But before I go, I'd love for you to know that our clients get custom-built websites they fully own, CRM systems tailored to how they work, and real human support. No templates. No platform lock-in. If the timing ever makes sense, we'll be here.`,
                    ctaLabel: 'Take a Look When You\'re Ready',
                    ctaUrl: 'https://diamondbackcoding.com',
                    accentColor: '#2D3142',
                    tagline: 'BUILT FOR YOUR BUSINESS.',
                },
                followupindefinite: {
                    eyebrow: 'Checking in',
                    headline: 'We\'re still here when you\'re ready.',
                    subhead: `Hi ${lead.name || 'there'} — hope things are going well.`,
                    body: `We know timing isn't always right. When it is, we'd love to talk about how a custom website or CRM can take work off your plate and keep more revenue in your business. No obligation — just a conversation.`,
                    ctaLabel: 'Let\'s Talk',
                    ctaUrl: 'https://diamondbackcoding.com/contact.html',
                    accentColor: '#FF6B35',
                    tagline: 'DIAMONDBACK CODING.',
                },
            };

            const fc = followupContent[template];

            emailHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${emailSubject}</title>
<style>
@media only screen and (max-width: 620px) {
  .wrap { width: 100% !important; }
  .section-pad { padding: 36px 24px !important; }
  .headline { font-size: 32px !important; }
  .cta-btn a { font-size: 15px !important; padding: 16px 28px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#F7F9FB;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F9FB;">
<tr><td align="center" style="padding:32px 16px 48px;">

<table class="wrap" width="620" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;">

<!-- HEADER -->
<tr><td style="background:#FFFFFF;border-radius:3px 3px 0 0;padding:26px 40px;" class="section-pad">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td valign="middle">
      <span style="font-size:12px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:#111111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">DIAMONDBACK CODING</span>
    </td>
    <td align="right" valign="middle">
      <table cellpadding="0" cellspacing="0" border="0" style="background:${fc.accentColor};border-radius:2px;">
      <tr><td style="padding:6px 14px;">
        <span style="color:#FFFFFF;font-size:9px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${fc.tagline}</span>
      </td></tr>
      </table>
    </td>
  </tr>
  </table>
</td></tr>

<!-- SEPARATOR -->
<tr><td style="background:#FFFFFF;height:1px;padding:0;"></td></tr>

<!-- HERO -->
<tr><td style="background:#FFFFFF;padding:48px 40px 56px;" class="section-pad">
  <p style="margin:0 0 18px;font-size:10px;font-weight:800;letter-spacing:3.5px;text-transform:uppercase;color:${fc.accentColor};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${fc.eyebrow}</p>
  <p class="headline" style="margin:0 0 22px;font-size:42px;font-weight:800;color:#2D3142;line-height:1.08;letter-spacing:-1.5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${fc.headline}</p>
  <p style="margin:0 0 16px;font-size:16px;font-weight:500;color:#444444;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${fc.subhead}</p>
  <p style="margin:0;font-size:15px;font-weight:400;color:#666666;line-height:1.75;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${fc.body}</p>
</td></tr>

<!-- CTA -->
<tr><td style="background:#F7F9FB;padding:40px 40px 48px;" class="section-pad">
  <table cellpadding="0" cellspacing="0" border="0">
  <tr class="cta-btn"><td style="background:${fc.accentColor};border-radius:3px;">
    <a href="${fc.ctaUrl}" style="display:block;padding:18px 40px;font-size:16px;font-weight:800;color:#FFFFFF;text-decoration:none;letter-spacing:0.5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${fc.ctaLabel}</a>
  </td></tr>
  </table>
  <p style="margin:20px 0 0;font-size:13px;color:#999999;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Or reply directly to this email — we read every one.</p>
</td></tr>

<!-- FOOTER -->
<tr><td style="background:#2D3142;padding:32px 40px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td valign="top">
      <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#FFFFFF;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Diamondback Coding</p>
      <p style="margin:0;font-size:11px;color:#B8B8B8;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        Web Development &amp; CRM Solutions<br>
        Austin, TX 78746<br>
        <a href="tel:+15129800393" style="color:${fc.accentColor};text-decoration:none;">(512) 980-0393</a>
      </p>
    </td>
    <td align="right" valign="top">
      <p style="margin:0 0 8px;"><a href="https://diamondbackcoding.com" style="color:#B8B8B8;font-size:11px;text-decoration:none;letter-spacing:1.5px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Website</a></p>
      <p style="margin:0;"><a href="https://instagram.com/diamondbackcoding" style="color:#B8B8B8;font-size:11px;text-decoration:none;letter-spacing:1.5px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Instagram</a></p>
    </td>
  </tr>
  <tr><td colspan="2" style="padding-top:22px;border-top:1px solid #454B5F;">
    <p style="margin:0;font-size:11px;color:#7A7F8F;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      You received this because you previously connected with Diamondback Coding. &nbsp;
      <a href="${unsubUrl}" style="color:#7A7F8F;text-decoration:underline;">Unsubscribe</a>
    </p>
  </td></tr>
  </table>
</td></tr>

</table>

</td></tr>
</table>

</body>
</html>`;

        } else if (template === 'checkin' || template === 'referralrequest' || template === 'thankyou' || template === 'proposal' || template === 'projectupdate' || template === 'invoicereminder' || template === 'projectcomplete') {
            // These use the branded buildEmailHTML wrapper with plain-text body
            emailHTML = buildEmailHTML(`
                <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${emailBody.replace(/\n/g, '<br>').replace(/^ +/gm, '')}</div>
                <div class="sign-off">
                    <p>Warm regards,</p>
                    <p class="team-name">The Diamondback Coding Team</p>
                </div>
            `, { unsubscribeUrl });

        } else {
            // Use standard wrapper for other templates
            emailHTML = buildEmailHTML(`
                <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${emailBody.replace(/\n/g, '<br>').replace(/^ +/gm, '')}</div>

                <div class="sign-off">
                    <p>Warm regards,</p>
                    <p class="team-name">The Diamondback Coding Team</p>
                </div>
            `, { unsubscribeUrl });
        }

        // Create email_log entry and send with tracking pixel
        await sendTrackedEmail({ leadId, to: lead.email, subject: emailSubject, html: emailHTML });
        
        // ✅ CRITICAL: Do NOT update last_contact_date here!
        // The sendTrackedEmail function and tracking pixel endpoint handle this correctly:
        // - Email opens → status becomes 'opened' → lead advances
        // - 24 hours without bounce → status becomes 'sent' → lead advances
        // Updating immediately here was causing false hot leads!
        
        // Add note to lead
        let notes = [];
        try {
            if (lead.notes) {
                notes = JSON.parse(lead.notes);
            }
        } catch (e) {
            notes = [];
        }
        
        notes.push({
            text: `Follow-up email sent: "${emailSubject}"`,
            author: req.user.username || 'Admin',
            date: new Date().toISOString()
        });
        
        await pool.query(
            'UPDATE leads SET notes = $1 WHERE id = $2',
            [JSON.stringify(notes), leadId]
        );
        
        console.log(`[FOLLOW-UP] ⏳ Email queued for ${lead.email} - awaiting delivery confirmation`);
        
        res.json({
            success: true,
            message: 'Email queued - awaiting delivery confirmation (will confirm within 24 hours or when opened)',
            status: 'queued'
        });
        
    } catch (error) {
        console.error('[FOLLOW-UP] Email send error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send email',
            error: error.message
        });
    }
});

// ========================================
// BULK FOLLOW-UP EMAIL
// ========================================

// Send follow-up emails to multiple leads
app.post('/api/follow-ups/send-bulk', authenticateToken, async (req, res) => {
    try {
        const { leadIds, subject, message, template } = req.body;
        
        if (!leadIds || leadIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No leads selected'
            });
        }
        
        console.log(`[BULK FOLLOW-UP] Sending to ${leadIds.length} leads`);
        
        let successCount = 0;
        let failCount = 0;
        const errors = [];
        
        for (const leadId of leadIds) {
            try {
                // Call the single send endpoint logic
                const leadResult = await pool.query(
                    'SELECT * FROM leads WHERE id = $1',
                    [leadId]
                );
                
                if (leadResult.rows.length === 0) {
                    failCount++;
                    errors.push({ leadId, error: 'Lead not found' });
                    continue;
                }
                
                const lead = leadResult.rows[0];
                
                if (!lead.email) {
                    failCount++;
                    errors.push({ leadId, error: 'No email address' });
                    continue;
                }

                if (lead.unsubscribed) {
                    failCount++;
                    errors.push({ leadId, error: 'Lead has unsubscribed' });
                    continue;
                }
                
                // Send email (simplified - use template logic from above)
                let emailSubject = subject || `Following up - ${lead.name}`;
                let emailBody = message || `Hi ${lead.name}, just checking in...`;
                
                // Generate unsubscribe token
                let unsubscribeUrl = null;
                try {
                    let token = lead.unsubscribe_token;
                    if (!token) {
                        token = crypto.randomBytes(32).toString('hex');
                        await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [token, leadId]);
                    }
                    unsubscribeUrl = `${BASE_URL}/api/unsubscribe/${token}`;
                } catch (e) {
                    console.warn('[BULK] Could not generate unsubscribe token for lead', leadId);
                }

                const emailHTML = buildEmailHTML(`
                    <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${emailBody.replace(/\n/g, '<br>')}</div>

                    <div class="sign-off">
                        <p>Warm regards,</p>
                        <p class="team-name">The Diamondback Coding Team</p>
                    </div>
                `, { unsubscribeUrl });

                await sendTrackedEmail({ leadId, to: lead.email, subject: emailSubject, html: emailHTML });
                
                // DO NOT update last_contact_date here - it will be updated when email is confirmed
                // The sendTrackedEmail function handles this correctly now
                
                successCount++;
                
            } catch (error) {
                console.error(`[BULK] Error sending to lead ${leadId}:`, error);
                failCount++;
                errors.push({ leadId, error: error.message });
            }
        }
        
        console.log(`[BULK FOLLOW-UP] ⏳ Queued: ${successCount}, ❌ Failed: ${failCount}`);
        
        res.json({
            success: true,
            message: `Queued ${successCount} emails (awaiting confirmation), ${failCount} failed`,
            queuedCount: successCount,
            failCount,
            errors: errors.length > 0 ? errors : undefined
        });
        
    } catch (error) {
        console.error('[BULK FOLLOW-UP] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Bulk send failed',
            error: error.message
        });
    }
});


// Send bulk email to specific follow-up category
app.post('/api/follow-ups/send-by-category', authenticateToken, async (req, res) => {
    try {
        const { category, subject, message } = req.body;
        
        console.log(`[BULK CATEGORY] Sending to category: ${category}`);
        
        if (!category || !subject || !message) {
            return res.status(400).json({
                success: false,
                message: 'Category, subject, and message are required'
            });
        }
        
        // Valid categories
        const validCategories = ['never_contacted', '1_day', '3_day', '7_day', '14_day'];
        if (!validCategories.includes(category)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid category'
            });
        }
        
        // Get leads in this category
        const leadsResult = await pool.query(`
            SELECT 
                l.id,
                l.name,
                l.email,
                l.notes,  -- NEW: Fetch notes to update them
                l.unsubscribe_token,
                COALESCE(CURRENT_DATE - l.last_contact_date, 999) as days_since_contact
            FROM leads l
            WHERE l.status IN ('new', 'contacted', 'qualified', 'pending')
            AND l.is_customer = FALSE
            AND l.unsubscribed = FALSE
            AND l.email IS NOT NULL
            AND (
                CASE 
                    WHEN $1 = 'never_contacted' THEN l.last_contact_date IS NULL
                    WHEN $1 = '14_day' THEN (CURRENT_DATE - l.last_contact_date) >= 14
                    WHEN $1 = '7_day' THEN (CURRENT_DATE - l.last_contact_date) >= 7 AND (CURRENT_DATE - l.last_contact_date) < 14
                    WHEN $1 = '3_day' THEN (CURRENT_DATE - l.last_contact_date) >= 3 AND (CURRENT_DATE - l.last_contact_date) < 7
                    WHEN $1 = '1_day' THEN (CURRENT_DATE - l.last_contact_date) >= 1 AND (CURRENT_DATE - l.last_contact_date) < 3
                END
            )
        `, [category]);
        
        const leads = leadsResult.rows;
        
        if (leads.length === 0) {
            return res.json({
                success: true,
                message: 'No leads in this category',
                successCount: 0,
                failCount: 0
            });
        }
        
        console.log(`[BULK CATEGORY] Found ${leads.length} leads in ${category}`);
        
        let successCount = 0;
        let failCount = 0;
        const errors = [];
        
        // Send emails
        for (const lead of leads) {
            try {
                // Generate unsubscribe token
                let unsubscribeUrl = null;
                try {
                    let token = lead.unsubscribe_token;
                    if (!token) {
                        token = crypto.randomBytes(32).toString('hex');
                        await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [token, lead.id]);
                    }
                    unsubscribeUrl = `${BASE_URL}/api/unsubscribe/${token}`;
                } catch (e) {
                    console.warn('[BULK CATEGORY] Could not generate unsubscribe token for lead', lead.id);
                }

                const emailHTML = buildEmailHTML(`
                    <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${message.replace(/\n/g, '<br>')}</div>

                    <div class="sign-off">
                        <p>Warm regards,</p>
                        <p class="team-name">The Diamondback Coding Team</p>
                    </div>
                `, { unsubscribeUrl });

                await sendTrackedEmail({ leadId: lead.id, to: lead.email, subject, html: emailHTML });
                
                // ✅ CRITICAL: Do NOT update last_contact_date here!
                // The sendTrackedEmail function and tracking pixel endpoint handle this correctly
                // This was the 8th instance of the immediate update bug!
                
                // Add note to lead (without updating last_contact_date)
                let notes = [];
                try {
                    if (lead.notes) {
                        notes = JSON.parse(lead.notes);
                    }
                } catch (e) {
                    notes = [];
                }
                
                notes.push({
                    text: `Follow-up email sent: "${subject}"`,
                    author: req.user.username || 'Admin',
                    date: new Date().toISOString()
                });
                
                await pool.query(
                    'UPDATE leads SET notes = $1 WHERE id = $2',
                    [JSON.stringify(notes), lead.id]
                );
                
                successCount++;
                console.log(`[BULK CATEGORY] ✅ Sent to ${lead.email}`);
                
            } catch (error) {
                console.error(`[BULK CATEGORY] ❌ Error sending to ${lead.email}:`, error);
                failCount++;
                errors.push({ 
                    leadId: lead.id, 
                    email: lead.email,
                    error: error.message 
                });
            }
        }
        
        console.log(`[BULK CATEGORY] ✅ Complete: ${successCount} sent, ${failCount} failed`);
        
        res.json({
            success: true,
            message: `Sent ${successCount} emails to ${category} category, ${failCount} failed`,
            successCount,
            failCount,
            totalLeads: leads.length,
            errors: errors.length > 0 ? errors : undefined
        });
        
    } catch (error) {
        console.error('[BULK CATEGORY] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Bulk send failed',
            error: error.message
        });
    }
});


// ========================================
// SEND BULK EMAIL BY CATEGORY (frontend endpoint)
// Frontend calls POST /api/follow-ups/email-category
// with { category, subject, body }
// ========================================
app.post('/api/follow-ups/email-category', authenticateToken, async (req, res) => {
    try {
        // Frontend sends 'body', internal send-by-category uses 'message' — normalise here
        const { category, subject, body, message } = req.body;
        const emailMessage = body || message;

        console.log(`[EMAIL-CATEGORY] Sending to category: ${category}`);

        if (!category || !subject || !emailMessage) {
            return res.status(400).json({
                success: false,
                message: 'Category, subject, and body/message are required'
            });
        }

        const validCategories = ['never_contacted', '1_day', '3_day', '7_day', '14_day'];
        if (!validCategories.includes(category)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid category'
            });
        }

        // Fetch leads in this category, excluding unsubscribed
        const leadsResult = await pool.query(`
            SELECT 
                l.id,
                l.name,
                l.email,
                l.notes,
                l.unsubscribe_token
            FROM leads l
            WHERE l.status IN ('new', 'contacted', 'qualified', 'pending')
            AND l.is_customer = FALSE
            AND l.unsubscribed = FALSE
            AND l.email IS NOT NULL
            AND (
                CASE 
                    WHEN $1 = 'never_contacted' THEN l.last_contact_date IS NULL
                    WHEN $1 = '14_day' THEN (CURRENT_DATE - l.last_contact_date) >= 14
                    WHEN $1 = '7_day' THEN (CURRENT_DATE - l.last_contact_date) >= 7 AND (CURRENT_DATE - l.last_contact_date) < 14
                    WHEN $1 = '3_day' THEN (CURRENT_DATE - l.last_contact_date) >= 3 AND (CURRENT_DATE - l.last_contact_date) < 7
                    WHEN $1 = '1_day' THEN (CURRENT_DATE - l.last_contact_date) >= 1 AND (CURRENT_DATE - l.last_contact_date) < 3
                END
            )
        `, [category]);

        const leads = leadsResult.rows;

        if (leads.length === 0) {
            return res.json({
                success: true,
                message: 'No leads in this category',
                sent_count: 0,
                fail_count: 0
            });
        }

        console.log(`[EMAIL-CATEGORY] Found ${leads.length} leads in ${category}`);

        let sent_count = 0;
        let fail_count = 0;
        const errors = [];

        for (const lead of leads) {
            try {
                // Generate unsubscribe token if this lead doesn't have one yet
                let token = lead.unsubscribe_token;
                if (!token) {
                    token = crypto.randomBytes(32).toString('hex');
                    await pool.query(
                        'UPDATE leads SET unsubscribe_token = $1 WHERE id = $2',
                        [token, lead.id]
                    );
                }

                const unsubscribeUrl = `${BASE_URL}/api/unsubscribe/${token}`;

                const emailHTML = buildEmailHTML(`
                    <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${emailMessage.replace(/\n/g, '<br>')}</div>

                    <div class="sign-off">
                        <p>Warm regards,</p>
                        <p class="team-name">The Diamondback Coding Team</p>
                    </div>
                `, { unsubscribeUrl });

                await sendTrackedEmail({ leadId: lead.id, to: lead.email, subject, html: emailHTML });

                // ✅ CRITICAL: Do NOT update last_contact_date here!
                // The sendTrackedEmail function and tracking pixel endpoint handle this correctly
                // This was the 9th instance of the immediate update bug!

                // Append note to lead (without updating last_contact_date)
                let notes = [];
                try {
                    if (lead.notes) notes = JSON.parse(lead.notes);
                } catch (e) {
                    notes = [];
                }
                notes.push({
                    text: `Follow-up email sent: "${subject}"`,
                    author: req.user.username || 'Admin',
                    date: new Date().toISOString()
                });
                await pool.query(
                    'UPDATE leads SET notes = $1 WHERE id = $2',
                    [JSON.stringify(notes), lead.id]
                );

                sent_count++;
                console.log(`[EMAIL-CATEGORY] ✅ Sent to ${lead.email}`);

            } catch (error) {
                console.error(`[EMAIL-CATEGORY] ❌ Error sending to ${lead.email}:`, error);
                fail_count++;
                errors.push({ leadId: lead.id, email: lead.email, error: error.message });
            }
        }

        console.log(`[EMAIL-CATEGORY] ✅ Complete: ${sent_count} sent, ${fail_count} failed`);

        res.json({
            success: true,
            message: `Sent ${sent_count} emails to ${category} category, ${fail_count} failed`,
            sent_count,
            fail_count,
            totalLeads: leads.length,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('[EMAIL-CATEGORY] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Bulk send failed',
            error: error.message
        });
    }
});

// ========================================
// AUTO-CAMPAIGNS
// ========================================

// GET all campaigns (with lead info joined)
app.get('/api/auto-campaigns', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ac.*, l.name as lead_name, l.email as lead_email, l.project_type as lead_project_type, l.last_contact_date
            FROM auto_campaigns ac
            JOIN leads l ON l.id = ac.lead_id
            ORDER BY ac.created_at DESC
        `);
        res.json({ success: true, campaigns: result.rows });
    } catch (err) {
        console.error('[AUTO-CAMPAIGNS] GET error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch campaigns' });
    }
});

// POST create campaign + send first email immediately
app.post('/api/auto-campaigns', authenticateToken, async (req, res) => {
    try {
        const { leadId, subject, body } = req.body;
        if (!leadId || !subject || !body) {
            return res.status(400).json({ success: false, message: 'leadId, subject, and body are required' });
        }

        const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
        if (!leadResult.rows.length) return res.status(404).json({ success: false, message: 'Lead not found' });
        const lead = leadResult.rows[0];

        if (lead.unsubscribed) {
            return res.status(400).json({ success: false, message: 'This lead has unsubscribed from emails' });
        }

        // Block duplicate active campaign on same lead
        const existing = await pool.query('SELECT id FROM auto_campaigns WHERE lead_id = $1 AND is_active = TRUE', [leadId]);
        if (existing.rows.length) return res.status(409).json({ success: false, message: 'This lead already has an active auto-campaign' });

        // Personalize
        const personalizedBody = body
            .replace(/\{\{name\}\}/g, lead.name || 'there')
            .replace(/\{\{project_type\}\}/g, lead.project_type || 'your project');

        // Unsubscribe token
        let unsub = lead.unsubscribe_token;
        if (!unsub) {
            unsub = crypto.randomBytes(32).toString('hex');
            await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsub, leadId]);
        }
        const unsubscribeUrl = `${BASE_URL}/api/unsubscribe/${unsub}`;

        // Send first email with tracking
        const emailHTML = buildEmailHTML(`
            <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${personalizedBody.replace(/\n/g, '<br>')}</div>
            <div class="sign-off"><p>Warm regards,</p><p class="team-name">The Diamondback Coding Team</p></div>
        `, { unsubscribeUrl });

        await sendTrackedEmail({ leadId, to: lead.email, subject, html: emailHTML });

        // Insert campaign row
        const ins = await pool.query(`
            INSERT INTO auto_campaigns (lead_id, subject, body, is_active, last_sent_at)
            VALUES ($1, $2, $3, TRUE, CURRENT_TIMESTAMP) RETURNING *
        `, [leadId, subject, body]);

        // ✅ CRITICAL: Do NOT update last_contact_date here!
        // The sendTrackedEmail function and tracking pixel endpoint handle this correctly
        // This was ANOTHER instance of the immediate update bug!

        // Log note
        let notes = [];
        try { if (lead.notes) notes = JSON.parse(lead.notes); } catch(e) {}
        notes.push({ text: `[Auto-Campaign] Started — first email sent: "${subject}"`, author: req.user?.username || 'Admin', date: new Date().toISOString() });
        await pool.query('UPDATE leads SET notes = $1 WHERE id = $2', [JSON.stringify(notes), leadId]);

        console.log(`[AUTO-CAMPAIGNS] ✅ Created #${ins.rows[0].id} for lead ${leadId}`);
        res.json({ success: true, campaign: ins.rows[0] });
    } catch (err) {
        console.error('[AUTO-CAMPAIGNS] POST error:', err);
        res.status(500).json({ success: false, message: 'Failed to create campaign: ' + err.message });
    }
});

// PUT edit subject/body
app.put('/api/auto-campaigns/:id', authenticateToken, async (req, res) => {
    try {
        const { subject, body } = req.body;
        if (!subject || !body) return res.status(400).json({ success: false, message: 'subject and body required' });
        const result = await pool.query(`UPDATE auto_campaigns SET subject=$1, body=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *`, [subject, body, req.params.id]);
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Campaign not found' });
        res.json({ success: true, campaign: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update' });
    }
});

// PATCH toggle active/paused
app.patch('/api/auto-campaigns/:id/toggle', authenticateToken, async (req, res) => {
    try {
        const cur = await pool.query('SELECT * FROM auto_campaigns WHERE id=$1', [req.params.id]);
        if (!cur.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
        const newVal = !cur.rows[0].is_active;
        const result = await pool.query(`UPDATE auto_campaigns SET is_active=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *`, [newVal, req.params.id]);

        // Note on lead
        const lead = await pool.query('SELECT notes FROM leads WHERE id=$1', [cur.rows[0].lead_id]);
        if (lead.rows.length) {
            let notes = [];
            try { if (lead.rows[0].notes) notes = JSON.parse(lead.rows[0].notes); } catch(e) {}
            notes.push({ text: `[Auto-Campaign] ${newVal ? 'Resumed' : 'Paused'}`, author: req.user?.username || 'Admin', date: new Date().toISOString() });
            await pool.query('UPDATE leads SET notes=$1 WHERE id=$2', [JSON.stringify(notes), cur.rows[0].lead_id]);
        }
        res.json({ success: true, campaign: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Toggle failed' });
    }
});

// DELETE remove campaign
app.delete('/api/auto-campaigns/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM auto_campaigns WHERE id=$1 RETURNING *', [req.params.id]);
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true, message: 'Campaign removed' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Delete failed' });
    }
});

// POST run-due — fires emails for active campaigns where last_sent_at >= 1 day ago
// Called by the frontend each time the follow-ups page loads
app.post('/api/auto-campaigns/run-due', authenticateToken, async (req, res) => {
    try {
        console.log('[AUTO-CAMPAIGNS] Checking for due campaigns...');
        const due = await pool.query(`
            SELECT ac.*, 
                   l.name as lead_name, 
                   l.email as lead_email, 
                   l.project_type as lead_project_type, 
                   l.unsubscribe_token, 
                   l.notes as lead_notes,
                   l.lead_temperature,
                   l.last_contact_date,
                   COALESCE(l.follow_up_count, 0) as follow_up_count
            FROM auto_campaigns ac
            JOIN leads l ON l.id = ac.lead_id
            WHERE ac.is_active = TRUE
              AND l.unsubscribed = FALSE
              AND l.email IS NOT NULL
              AND (
                -- HOT LEADS TIMELINE (reset when they become hot):
                -- Never contacted (when they first become hot): send immediately
                -- After first contact on hot lead: 3.5 days
                -- After 2nd contact: 7 days  
                -- After 3rd+ contacts: alternates between 3.5 and 7 days
                (l.lead_temperature = 'hot' AND (
                    l.last_contact_date IS NULL 
                    OR (l.follow_up_count >= 1 AND l.follow_up_count % 2 = 1 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '3.5 days')
                    OR (l.follow_up_count >= 2 AND l.follow_up_count % 2 = 0 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '7 days')
                ))
                OR
                -- COLD LEADS TIMELINE:
                -- Never contacted: send immediately
                -- 1st follow-up: 3 days
                -- 2nd follow-up: 5 days
                -- 3rd+ follow-ups: every 7 days
                (COALESCE(l.lead_temperature, 'cold') != 'hot' AND (
                    l.last_contact_date IS NULL
                    OR (l.follow_up_count = 0 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '3 days')
                    OR (l.follow_up_count = 1 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '5 days')
                    OR (l.follow_up_count >= 2 AND l.last_contact_date <= CURRENT_DATE - INTERVAL '7 days')
                ))
              )
        `);
        console.log(`[AUTO-CAMPAIGNS] ${due.rows.length} due`);

        let sent = 0;
        const errors = [];
        for (const c of due.rows) {
            try {
                const isHotLead = c.lead_temperature === 'hot';
                const followUpCount = parseInt(c.follow_up_count) || 0;
                
                let emailSubject, emailHTML;
                
                if (isHotLead) {
                    // ✅ HOT LEADS: Use the original subject/body that was saved when auto-campaign was created
                    // Hot leads just repeat the same message on their schedule (3.5/7 day alternating)
                    console.log(`[AUTO-CAMPAIGNS] HOT Lead ${c.lead_id} (${c.lead_email}): Using saved message, follow_up_count=${followUpCount}`);
                    
                    const personalizedBody = c.body
                        .replace(/\{\{name\}\}/g, c.lead_name || 'there')
                        .replace(/\{\{project_type\}\}/g, c.lead_project_type || 'your project');
                    
                    emailSubject = c.subject;
                    
                    let unsub = c.unsubscribe_token;
                    if (!unsub) {
                        unsub = crypto.randomBytes(32).toString('hex');
                        await pool.query('UPDATE leads SET unsubscribe_token=$1 WHERE id=$2', [unsub, c.lead_id]);
                    }
                    
                    emailHTML = buildEmailHTML(`
                        <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${personalizedBody.replace(/\n/g, '<br>')}</div>
                        <div class="sign-off"><p>Warm regards,</p><p class="team-name">The Diamondback Coding Team</p></div>
                    `, { unsubscribeUrl: `${BASE_URL}/api/unsubscribe/${unsub}` });
                    
                } else {
                    // ✅ COLD LEADS: Follow the template sequence based on follow_up_count
                    // followup2 → followup3 → followupindefinite (repeating)
                    let templateName;
                    
                    if (followUpCount === 0) {
                        // Day 3: Second Follow-Up (first was manual)
                        templateName = 'followup2';
                    } else if (followUpCount === 1) {
                        // Day 5: Third Follow-Up
                        templateName = 'followup3';
                    } else {
                        // Day 7+: Indefinite Follow-Up (repeats every 7 days)
                        templateName = 'followupindefinite';
                    }
                    
                    console.log(`[AUTO-CAMPAIGNS] COLD Lead ${c.lead_id} (${c.lead_email}): follow_up_count=${followUpCount}, using template="${templateName}"`);
                    
                    // Get template content
                    const followupContent = {
                        followup2: {
                            subject: 'Following up again',
                            eyebrow: 'Following up again',
                            headline: 'You keep 100% of your revenue.',
                            subhead: `Hi ${c.lead_name || 'there'} — just circling back one more time.`,
                            body: `Platforms like Shopify and Squarespace quietly take 2–5% of every sale you make. With a custom Diamondback site, that money stays in your pocket — forever. For a business doing $200K/year, that's up to $10,000 back in your pocket annually.`,
                            ctaLabel: 'See How Much You Could Save',
                            ctaUrl: 'https://diamondbackcoding.com/contact.html',
                            accentColor: '#1A7A3A',
                            tagline: 'ZERO TRANSACTION FEES.',
                        },
                        followup3: {
                            subject: 'One last thing',
                            eyebrow: 'One last thing',
                            headline: 'No pressure — just wanted you to have this.',
                            subhead: `Hi ${c.lead_name || 'there'},`,
                            body: `I won't keep filling your inbox. But before I go, I'd love for you to know that our clients get custom-built websites they fully own, CRM systems tailored to how they work, and real human support. No templates. No platform lock-in. If the timing ever makes sense, we'll be here.`,
                            ctaLabel: 'Take a Look When You\'re Ready',
                            ctaUrl: 'https://diamondbackcoding.com',
                            accentColor: '#2D3142',
                            tagline: 'BUILT FOR YOUR BUSINESS.',
                        },
                        followupindefinite: {
                            subject: 'Checking in',
                            eyebrow: 'Checking in',
                            headline: 'We\'re still here when you\'re ready.',
                            subhead: `Hi ${c.lead_name || 'there'} — hope things are going well.`,
                            body: `We know timing isn't always right. When it is, we'd love to talk about how a custom website or CRM can take work off your plate and keep more revenue in your business. No obligation — just a conversation.`,
                            ctaLabel: 'Let\'s Talk',
                            ctaUrl: 'https://diamondbackcoding.com/contact.html',
                            accentColor: '#FF6B35',
                            tagline: 'DIAMONDBACK CODING.',
                        },
                    };
                    
                    const fc = followupContent[templateName];
                    emailSubject = fc.subject;
                    
                    // Build the follow-up email HTML using the selected template
                    let unsub = c.unsubscribe_token;
                    if (!unsub) {
                        unsub = crypto.randomBytes(32).toString('hex');
                        await pool.query('UPDATE leads SET unsubscribe_token=$1 WHERE id=$2', [unsub, c.lead_id]);
                    }

                    emailHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${fc.headline}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f5">
<tr><td align="center" style="padding:40px 20px">

<table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;max-width:600px;box-shadow:0 2px 8px rgba(0,0,0,0.08);border-radius:8px;overflow:hidden">

<!-- Header -->
<tr><td style="background:linear-gradient(135deg, ${fc.accentColor} 0%, ${fc.accentColor}dd 100%);padding:40px 40px 35px 40px;text-align:center">
<span style="color:#ffffff;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;display:block;margin-bottom:16px;opacity:0.9">${fc.eyebrow}</span>
<span style="color:#ffffff;font-size:28px;font-weight:700;letter-spacing:-0.5px;display:block;line-height:1.2">${fc.headline}</span>
</td></tr>

<!-- Body -->
<tr><td style="padding:40px 45px">
<p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 20px">${fc.subhead}</p>
<p style="font-size:15px;line-height:1.75;color:#555;margin:0 0 30px">${fc.body}</p>

<!-- CTA Button -->
<table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">
<tr><td style="background-color:${fc.accentColor};border-radius:6px;text-align:center">
<a href="${fc.ctaUrl}" style="display:inline-block;padding:16px 32px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.5px">${fc.ctaLabel}</a>
</td></tr>
</table>

</td></tr>

<!-- Footer -->
<tr><td style="background-color:#f9f9f9;padding:30px 40px;text-align:center;border-top:1px solid #e5e5e5">
<p style="font-size:12px;color:#888;margin:0 0 8px;letter-spacing:1px">${fc.tagline}</p>
<p style="font-size:13px;color:#666;margin:0 0 12px;font-weight:600">Diamondback Coding</p>
<p style="font-size:11px;color:#999;margin:0">
<a href="tel:+19402178680" style="color:#999;text-decoration:none">940-217-8680</a> | 
<a href="mailto:hello@diamondbackcoding.com" style="color:#999;text-decoration:none">hello@diamondbackcoding.com</a>
</p>
<p style="font-size:10px;color:#aaa;margin:12px 0 0">
<a href="${BASE_URL}/api/unsubscribe/${unsub}" style="color:#aaa;text-decoration:underline">Unsubscribe</a>
</p>
</td></tr>

</table>

</td></tr>
</table>

</body>
</html>`;
                }

                // Send the email (same for both hot and cold)
                await sendTrackedEmail({ leadId: c.lead_id, to: c.lead_email, subject: emailSubject, html: emailHTML });

                await pool.query('UPDATE auto_campaigns SET last_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1', [c.id]);
                
                // ✅ CRITICAL: Do NOT update last_contact_date here!
                // The sendTrackedEmail function and tracking pixel endpoint handle this correctly:
                // - Email opens → lead advances
                // - 24 hours without bounce → lead advances
                // This was another instance of the same bug!

                // Note
                let notes = [];
                try { if (c.lead_notes) notes = JSON.parse(c.lead_notes); } catch(e) {}
                const noteText = isHotLead 
                    ? `[Auto-Campaign] HOT lead email sent: "${emailSubject}"`
                    : `[Auto-Campaign] COLD lead email sent: "${emailSubject}" (${templateName || 'saved template'})`;
                notes.push({ text: noteText, author: 'System', date: new Date().toISOString() });
                await pool.query('UPDATE leads SET notes=$1 WHERE id=$2', [JSON.stringify(notes), c.lead_id]);

                sent++;
                console.log(`[AUTO-CAMPAIGNS] ✅ Sent to ${c.lead_email} (${isHotLead ? 'HOT' : 'COLD'})`);
            } catch (e) {
                console.error(`[AUTO-CAMPAIGNS] ❌ Campaign ${c.id}:`, e.message);
                errors.push({ id: c.id, error: e.message });
            }
        }
        res.json({ success: true, sent, total_due: due.rows.length, errors });
    } catch (err) {
        console.error('[AUTO-CAMPAIGNS] run-due error:', err);
        res.status(500).json({ success: false, message: 'run-due failed' });
    }
});

// ========================================
// PUBLIC UNSUBSCRIBE ENDPOINT (no auth required)
// ========================================

// Alias: frontend sendTemperatureBulkEmail calls /api/send-email
// Route to send-custom logic so those emails are also tracked
app.post('/api/send-email', authenticateToken, async (req, res) => {
    const { to, subject, body, leadId } = req.body;
    if (!to || !subject || !body) {
        return res.status(400).json({ success: false, message: 'Missing required fields: to, subject, body' });
    }
    let unsubscribeUrl = null;
    if (leadId) {
        try {
            const leadRow = await pool.query('SELECT unsubscribe_token, unsubscribed FROM leads WHERE id = $1', [leadId]);
            const lead = leadRow.rows[0];
            if (lead?.unsubscribed) {
                return res.status(400).json({ success: false, message: 'Lead has unsubscribed' });
            }
            let token = lead?.unsubscribe_token;
            if (!token) {
                token = crypto.randomBytes(32).toString('hex');
                await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [token, leadId]);
            }
            unsubscribeUrl = `${BASE_URL}/api/unsubscribe/${token}`;
        } catch (e) {}
    }
    const emailHTML = buildEmailHTML(`
        <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${body.replace(/\n/g, '<br>')}</div>
        <div class="sign-off"><p>Warm regards,</p><p class="team-name">The Diamondback Coding Team</p></div>
    `, { unsubscribeUrl });
    try {
        await sendTrackedEmail({ leadId: leadId || null, to, subject, html: emailHTML });
        
        // ✅ CRITICAL: Do NOT update last_contact_date here!
        // The sendTrackedEmail function and tracking pixel endpoint handle this correctly:
        // - Email opens → status becomes 'opened' → lead advances
        // - 24 hours without bounce → status becomes 'sent' → lead advances
        // This was the MAIN BUG causing false hot leads!
        
        res.json({ success: true, message: 'Email sent successfully' });
    } catch (err) {
        console.error('[SEND-EMAIL] Error:', err);
        res.status(500).json({ success: false, message: 'Failed to send: ' + err.message });
    }
});

app.get('/api/unsubscribe/:token', async (req, res) => {
    try {
        const { token } = req.params;

        if (!token || token.length < 10) {
            return res.status(400).send(`
                <!DOCTYPE html><html><head><title>Invalid Link</title></head>
                <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 80px auto; text-align: center; padding: 0 20px;">
                    <h2 style="color: #ef4444;">Invalid Unsubscribe Link</h2>
                    <p style="color: #666;">This link is invalid or has already been used.</p>
                </body></html>
            `);
        }

        // Find the lead by token
        const result = await pool.query(
            'SELECT id, name, email, unsubscribed FROM leads WHERE unsubscribe_token = $1',
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(404).send(`
                <!DOCTYPE html><html><head><title>Not Found</title></head>
                <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 80px auto; text-align: center; padding: 0 20px;">
                    <h2 style="color: #ef4444;">Link Not Found</h2>
                    <p style="color: #666;">This unsubscribe link is not valid. It may have expired or been removed.</p>
                </body></html>
            `);
        }

        const lead = result.rows[0];

        // Already unsubscribed — still show success (idempotent)
        if (lead.unsubscribed) {
            return res.send(`
                <!DOCTYPE html><html><head><title>Already Unsubscribed</title></head>
                <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 80px auto; text-align: center; padding: 0 20px;">
                    <h2 style="color: #22c55e;">Already Unsubscribed</h2>
                    <p style="color: #666;">You have already been removed from our follow-up email list.</p>
                </body></html>
            `);
        }

        // Set unsubscribed flag
        await pool.query(
            'UPDATE leads SET unsubscribed = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [lead.id]
        );

        // Log a note on the lead record so admin is notified
        try {
            const noteResult = await pool.query('SELECT notes FROM leads WHERE id = $1', [lead.id]);
            let notes = [];
            try {
                if (noteResult.rows[0]?.notes) {
                    notes = JSON.parse(noteResult.rows[0].notes);
                }
            } catch (e) { notes = []; }

            notes.push({
                text: '⛔ Lead unsubscribed from follow-up emails via email link.',
                author: 'System',
                date: new Date().toISOString()
            });

            await pool.query('UPDATE leads SET notes = $1 WHERE id = $2', [JSON.stringify(notes), lead.id]);
        } catch (noteErr) {
            console.warn('[UNSUBSCRIBE] Could not append note:', noteErr.message);
        }

        console.log(`[UNSUBSCRIBE] ✅ Lead ${lead.id} (${lead.email}) unsubscribed via token`);

        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Unsubscribed</title></head>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 80px auto; text-align: center; padding: 0 20px;">
                <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 48px 32px;">
                    <div style="width: 64px; height: 64px; background: #22c55e; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </div>
                    <h2 style="color: #166534; margin: 0 0 12px;">Successfully Unsubscribed</h2>
                    <p style="color: #4ade80; margin: 0 0 8px; font-size: 15px;">
                        You have been removed from Diamondback Coding's follow-up email list.
                    </p>
                    <p style="color: #6b7280; margin: 0; font-size: 13px;">
                        You will no longer receive follow-up emails from us. If you change your mind, 
                        please reach out to <a href="mailto:contact@diamondbackcoding.com" style="color: #16a34a;">contact@diamondbackcoding.com</a>.
                    </p>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('[UNSUBSCRIBE] Error:', error);
        res.status(500).send(`
            <!DOCTYPE html><html><head><title>Error</title></head>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 80px auto; text-align: center; padding: 0 20px;">
                <h2 style="color: #ef4444;">Something Went Wrong</h2>
                <p style="color: #666;">Please try again later or contact us at <a href="mailto:contact@diamondbackcoding.com">contact@diamondbackcoding.com</a>.</p>
            </body></html>
        `);
    }
});

// HEALTH CHECK

// ========================================
// RECRUITMENT: JOBS & APPLICATIONS
// ========================================

// --- JOBS (admin-created) ---

// GET all published jobs (public — no auth, used by careers + apply pages)
app.get('/api/jobs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, title, department, type, location, description, duties, requirements, created_at, updated_at
            FROM jobs
            WHERE published = true
            ORDER BY created_at DESC
        `);
        res.json({ success: true, jobs: result.rows });
    } catch (err) {
        console.error('[JOBS] GET /api/jobs error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch jobs' });
    }
});

// GET all jobs (admin — includes drafts)
app.get('/api/admin/jobs', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC');
        res.json({ success: true, jobs: result.rows });
    } catch (err) {
        console.error('[JOBS] GET /api/admin/jobs error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch jobs' });
    }
});

// POST create job
app.post('/api/admin/jobs', authenticateToken, async (req, res) => {
    try {
        const { title, department, type, location, description, duties, requirements, published } = req.body;
        if (!title || !department || !type || !location || !description) {
            return res.status(400).json({ success: false, message: 'Title, department, type, location, and description are required' });
        }
        const result = await pool.query(`
            INSERT INTO jobs (title, department, type, location, description, duties, requirements, published)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [title, department, type, location, description, duties || [], requirements || [], published || false]);
        res.status(201).json({ success: true, job: result.rows[0] });
    } catch (err) {
        console.error('[JOBS] POST error:', err);
        res.status(500).json({ success: false, message: 'Failed to create job' });
    }
});

// PUT update job
app.put('/api/admin/jobs/:id', authenticateToken, async (req, res) => {
    try {
        const { title, department, type, location, description, duties, requirements, published } = req.body;
        const result = await pool.query(`
            UPDATE jobs
            SET title = COALESCE($1, title),
                department = COALESCE($2, department),
                type = COALESCE($3, type),
                location = COALESCE($4, location),
                description = COALESCE($5, description),
                duties = COALESCE($6, duties),
                requirements = COALESCE($7, requirements),
                published = COALESCE($8, published),
                updated_at = NOW()
            WHERE id = $9
            RETURNING *
        `, [title, department, type, location, description, duties, requirements, published, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Job not found' });
        res.json({ success: true, job: result.rows[0] });
    } catch (err) {
        console.error('[JOBS] PUT error:', err);
        res.status(500).json({ success: false, message: 'Failed to update job' });
    }
});

// DELETE job
app.delete('/api/admin/jobs/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM jobs WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Job not found' });
        res.json({ success: true, message: 'Job deleted' });
    } catch (err) {
        console.error('[JOBS] DELETE error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete job' });
    }
});

// --- APPLICATIONS (candidates submit) ---

// POST submit application (public — candidates use this)
app.post('/api/applications', upload.single('resume'), async (req, res) => {
    try {
        const { jobId, firstName, lastName, email, phone, city, state, linkedIn, portfolio, experience, coverLetter, startDate, salary, referral } = req.body;
        if (!jobId || !firstName || !lastName || !email || !phone) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        const jobCheck = await pool.query('SELECT id FROM jobs WHERE id = $1 AND published = true', [jobId]);
        if (jobCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Job not found or no longer available' });
        }
        const resumePath = req.file ? req.file.path : null;
        const resumeOriginalName = req.file ? req.file.originalname : null;
        const result = await pool.query(`
            INSERT INTO applications (job_id, first_name, last_name, email, phone, city, state, linkedin_url, portfolio_url, experience, cover_letter, start_date, expected_salary, referral_source, resume_path, resume_original_name, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'new')
            RETURNING *
        `, [jobId, firstName, lastName, email, phone, city||null, state||null, linkedIn||null, portfolio||null, experience||null, coverLetter||null, startDate||null, salary||null, referral||null, resumePath, resumeOriginalName]);
        res.status(201).json({ success: true, message: 'Application submitted successfully', application: result.rows[0] });
    } catch (err) {
        console.error('[APPLICATIONS] POST error:', err);
        res.status(500).json({ success: false, message: 'Failed to submit application' });
    }
});

// GET all applications (admin)
app.get('/api/admin/applications', authenticateToken, async (req, res) => {
    try {
        const { jobId, status } = req.query;
        let query = `
            SELECT a.*, j.title as job_title, j.department
            FROM applications a
            JOIN jobs j ON a.job_id = j.id
        `;
        const params = [];
        const conditions = [];
        if (jobId) { conditions.push(`a.job_id = $${params.length + 1}`); params.push(jobId); }
        if (status) { conditions.push(`a.status = $${params.length + 1}`); params.push(status); }
        if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY a.created_at DESC';
        const result = await pool.query(query, params);
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error('[APPLICATIONS] GET error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch applications' });
    }
});

// GET single application (admin)
app.get('/api/admin/applications/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.*, j.title as job_title, j.department
            FROM applications a JOIN jobs j ON a.job_id = j.id
            WHERE a.id = $1
        `, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Application not found' });
        res.json({ success: true, application: result.rows[0] });
    } catch (err) {
        console.error('[APPLICATIONS] GET single error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch application' });
    }
});

// PATCH update application status / notes (admin)
app.patch('/api/admin/applications/:id', authenticateToken, async (req, res) => {
    try {
        const { status, notes } = req.body;
        const sets = [];
        const params = [];
        if (status !== undefined) { sets.push(`status = $${params.length + 1}`); params.push(status); }
        if (notes !== undefined) { sets.push(`notes = $${params.length + 1}`); params.push(notes); }
        if (sets.length === 0) return res.status(400).json({ success: false, message: 'Nothing to update' });
        sets.push('updated_at = NOW()');
        params.push(req.params.id);
        const result = await pool.query(`UPDATE applications SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Application not found' });

        // Send status notification email if status actually changed
        if (status !== undefined) {
            const app = result.rows[0];
            try {
                // Fetch the job title for the email
                let jobTitle = 'Open Position';
                if (app.job_id) {
                    const jobRow = await pool.query('SELECT title FROM jobs WHERE id = $1', [app.job_id]);
                    if (jobRow.rows.length > 0) jobTitle = jobRow.rows[0].title;
                }
                await sendApplicationStatusEmail(app, jobTitle, status);
            } catch (emailErr) {
                // Email failure should never block the status update response
                console.error('[APPLICATIONS] Status email failed:', emailErr);
            }
        }

        res.json({ success: true, application: result.rows[0] });
    } catch (err) {
        console.error('[APPLICATIONS] PATCH error:', err);
        res.status(500).json({ success: false, message: 'Failed to update application' });
    }
});

// ─── Application status notification emails ─────────────────────────────────
async function sendApplicationStatusEmail(app, jobTitle, newStatus) {
    const firstName = app.first_name || 'Candidate';

    const statusConfig = {
        new: {
            subject: `Your application for ${jobTitle} has been received`,
            bodyHTML: `
                <p>Hi ${firstName},</p>
                <p>Thank you for submitting your application for the <strong>${jobTitle}</strong> position. We've received everything and our team will begin reviewing your materials shortly.</p>
                <p>We appreciate your interest in joining Diamondback Coding and will be in touch with next steps.</p>
            `
        },
        reviewing: {
            subject: `Your application for ${jobTitle} is under review`,
            bodyHTML: `
                <p>Hi ${firstName},</p>
                <p>Great news — our team has started reviewing your application for the <strong>${jobTitle}</strong> position.</p>
                <p>We're taking a close look at your background and qualifications. You'll hear from us soon with an update on next steps.</p>
            `
        },
        interviewing: {
            subject: `You've been selected for an interview — ${jobTitle}`,
            bodyHTML: `
                <p>Hi ${firstName},</p>
                <p>Congratulations! We'd like to invite you to interview for the <strong>${jobTitle}</strong> position at Diamondback Coding.</p>
                <p>A member of our team will be reaching out shortly with scheduling details. In the meantime, please feel free to reply to this email with any questions.</p>
            `
        },
        hired: {
            subject: `Congratulations — Welcome to Diamondback Coding!`,
            bodyHTML: `
                <p>Hi ${firstName},</p>
                <p>We are thrilled to let you know that you have been selected for the <strong>${jobTitle}</strong> position at Diamondback Coding.</p>
                <p>We'll be sending you onboarding details and next steps shortly. We're truly excited to have you on the team!</p>
            `
        },
        rejected: {
            subject: `Your application for ${jobTitle} — Update`,
            bodyHTML: `
                <p>Hi ${firstName},</p>
                <p>Thank you for taking the time to apply for the <strong>${jobTitle}</strong> position at Diamondback Coding. We truly appreciate your interest in our team.</p>
                <p>After careful consideration, we have decided to move forward with other candidates at this time. This was not an easy decision, and we want you to know that your application was given thorough and serious consideration.</p>
                <p>We encourage you to keep an eye on future openings — we'd love to see you apply again.</p>
            `
        },
        on_hold: {
            subject: `Your application for ${jobTitle} has been placed on hold`,
            bodyHTML: `
                <p>Hi ${firstName},</p>
                <p>We wanted to let you know that your application for the <strong>${jobTitle}</strong> position has been temporarily placed on hold.</p>
                <p>This may be due to changes in the hiring timeline or other factors on our end. Rest assured your application remains active and we will follow up with you as soon as we have more information.</p>
            `
        }
    };

    const config = statusConfig[newStatus];
    if (!config) {
        console.log(`[APPLICATIONS] No email template for status: ${newStatus}`);
        return;
    }

    const emailHTML = buildEmailHTML(`
        ${config.bodyHTML}

        <div class="sign-off">
            <p>Warm regards,</p>
            <p class="team-name">The Diamondback Coding Team</p>
        </div>
    `);

    const mailOptions = {
        from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
        to: app.email,
        subject: config.subject,
        html: emailHTML
    };

    await transporter.sendMail(mailOptions);
    console.log(`[APPLICATIONS] ✅ Status email "${newStatus}" sent to ${app.email} for job "${jobTitle}"`);
}

// DELETE application (admin)
app.delete('/api/admin/applications/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM applications WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Application not found' });
        res.json({ success: true, message: 'Application deleted' });
    } catch (err) {
        console.error('[APPLICATIONS] DELETE error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete application' });
    }
});

// GET download resume (admin)
app.get('/api/admin/applications/:id/resume', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT resume_path, resume_original_name FROM applications WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0 || !result.rows[0].resume_path) {
            return res.status(404).json({ success: false, message: 'No resume on file' });
        }
        res.setHeader('Content-Disposition', `attachment; filename="${result.rows[0].resume_original_name || 'resume'}"`);
        res.sendFile(path.resolve(result.rows[0].resume_path));
    } catch (err) {
        console.error('[APPLICATIONS] GET resume error:', err);
        res.status(500).json({ success: false, message: 'Failed to download resume' });
    }
});

// ========================================
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ========================================
// 404 HANDLER
// ========================================
app.use((req, res) => {
    // If it's an API route, return JSON
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ 
            success: false, 
            message: 'API endpoint not found' 
        });
    } else {
        // Serve the custom 404 page
        res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    }
});

// ========================================
// ERROR HANDLER
// ========================================
app.use((err, req, res, next) => {
    console.error('Server error:', err.stack);
    res.status(500).json({ 
        success: false, 
        message: 'Internal server error' 
    });
});

console.log('\n[ROUTES] Listing all registered API routes:');
console.log('==========================================');

let routeCount = 0;
app._router.stack.forEach((middleware) => {
    if (middleware.route) {
        const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
        console.log(`  ${methods.padEnd(8)} ${middleware.route.path}`);
        routeCount++;
    } else if (middleware.name === 'router') {
        middleware.handle.stack.forEach((handler) => {
            if (handler.route) {
                const methods = Object.keys(handler.route.methods).join(', ').toUpperCase();
                console.log(`  ${methods.padEnd(8)} ${handler.route.path}`);
                routeCount++;
            }
        });
    }
});

console.log('==========================================');
console.log(`[ROUTES] Total routes registered: ${routeCount}\n`);

// Check specifically for client routes
const clientRoutes = [
    '/api/client/login',
    '/api/client/dashboard',
    '/api/client/projects',
    '/api/client/invoices'
];

console.log('[CHECK] Verifying client portal routes:');
clientRoutes.forEach(route => {
    const exists = app._router.stack.some(middleware => 
        middleware.route && middleware.route.path === route
    );
    console.log(`  ${route.padEnd(30)} ${exists ? '[OK]' : '[MISSING]'}`);
});
console.log('');

// ========================================
// MIGRATION: Temperature System for Existing Leads
// ========================================
async function migrateExistingLeadsToTemperature() {
    console.log('[MIGRATION] Checking for leads needing temperature migration...');
    
    try {
        // Set all existing leads to 'cold' if they don't have a temperature
        const result = await pool.query(`
            UPDATE leads 
            SET lead_temperature = 'cold',
                engagement_score = 0,
                engagement_history = '[]'::jsonb
            WHERE lead_temperature IS NULL OR lead_temperature = ''
            RETURNING id, name, email
        `);
        
        if (result.rows.length > 0) {
            console.log(`[MIGRATION] ✅ Updated ${result.rows.length} leads to 'cold' temperature`);
        } else {
            console.log('[MIGRATION] ℹ️  All leads already have temperature values');
        }
        
        return { success: true, migrated: result.rows.length };
        
    } catch (error) {
        console.error('[MIGRATION] ⚠️  Migration error (non-critical):', error.message);
        // Don't fail startup if migration has issues
        return { success: false, error: error.message };
    }
}

// ========================================
// SERVER STARTUP
// ========================================
// ========================================
// BACKGROUND JOB: Auto-confirm email deliveries
// ========================================
// Emails stay 'queued' until we have proof they were delivered.
// After 24 hours with no bounce, we assume delivery and:
// 1. Mark email as 'sent' 
// 2. Advance the lead (increment follow_up_count, update last_contact_date)
function startEmailConfirmationJob() {
    // Run every hour
    const INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
    
    async function confirmQueuedEmails() {
        try {
            console.log('[EMAIL-CONFIRM] Running background job to confirm queued emails...');
            
            // Find emails that have been queued for 24+ hours with no bounce
            const result = await pool.query(`
                UPDATE email_log 
                SET status = 'sent'
                WHERE status = 'queued' 
                AND sent_at < NOW() - INTERVAL '24 hours'
                AND opened_at IS NULL
                RETURNING id, lead_id, subject, sent_at
            `);
            
            if (result.rows.length > 0) {
                console.log(`[EMAIL-CONFIRM] ✅ Confirmed ${result.rows.length} emails as delivered (no bounce after 24hrs)`);
                
                // Now advance the leads for these confirmed emails
                for (const email of result.rows) {
                    if (email.lead_id) {
                        try {
                            await pool.query(
                                `UPDATE leads 
                                 SET last_contact_date = CURRENT_DATE, 
                                     follow_up_count = COALESCE(follow_up_count, 0) + 1,
                                     updated_at = CURRENT_TIMESTAMP
                                 WHERE id = $1
                                 AND (last_contact_date IS NULL OR last_contact_date < CURRENT_DATE)`,
                                [email.lead_id]
                            );
                            console.log(`[EMAIL-CONFIRM] ✅ Advanced lead ${email.lead_id} after confirming email ${email.id}`);
                        } catch (err) {
                            console.error(`[EMAIL-CONFIRM] Error advancing lead ${email.lead_id}:`, err);
                        }
                    }
                }
            } else {
                console.log('[EMAIL-CONFIRM] No queued emails to confirm at this time');
            }
        } catch (error) {
            console.error('[EMAIL-CONFIRM] Error in confirmation job:', error);
        }
    }
    
    // Run immediately on startup
    confirmQueuedEmails();
    
    // Then run every hour
    setInterval(confirmQueuedEmails, INTERVAL);
    
    console.log('[EMAIL-CONFIRM] ✅ Background job started - will auto-confirm emails every hour');
}

async function startServer() {
    try {
        await initializeDatabase(pool);
        await initializeExpenseTables();
        await addLeadSourceTracking();
        
        // Migrate existing leads to temperature system
        await migrateExistingLeadsToTemperature();
        
        // ✅ THIS LINE MUST BE HERE
        const emailConfigured = await verifyEmailConfig();
        if (!emailConfigured) {
            console.warn('⚠️  Email functionality may not work properly');
        }
        
        // Start background job to auto-confirm email deliveries
        startEmailConfirmationJob();
        
        app.listen(PORT, () => {
            console.log('');
            console.log('========================================');
            console.log('🚀 Diamondback Coding Server Running');
            console.log('========================================');
            console.log(`📡 Port: ${PORT}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🔗 Local: http://localhost:${PORT}`);
            console.log(`📧 Email: ${emailConfigured ? 'Configured ✅' : 'Not configured ⚠️'}`);
            console.log('========================================');
            console.log('');
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// ========================================
// MARKETING BLAST
// Sends a bulk promotional email to a chosen audience group.
// Does NOT update last_contact_date or follow_up_count.
// Link clicks still fire the engagement tracker → cold leads can go hot.
// ========================================
app.post('/api/marketing/blast', authenticateToken, async (req, res) => {
    try {
        const { audience, template, subject, body } = req.body;

        if (!audience || !template || !subject) {
            return res.status(400).json({ success: false, message: 'audience, template, and subject are required' });
        }

        console.log(`[MARKETING] Blast — audience=${audience} template=${template}`);

        // Resolve recipient list based on audience key
        let recipientQuery = '';
        if (audience === 'all_leads') {
            recipientQuery = `SELECT id, name, email, unsubscribe_token FROM leads WHERE is_customer = FALSE AND COALESCE(unsubscribed, FALSE) = FALSE AND email IS NOT NULL`;
        } else if (audience === 'hot_leads') {
            recipientQuery = `SELECT id, name, email, unsubscribe_token FROM leads WHERE lead_temperature = 'hot' AND is_customer = FALSE AND COALESCE(unsubscribed, FALSE) = FALSE AND email IS NOT NULL`;
        } else if (audience === 'cold_leads') {
            recipientQuery = `SELECT id, name, email, unsubscribe_token FROM leads WHERE COALESCE(lead_temperature, 'cold') != 'hot' AND is_customer = FALSE AND COALESCE(unsubscribed, FALSE) = FALSE AND email IS NOT NULL`;
        } else if (audience === 'all_customers') {
            recipientQuery = `SELECT id, name, email, unsubscribe_token FROM leads WHERE is_customer = TRUE AND COALESCE(unsubscribed, FALSE) = FALSE AND email IS NOT NULL`;
        } else if (audience === 'everyone') {
            recipientQuery = `SELECT id, name, email, unsubscribe_token FROM leads WHERE COALESCE(unsubscribed, FALSE) = FALSE AND email IS NOT NULL`;
        } else {
            return res.status(400).json({ success: false, message: `Unknown audience: ${audience}` });
        }

        const recipientsResult = await pool.query(recipientQuery);
        const recipients = recipientsResult.rows;

        console.log(`[MARKETING] Sending to ${recipients.length} recipients`);

        let sent = 0;
        let skipped = 0;
        const errors = [];

        for (const lead of recipients) {
            try {
                // Ensure unsubscribe token exists
                let unsubToken = lead.unsubscribe_token;
                if (!unsubToken) {
                    unsubToken = crypto.randomBytes(32).toString('hex');
                    await pool.query('UPDATE leads SET unsubscribe_token = $1 WHERE id = $2', [unsubToken, lead.id]);
                }
                const unsubUrl = `${BASE_URL}/api/unsubscribe/${unsubToken}`;

                // Build HTML for this lead using the same template system
                let emailHTML = '';
                const name = lead.name || 'there';

                if (template === 'zerotransactionfees') {
                    // Reuse the zero transaction fees template (inline version)
                    emailHTML = await buildMarketingTemplateHTML(template, name, subject, body, unsubUrl, BASE_URL);
                } else if (['initial', 'valentinessale', 'springsale', 'blackfriday', 'initialsale', 'valentines14'].includes(template)) {
                    emailHTML = await buildMarketingTemplateHTML(template, name, subject, body, unsubUrl, BASE_URL);
                } else {
                    // Custom or simple text template
                    const personalizedBody = (body || '').replace(/{{name}}/g, name).replace(/{{Name}}/g, name);
                    emailHTML = buildEmailHTML(`
                        <p>Hi ${name},</p>
                        <div style="white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: #3d3d3d;">${personalizedBody.replace(/\n/g, '<br>')}</div>
                        <div class="sign-off">
                            <p>Warm regards,</p>
                            <p class="team-name">The Diamondback Coding Team</p>
                        </div>
                    `, { unsubscribeUrl: unsubUrl });
                }

                // Send — tracked. isMarketing = true means we do NOT update follow_up_count or last_contact_date
                await sendTrackedEmail({ leadId: lead.id, to: lead.email, subject, html: emailHTML, isMarketing: true });
                sent++;

                // Small delay to avoid rate limits
                await new Promise(r => setTimeout(r, 120));

            } catch (err) {
                console.error(`[MARKETING] Failed for ${lead.email}:`, err.message);
                errors.push(lead.email);
                skipped++;
            }
        }

        console.log(`[MARKETING] ✅ Done — sent=${sent} skipped=${skipped}`);
        res.json({ success: true, sent, skipped, errors: errors.slice(0, 10) });

    } catch (error) {
        console.error('[MARKETING] Blast error:', error);
        res.status(500).json({ success: false, message: 'Marketing blast failed', error: error.message });
    }
});

// Helper: build HTML for a marketing template by name
// Calls the same server-side template logic used by follow-ups
async function buildMarketingTemplateHTML(template, name, subject, bodyText, unsubUrl, baseUrl) {
    // For HTML templates: delegate to inline generation matching the follow-up handler
    // We generate a minimal stub — the main template bodies are defined in /api/follow-ups/:leadId/send-email
    // For marketing blasts we use the buildEmailHTML wrapper with a branded personalised message,
    // unless it's one of the full-design templates. Full-design templates use a helper req to the
    // same code path. For simplicity, we inline the "clean" versions here:
    const accentColor = '#FF6B35';

    if (template === 'zerotransactionfees') {
        // Return a concise but branded version referencing the zero-fee pitch
        return buildEmailHTML(`
            <p>Hi ${name},</p>
            <h2 style="font-size:24px;color:#2D3142;letter-spacing:-0.5px;">Every sale you make, they take a cut.</h2>
            <p>Shopify, Squarespace, and Wix charge 2–5% on every transaction. On $200K in annual sales, that's up to <strong>$10,000 quietly disappearing</strong> every year.</p>
            <p>At Diamondback Coding, we charge <strong>zero transaction fees</strong> — ever. You get a fully custom website you own outright, with no platform dependencies and no revenue leaks.</p>
            <div style="background:#FFF8F0;border-left:3px solid #FF6B35;padding:18px 20px;border-radius:4px;margin:20px 0;">
                <strong>What $200K/yr looks like:</strong><br>
                Other platforms: <span style="color:#CC2222;font-weight:700;">−$6,000/yr</span> in fees &nbsp;|&nbsp; Diamondback: <span style="color:#1A7A3A;font-weight:700;">$0</span>
            </div>
            <p>Ready to stop losing revenue to your own platform?</p>
            <div style="margin:28px 0;">
                <a href="${baseUrl}/contact.html" style="background:#FF6B35;color:#fff;padding:14px 32px;border-radius:3px;font-weight:700;text-decoration:none;font-size:15px;">Get a Free Consultation</a>
            </div>
            <div class="sign-off"><p>Warm regards,</p><p class="team-name">The Diamondback Coding Team</p></div>
        `, { unsubscribeUrl: unsubUrl });
    }

    // For promo and other HTML templates: personalized intro + promo body
    const promoDetails = {
        initial: { headline: 'Your Vision. Our Code.', body: `We build custom websites and CRM systems for businesses like yours — no templates, no transaction fees, full ownership.` },
        valentinessale: { headline: "Valentine's Day: 25% OFF Everything", body: `This Valentine's Day, treat your business to a custom website or CRM at 25% off. Offer ends soon.` },
        springsale: { headline: 'Spring Sale: 25% OFF All Services', body: `Spring is here — and so is our biggest sale of the season. 25% off custom web development and CRM solutions.` },
        blackfriday: { headline: 'BLACK FRIDAY: 25% OFF Everything', body: `Our biggest deal of the year. 25% off all custom development packages — today only.` },
        initialsale: { headline: 'Spring Event: 25% OFF — Limited Time', body: `Kick off spring with a custom website or CRM at 25% off. Spots are filling fast.` },
        valentines14: { headline: "Valentine's Special: 14% Off", body: `Show your business some love this Valentine's season with 14% off our custom web solutions.` },
        checkin: { headline: `Checking In, ${name}`, body: `We wanted to take a moment to check in. How is everything going? If there's anything we can help with — updates, new features, SEO — just say the word.` },
        referralrequest: { headline: 'Know Someone Who Could Use Us?', body: `If you know a business owner looking for a custom website or CRM, we'd love an introduction. We take care of your referrals like they're our own.` },
    };

    const pd = promoDetails[template] || { headline: 'Diamondback Coding', body: bodyText || '' };

    return buildEmailHTML(`
        <p>Hi ${name},</p>
        <h2 style="font-size:24px;color:#2D3142;letter-spacing:-0.5px;margin-bottom:12px;">${pd.headline}</h2>
        <p>${pd.body}</p>
        <div style="margin:28px 0;">
            <a href="${baseUrl}/contact.html" style="background:${accentColor};color:#fff;padding:14px 32px;border-radius:3px;font-weight:700;text-decoration:none;font-size:15px;">Learn More</a>
        </div>
        <div class="sign-off"><p>Warm regards,</p><p class="team-name">The Diamondback Coding Team</p></div>
    `, { unsubscribeUrl: unsubUrl });
}

startServer();

// ========================================
// GRACEFUL SHUTDOWN
// ========================================
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received: closing HTTP server');
    await pool.end();
    process.exit(0);
});