// ========================================
// email-config.js — Diamondback Coding
// Nodemailer transport used by server.js.
//   const { transporter, verifyEmailConfig } = require('./email-config.js');
//
// Environment variables:
//   EMAIL_HOST       SMTP host            (default: smtp-relay.brevo.com)
//   EMAIL_PORT       SMTP port            (default: 587)
//   EMAIL_USER       SMTP username/login
//   EMAIL_PASS       SMTP password / SMTP key
//   EMAIL_FROM       Default From header
//   EMAIL_REPLY_TO   Default Reply-To header
//
// NOTE ON THE MIGRATION FROM GMAIL:
//   The previous version used `service: 'gmail'` with EMAIL_PASSWORD. Two things
//   changed — the transport is now Brevo's SMTP relay, and the password variable
//   is EMAIL_PASS (not EMAIL_PASSWORD), matching the rest of the platform. Set
//   EMAIL_PASS in Render or sending will fail on the first message.
//
//   Brevo SMTP credentials are NOT your Brevo API key. Find them under
//   Brevo → SMTP & API → SMTP. The API key is used separately for
//   transactional SMS (BREVO_API_KEY).
// ========================================

const nodemailer = require('nodemailer');
require('dotenv').config();

const EMAIL_PORT = process.env.EMAIL_PORT || '587';

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp-relay.brevo.com',
    port: parseInt(EMAIL_PORT, 10),
    secure: EMAIL_PORT === '465',   // implicit TLS on 465, STARTTLS on 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD, // legacy fallback
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
});

// Fill in From / Reply-To when the caller omits them, so no mail goes out
// with a bare envelope sender.
transporter.use('compile', (mail, callback) => {
    if (!mail.data.from) {
        mail.data.from = process.env.EMAIL_FROM
            || 'Diamondback Coding <contact@diamondbackcoding.com>';
    }
    if (!mail.data.replyTo) {
        mail.data.replyTo = process.env.EMAIL_REPLY_TO
            || 'contact@diamondbackcoding.com';
    }
    callback();
});

// server.js awaits this on startup. Returns false instead of throwing so a
// misconfigured mailer doesn't take the whole process down.
async function verifyEmailConfig() {
    try {
        const pass = process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD;
        if (!process.env.EMAIL_USER || !pass) {
            console.warn('[EMAIL] EMAIL_USER / EMAIL_PASS not set — email sending will fail until configured.');
            return false;
        }
        await transporter.verify();
        console.log('[EMAIL] SMTP transport verified for Diamondback Coding.');
        return true;
    } catch (err) {
        console.error('[EMAIL] SMTP verification failed:', err.message);
        return false;
    }
}

module.exports = { transporter, verifyEmailConfig };