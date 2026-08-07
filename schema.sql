-- =====================================================================
--  CraftedCode Co. / CodeNexus  —  full database schema
--  Rebuilds every table server.js needs, from scratch, idempotently.
--  Safe to run repeatedly: every statement is IF NOT EXISTS guarded.
--
--  Run order matters: this file must be applied BEFORE server.js
--  calls initializeDatabase(), because that function's first
--  statements ALTER tables it assumes already exist.
-- =====================================================================

-- ---------------------------------------------------------------------
-- SECTION 1 — base tables (no foreign keys yet, so order is irrelevant)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS activity_log (
id SERIAL PRIMARY KEY,
                user_email VARCHAR(255),
                action VARCHAR(100) NOT NULL,
                resource_type VARCHAR(50),
                resource_id INTEGER,
                details JSONB,
                ip_address VARCHAR(50),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_files (
    id          SERIAL PRIMARY KEY,
    filename    VARCHAR(255),
    filepath    TEXT,
    file_size   BIGINT,
    mime_type   VARCHAR(255),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_sessions (
id SERIAL PRIMARY KEY,
                user_email VARCHAR(255),
                token TEXT UNIQUE NOT NULL,
                ip_address VARCHAR(50),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS admin_users (
id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
);

CREATE TABLE IF NOT EXISTS applications (
id SERIAL PRIMARY KEY,
    job_id INTEGER,
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
);

CREATE TABLE IF NOT EXISTS appointments (
    id              SERIAL PRIMARY KEY,
    lead_email      VARCHAR(255),
    lead_name       VARCHAR(255),
    scheduled_time  TIMESTAMP,
    event_type      VARCHAR(255),
    status          VARCHAR(50) DEFAULT 'scheduled',
    notes           TEXT,
    cancelled_at    TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auto_campaigns (
id SERIAL PRIMARY KEY,
    lead_id INTEGER,
    subject VARCHAR(500) NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                contact_name VARCHAR(255) NOT NULL,
                contact_email VARCHAR(255) NOT NULL,
                contact_phone VARCHAR(50),
                booking_date DATE NOT NULL,
                booking_time TIME NOT NULL,
                duration_minutes INTEGER DEFAULT 30,
                service_type VARCHAR(100),
                notes TEXT,
                status VARCHAR(50) DEFAULT 'scheduled',
                booked_from VARCHAR(50) DEFAULT 'email',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_appointments (
id SERIAL PRIMARY KEY,
                        client_portal_id VARCHAR(64),
                        user_id INTEGER,
                        assigned_to_email VARCHAR(255),
                        client_name VARCHAR(255),
                        client_email VARCHAR(255),
                        client_phone VARCHAR(50),
                        scheduled_at TIMESTAMPTZ,
                        notes TEXT,
                        status VARCHAR(50) DEFAULT 'scheduled',
                        confirmation_sent BOOLEAN DEFAULT FALSE,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_chain_queue (
id SERIAL PRIMARY KEY,
                        lead_id INTEGER,
                        chain_id INTEGER,
                        step_index INTEGER DEFAULT 0,
                        template_id INTEGER,
                        scheduled_at TIMESTAMPTZ DEFAULT NOW(),
                        sent_at TIMESTAMPTZ,
                        client_portal_id VARCHAR(64),
                        is_active BOOLEAN DEFAULT TRUE,
                        created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_companies (
    id                  SERIAL PRIMARY KEY,
    client_portal_id    VARCHAR(255) UNIQUE NOT NULL,
    company_name        VARCHAR(255),
    admin_email         VARCHAR(255),
    admin_name          VARCHAR(255),
    total_active_seats  INTEGER NOT NULL DEFAULT 0,
    purchased_seats     INTEGER NOT NULL DEFAULT 0,
    monthly_total       NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_contacts (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER,
    name        VARCHAR(255),
    email       VARCHAR(255),
    phone       VARCHAR(50),
    company     VARCHAR(255),
    notes       TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_deals (
    id                   SERIAL PRIMARY KEY,
    client_id            INTEGER,
    contact_id           INTEGER,
    name                 VARCHAR(255),
    amount               NUMERIC(12,2) DEFAULT 0,
    stage                VARCHAR(100) DEFAULT 'new',
    probability          INTEGER DEFAULT 50,
    expected_close_date  DATE,
    notes                TEXT,
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_email_chain_steps (
id SERIAL PRIMARY KEY,
                chain_id INTEGER,
                template_id INTEGER,
                step_order INTEGER NOT NULL,
                delay_days INTEGER NOT NULL DEFAULT 3
);

CREATE TABLE IF NOT EXISTS client_email_chains (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(20) NOT NULL,
                name VARCHAR(255) NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                loop BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_email_log (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(20),
                lead_id INTEGER,
                lead_email VARCHAR(255),
                assigned_to_user_email VARCHAR(255),
                template_id INTEGER,
                chain_id INTEGER,
                subject VARCHAR(500),
                email_type VARCHAR(100) DEFAULT 'marketing',
                status VARCHAR(50) DEFAULT 'pending',
                brevo_message_id VARCHAR(255),
                sent_at TIMESTAMP,
                opened_at TIMESTAMP,
                clicked_at TIMESTAMP,
                lead_became_hot BOOLEAN DEFAULT FALSE,
                to_email VARCHAR(255),
                error_message TEXT,
                created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_email_settings (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(20) NOT NULL UNIQUE,
                brevo_api_key TEXT,
                sender_email VARCHAR(255),
                sender_name VARCHAR(255),
                company_name VARCHAR(255),
                company_phone VARCHAR(50),
                company_email VARCHAR(255),
                company_address TEXT,
                website_url VARCHAR(500),
                accent_color VARCHAR(20) DEFAULT '#FF6B35',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_email_templates (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(20),
                individual_owner_id INTEGER,
                name VARCHAR(255) NOT NULL,
                topic VARCHAR(100),
                eyebrow VARCHAR(255),
                headline VARCHAR(500),
                body_html TEXT NOT NULL,
                cta_label VARCHAR(100),
                subject VARCHAR(500) NOT NULL,
                is_automated BOOLEAN DEFAULT FALSE,
                created_by_user_email VARCHAR(255),
                website_url VARCHAR(500),
                website_btn_label VARCHAR(100),
                include_contact_form BOOLEAN DEFAULT TRUE,
                contact_btn_label VARCHAR(100),
                include_schedule_btn BOOLEAN DEFAULT TRUE,
                schedule_btn_label VARCHAR(100),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_products (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(50),
                individual_owner_id INTEGER,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price NUMERIC(10,2),
                sku VARCHAR(100),
                category VARCHAR(100),
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_projects (
id SERIAL PRIMARY KEY,
        lead_id INTEGER,
        project_name VARCHAR(500) NOT NULL,
        description TEXT,
        start_date DATE,
        end_date DATE,
        status VARCHAR(50) DEFAULT 'in_progress',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_sms_chain_queue (
id SERIAL PRIMARY KEY,
                    chain_id INTEGER,
                    lead_id INTEGER,
                    client_portal_id VARCHAR(255),
                    current_step INTEGER DEFAULT 0,
                    next_send_at TIMESTAMP,
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_sms_chain_steps (
id SERIAL PRIMARY KEY,
                    chain_id INTEGER,
                    template_id INTEGER,
                    step_order INTEGER NOT NULL DEFAULT 0,
                    delay_days INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_sms_chains (
id SERIAL PRIMARY KEY,
                    client_portal_id VARCHAR(255),
                    name VARCHAR(255) NOT NULL,
                    loop BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_sms_templates (
    id                SERIAL PRIMARY KEY,
    client_portal_id  VARCHAR(255),
    name              VARCHAR(255) NOT NULL,
    body              TEXT,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_tasks (
id SERIAL PRIMARY KEY,
        client_id INTEGER,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        due_date TIMESTAMP,
        priority VARCHAR(50) DEFAULT 'medium',
        status VARCHAR(50) DEFAULT 'pending',
        completed BOOLEAN DEFAULT FALSE,
        completed_at TIMESTAMP,
        related_to_type VARCHAR(100),
        related_to_id INTEGER,
        assigned_to_name VARCHAR(255),
        created_by_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_unsubscribes (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(20),
                email VARCHAR(255) NOT NULL,
                unsubscribed_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(client_portal_id, email)
);

CREATE TABLE IF NOT EXISTS client_uploads (
id SERIAL PRIMARY KEY,
        lead_id INTEGER,
        project_id INTEGER,
        filename VARCHAR(500) NOT NULL,
        filepath TEXT NOT NULL,
        file_size BIGINT,
        mime_type VARCHAR(100),
        description TEXT,
        shared_by_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_users (
    id                      SERIAL PRIMARY KEY,
    client_portal_id        VARCHAR(255) NOT NULL,
    user_label              VARCHAR(255),
    user_name               VARCHAR(255),
    user_email              VARCHAR(255) NOT NULL,
    subscription_id         INTEGER,
    stripe_subscription_id  VARCHAR(255),
    package_key             VARCHAR(100),
    package_name            VARCHAR(255),
    price_per_user          NUMERIC(10,2) DEFAULT 0,
    is_admin                BOOLEAN DEFAULT FALSE,
    status                  VARCHAR(50) DEFAULT 'active',
    sender_name             VARCHAR(255),
    sms_enabled             BOOLEAN DEFAULT FALSE,
    sms_sender_name         VARCHAR(11),
    added_date              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cancelled_date          TIMESTAMP,
    access_until            TIMESTAMP,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cookie_consent (
id SERIAL PRIMARY KEY,
                user_id VARCHAR(255),
                consent_type VARCHAR(50) NOT NULL,
                preferences JSONB,
                ip_address VARCHAR(45),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_integration_webhooks (
id                SERIAL PRIMARY KEY,
                lead_id           INTEGER,
                client_portal_id  VARCHAR(20),
                name              VARCHAR(100),
                url               TEXT NOT NULL,
                trigger_events    TEXT[] DEFAULT ARRAY['lead.created','lead.updated','lead.status_changed'],
                is_active         BOOLEAN DEFAULT TRUE,
                created_at        TIMESTAMP DEFAULT NOW(),
                last_fired_at     TIMESTAMP,
                fire_count        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS crm_integrations (
id                SERIAL PRIMARY KEY,
                lead_id           INTEGER,
                client_portal_id  VARCHAR(20),
                integration_key   VARCHAR(50) NOT NULL,
                access_token      TEXT,
                refresh_token     TEXT,
                token_expires_at  TIMESTAMP,
                account_id        VARCHAR(255),
                account_name      VARCHAR(255),
                account_email     VARCHAR(255),
                metadata          JSONB DEFAULT '{}'::jsonb,
                connected_at      TIMESTAMP DEFAULT NOW(),
                last_synced_at    TIMESTAMP,
                status            VARCHAR(20) DEFAULT 'active',
                UNIQUE(lead_id, integration_key),
                UNIQUE(client_portal_id, integration_key)
);

CREATE TABLE IF NOT EXISTS crm_subscriptions (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                lead_email VARCHAR(255) NOT NULL,
                lead_name VARCHAR(255),
                package_key VARCHAR(100) NOT NULL,
                package_name VARCHAR(255) NOT NULL,
                user_count INTEGER NOT NULL DEFAULT 1,
                price_per_user NUMERIC(10,2) NOT NULL,
                monthly_total NUMERIC(10,2) NOT NULL,
                stripe_customer_id VARCHAR(255),
                stripe_subscription_id VARCHAR(255) UNIQUE,
                stripe_price_id VARCHAR(255),
                status VARCHAR(50) NOT NULL DEFAULT 'active',
                current_period_start TIMESTAMP,
                current_period_end TIMESTAMP,
                cancel_at_period_end BOOLEAN DEFAULT FALSE,
                cancelled_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deal_activities (
id SERIAL PRIMARY KEY,
                deal_id INTEGER,
                activity_type VARCHAR(100) NOT NULL,
                description TEXT,
                metadata JSONB,
                created_by INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_shares (
id SERIAL PRIMARY KEY,
                document_id INTEGER,
                shared_with_email VARCHAR(255),
                share_token VARCHAR(255) UNIQUE,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_versions (
id SERIAL PRIMARY KEY,
                document_id INTEGER,
                version_number INTEGER NOT NULL,
                filename VARCHAR(500) NOT NULL,
                file_path TEXT NOT NULL,
                file_size BIGINT,
                uploaded_by INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                filename VARCHAR(500) NOT NULL,
                original_filename VARCHAR(500) NOT NULL,
                file_path TEXT NOT NULL,
                file_size BIGINT,
                mime_type VARCHAR(100),
                document_type VARCHAR(100),
                description TEXT,
                uploaded_by INTEGER,
                is_shared BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_log (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                template_id INTEGER,
                subject VARCHAR(500),
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                opened_at TIMESTAMP,
                clicked_at TIMESTAMP,
                status VARCHAR(50) DEFAULT 'sent'
);

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
);

CREATE TABLE IF NOT EXISTS expenses (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
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
                created_by INTEGER
);

CREATE TABLE IF NOT EXISTS invoice_items (
id SERIAL PRIMARY KEY,
                invoice_id INTEGER,
                description VARCHAR(500) NOT NULL,
                quantity INTEGER DEFAULT 1,
                unit_price DECIMAL(10, 2) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
id SERIAL PRIMARY KEY,
                invoice_number VARCHAR(50) UNIQUE NOT NULL,
                lead_id INTEGER,
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
                created_by INTEGER,
                paid_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
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
);

CREATE TABLE IF NOT EXISTS lead_notes (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                note_text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by INTEGER
);

CREATE TABLE IF NOT EXISTS lead_products (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                product_id INTEGER,
                client_portal_id VARCHAR(50),
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(lead_id, product_id)
);

CREATE TABLE IF NOT EXISTS lead_scores (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                total_score INTEGER DEFAULT 0,
                engagement_score INTEGER DEFAULT 0,
                demographic_score INTEGER DEFAULT 0,
                behavioral_score INTEGER DEFAULT 0,
                grade VARCHAR(1),
                last_calculated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_lead_score UNIQUE (lead_id)
);

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
);

CREATE TABLE IF NOT EXISTS message_log (
id SERIAL PRIMARY KEY,
                    lead_id INTEGER,
                    client_portal_id VARCHAR(255),
                    direction VARCHAR(10) NOT NULL DEFAULT 'outbound',
                    channel VARCHAR(10) NOT NULL DEFAULT 'email',
                    content TEXT,
                    subject VARCHAR(500),
                    status VARCHAR(50) DEFAULT 'sent',
                    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    from_number VARCHAR(50),
                    to_number VARCHAR(50),
                    from_email VARCHAR(255),
                    to_email VARCHAR(255),
                    brevo_message_id VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pipeline_deals (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                stage_id INTEGER,
                title VARCHAR(500) NOT NULL,
                value DECIMAL(10, 2),
                expected_close_date DATE,
                probability INTEGER DEFAULT 50,
                position INTEGER DEFAULT 0,
                notes TEXT,
                assigned_to INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS portal_bg_images (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(20) NOT NULL,
                url TEXT NOT NULL,
                label VARCHAR(100),
                uploaded_by VARCHAR(255),
                created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portal_usage_events (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(255) NOT NULL,
                portal_label VARCHAR(500),
                event_type VARCHAR(20) NOT NULL,
                lead_id INTEGER,
                lead_email VARCHAR(255),
                subject VARCHAR(500),
                brevo_message_id VARCHAR(255),
                brevo_cost DECIMAL(12,6),
                client_charge DECIMAL(12,6),
                billing_month DATE NOT NULL,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portal_usage_log (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(255) NOT NULL,
                portal_label VARCHAR(500),
                billing_month DATE NOT NULL,
                email_count INTEGER DEFAULT 0,
                sms_count INTEGER DEFAULT 0,
                email_cost DECIMAL(12,6) DEFAULT 0,
                sms_cost DECIMAL(12,6) DEFAULT 0,
                email_revenue DECIMAL(12,6) DEFAULT 0,
                sms_revenue DECIMAL(12,6) DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(client_portal_id, billing_month)
);

CREATE TABLE IF NOT EXISTS project_milestones (
id SERIAL PRIMARY KEY,
        project_id INTEGER,
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
);

CREATE TABLE IF NOT EXISTS recurring_invoices (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(255) NOT NULL,
                lead_id INTEGER,
                lead_name VARCHAR(255),
                lead_email VARCHAR(255),
                description VARCHAR(500),
                amount DECIMAL(10,2) NOT NULL,
                send_day_of_month INTEGER NOT NULL DEFAULT 1,
                is_active BOOLEAN DEFAULT TRUE,
                last_sent_at TIMESTAMP,
                next_send_date DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS score_history (
id SERIAL PRIMARY KEY,
                lead_id INTEGER,
                rule_id INTEGER,
                points_added INTEGER,
                reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS sms_auto_sequences (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(50) NOT NULL UNIQUE,
                enabled BOOLEAN DEFAULT FALSE,
                steps JSONB DEFAULT '[]',
                updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_templates (
id SERIAL PRIMARY KEY,
                client_portal_id VARCHAR(50) NOT NULL,
                name VARCHAR(255) NOT NULL,
                body TEXT NOT NULL,
                include_schedule_link BOOLEAN DEFAULT FALSE,
                include_contact_link BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_events (
id SERIAL PRIMARY KEY,
                subscription_id INTEGER,
                lead_email VARCHAR(255),
                event_type VARCHAR(100) NOT NULL,
                amount NUMERIC(10,2),
                description TEXT,
                stripe_event_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS support_tickets (
id SERIAL PRIMARY KEY,
        lead_id INTEGER,
        client_name VARCHAR(255),
        client_email VARCHAR(255),
        subject VARCHAR(500) NOT NULL,
        message TEXT NOT NULL,
        priority VARCHAR(50) DEFAULT 'medium',
        category VARCHAR(100) DEFAULT 'general',
        status VARCHAR(50) DEFAULT 'open',
        assigned_to INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
id SERIAL PRIMARY KEY,
                title VARCHAR(500) NOT NULL,
                description TEXT,
                due_date DATE,
                priority VARCHAR(20) DEFAULT 'medium',
                status VARCHAR(50) DEFAULT 'pending',
                completed BOOLEAN DEFAULT FALSE,
                assigned_to INTEGER,
                created_by VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ticket_responses (
id SERIAL PRIMARY KEY,
        ticket_id INTEGER,
        user_id INTEGER,
        user_type VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- ---------------------------------------------------------------------
-- SECTION 2 — columns your server.js migrations add later.
-- Folded in here so the schema is complete on first boot.
-- ---------------------------------------------------------------------

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMP;
ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS stop_reason TEXT;
ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMP;
ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE client_companies ADD COLUMN IF NOT EXISTS purchased_seats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE client_email_log ADD COLUMN IF NOT EXISTS lead_became_hot BOOLEAN DEFAULT FALSE;
ALTER TABLE client_email_log ADD COLUMN IF NOT EXISTS to_email VARCHAR(255);
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS bounce_count INTEGER DEFAULT 0;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS brevo_sms_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS brevo_sms_sender VARCHAR(20);
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS company_logo_url TEXT;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS complaint_count INTEGER DEFAULT 0;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS dkim_selector VARCHAR(100);
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS dkim_value TEXT;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS domain_id INTEGER;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS emailjs_public_key VARCHAR(255);
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS emailjs_service_id VARCHAR(255);
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS emailjs_template_id VARCHAR(255);
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS emails_sent_today INTEGER DEFAULT 0;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS rate_limit_day INTEGER DEFAULT 500;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS rate_reset_at DATE DEFAULT CURRENT_DATE;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS suspended BOOLEAN DEFAULT FALSE;
ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS verified_domain VARCHAR(255);
ALTER TABLE client_email_templates ADD COLUMN IF NOT EXISTS contact_btn_label VARCHAR(100);
ALTER TABLE client_email_templates ADD COLUMN IF NOT EXISTS include_contact_form BOOLEAN DEFAULT TRUE;
ALTER TABLE client_email_templates ADD COLUMN IF NOT EXISTS include_schedule_btn BOOLEAN DEFAULT TRUE;
ALTER TABLE client_email_templates ADD COLUMN IF NOT EXISTS individual_owner_id INTEGER;
ALTER TABLE client_email_templates ADD COLUMN IF NOT EXISTS schedule_btn_label VARCHAR(100);
ALTER TABLE client_email_templates ADD COLUMN IF NOT EXISTS website_btn_label VARCHAR(100);
ALTER TABLE client_email_templates ADD COLUMN IF NOT EXISTS website_url VARCHAR(500);
ALTER TABLE client_products ADD COLUMN IF NOT EXISTS individual_owner_id INTEGER;
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS assigned_to_name VARCHAR(255);
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE;
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255);
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS related_to_id INTEGER;
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS related_to_type VARCHAR(100);
ALTER TABLE company_users ADD COLUMN IF NOT EXISTS access_until TIMESTAMP;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS brevo_message_id TEXT;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS projects_assigned INTEGER DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tasks_completed INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_notes TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS short_description VARCHAR(255);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_payment_link TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_reply_chain_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS became_hot_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_account_created_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_last_login TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_password TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS crm_assigned_to INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_status VARCHAR(50);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deal_value DECIMAL(10, 2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS engagement_score INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS expected_close_date DATE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_contact_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_count INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_step INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS individual_owner_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_customer BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contact_date TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_engagement_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_payment_date TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lifetime_value DECIMAL(10, 2) DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS probability INTEGER DEFAULT 50;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS project_type VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referrer_url TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_details TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS state VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS timeline VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS unsubscribe_token VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS unsubscribed BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_content VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS win_loss_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS zip_code VARCHAR(20);
ALTER TABLE portal_bg_images ADD COLUMN IF NOT EXISTS lead_id INTEGER;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS client_name TEXT;


-- ---------------------------------------------------------------------
-- SECTION 2b — columns your code queries that no CREATE/ALTER in
-- server.js ever adds. These were added by hand to the old database,
-- which is why they vanished with it. Recovered from query analysis.
-- ---------------------------------------------------------------------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_portal_id    VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_company_admin    BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_co_admin         BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_portal_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_temperature    VARCHAR(20) DEFAULT 'cold';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperature         VARCHAR(20) DEFAULT 'cold';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS in_followup_queue   BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted      TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_reply          BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS engagement_history  JSONB DEFAULT '[]'::jsonb;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS website             VARCHAR(255);

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;

ALTER TABLE crm_subscriptions ADD COLUMN IF NOT EXISTS client_portal_id        VARCHAR(255);
ALTER TABLE crm_subscriptions ADD COLUMN IF NOT EXISTS is_company_subscription BOOLEAN DEFAULT FALSE;
ALTER TABLE crm_subscriptions ADD COLUMN IF NOT EXISTS user_label              VARCHAR(255);

ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS chain_id     INTEGER;
ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS current_step INTEGER DEFAULT 0;
ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS lead_email   VARCHAR(255);
ALTER TABLE auto_campaigns ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMP;

ALTER TABLE client_chain_queue ADD COLUMN IF NOT EXISTS current_step INTEGER DEFAULT 0;
ALTER TABLE client_chain_queue ADD COLUMN IF NOT EXISTS lead_email   VARCHAR(255);
ALTER TABLE client_chain_queue ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMP;

ALTER TABLE client_email_settings ADD COLUMN IF NOT EXISTS domain_status VARCHAR(50);
ALTER TABLE email_log             ADD COLUMN IF NOT EXISTS email_type    VARCHAR(50) DEFAULT 'follow-up';

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_name  VARCHAR(255);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS items          JSONB DEFAULT '[]'::jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS name                  VARCHAR(255);
ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS completion_percentage INTEGER DEFAULT 0;
ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP;


-- ---------------------------------------------------------------------
-- SECTION 3 — foreign keys, added last so target tables all exist.
-- ---------------------------------------------------------------------

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_sessions_user_email') THEN
        ALTER TABLE admin_sessions ADD CONSTRAINT fk_admin_sessions_user_email
            FOREIGN KEY (user_email) REFERENCES admin_users(email) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_applications_job_id') THEN
        ALTER TABLE applications ADD CONSTRAINT fk_applications_job_id
            FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_auto_campaigns_lead_id') THEN
        ALTER TABLE auto_campaigns ADD CONSTRAINT fk_auto_campaigns_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bookings_lead_id') THEN
        ALTER TABLE bookings ADD CONSTRAINT fk_bookings_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_chain_queue_lead_id') THEN
        ALTER TABLE client_chain_queue ADD CONSTRAINT fk_client_chain_queue_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_email_chain_steps_chain_id') THEN
        ALTER TABLE client_email_chain_steps ADD CONSTRAINT fk_client_email_chain_steps_chain_id
            FOREIGN KEY (chain_id) REFERENCES client_email_chains(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_email_chain_steps_template_id') THEN
        ALTER TABLE client_email_chain_steps ADD CONSTRAINT fk_client_email_chain_steps_template_id
            FOREIGN KEY (template_id) REFERENCES client_email_templates(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_email_log_lead_id') THEN
        ALTER TABLE client_email_log ADD CONSTRAINT fk_client_email_log_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_email_templates_individual_owner_id') THEN
        ALTER TABLE client_email_templates ADD CONSTRAINT fk_client_email_templates_individual_owner_id
            FOREIGN KEY (individual_owner_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_projects_lead_id') THEN
        ALTER TABLE client_projects ADD CONSTRAINT fk_client_projects_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_sms_chain_queue_chain_id') THEN
        ALTER TABLE client_sms_chain_queue ADD CONSTRAINT fk_client_sms_chain_queue_chain_id
            FOREIGN KEY (chain_id) REFERENCES client_sms_chains(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_sms_chain_queue_lead_id') THEN
        ALTER TABLE client_sms_chain_queue ADD CONSTRAINT fk_client_sms_chain_queue_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_sms_chain_steps_chain_id') THEN
        ALTER TABLE client_sms_chain_steps ADD CONSTRAINT fk_client_sms_chain_steps_chain_id
            FOREIGN KEY (chain_id) REFERENCES client_sms_chains(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_sms_chain_steps_template_id') THEN
        ALTER TABLE client_sms_chain_steps ADD CONSTRAINT fk_client_sms_chain_steps_template_id
            FOREIGN KEY (template_id) REFERENCES client_sms_templates(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_tasks_client_id') THEN
        ALTER TABLE client_tasks ADD CONSTRAINT fk_client_tasks_client_id
            FOREIGN KEY (client_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_uploads_lead_id') THEN
        ALTER TABLE client_uploads ADD CONSTRAINT fk_client_uploads_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_integration_webhooks_lead_id') THEN
        ALTER TABLE crm_integration_webhooks ADD CONSTRAINT fk_crm_integration_webhooks_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_integrations_lead_id') THEN
        ALTER TABLE crm_integrations ADD CONSTRAINT fk_crm_integrations_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_subscriptions_lead_id') THEN
        ALTER TABLE crm_subscriptions ADD CONSTRAINT fk_crm_subscriptions_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_activities_deal_id') THEN
        ALTER TABLE deal_activities ADD CONSTRAINT fk_deal_activities_deal_id
            FOREIGN KEY (deal_id) REFERENCES pipeline_deals(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_activities_created_by') THEN
        ALTER TABLE deal_activities ADD CONSTRAINT fk_deal_activities_created_by
            FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_shares_document_id') THEN
        ALTER TABLE document_shares ADD CONSTRAINT fk_document_shares_document_id
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_versions_document_id') THEN
        ALTER TABLE document_versions ADD CONSTRAINT fk_document_versions_document_id
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_versions_uploaded_by') THEN
        ALTER TABLE document_versions ADD CONSTRAINT fk_document_versions_uploaded_by
            FOREIGN KEY (uploaded_by) REFERENCES admin_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_documents_lead_id') THEN
        ALTER TABLE documents ADD CONSTRAINT fk_documents_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_documents_uploaded_by') THEN
        ALTER TABLE documents ADD CONSTRAINT fk_documents_uploaded_by
            FOREIGN KEY (uploaded_by) REFERENCES admin_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_log_lead_id') THEN
        ALTER TABLE email_log ADD CONSTRAINT fk_email_log_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_lead_id') THEN
        ALTER TABLE expenses ADD CONSTRAINT fk_expenses_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_created_by') THEN
        ALTER TABLE expenses ADD CONSTRAINT fk_expenses_created_by
            FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_items_invoice_id') THEN
        ALTER TABLE invoice_items ADD CONSTRAINT fk_invoice_items_invoice_id
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_lead_id') THEN
        ALTER TABLE invoices ADD CONSTRAINT fk_invoices_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_created_by') THEN
        ALTER TABLE invoices ADD CONSTRAINT fk_invoices_created_by
            FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_notes_lead_id') THEN
        ALTER TABLE lead_notes ADD CONSTRAINT fk_lead_notes_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_notes_created_by') THEN
        ALTER TABLE lead_notes ADD CONSTRAINT fk_lead_notes_created_by
            FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_products_lead_id') THEN
        ALTER TABLE lead_products ADD CONSTRAINT fk_lead_products_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_products_product_id') THEN
        ALTER TABLE lead_products ADD CONSTRAINT fk_lead_products_product_id
            FOREIGN KEY (product_id) REFERENCES client_products(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_scores_lead_id') THEN
        ALTER TABLE lead_scores ADD CONSTRAINT fk_lead_scores_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_message_log_lead_id') THEN
        ALTER TABLE message_log ADD CONSTRAINT fk_message_log_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pipeline_deals_lead_id') THEN
        ALTER TABLE pipeline_deals ADD CONSTRAINT fk_pipeline_deals_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pipeline_deals_stage_id') THEN
        ALTER TABLE pipeline_deals ADD CONSTRAINT fk_pipeline_deals_stage_id
            FOREIGN KEY (stage_id) REFERENCES pipeline_stages(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pipeline_deals_assigned_to') THEN
        ALTER TABLE pipeline_deals ADD CONSTRAINT fk_pipeline_deals_assigned_to
            FOREIGN KEY (assigned_to) REFERENCES admin_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_milestones_project_id') THEN
        ALTER TABLE project_milestones ADD CONSTRAINT fk_project_milestones_project_id
            FOREIGN KEY (project_id) REFERENCES client_projects(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recurring_invoices_lead_id') THEN
        ALTER TABLE recurring_invoices ADD CONSTRAINT fk_recurring_invoices_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_score_history_lead_id') THEN
        ALTER TABLE score_history ADD CONSTRAINT fk_score_history_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_score_history_rule_id') THEN
        ALTER TABLE score_history ADD CONSTRAINT fk_score_history_rule_id
            FOREIGN KEY (rule_id) REFERENCES scoring_rules(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_subscription_events_subscription_id') THEN
        ALTER TABLE subscription_events ADD CONSTRAINT fk_subscription_events_subscription_id
            FOREIGN KEY (subscription_id) REFERENCES crm_subscriptions(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_tickets_lead_id') THEN
        ALTER TABLE support_tickets ADD CONSTRAINT fk_support_tickets_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_tickets_assigned_to') THEN
        ALTER TABLE support_tickets ADD CONSTRAINT fk_support_tickets_assigned_to
            FOREIGN KEY (assigned_to) REFERENCES admin_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_assigned_to') THEN
        ALTER TABLE tasks ADD CONSTRAINT fk_tasks_assigned_to
            FOREIGN KEY (assigned_to) REFERENCES employees(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_responses_ticket_id') THEN
        ALTER TABLE ticket_responses ADD CONSTRAINT fk_ticket_responses_ticket_id
            FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_assigned_to') THEN
        ALTER TABLE leads ADD CONSTRAINT fk_leads_assigned_to
            FOREIGN KEY (assigned_to) REFERENCES employees(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_crm_assigned_to') THEN
        ALTER TABLE leads ADD CONSTRAINT fk_leads_crm_assigned_to
            FOREIGN KEY (crm_assigned_to) REFERENCES company_users(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_individual_owner_id') THEN
        ALTER TABLE leads ADD CONSTRAINT fk_leads_individual_owner_id
            FOREIGN KEY (individual_owner_id) REFERENCES leads(id) ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_portal_bg_images_lead_id') THEN
        ALTER TABLE portal_bg_images ADD CONSTRAINT fk_portal_bg_images_lead_id
            FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_deals_contact_id') THEN
        ALTER TABLE client_deals ADD CONSTRAINT fk_client_deals_contact_id
            FOREIGN KEY (contact_id) REFERENCES client_contacts(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- SECTION 4 — type corrections your startup code tries to apply
-- ---------------------------------------------------------------------
ALTER TABLE company_users
    ALTER COLUMN price_per_user TYPE NUMERIC(10,2)
    USING CAST(price_per_user AS NUMERIC(10,2));

-- ---------------------------------------------------------------------
-- SECTION 5 — indexes on the columns your hot queries filter by
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_email              ON leads (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_leads_portal             ON leads (client_portal_id);
CREATE INDEX IF NOT EXISTS idx_leads_status             ON leads (status);
CREATE INDEX IF NOT EXISTS idx_company_users_portal     ON company_users (client_portal_id);
CREATE INDEX IF NOT EXISTS idx_company_users_email      ON company_users (LOWER(user_email));
CREATE INDEX IF NOT EXISTS idx_company_users_stripe_sub ON company_users (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_client_companies_admin   ON client_companies (LOWER(admin_email));
CREATE INDEX IF NOT EXISTS idx_appointments_lead_email  ON appointments (LOWER(lead_email));
CREATE INDEX IF NOT EXISTS idx_appointments_time        ON appointments (scheduled_time);
CREATE INDEX IF NOT EXISTS idx_client_contacts_client   ON client_contacts (client_id);
CREATE INDEX IF NOT EXISTS idx_client_deals_client      ON client_deals (client_id);