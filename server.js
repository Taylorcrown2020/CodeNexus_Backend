// ========================================
// server.js - Complete CraftedCode Co. Backend
// ========================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================
// STRIPE WEBHOOK (MUST BE FIRST!)
// ========================================
app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('⚠️  Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            const invoiceId = session.metadata.invoice_id;
            
            if (invoiceId) {
                try {
                    // Mark invoice as paid
                    await pool.query(
                        `UPDATE invoices 
                         SET status = 'paid', 
                             paid_at = CURRENT_TIMESTAMP,
                             payment_method = 'Stripe',
                             payment_reference = $1
                         WHERE id = $2`,
                        [session.id, invoiceId]
                    );
                    
                    // Get invoice and customer details
                    const invoiceResult = await pool.query(
                        `SELECT i.*, l.id as lead_id, l.name, l.is_customer
                         FROM invoices i
                         LEFT JOIN leads l ON i.lead_id = l.id
                         WHERE i.id = $1`,
                        [invoiceId]
                    );
                    
                    const invoice = invoiceResult.rows[0];
                    
                    if (!invoice) {
                        console.error('Invoice not found:', invoiceId);
                        return res.json({received: true});
                    }
                    
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
                        console.log(`✅ Lead converted to customer: ${invoice.name}`);
                    } else {
                        // Make sure customer is active
                        await pool.query(
                            `UPDATE leads 
                             SET customer_status = 'active',
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $1`,
                            [invoice.lead_id]
                        );
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
                    
                    console.log(`✅ Payment processed for invoice ${invoice.invoice_number}`);
                    console.log(`   💰 Amount: $${parseFloat(invoice.total_amount).toLocaleString()}`);
                    console.log(`   👤 Customer: ${invoice.name}`);
                    console.log(`   📊 Lifetime Value: $${parseFloat(lifetimeValue.rows[0].total).toLocaleString()}`);
                } catch (error) {
                    console.error('Error processing webhook:', error);
                }
            }
            break;
            
        case 'payment_intent.succeeded':
            console.log('💳 Payment intent succeeded:', event.data.object.id);
            break;
            
        case 'payment_intent.payment_failed':
            console.log('❌ Payment failed:', event.data.object.id);
            break;
            
        default:
            console.log(`Unhandled event type ${event.type}`);
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
// DATABASE CONNECTION
// ========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

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
app.patch('/api/leads/:id/status', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { status, isCustomer, customerStatus } = req.body;

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
        } else {
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
        
        const { name, email, phone, role } = req.body;
        
        console.log('📝 Creating employee:', { name, email, phone, role });

        if (!name || !email) {
            return res.status(400).json({
                success: false,
                message: 'Name and email are required.'
            });
        }

        const result = await pool.query(
            `INSERT INTO employees (name, email, phone, role)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [name.trim(), email.trim().toLowerCase(), phone || null, role || 'Team Member']
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

        const result = await pool.query(
            'UPDATE employees SET is_active = FALSE WHERE id = $1 RETURNING *',
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
            message: 'Employee deleted successfully.'
        });
    } catch (error) {
        console.error('Delete employee error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
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
        
        // Get invoice items
        const itemsResult = await pool.query(
            'SELECT * FROM invoice_items WHERE invoice_id = $1',
            [invoiceId]
        );
        
        // Validate we have all required data
        if (!invoice.short_description) {
            console.error('❌ Missing short_description for invoice:', invoice.invoice_number);
            return res.status(400).json({
                success: false,
                message: 'Invoice must have a description before creating payment link'
            });
        }
        
        const description = invoice.short_description || `Invoice ${invoice.invoice_number}`;
        
        console.log('💳 Creating Stripe price...');
        
        // Create Stripe Price (FIXED - removed description from product_data)
        const price = await stripe.prices.create({
            unit_amount: Math.round(parseFloat(invoice.total_amount) * 100), // Convert to cents
            currency: 'usd',
            product_data: {
                name: `Invoice ${invoice.invoice_number} — ${description}`,
                // REMOVED: description - Stripe doesn't accept this parameter here
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
                customer_email: invoice.email || ''
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

// Add this with your other imports at the top
const nodemailer = require('nodemailer');

// Email configuration (you'll need to set up your email service)
const transporter = nodemailer.createTransport({
    service: 'gmail', // or 'outlook', 'yahoo', etc.
    auth: {
        user: process.env.EMAIL_USER, // your email
        pass: process.env.EMAIL_PASSWORD // your email password or app-specific password
    }
});

// Add this route with your other API routes
app.post('/api/email/send-timeline', authenticateToken, async (req, res) => {
    try {
        const { timeline, clientEmail, clientName } = req.body;
        
        if (!clientEmail) {
            return res.status(400).json({ success: false, message: 'Client email is required' });
        }
        
        // Calculate total price
        let totalPrice = 0;
        timeline.packages.forEach(key => {
            if (servicePackages[key] && !servicePackages[key].isFree) {
                totalPrice += servicePackages[key].price;
            }
        });
        
        const documentId = `SLA-${new Date(timeline.createdAt).getFullYear()}-${String(Date.now()).slice(-6)}`;
        
        // Create email HTML (simplified version - you can make this match your PDF)
        const emailHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                    .header { background: #22c55e; color: white; padding: 30px; text-align: center; }
                    .content { padding: 30px; max-width: 800px; margin: 0 auto; }
                    .button { display: inline-block; background: #22c55e; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; margin: 20px 0; }
                    .footer { background: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1 style="margin: 0; font-size: 32px;">DIAMONDBACK CODING</h1>
                    <p style="margin: 5px 0 0 0; opacity: 0.9;">Premium Development Services</p>
                </div>
                
                <div class="content">
                    <h2>Hello ${clientName},</h2>
                    
                    <p>Thank you for choosing Diamondback Coding! Your Service Level Agreement (SLA) is ready for review.</p>
                    
                    <p><strong>Project Details:</strong></p>
                    <ul>
                        <li><strong>Project:</strong> ${timeline.projectName || 'Web Development Project'}</li>
                        <li><strong>Start Date:</strong> ${new Date(timeline.startDate).toLocaleDateString()}</li>
                        <li><strong>Total Investment:</strong> ${timeline.isFreeProject ? 'FREE' : '$' + totalPrice.toLocaleString()}</li>
                        <li><strong>Document ID:</strong> ${documentId}</li>
                    </ul>
                    
                    <p><strong>Selected Services:</strong></p>
                    <ul>
                        ${timeline.packages.map(key => `<li>${servicePackages[key]?.name || key}</li>`).join('')}
                    </ul>
                    
                    <p>Please review the attached SLA document carefully. If you have any questions or need clarification on any terms, please don't hesitate to reach out.</p>
                    
                    <p><strong>Next Steps:</strong></p>
                    <ol>
                        <li>Review the attached SLA document</li>
                        <li>Sign and date the client signature section</li>
                        <li>Return the signed document to us</li>
                        <li>We'll schedule your discovery & planning meeting!</li>
                    </ol>
                    
                    <p>We're excited to work with you and bring your vision to life!</p>
                    
                    <p>Best regards,<br>
                    <strong>Diamondback Coding Team</strong></p>
                </div>
                
                <div class="footer">
                    <p>Diamondback Coding<br>
                    15709 Spillman Ranch Loop, Austin, TX 78738<br>
                    diamondbackcoding@gmail.com | (940) 217-8680</p>
                    <p style="font-size: 11px; color: #999; margin-top: 10px;">This is an automated message. Please do not reply directly to this email.</p>
                </div>
            </body>
            </html>
        `;
        
        // Email options
        const mailOptions = {
            from: `"Diamondback Coding" <${process.env.EMAIL_USER}>`,
            to: clientEmail,
            subject: `Your Service Level Agreement - ${timeline.projectName || 'Web Development Project'}`,
            html: emailHTML
            // Note: For PDF attachment, you'd need to generate it server-side or use a PDF generation library
        };
        
        // Send email
        await transporter.sendMail(mailOptions);
        
        res.json({ success: true, message: 'Email sent successfully' });
        
    } catch (error) {
        console.error('Email error:', error);
        res.status(500).json({ success: false, message: 'Failed to send email', error: error.message });
    }
});

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

// ========================================
// SERVER STARTUP
// ========================================
async function startServer() {
    try {
        await initializeDatabase();
        await initializeExpenseTables(); // THIS IS THE NEW LINE ADDED
        
        app.listen(PORT, () => {
            console.log('');
            console.log('========================================');
            console.log('🚀 CraftedCode Co. Server Running');
            console.log('========================================');
            console.log(`📡 Port: ${PORT}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🔗 Local: http://localhost:${PORT}`);
            console.log(`📄 Main Site: http://localhost:${PORT}`);
            console.log(`📧 Contact Form: http://localhost:${PORT}/contact`);
            console.log(`🔐 Admin Login: http://localhost:${PORT}/admin`);
            console.log(`📊 Admin Portal: http://localhost:${PORT}/admin/portal`);
            console.log(`💚 Health Check: http://localhost:${PORT}/api/health`);
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