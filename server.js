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
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
            END $$;
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
        
        console.log('✅ Database migrations completed');

        await client.query('COMMIT');
        console.log('✅ Database tables initialized');

        // Create default admin user if none exists
        const adminCheck = await pool.query('SELECT * FROM admin_users LIMIT 1');
        
        if (adminCheck.rows.length === 0) {
            const defaultPassword = 'Admin123!';
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

// Create new lead (PUBLIC - from contact form AND authenticated admin creation)
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

        const isAuthenticated = req.headers.authorization;

        // Log the incoming data for debugging
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

        res.json({
            success: true,
            message: isAuthenticated ? 'Lead created successfully.' : 'Thank you for contacting us! We\'ll get back to you within 24 hours.',
            lead: result.rows[0]
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

        const emailHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; background: white; }
        .header { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 40px 30px; text-align: center; }
        .header h1 { color: white; font-size: 28px; margin: 0 0 8px 0; }
        .header p { color: rgba(255,255,255,0.95); font-size: 14px; margin: 0; }
        .content { padding: 40px 30px; }
        .info-box { background: #f8f9fa; border-left: 4px solid #22c55e; padding: 20px; margin: 20px 0; border-radius: 4px; }
        .info-row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px; }
        .info-label { color: #666; font-weight: 600; }
        .info-value { color: #000; font-weight: 700; }
        .attachment-note { background: #fff3cd; border: 1px solid #ffc107; padding: 16px; border-radius: 6px; margin: 20px 0; font-size: 13px; }
        .footer { background: #333; color: white; padding: 30px; text-align: center; font-size: 12px; }
        .footer a { color: #22c55e; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 Your Project Timeline is Ready!</h1>
            <p>Service Level Agreement & Project Details</p>
        </div>
        
        <div class="content">
            <p style="font-size: 15px; line-height: 1.7; color: #444;">
                <strong>Hi ${timeline.clientName},</strong>
            </p>
            
            <p style="font-size: 15px; line-height: 1.7; color: #444;">
                Thank you for choosing Diamondback Coding! We're excited to work with you on 
                <strong>${timeline.projectName || 'your project'}</strong>.
            </p>
            
            <p style="font-size: 15px; line-height: 1.7; color: #444;">
                Attached to this email is your complete <strong>Service Level Agreement (SLA)</strong> 
                which includes the detailed project timeline, deliverables, and terms.
            </p>
            
            <div class="info-box">
                <div class="info-row">
                    <span class="info-label">Project:</span>
                    <span class="info-value">${timeline.projectName || 'Web Development'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Investment:</span>
                    <span class="info-value" style="color: #22c55e;">
                        ${timeline.isFreeProject ? 'FREE' : '$' + totalPrice.toLocaleString()}
                    </span>
                </div>
                <div class="info-row">
                    <span class="info-label">Services:</span>
                    <span class="info-value">${packagesText}</span>
                </div>
            </div>
            
            <div class="attachment-note">
                <strong>📎 PDF Attached:</strong> Please review the attached SLA document for complete 
                project details, timeline, and terms. <strong>Your signature is required</strong> to proceed.
            </div>
            
            <h3 style="color: #333; margin-top: 30px;">Next Steps:</h3>
            <ol style="font-size: 14px; line-height: 1.8; color: #555;">
                <li><strong>Review</strong> the attached SLA document carefully</li>
                <li><strong>Sign</strong> the document in the designated client signature area</li>
                <li><strong>Return</strong> the signed copy to us via email</li>
                <li>We'll schedule our <strong>kick-off meeting</strong> to get started!</li>
            </ol>
            
            <p style="font-size: 15px; line-height: 1.7; color: #444; margin-top: 30px;">
                Have questions? We're here to help! Feel free to reach out anytime.
            </p>
            
            <p style="font-size: 15px; color: #444; margin-top: 20px;">
                <strong>Looking forward to building something amazing together!</strong><br>
                — The Diamondback Coding Team
            </p>
        </div>
        
        <div class="footer">
            <p style="margin: 0 0 8px 0;"><strong>Diamondback Coding</strong></p>
            <p style="margin: 0 0 4px 0;">15709 Spillman Ranch Loop, Austin, TX 78738</p>
            <p style="margin: 0 0 4px 0;">
                <a href="mailto:contact@diamondbackcoding.com">contact@diamondbackcoding.com</a> • 
                <a href="tel:+19402178680">(940) 217-8680</a>
            </p>
            <p style="margin: 20px 0 0 0; font-size: 11px; opacity: 0.7;">
                © ${new Date().getFullYear()} Diamondback Coding. All rights reserved.
            </p>
        </div>
    </div>
</body>
</html>
        `;

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
                <td style="padding: 12px; border-bottom: 1px solid #eee;">${item.description}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity || 1}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">$${parseFloat(item.unit_price || item.amount).toLocaleString()}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">$${parseFloat(item.amount).toLocaleString()}</td>
            </tr>
        `).join('');
        
        const taxAmount = parseFloat(invoice.tax_amount || 0);
        const discount = parseFloat(invoice.discount_amount || 0);
        
        const emailHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
                    .header { background: #22c55e; color: white; padding: 30px; text-align: center; }
                    .content { padding: 30px; max-width: 800px; margin: 0 auto; background: white; }
                    .footer { background: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                    .btn { background: #22c55e; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; }
                    .invoice-amount { font-size: 32px; font-weight: bold; color: #22c55e; margin: 20px 0; }
                    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                    th { background: #f8f9fa; padding: 12px; text-align: left; font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #22c55e; }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1 style="margin: 0; font-size: 32px;">INVOICE</h1>
                    <p style="margin: 5px 0 0 0; opacity: 0.9; font-size: 18px;">#${invoice.invoice_number}</p>
                </div>
                
                <div class="content">
                    <h2>Hello ${clientName || 'Valued Customer'},</h2>
                    
                    <p>Thank you for your business! Here's your invoice.</p>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                            <div>
                                <p style="margin: 5px 0; font-size: 12px; color: #666;">INVOICE NUMBER</p>
                                <p style="margin: 5px 0; font-weight: bold;">${invoice.invoice_number}</p>
                            </div>
                            <div>
                                <p style="margin: 5px 0; font-size: 12px; color: #666;">ISSUE DATE</p>
                                <p style="margin: 5px 0; font-weight: bold;">${new Date(invoice.issue_date).toLocaleDateString()}</p>
                            </div>
                            <div>
                                <p style="margin: 5px 0; font-size: 12px; color: #666;">DUE DATE</p>
                                <p style="margin: 5px 0; font-weight: bold;">${new Date(invoice.due_date).toLocaleDateString()}</p>
                            </div>
                            <div>
                                <p style="margin: 5px 0; font-size: 12px; color: #666;">AMOUNT DUE</p>
                                <p style="margin: 5px 0; font-size: 24px; font-weight: bold; color: #22c55e;">$${parseFloat(invoice.total_amount).toLocaleString()}</p>
                            </div>
                        </div>
                    </div>
                    
                    <h3>Invoice Details</h3>
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
                    
                    <div style="text-align: right; margin-top: 20px;">
                        <p style="margin: 5px 0;"><strong>Subtotal:</strong> $${parseFloat(invoice.subtotal).toLocaleString()}</p>
                        ${taxAmount > 0 ? `<p style="margin: 5px 0;"><strong>Tax (${invoice.tax_rate}%):</strong> $${taxAmount.toLocaleString()}</p>` : ''}
                        ${discount > 0 ? `<p style="margin: 5px 0;"><strong>Discount:</strong> -$${discount.toLocaleString()}</p>` : ''}
                        <p style="margin: 15px 0 0 0; font-size: 20px;"><strong>Total:</strong> <span style="color: #22c55e;">$${parseFloat(invoice.total_amount).toLocaleString()}</span></p>
                    </div>
                    
                    ${invoice.stripe_payment_link ? `
                        <div style="text-align: center; margin: 40px 0; padding: 30px; background: #f8f9fa; border-radius: 10px;">
                            <p style="margin: 0 0 20px 0; font-size: 16px; font-weight: bold;">Pay Online Securely</p>
                            <a href="${invoice.stripe_payment_link}" class="btn">
                                Pay Invoice Now
                            </a>
                            <p style="font-size: 12px; color: #666; margin: 15px 0 0 0;">
                                Secure payment powered by Stripe
                            </p>
                        </div>
                    ` : ''}
                    
                    ${invoice.notes ? `
                        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                            <p style="margin: 0 0 10px 0; font-weight: bold;">Notes:</p>
                            <p style="margin: 0;">${invoice.notes}</p>
                        </div>
                    ` : ''}
                    
                    <p>If you have any questions about this invoice, please don't hesitate to contact us.</p>
                    
                    <p>Best regards,<br>
                    <strong>Diamondback Coding Team</strong></p>
                </div>
                
                <div class="footer">
                    <p><strong>Diamondback Coding</strong><br>
                    15709 Spillman Ranch Loop, Austin, TX 78738<br>
                    <a href="mailto:contact@diamondbackcoding.com">contact@diamondbackcoding.com</a> | (940) 217-8680</p>
                    <p style="margin-top: 15px; color: #999; font-size: 11px;">
                        This is an automated message. Please do not reply directly to this email.
                    </p>
                </div>
            </body>
            </html>
        `;
        
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
        const emailHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
                    .header { background: #22c55e; color: white; padding: 30px; text-align: center; }
                    .content { padding: 30px; max-width: 800px; margin: 0 auto; background: white; }
                    .footer { background: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                    .btn { 
                        background: #22c55e; 
                        color: white; 
                        padding: 15px 30px; 
                        text-decoration: none; 
                        border-radius: 5px; 
                        display: inline-block;
                        font-weight: bold;
                    }
                    .invoice-amount {
                        font-size: 32px;
                        font-weight: bold;
                        color: #22c55e;
                        margin: 20px 0;
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1 style="margin: 0; font-size: 32px;">DIAMONDBACK CODING</h1>
                    <p style="margin: 5px 0 0 0; opacity: 0.9;">Premium Development Services</p>
                </div>
                
                <div class="content">
                    <h2>Hello ${clientName || 'Valued Customer'},</h2>
                    
                    <p>Your invoice is attached to this email.</p>
                    
                    <p><strong>Invoice Details:</strong></p>
                    <ul style="line-height: 2;">
                        <li><strong>Invoice Number:</strong> ${invoice.invoice_number}</li>
                        <li><strong>Issue Date:</strong> ${new Date(invoice.issue_date).toLocaleDateString()}</li>
                        <li><strong>Due Date:</strong> ${new Date(invoice.due_date).toLocaleDateString()}</li>
                    </ul>
                    
                    <div style="text-align: center; background: #f8f9fa; padding: 30px; border-radius: 10px; margin: 30px 0;">
                        <div style="font-size: 14px; color: #666; margin-bottom: 10px;">Amount Due</div>
                        <div class="invoice-amount">$${parseFloat(invoice.total_amount).toLocaleString()}</div>
                    </div>
                    
                    ${invoice.stripe_payment_link ? `
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${invoice.stripe_payment_link}" class="btn">
                                Pay Invoice Online
                            </a>
                            <p style="font-size: 12px; color: #666; margin-top: 10px;">
                                Secure payment powered by Stripe
                            </p>
                        </div>
                    ` : ''}
                    
                    <p>If you have any questions about this invoice, please don't hesitate to contact us.</p>
                    
                    <p>Best regards,<br>
                    <strong>Diamondback Coding Team</strong></p>
                </div>
                
                <div class="footer">
                    <p><strong>Diamondback Coding</strong><br>
                    15709 Spillman Ranch Loop, Austin, TX 78738<br>
                    <a href="mailto:contact@diamondbackcoding.com">contact@diamondbackcoding.com</a> | (940) 217-8680</p>
                    <p style="margin-top: 15px; color: #999; font-size: 11px;">
                        This is an automated message. Please do not reply directly to this email.
                    </p>
                </div>
            </body>
            </html>
        `;
        
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
                COUNT(*) FILTER (WHERE status = 'new') as new_leads,
                COUNT(*) FILTER (WHERE status = 'contacted') as contacted,
                COUNT(*) FILTER (WHERE status = 'pending') as pending,
                COUNT(*) FILTER (WHERE is_customer = true) as converted,
                ROUND(
                    COUNT(*) FILTER (WHERE is_customer = true)::numeric / 
                    NULLIF(COUNT(*), 0) * 100, 
                    2
                ) as conversion_rate
            FROM leads
            WHERE created_at >= NOW() - INTERVAL '90 days'
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
            WHERE created_at >= NOW() - INTERVAL '90 days'
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
                AND (
                    l.last_contact_date IS NULL
                    OR l.last_contact_date <= CURRENT_DATE - INTERVAL '1 day'
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
        const emailHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        line-height: 1.6; 
                        color: #333; 
                        margin: 0;
                        padding: 0;
                    }
                    .container { 
                        max-width: 600px; 
                        margin: 0 auto; 
                        background: #ffffff;
                    }
                    .header { 
                        background: #22c55e; 
                        color: white; 
                        padding: 30px 20px; 
                        text-align: center; 
                    }
                    .header h2 {
                        margin: 0;
                        font-size: 24px;
                    }
                    .content { 
                        padding: 30px 20px; 
                        background: #f9f9f9; 
                    }
                    .content p {
                        margin: 0 0 15px 0;
                    }
                    .footer { 
                        padding: 20px; 
                        text-align: center; 
                        font-size: 12px; 
                        color: #666; 
                        background: #f0f0f0;
                        border-top: 1px solid #ddd;
                    }
                    .footer p {
                        margin: 5px 0;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h2>Diamondback Coding</h2>
                    </div>
                    <div class="content">
                        ${body.replace(/\n/g, '<br>')}
                    </div>
                    <div class="footer">
                        <p><strong>Diamondback Coding</strong></p>
                        <p>15709 Spillman Ranch Loop, Austin, TX 78738</p>
                        <p>contact@diamondbackcoding.com | (940) 217-8680</p>
                    </div>
                </div>
            </body>
            </html>
        `;
        
        // Send the email using Nodemailer
        try {
            const info = await transporter.sendMail({
                from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
                to: to,
                subject: subject,
                html: emailHTML
            });
            
            console.log('[EMAIL API] ✅ Email sent successfully to:', to);
            console.log('[EMAIL API] Message ID:', info.messageId);
            
        } catch (emailError) {
            console.error('[EMAIL API] ❌ Email send error:', emailError);
            return res.status(500).json({
                success: false,
                message: 'Failed to send email: ' + emailError.message
            });
        }
        
        // 🔥 UPDATE: Update last_contact_date in database
        if (leadId) {
            try {
                const updateResult = await pool.query(
                    `UPDATE leads 
                     SET last_contact_date = CURRENT_TIMESTAMP,
                         status = CASE 
                             WHEN status = 'new' THEN 'contacted'
                             ELSE status 
                         END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1
                     RETURNING id, name, email, status, last_contact_date`,
                    [leadId]
                );
                
                if (updateResult.rows.length > 0) {
                    console.log('[EMAIL API] ✅ Updated last_contact_date for lead:', leadId);
                    console.log('[EMAIL API] Lead data:', updateResult.rows[0]);
                    
                    // Optional: Add a note to the lead's notes
                    const notesResult = await pool.query(
                        'SELECT notes FROM leads WHERE id = $1',
                        [leadId]
                    );
                    
                    let notes = [];
                    if (notesResult.rows[0]?.notes) {
                        try {
                            notes = JSON.parse(notesResult.rows[0].notes);
                        } catch (e) {
                            notes = [];
                        }
                    }
                    
                    notes.push({
                        text: `Email sent: "${subject}"`,
                        author: req.user.username || 'Admin',
                        date: new Date().toISOString()
                    });
                    
                    await pool.query(
                        'UPDATE leads SET notes = $1 WHERE id = $2',
                        [JSON.stringify(notes), leadId]
                    );
                    
                    console.log('[EMAIL API] ✅ Added email note to lead');
                } else {
                    console.warn('[EMAIL API] ⚠️ Lead not found for ID:', leadId);
                }
                
            } catch (dbError) {
                console.error('[EMAIL API] ❌ Database update error:', dbError);
                // Don't fail the request if DB update fails, email was still sent
            }
        }
        
        // Return success response
        res.json({ 
            success: true, 
            message: 'Email sent successfully and lead updated',
            messageId: info?.messageId
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
app.get('/api/analytics/funnel', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE is_customer = FALSE) as total_leads,
                COUNT(*) FILTER (WHERE status = 'contacted' AND is_customer = FALSE) as contacted,
                COUNT(*) FILTER (WHERE status = 'closed' OR is_customer = TRUE) as closed,
                COUNT(*) FILTER (WHERE is_customer = TRUE) as customers,
                ROUND(AVG(
                    EXTRACT(EPOCH FROM (
                        CASE 
                            WHEN is_customer THEN 
                                COALESCE(last_payment_date, updated_at) - created_at
                            ELSE NULL
                        END
                    )) / 86400
                ), 1) as avg_days_to_convert
            FROM leads
        `);
        
        res.json({
            success: true,
            funnel: result.rows[0]
        });
    } catch (error) {
        console.error('Get funnel error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

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
        // Hash the password
        const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
        
        // Update the lead with client credentials
        await pool.query(`
            UPDATE leads 
            SET email = $1, 
                client_password = $2,
                is_customer = TRUE,
                client_account_created_at = CURRENT_TIMESTAMP
            WHERE id = $3
        `, [email, hashedPassword, leadId]);
        
        // Get lead details for email
        const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
        const lead = leadResult.rows[0];
        
        // Send welcome email if requested
        if (sendWelcomeEmail && lead) {
            await sendClientWelcomeEmail(lead.email, lead.name, temporaryPassword);
        }
        
        res.json({ 
            success: true, 
            message: 'Client account created successfully',
            credentials: {
                email: email,
                temporaryPassword: temporaryPassword
            }
        });
    } catch (error) {
        console.error('Failed to create client account:', error);
        res.status(500).json({ success: false, message: 'Failed to create account' });
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
        
        console.log(`[FOLLOW-UP] ✅ Lead ${leadId} marked as contacted`);
        
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
        
        // Determine email content
        let emailSubject = subject;
        let emailBody = message;
        
        // Use template if provided
        if (template === 'initial') {
            emailSubject = `Following up on your inquiry - ${lead.name}`;
            emailBody = `
                Hi ${lead.name},
                
                I wanted to follow up on your recent inquiry about ${lead.project_type || 'our services'}.
                
                We'd love to learn more about your project and discuss how we can help.
                
                Would you be available for a brief call this week?
                
                Best regards,
                Diamondback Coding Team
            `;
        } else if (template === 'reminder') {
            emailSubject = `Quick check-in - ${lead.name}`;
            emailBody = `
                Hi ${lead.name},
                
                Just checking in to see if you had any questions about ${lead.project_type || 'your project'}.
                
                We're here to help whenever you're ready.
                
                Best regards,
                Diamondback Coding Team
            `;
        }
        
        // Send email using your existing transporter
        const mailOptions = {
            from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
            to: lead.email,
            subject: emailSubject,
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                        .header { background: #22c55e; color: white; padding: 30px; text-align: center; margin-bottom: 30px; }
                        .content { padding: 20px; background: white; }
                        .footer { background: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666; margin-top: 30px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1 style="margin: 0; font-size: 24px;">Diamondback Coding</h1>
                        </div>
                        <div class="content">
                            ${emailBody.replace(/\n/g, '<br>')}
                        </div>
                        <div class="footer">
                            <p><strong>Diamondback Coding</strong><br>
                            15709 Spillman Ranch Loop, Austin, TX 78738<br>
                            <a href="mailto:contact@diamondbackcoding.com">contact@diamondbackcoding.com</a> | (940) 217-8680</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        };
        
        await transporter.sendMail(mailOptions);
        
        // Update last_contact_date
        await pool.query(
            `UPDATE leads 
             SET last_contact_date = CURRENT_DATE,
                 status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [leadId]
        );
        
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
        
        console.log(`[FOLLOW-UP] ✅ Email sent to ${lead.email}`);
        
        res.json({
            success: true,
            message: 'Follow-up email sent successfully'
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
                
                // Send email (simplified - use template logic from above)
                let emailSubject = subject || `Following up - ${lead.name}`;
                let emailBody = message || `Hi ${lead.name}, just checking in...`;
                
                const mailOptions = {
                    from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
                    to: lead.email,
                    subject: emailSubject,
                    html: `<p>${emailBody.replace(/\n/g, '<br>')}</p>`
                };
                
                await transporter.sendMail(mailOptions);
                
                // Update lead
                await pool.query(
                    `UPDATE leads 
                     SET last_contact_date = CURRENT_DATE,
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $1`,
                    [leadId]
                );
                
                successCount++;
                
            } catch (error) {
                console.error(`[BULK] Error sending to lead ${leadId}:`, error);
                failCount++;
                errors.push({ leadId, error: error.message });
            }
        }
        
        console.log(`[BULK FOLLOW-UP] ✅ Sent: ${successCount}, ❌ Failed: ${failCount}`);
        
        res.json({
            success: true,
            message: `Sent ${successCount} emails, ${failCount} failed`,
            successCount,
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
                
                // Send email (simplified - use template logic from above)
                let emailSubject = subject || `Following up - ${lead.name}`;
                let emailBody = message || `Hi ${lead.name}, just checking in...`;
                
                const mailOptions = {
                    from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
                    to: lead.email,
                    subject: emailSubject,
                    html: `<p>${emailBody.replace(/\n/g, '<br>')}</p>`
                };
                
                await transporter.sendMail(mailOptions);
                
                // Update lead
                await pool.query(
                    `UPDATE leads 
                     SET last_contact_date = CURRENT_DATE,
                         status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $1`,
                    [leadId]
                );
                
                // Add note to lead (NEW: Mirror single send logic)
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
                
                successCount++;
                
            } catch (error) {
                console.error(`[BULK] Error sending to lead ${leadId}:`, error);
                failCount++;
                errors.push({ leadId, error: error.message });
            }
        }
        
        console.log(`[BULK FOLLOW-UP] ✅ Sent: ${successCount}, ❌ Failed: ${failCount}`);
        
        res.json({
            success: true,
            message: `Sent ${successCount} emails, ${failCount} failed`,
            successCount,
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
                COALESCE(CURRENT_DATE - l.last_contact_date, 999) as days_since_contact
            FROM leads l
            WHERE l.status IN ('new', 'contacted', 'qualified', 'pending')
            AND l.is_customer = FALSE
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
                const emailHTML = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <style>
                            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                            .header { background: #22c55e; color: white; padding: 30px; text-align: center; margin-bottom: 30px; }
                            .content { padding: 20px; background: white; white-space: pre-wrap; }
                            .footer { background: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666; margin-top: 30px; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <h1 style="margin: 0; font-size: 24px;">Diamondback Coding</h1>
                            </div>
                            <div class="content">
                                ${message.replace(/\n/g, '<br>')}
                            </div>
                            <div class="footer">
                                <p><strong>Diamondback Coding</strong><br>
                                15709 Spillman Ranch Loop, Austin, TX 78738<br>
                                <a href="mailto:contact@diamondbackcoding.com">contact@diamondbackcoding.com</a> | (940) 217-8680</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `;
                
                const mailOptions = {
                    from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
                    to: lead.email,
                    subject: subject,
                    html: emailHTML
                };
                
                await transporter.sendMail(mailOptions);
                
                // Update last_contact_date
                await pool.query(
                    `UPDATE leads 
                     SET last_contact_date = CURRENT_DATE,
                         status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $1`,
                    [lead.id]
                );
                
                // Add note to lead (NEW: Mirror single send logic)
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

// Get follow-up statistics with categories
app.get('/api/follow-ups/stats', authenticateToken, async (req, res) => {
    try {
        console.log('[FOLLOW-UP STATS] Getting statistics');
        
        const stats = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE last_contact_date IS NULL) as never_contacted,
                COUNT(*) FILTER (WHERE (CURRENT_DATE - last_contact_date) >= 1 AND (CURRENT_DATE - last_contact_date) < 3) as one_day,
                COUNT(*) FILTER (WHERE (CURRENT_DATE - last_contact_date) >= 3 AND (CURRENT_DATE - last_contact_date) < 7) as three_day,
                COUNT(*) FILTER (WHERE (CURRENT_DATE - last_contact_date) >= 7 AND (CURRENT_DATE - last_contact_date) < 14) as seven_day,
                COUNT(*) FILTER (WHERE (CURRENT_DATE - last_contact_date) >= 14) as fourteen_day,
                COUNT(*) as total_pending
            FROM leads
            WHERE status IN ('new', 'contacted', 'qualified', 'pending')
            AND is_customer = FALSE
            AND (
                last_contact_date IS NULL
                OR last_contact_date <= CURRENT_DATE - INTERVAL '1 day'
            )
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

async function renderFollowUps(content, categories) {
    console.log('[DEBUG] renderFollowUps called');
    console.log('[DEBUG] content element:', content);
    console.log('[DEBUG] categories:', categories);
    console.log('[DEBUG] categories type:', typeof categories);
    console.log('[DEBUG] categories is array?:', Array.isArray(categories));
    
    // Just show the raw data for now
    content.innerHTML = `
        <div style="padding: 40px;">
            <h2>DEBUG INFO</h2>
            <pre style="background: #f5f5f5; padding: 20px; border-radius: 8px; overflow: auto;">
Categories: ${JSON.stringify(categories, null, 2)}
            </pre>
        </div>
    `;
}

// ========================================
// HEALTH CHECK
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
// SERVER STARTUP
// ========================================
async function startServer() {
    try {
        await initializeDatabase(pool);
        await initializeExpenseTables();
        await addLeadSourceTracking();
        
        // ✅ THIS LINE MUST BE HERE
        const emailConfigured = await verifyEmailConfig();
        if (!emailConfigured) {
            console.warn('⚠️  Email functionality may not work properly');
        }
        
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