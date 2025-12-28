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

        // Create leads table
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
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
                COUNT(*) as total,
                COUNT(CASE WHEN status = 'new' THEN 1 END) as new,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                COUNT(CASE WHEN status = 'contacted' THEN 1 END) as contacted,
                COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed
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
    }
});

// Update lead status
app.patch('/api/leads/:id/status', authenticateToken, async (req, res) => {
    try {
        const leadId = req.params.id;
        const { status } = req.body;

        await pool.query(
            'UPDATE leads SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [status, leadId]
        );

        res.json({
            success: true,
            message: 'Status updated successfully.'
        });
    } catch (error) {
        console.error('Update status error:', error);
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
        // Otherwise, serve the index page (for client-side routing)
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
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