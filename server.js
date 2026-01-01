// ========================================
// server.js - Complete CodeNexus Backend
// ========================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================
// MIDDLEWARE
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
                first_name VARCHAR(255) NOT NULL,
                last_name VARCHAR(255) NOT NULL,
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

        // Add columns if they don't exist (for existing databases)
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
                ['admin', 'admin@codenexus.dev', hashedPassword]
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

// ========================================
// LEAD MANAGEMENT ROUTES
// ========================================

// Get all leads
app.get('/api/leads', authenticateToken, async (req, res) => {
    try {
        const { status, search } = req.query;
        
        let query = 'SELECT * FROM leads WHERE 1=1';
        let params = [];
        let paramIndex = 1;

        if (status && status !== 'all') {
            query += ` AND status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (search) {
            query += ` AND (first_name ILIKE $${paramIndex} OR last_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        query += ' ORDER BY created_at DESC';

        const result = await pool.query(query, params);

        res.json({
            success: true,
            leads: result.rows
        });
    } catch (error) {
        console.error('Get leads error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error.' 
        });
    }
});

// Get single lead with notes
app.get('/api/leads/:id', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;

        const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
        
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

// Create new lead (PUBLIC - from contact form)
app.post('/api/leads', async (req, res) => {
    try {
        const { firstName, lastName, email, phone, service, budget, details } = req.body;

        if (!firstName || !lastName || !email) {
            return res.status(400).json({
                success: false,
                message: 'First name, last name, and email are required.'
            });
        }

        const result = await pool.query(
            `INSERT INTO leads (first_name, last_name, email, phone, service, budget, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [firstName, lastName, email, phone || '', service || '', budget || '', details || '']
        );

        console.log('✅ New lead created:', result.rows[0].email);

        res.json({
            success: true,
            message: 'Thank you for contacting us! We\'ll get back to you within 24 hours.',
            lead: result.rows[0]
        });
    } catch (error) {
        console.error('Create lead error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error. Please try again.' 
        });
    }function showSection(section) {
            document.querySelectorAll('.menu-item').forEach(item => {
                item.classList.remove('active');
            });
            event.target.classList.add('active');
            
            // Update page title
            const pageTitle = document.querySelector('.page-title');
            const filterButtons = document.querySelector('.filter-buttons');
            
            if (section === 'customers') {
                viewMode = 'customers';
                pageTitle.textContent = '// Customers';
                // Show customer-specific filters
                filterButtons.style.display = 'flex';
                filterButtons.innerHTML = `
                    <button class="filter-btn active" onclick="filterCustomers('all')">All</button>
                    <button class="filter-btn" onclick="filterCustomers('onboarding')">Onboarding</button>
                    <button class="filter-btn" onclick="filterCustomers('in-progress')">In Progress</button>
                    <button class="filter-btn" onclick="filterCustomers('review')">Review</button>
                    <button class="filter-btn" onclick="filterCustomers('completed')">Completed</button>
                    <button class="filter-btn" onclick="filterCustomers('on-hold')">On Hold</button>
                    <button class="filter-btn" onclick="filterCustomers('churned')">Churned</button>
                    <button class="filter-btn" onclick="filterCustomers('cancelled')">Cancelled</button>
                `;
                // Render customers table
        function renderCustomers(searchQuery = '') {
            const tbody = document.getElementById('leadsTableBody');
            tbody.innerHTML = '';

            let filteredCustomers = customers;

            // Apply status filter
            if (currentFilter && currentFilter !== 'all') {
                filteredCustomers = filteredCustomers.filter(c => 
                    (c.customer_status || 'onboarding') === currentFilter
                );
            }

            // Apply search filter
            if (searchQuery) {
                const query = searchQuery.toLowerCase();
                filteredCustomers = filteredCustomers.filter(customer =>
                    customer.first_name.toLowerCase().includes(query) ||
                    customer.last_name.toLowerCase().includes(query) ||
                    customer.email.toLowerCase().includes(query) ||
                    (customer.phone && customer.phone.includes(query))
                );
            }

            filteredCustomers.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            filteredCustomers.forEach(customer => {
                const row = document.createElement('tr');
                row.onclick = () => openLeadModal(customer.id);
                
                const statusDisplay = customer.customer_status || 'onboarding';
                
                row.innerHTML = `
                    <td>${customer.first_name} ${customer.last_name}</td>
                    <td>${customer.email}</td>
                    <td>${customer.phone || 'N/A'}</td>
                    <td>${customer.service || 'Not specified'}</td>
                    <td>${customer.budget || 'Not specified'}</td>
                    <td>${formatDate(customer.created_at)}</td>
                    <td><span class="status-badge status-${statusDisplay}">${statusDisplay.replace('-', ' ')}</span></td>
                    <td><span class="priority-badge priority-${customer.priority}">${customer.priority}</span></td>
                    <td onclick="event.stopPropagation()">
                        <button class="action-btn" onclick="openLeadModal(${customer.id})">View</button>
                        <button class="action-btn" onclick="deleteLead(${customer.id})" style="border-color: var(--danger); color: var(--danger);">Delete</button>
                    </td>
                `;
                
                tbody.appendChild(row);
            });

            if (filteredCustomers.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 40px; color: var(--text-light);">No customers found</td></tr>';
            }
        };
            } else {
                viewMode = 'leads';
                pageTitle.textContent = '// Dashboard';
                // Show lead-specific filters
                filterButtons.style.display = 'flex';
                filterButtons.innerHTML = `
                    <button class="filter-btn active" onclick="filterLeads('all')">All</button>
                    <button class="filter-btn" onclick="filterLeads('new')">New</button>
                    <button class="filter-btn" onclick="filterLeads('pending')">Pending</button>
                    <button class="filter-btn" onclick="filterLeads('contacted')">Contacted</button>
                    <button class="filter-btn" onclick="filterLeads('lost')">Lost</button>
                `;
                
                if (section === 'new') {
                    currentFilter = 'new';
                    loadLeads();
                } else if (section === 'pending') {
                    currentFilter = 'pending';
                    loadLeads();
                } else if (section === 'contacted') {
                    currentFilter = 'contacted';
                    loadLeads();
                } else if (section === 'leads' || section === 'dashboard') {
                    currentFilter = 'all';
                    loadLeads();
                }
            }
        }
});

async function filterCustomers(filter) {
            currentFilter = filter;
            
            document.querySelectorAll('.filter-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            event.target.classList.add('active');
            
            renderCustomers();
        }

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
        
        app.listen(PORT, () => {
            console.log('');
            console.log('========================================');
            console.log('🚀 CodeNexus Server Running');
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