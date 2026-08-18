// ============================================================================
// diamondback-documents.js — Diamondback Coding
//
// ONE SOURCE OF TRUTH FOR EVERY CUSTOMER-FACING LEGAL DOCUMENT.
//
// Before this file, an agreement existed in three different forms that could
// disagree with each other:
//   * a paragraph of `terms` text written at creation time,
//   * a PDF assembled separately in diamondback-portal.js,
//   * whatever subset of those the portal happened to render on screen.
// The customer signed the third one. The PDF said something else. That is the
// worst possible arrangement for a document you may one day have to enforce.
//
// Now: buildAgreementDocument() produces a structured document. Everything
// else — the on-screen signing view, the PDF, the plain-text snapshot that gets
// hashed into agreement_signatures — renders THAT SAME OBJECT. They cannot
// drift, because there is only one of them.
//
// WHAT CHANGED IN THIS ROUND
//   1. Recurring agreements carry an explicit AUTOPAY AUTHORIZATION section.
//      Signing is consent to scheduled automatic debits of a stated amount, on
//      a stated day, until cancelled — worded the way a card network or bank
//      expects to see it when a charge is disputed.
//   2. The document is rendered IN FULL. No truncation, no "…", no collapsed
//      sections, no scroll trap. renderAgreementHTML() emits every clause.
//   3. Black-and-white light theme, contrast-audited (see PALETTE below).
//      Nothing on this page is lighter than 4.5:1 against its own background.
//   4. Austin, TX business identity on every document.
//   5. Receipts are real documents with their own PDF, not a line in an email.
//
// NOT LEGAL ADVICE. The clause library below is a solid commercial baseline
// written to protect the company, but it has not been reviewed by a Texas
// attorney. Have counsel read CLAUSES once before you rely on it in a dispute —
// particularly the limitation of liability, which is the clause most often
// struck down when it is drafted without local review.
// ============================================================================

const crypto = require('crypto');
const PDFDocument = require('pdfkit');

// ============================================================================
// BUSINESS IDENTITY — appears on every document
// ============================================================================
// Overridable by env so a change of address doesn't need a code deploy, but the
// defaults are the real ones and are what ship.
const COMPANY = {
    legalName:  process.env.COMPANY_LEGAL_NAME  || 'Diamondback Coding',
    tradeName:  process.env.COMPANY_TRADE_NAME  || 'Diamondback Coding',
    street:     process.env.COMPANY_STREET      || '3600 N Capital of Texas Hwy, Building B, Suite 350',
    city:       process.env.COMPANY_CITY        || 'Austin',
    state:      process.env.COMPANY_STATE       || 'TX',
    zip:        process.env.COMPANY_ZIP         || '78746',
    phone:      process.env.COMPANY_PHONE       || '(940) 217-8680',
    email:      process.env.COMPANY_EMAIL       || 'contact@diamondbackcoding.com',
    website:    process.env.COMPANY_WEBSITE     || 'https://diamondbackcoding.com',
    // Governing law. Travis County is where Austin sits — venue follows the
    // business address, so these move together if the address ever does.
    state_full: process.env.COMPANY_STATE_FULL  || 'Texas',
    county:     process.env.COMPANY_COUNTY      || 'Travis County',
    // Shown on invoices/receipts where sales tax applies.
    taxRatePct: Number(process.env.SALES_TAX_RATE_PCT || 8.25),
};

COMPANY.cityStateZip = `${COMPANY.city}, ${COMPANY.state} ${COMPANY.zip}`;
COMPANY.addressBlock = [COMPANY.street, COMPANY.cityStateZip].filter(Boolean);
COMPANY.addressOneLine = `${COMPANY.street}, ${COMPANY.cityStateZip}`;

// ============================================================================
// PALETTE — contrast-audited, black and white, light theme
// ============================================================================
// EVERY value here has been checked against the background it is used on. The
// ratio in each comment is WCAG contrast against PAPER (#FFFFFF) unless noted.
// WCAG AA needs 4.5:1 for body text and 3:1 for large text.
//
// THE RULE THAT PREVENTS THE BUG THIS ROUND WAS ABOUT:
//   Never put INK_INVERSE (#FFFFFF) on anything except INK or INK_STRONG.
//   Every "invisible text" bug in this codebase has been white text left behind
//   on a panel that later turned white. assertReadable() below fails loudly if
//   that pairing is ever reintroduced.
const PALETTE = {
    PAPER:        '#FFFFFF',  // page background
    PANEL:        '#F4F5F7',  // key/value panels, table zebra — 1.06:1 vs paper, non-text
    PANEL_EDGE:   '#DCE0E6',  // hairlines — non-text, 1.4:1, fine for rules
    INK:          '#14171C',  // body text            — 15.9:1  ✓✓✓
    INK_STRONG:   '#000000',  // headings, totals     — 21:1    ✓✓✓
    INK_SECOND:   '#3F4650',  // sub-headings         —  9.7:1  ✓✓✓
    INK_MUTED:    '#5C646F',  // labels, captions     —  6.4:1  ✓✓  (floor for small text)
    INK_INVERSE:  '#FFFFFF',  // ONLY on INK / INK_STRONG fills
    RULE:         '#14171C',  // heavy rules under section headings
    // Status colors. Both are dark enough to read as text on paper, which the
    // previous green (#16a34a, 3.1:1) was not at 13px.
    POSITIVE:     '#15803D',  //  4.8:1  ✓ — "Paid", "Received"
    ATTENTION:    '#A33A11',  //  5.7:1  ✓ — "Outstanding", "Past due"
};

// Pairings that are legal to use. Anything not listed is a bug.
const READABLE_ON = {
    [PALETTE.PAPER]: [PALETTE.INK, PALETTE.INK_STRONG, PALETTE.INK_SECOND,
                      PALETTE.INK_MUTED, PALETTE.POSITIVE, PALETTE.ATTENTION],
    [PALETTE.PANEL]: [PALETTE.INK, PALETTE.INK_STRONG, PALETTE.INK_SECOND,
                      PALETTE.INK_MUTED, PALETTE.POSITIVE, PALETTE.ATTENTION],
    [PALETTE.INK]:        [PALETTE.INK_INVERSE],
    [PALETTE.INK_STRONG]: [PALETTE.INK_INVERSE],
};

/**
 * Development guard. Throws if a foreground/background pair isn't on the list
 * above — i.e. if someone reintroduces white-on-white. Called by the renderers
 * for every colored block, so the failure happens at render time in dev rather
 * than in a customer's inbox.
 */
function assertReadable(fg, bg, where) {
    const allowed = READABLE_ON[String(bg).toUpperCase()];
    if (!allowed) return; // unknown background — not ours to police
    if (!allowed.includes(String(fg).toUpperCase())) {
        const msg = `[DOCUMENTS] Unreadable pairing: ${fg} on ${bg} (${where}).`;
        if (process.env.NODE_ENV !== 'production') throw new Error(msg);
        console.error(msg);
    }
}

// ============================================================================
// Small helpers
// ============================================================================
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const prettyDate = (d) => {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt)) return null;
    return dt.toLocaleDateString('en-US',
        { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};

const prettyDateTime = (d) => {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt)) return null;
    return dt.toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
};

/** 1st, 2nd, 3rd… — used in autopay copy, where "day 1" reads like a bug. */
function ordinal(n) {
    const v = Number(n);
    if (!v || v < 1 || v > 31) return null;
    const s = ['th', 'st', 'nd', 'rd'];
    const m = v % 100;
    return v + (s[(m - 20) % 10] || s[m] || s[0]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

function serviceLabel(key) {
    const map = {
        web_development: 'Web Development',
        web_design: 'Web Design',
        crm_implementation: 'CRM Implementation',
        seo: 'SEO & Digital Marketing',
        maintenance: 'Maintenance',
        monthly_maintenance: 'Monthly Maintenance',
        brevo_maintenance: 'Brevo Maintenance',
        database_maintenance: 'Database Maintenance',
        domain_renewal: 'Domain Renewal',
        hosting: 'Hosting',
        consulting: 'Consulting',
    };
    if (!key) return '—';
    return map[key] || String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============================================================================
// CLAUSE LIBRARY
// ============================================================================
// Written to protect the company. Read the notes — several of these exist
// because of a specific way a small services business gets hurt.
//
// {{PLACEHOLDERS}} are filled by buildAgreementDocument().
const CLAUSES = {

    // ---- Applies to every agreement ----------------------------------------
    parties: {
        heading: 'The parties',
        body: [
            `This agreement is between {{COMPANY_LEGAL}}, a {{STATE_FULL}} business with its principal place of business at {{COMPANY_ADDRESS}} ("Provider", "we", "us"), and {{CUSTOMER_NAME}} ("Client", "you").`,
            `It takes effect on the date you sign it electronically and remains in force until the work described in it is complete or it is terminated as set out below.`,
        ],
    },

    electronicSignature: {
        heading: 'Electronic signature and record',
        body: [
            `Typing your full name and submitting this form is your electronic signature. Under the federal E-SIGN Act and the {{STATE_FULL}} Uniform Electronic Transactions Act, it has the same legal effect as a handwritten signature.`,
            `When you sign, we record the exact text of this document as displayed to you, a cryptographic hash of that text, your typed name, the date and time, your IP address and your browser. That record is your and our proof of what was agreed. You can download a copy of this document at any time from your customer portal, and we will keep one for at least four years.`,
        ],
    },

    scopeAndChanges: {
        heading: 'Scope of work and changes',
        body: [
            `We will provide only what is described in this agreement. Anything not written here is out of scope, including work you may reasonably expect but which is not listed.`,
            `Additional work, added features, redesigns of previously approved work, and additional revision rounds beyond those stated are billable at our then-current rates and require your written approval before we begin. A change to scope may also move any dates in this agreement.`,
            // Scope creep is the single most common way a fixed-price services
            // job loses money. Naming it explicitly is what makes it billable
            // rather than an argument.
        ],
    },

    clientResponsibilities: {
        heading: 'What we need from you',
        body: [
            `You agree to supply content, credentials, approvals, feedback and access to any third-party account we need, in a usable form and within a reasonable time of us asking.`,
            `You confirm you own, or are licensed to use, all text, images, logos, video and other material you give us, and that our using it as intended will not infringe anyone's rights. You will cover us for any claim that it does.`,
            `If work is held up waiting on you for more than fifteen (15) consecutive days, we may treat the project as suspended. Restarting a suspended project may require rescheduling, and any fees already earned remain payable. If a project is suspended for more than sixty (60) days, we may close it and invoice all work completed to that point.`,
            // Idle-project protection: without this clause an unresponsive
            // client can freeze revenue indefinitely with no way to bill.
        ],
    },

    intellectualProperty: {
        heading: 'Ownership of work',
        body: [
            `On receipt of payment in full, you own the final deliverables produced specifically for you under this agreement.`,
            `We retain ownership of everything we bring to the work that is not specific to you: our pre-existing code, frameworks, libraries, tooling, templates and know-how. Where any of that is embedded in your deliverables, you receive a perpetual, non-exclusive, non-transferable licence to use it as part of those deliverables.`,
            `Until payment is received in full, all deliverables remain our property and any licence to use them is suspended.`,
            // The "until paid in full" reservation is the practical lever that
            // makes a non-paying client resolvable without litigation.
            `Third-party software, fonts, plugins, hosting and services carry their own licences and fees, which are yours to hold and pay for.`,
            `Unless you tell us in writing not to, we may show the finished work in our portfolio and marketing. We will never publish your confidential information or credentials.`,
        ],
    },

    confidentiality: {
        heading: 'Confidentiality',
        body: [
            `Each of us will keep the other's non-public business, technical and customer information confidential, use it only to perform this agreement, and protect it with at least reasonable care. This does not cover information that is already public, was already known without obligation, or must be disclosed by law.`,
        ],
    },

    warrantyAndDisclaimer: {
        heading: 'Warranty and disclaimer',
        body: [
            `We warrant that we will perform in a professional and workmanlike manner consistent with industry standards. For thirty (30) days after delivery we will correct, at no charge, any defect that stops a deliverable working as described in this agreement.`,
            `That thirty-day correction is your sole remedy for a defect. It does not cover changes of mind, new requirements, problems caused by changes made by you or a third party, or failures in third-party software or services.`,
            `EXCEPT AS STATED ABOVE, ALL DELIVERABLES AND SERVICES ARE PROVIDED "AS IS". WE DISCLAIM ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. We do not warrant uninterrupted or error-free operation, any particular search ranking, traffic level, conversion rate or business result.`,
            // Capitalised on purpose: Texas courts apply a conspicuousness
            // requirement to warranty disclaimers, and all-caps is the
            // conventional way to satisfy it.
        ],
    },

    limitationOfLiability: {
        heading: 'Limitation of liability',
        body: [
            `TO THE FULLEST EXTENT PERMITTED BY LAW, NEITHER PARTY IS LIABLE TO THE OTHER FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOST DATA, LOST BUSINESS OPPORTUNITY OR BUSINESS INTERRUPTION, EVEN IF ADVISED THAT THEY WERE POSSIBLE.`,
            `OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THIS AGREEMENT, ON ANY THEORY OF LIABILITY, WILL NOT EXCEED THE AMOUNTS YOU ACTUALLY PAID US UNDER THIS AGREEMENT IN THE SIX (6) MONTHS IMMEDIATELY BEFORE THE EVENT GIVING RISE TO THE CLAIM.`,
            `You are responsible for maintaining your own backups of your data and content. We are not liable for data loss.`,
            // The 6-month cap is the clause worth paying a Texas attorney to
            // review. It is generally enforceable between businesses here, but
            // enforceability turns on drafting details worth a second opinion.
        ],
    },

    indemnity: {
        heading: 'Indemnity',
        body: [
            `You will defend, indemnify and hold us harmless from any claim, damage, loss, liability and reasonable legal fees arising from the content or materials you supply, your use of the deliverables, your breach of this agreement, or your violation of any law or third-party right.`,
        ],
    },

    termination: {
        heading: 'Termination',
        body: [
            `Either of us may terminate this agreement on fourteen (14) days' written notice. Either of us may terminate immediately if the other materially breaches and does not cure within ten (10) days of written notice.`,
            `On termination you must pay for all work performed and all expenses committed up to the termination date. Deposits and setup fees already paid are non-refundable, as they cover reserved capacity and work already scheduled. We will hand over completed, paid-for deliverables; unpaid work stays ours.`,
        ],
    },

    nonSolicitation: {
        heading: 'Non-solicitation',
        body: [
            `While this agreement is in force and for twelve (12) months after it ends, you agree not to directly solicit or hire any of our employees or contractors who worked on your project, except through a general public job advertisement.`,
        ],
    },

    disputes: {
        heading: 'Governing law and disputes',
        body: [
            `This agreement is governed by the laws of the State of {{STATE_FULL}}, without regard to conflict-of-law rules.`,
            `If a dispute arises, we will each first try in good faith to resolve it by direct discussion within thirty (30) days. If that fails, the exclusive venue for any action is the state or federal courts located in {{COUNTY}}, {{STATE_FULL}}, and both of us consent to personal jurisdiction there.`,
            `The prevailing party in any action to enforce this agreement is entitled to recover its reasonable attorneys' fees and costs.`,
            // Fee-shifting matters more than it looks: it is what makes a small
            // unpaid invoice economically worth pursuing.
            `Each of us waives any right to a jury trial and agrees that claims will be brought individually, not as part of a class or representative action.`,
        ],
    },

    generalTerms: {
        heading: 'General',
        body: [
            `Neither of us is liable for delay or failure caused by events outside our reasonable control, including outages at a third-party provider, natural disaster, or civil disruption.`,
            `We may use subcontractors, and remain responsible for their work.`,
            `We are independent contractors. Nothing here creates a partnership, joint venture, employment relationship or agency.`,
            `Notices go to the email addresses on this agreement and are deemed received on the day sent.`,
            `You may not assign this agreement without our written consent. We may assign it in connection with a sale or merger of our business.`,
            `If any provision is held unenforceable, the rest stays in force and that provision is narrowed to the minimum extent needed to make it enforceable.`,
            `This document, together with any written change order signed by both of us, is the entire agreement between us and replaces every prior discussion, quote, proposal and understanding on this subject.`,
            // The integration clause is what stops "but you said on the phone…"
            // from becoming a term of the contract.
        ],
    },

    // ---- Project (one-off SLA) specific -------------------------------------
    projectPayment: {
        heading: 'Payment terms',
        body: ['{{PAYMENT_CLAUSE}}'],
    },

    // Recurring plans have their OWN late-payment clause. The generic one below
    // talks about invoices and payment terms, which makes no sense on a plan
    // that charges the card on the due date — there is nothing to "pay within
    // N days", and no invoice to be late against. Saying so plainly is also
    // what makes the 1.5% fee enforceable: a fee has to attach to a clearly
    // defined moment of default.
    recurringLatePayment: {
        heading: 'Failed payments and late fees',
        body: [
            `Each charge is taken automatically on its due date. There is no invoice, no payment terms and no grace for the charge itself — the amount is due, in full, on that date.`,
            `A payment is LATE only if the due date passes and the amount is still unpaid, which normally means no valid payment method was on file or the charge was declined. An amount that is owed but whose due date has not yet arrived is not late and carries no fee.`,
            `If a payment is late, a late fee of one and one-half percent (1.5%) of the amount due is added, or the maximum permitted by {{STATE_FULL}} law if lower. A further 1.5% is added for each additional {{INTERVAL_NOUN}} period that the amount remains unpaid. Late fees are compensation for the cost of chasing and carrying an unpaid balance, not a penalty.`,
            `We allow {{GRACE_DAYS}} days after the due date before a late fee is applied, so that a card which fails and retries successfully does not incur one.`,
            `If any amount remains unpaid fifteen (15) days after its due date we may suspend the service without notice and without liability for any consequence of that suspension, including downtime, lost data, missed updates or lost business. Service resumes when the account is brought current, and we may require the balance and all fees to be settled before it does.`,
            `If a payment is reversed, charged back or returned unpaid, you are responsible for the original amount plus any fee our bank or processor charges us, plus the late fee, and we may require a different payment method going forward.`,
            `You remain responsible for our costs of collection, including reasonable attorneys' fees and any collection agency charges.`,
            `We may waive a late fee at our discretion. Waiving one does not waive any other, and does not change this clause.`,
        ],
    },

    // Additional protections that only make sense on an ongoing plan.
    recurringProtections: {
        heading: 'Access, data and your obligations',
        body: [
            `You will keep a valid payment method on your account at all times, and will give us the access we need — hosting, domain, registrar, CMS and any third-party account — to do the work. If access is withdrawn or credentials stop working, the plan continues to be charged while we are unable to work, and we are not responsible for anything that goes wrong in the meantime.`,
            `You are responsible for your own content and for anything you or anyone else with access changes. If a change made outside this plan breaks the site, restoring it is billable separately at our then-current rates.`,
            `We keep routine backups as part of this plan, but you remain responsible for maintaining your own independent copy of your data and content. We are not liable for data loss.`,
            `We may suspend or terminate this plan immediately, without refund, if the service is used unlawfully, to send unsolicited bulk email, to host malicious or infringing material, or in a way that threatens the security or stability of our systems or another customer's.`,
            `Nothing in this plan transfers ownership of our tooling, monitoring, scripts or configuration to you. Those remain ours and the licence to benefit from them ends when the plan ends.`,
            `If the plan ends for any reason, we will provide a copy of your site files and database on request within thirty (30) days, provided the account is fully settled. After that period we are under no obligation to retain anything.`,
        ],
    },

    latePayment: {
        heading: 'Late payment',
        body: [
            `Invoices are due on the date shown. Any amount not paid when due carries a late charge of one and one-half percent (1.5%) per month, or the maximum permitted by {{STATE_FULL}} law if lower, from the due date until paid.`,
            `If an amount is more than fifteen (15) days overdue we may suspend work and withhold deliverables until the account is current, without liability for any resulting delay. You remain responsible for our costs of collection, including reasonable attorneys' fees.`,
            `If a payment is reversed, charged back or returned unpaid, you are responsible for the original amount plus any fee our bank or processor charges us, and we may require a different payment method going forward.`,
        ],
    },

    taxesAndFees: {
        heading: 'Taxes and processing fees',
        body: [
            `Prices are exclusive of tax. Applicable {{STATE_FULL}} sales tax and any card or bank processing fee are added to each invoice and shown separately.`,
        ],
    },

    // ---- Recurring (autopay) specific ---------------------------------------
    // THIS IS THE CENTRAL ADDITION THIS ROUND. Its exact wording matters: it is
    // what you produce if a customer disputes a recurring charge with their
    // bank, and it is what the card networks look for.
    autopayAuthorization: {
        heading: 'Automatic payment authorization',
        emphasis: true,          // renders as a bordered callout, not body copy
        body: [
            `BY SIGNING THIS AGREEMENT YOU ENROLL IN AUTOMATIC PAYMENT (AUTOPAY) AND AUTHORIZE RECURRING CHARGES. Please read this section carefully.`,
            `You authorize {{COMPANY_LEGAL}} to automatically charge {{AUTOPAY_AMOUNT}} to the payment method you keep on file — {{AUTOPAY_SCHEDULE_SENTENCE}} — without further authorization, notice or action from you, beginning {{AUTOPAY_START}}.`,
            `This authorization covers debit and credit cards and, where you provide bank details, ACH debits from your bank account. It continues for each billing period until you cancel it as described below or this agreement ends.`,
            `You are responsible for keeping a valid payment method on your account at all times. If a charge is declined we may retry it, and any amount that remains unpaid is subject to the late charges in this agreement. Repeated failure may result in suspension of the service.`,
            `The charge will appear on your statement as "{{STATEMENT_DESCRIPTOR}}". You will receive an emailed receipt after every successful charge.`,
            `If the amount or the schedule ever changes, we will tell you in writing at least ten (10) days beforehand, and a change in price requires a new signed agreement from you.`,
            `TO STOP AUTOMATIC PAYMENTS: cancel the plan from your customer portal at any time, or email {{COMPANY_EMAIL}}. {{CANCEL_EFFECT_SENTENCE}} You may also contact your bank to stop an ACH debit, subject to your bank's own rules and timing.`,
        ],
    },

    // MONTHLY plans. Annual plans get their own version below — the notice
    // rule reads very differently when a period is a year long.
    recurringTerm: {
        heading: 'Term, renewal and cancellation',
        body: [
            `This plan begins on {{AUTOPAY_START}} and renews automatically for successive {{INTERVAL_NOUN}} periods until cancelled.`,
            `You may cancel at any time from your customer portal or by emailing {{COMPANY_EMAIL}}. Cancellation takes effect {{NOTICE_DAYS}} days after we receive your request. Service continues through that date, and anything already due or falling due within the notice period must be settled before the cancellation completes.`,
            `You keep the service through the end of every period you have paid for. If a charge falls due inside the notice period, it is payable, and the plan then runs to the end of the period that charge covers — you do not lose time you have paid for.`,
            `Fees already paid are non-refundable, including for a period that is only partly used. We do not pro-rate.`,
            `We may terminate this plan on {{NOTICE_DAYS}} days' notice, or immediately for non-payment.`,
            `After cancellation, reinstating the plan requires signing a new reinstatement agreement, and may be subject to our then-current pricing.`,
        ],
    },

    // ANNUAL plans. A one-year period changes what the notice rule means in
    // both directions, and both directions have to be stated plainly:
    //   * the customer keeps the WHOLE year they paid for, not 30 days;
    //   * cancelling inside 30 days of a renewal does not dodge that renewal.
    // The second half is the part that gets disputed, so it is spelt out with
    // a worked example rather than left to be inferred.
    annualTerm: {
        heading: 'Term, renewal and cancellation',
        body: [
            `This plan begins on {{AUTOPAY_START}} and renews automatically for successive one-year periods until cancelled.`,
            `THERE IS NO NOTICE PERIOD ON THIS PLAN. Because it is an annual commitment, cancelling does not run down a notice period — it settles the year and ends at the end of it.`,
            `IF YOU HAVE ALREADY PAID FOR THE CURRENT YEAR, nothing further is owed. Your cancellation is recorded and the plan ends the day before your next renewal date. You keep the service for every day you have paid for.`,
            `IF THE CURRENT YEAR IS NOT YET PAID, cancelling settles it in full at that point. That payment covers a complete year, and the plan ends the day before the following renewal date. You are paying for a year and you receive a year.`,
            `In either case the end date is the day BEFORE a renewal date, never the renewal date itself, so no further charge is ever taken after you cancel.`,
            `Fees already paid are non-refundable, including where you stop using the service part-way through a year. We do not pro-rate and we do not refund unused months.`,
            `We may terminate this plan on thirty (30) days' notice, or immediately for non-payment. If we terminate for a reason other than non-payment, we will refund the unused whole months of the year you have paid for.`,
            `Where this plan covers a domain name or another item that must be renewed with a third party, cancelling means we stop renewing it. Anything registered in our name will be transferred to you on request, provided the account is settled; if you take no action, it may lapse or expire, and we are not responsible for that.`,
            `After cancellation, reinstating the plan requires signing a new reinstatement agreement, and may be subject to our then-current pricing. A lapsed domain may not be recoverable at the original price, or at all.`,
        ],
    },
    recurringScope: {
        heading: 'What this plan covers',
        body: [
            `{{PLAN_SCOPE}}`,
            // Named inclusions. The old version said only "maintenance and
            // support as described", which describes nothing and is unusable
            // in a dispute about what was owed.
            `Included each period: security and dependency updates, uptime monitoring, routine backups, bug fixes to work we built, and up to {{SUPPORT_HOURS}} of minor content or configuration changes. Unused time does not roll over.`,
            `Support requests are answered within two (2) business days. This plan is not a guaranteed uptime or response-time commitment, and no service credits arise under it.`,
            `NOT included, and quoted separately: new features or pages, redesigns, migrations, content creation, third-party integrations, SEO or marketing work, recovery from changes made by you or anyone else with access, and recovery from a hosting, platform or third-party failure outside our control.`,
            `Third-party costs — hosting, domains, licences, email and SMS platform fees — are passed through and are yours to pay unless this agreement says otherwise. If we advance one on your behalf, you reimburse it on the next charge.`,
            `We may perform the work at any time during the period and are not required to use a set number of hours in any given month.`,
        ],
    },

    priceChanges: {
        heading: 'Price changes',
        body: [
            `We may adjust the recurring fee no more than once in any twelve-month period, on at least thirty (30) days' written notice. A price increase requires a new signed agreement before it takes effect; if you do not sign, the plan continues at the current price until the end of the then-current period and then ends.`,
        ],
    },
};

// ============================================================================
// DOCUMENT ASSEMBLY
// ============================================================================

/**
 * Build the complete, structured agreement.
 *
 * @param {object} ctx
 * @param {object} ctx.agreement  sales_agreements row
 * @param {array}  ctx.items      agreement_items rows (may be empty)
 * @param {array}  ctx.milestones agreement_milestones rows (may be empty)
 * @param {object} ctx.plan       maintenance_plans row, when recurring
 * @param {number} ctx.noticeDays cancellation notice window
 *
 * @returns {{meta, sections, totals, signature}} — render this, don't rebuild it.
 */
function buildAgreementDocument({ agreement, items = [], milestones = [], plan = null,
                                  noticeDays = 30 } = {}) {
    const a = agreement || {};
    const kind = a.agreement_kind || 'sla';

    // Recurring is decided from the agreement's own autopay flag first (011
    // sets it), falling back to the plan and the kind. Order matters: the
    // signed document's own record of itself outranks a row that can be edited.
    const isPriceChange = kind === 'price_change';

    const isRecurring = !!a.autopay
        || kind === 'maintenance' || kind === 'subscription'
        || !!(plan && plan.id);

    const interval = a.autopay_interval || (plan && plan.interval_unit) || 'month';
    const isAnnual = interval === 'year';

    // ---- money -------------------------------------------------------------
    const lineItems = (items || []).filter((i) => !i.is_optional);
    const itemsTotal = lineItems.reduce((s, i) => s + Number(i.amount || 0), 0);
    // Line items win when present; sales_agreements.price is the legacy
    // fallback for older records that never had items.
    const subtotal = lineItems.length ? itemsTotal : Number(a.price || 0);
    const recurringAmount = Number(
        a.autopay_amount != null ? a.autopay_amount
        : (plan ? (plan.charge_total != null ? plan.charge_total : plan.amount) : a.price) || 0
    );

    const requiresDeposit = !!a.require_deposit && Number(a.deposit_pct || 0) > 0;
    const depositPct = Number(a.deposit_pct || 0);
    const deposit = requiresDeposit
        ? Number(a.deposit || Math.round(subtotal * depositPct) / 100)
        : 0;
    const balance = Math.round((subtotal - deposit) * 100) / 100;

    // ---- autopay schedule sentence -----------------------------------------
    // Written out longhand because "billed on day 1" is how a customer ends up
    // surprised, and a surprised customer files a chargeback.
    const day = a.autopay_day || (plan && plan.billing_day) || null;
    const billingMonth = (plan && plan.billing_month) || null;
    const startDate = a.billing_start_date || (plan && plan.billing_start_date)
        || (plan && plan.next_charge_date) || a.start_date || null;

    let scheduleSentence;
    if (isAnnual) {
        const when = billingMonth && day
            ? `each year on ${MONTHS[billingMonth - 1]} ${day}`
            : (startDate ? `each year on the anniversary of ${prettyDate(startDate)}` : 'once each year');
        scheduleSentence = `${money(recurringAmount)} per year, charged automatically ${when}`;
    } else {
        const when = day ? `on the ${ordinal(day)} of each month` : 'on the same day each month';
        scheduleSentence = `${money(recurringAmount)} per month, charged automatically ${when}`;
    }

    const substitutions = {
        COMPANY_LEGAL:        COMPANY.legalName,
        COMPANY_ADDRESS:      COMPANY.addressOneLine,
        COMPANY_EMAIL:        COMPANY.email,
        STATE_FULL:           COMPANY.state_full,
        COUNTY:               COMPANY.county,
        CUSTOMER_NAME:        a.customer_name || 'Client',
        NOTICE_DAYS:          String(noticeDays),
        // Monthly runs a notice period; annual settles the year instead. One
        // sentence, chosen by cadence, so the autopay clause cannot promise a
        // 30-day notice on a plan that does not have one.
        CANCEL_EFFECT_SENTENCE: isAnnual
            ? 'There is no notice period: cancelling settles the current year if it is not '
              + 'already paid, and the plan then ends the day before your next renewal date. '
              + 'No further charge is taken after that.'
            : `Cancellation takes effect ${noticeDays} days after we receive your request; charges `
              + 'falling due within that notice period remain payable and service continues until '
              + 'the cancellation date.',
        GRACE_DAYS:           String(process.env.LATE_FEE_GRACE_DAYS || 3),
        SUPPORT_HOURS:        process.env.PLAN_SUPPORT_HOURS || 'two (2) hours',
        LATE_FEE_PCT:         ((Number(process.env.LATE_FEE_RATE || 0.015)) * 100)
                                  .toFixed(2).replace(/\.?0+$/, ''),
        INTERVAL_NOUN:        isAnnual ? 'one-year' : 'one-month',
        AUTOPAY_AMOUNT:       money(recurringAmount),
        AUTOPAY_SCHEDULE_SENTENCE: scheduleSentence,
        AUTOPAY_START:        prettyDate(startDate) || 'the date this agreement is signed',
        // The last day they could cancel and still avoid the next renewal.
        // Computed from THIS plan's own renewal date so the example in the
        // clause is about their plan, not a generic one.
        ANNUAL_NOTICE_EXAMPLE: (() => {
            if (!startDate) return `${noticeDays} days before your renewal date`;
            const d = new Date(startDate);
            if (isNaN(d)) return `${noticeDays} days before your renewal date`;
            d.setDate(d.getDate() - noticeDays);
            return prettyDate(d) || `${noticeDays} days before your renewal date`;
        })(),
        STATEMENT_DESCRIPTOR: process.env.STRIPE_STATEMENT_DESCRIPTOR || 'DIAMONDBACK CODING',
        // Falling back to the plan's own name produced "Monthly Maintenance as
        // described in this agreement" — a sentence that describes nothing.
        // The generic fallback at least states what the plan is for.
        PLAN_SCOPE:           a.intro || (plan && plan.description)
                              || `Ongoing ${String(a.package_name || serviceLabel(a.service_type)).toLowerCase()} `
                               + `for the website, application and systems we maintain for you, as set out below.`,
        PAYMENT_CLAUSE:       requiresDeposit
            ? `A deposit of ${depositPct}% (${money(deposit)}) is due on signing and reserves your place in our schedule. Work begins once the deposit clears. The remaining balance of ${money(balance)} is due on completion, payable within ${a.net_days || 7} days of the completion invoice.`
            : `The full amount of ${money(subtotal)} is due on completion of the work, payable within ${a.net_days || 7} days of the invoice.`,
    };

    const fill = (s) => String(s).replace(/\{\{(\w+)\}\}/g,
        (m, k) => (substitutions[k] != null ? substitutions[k] : m));

    const clause = (c) => ({
        heading: fill(c.heading),
        emphasis: !!c.emphasis,
        paragraphs: c.body.map(fill),
    });

    // ---- section order -----------------------------------------------------
    // AUTOPAY GOES FIRST, immediately after the summary. A customer who reads
    // only the top of the document still cannot miss it — which is the point,
    // both for fairness and because "buried in the terms" is the argument that
    // loses a chargeback.
    const sections = [];

    sections.push(clause(CLAUSES.parties));

    // ------------------------------------------------------------------
    // A PRICE CHANGE AGREEMENT IS DELIBERATELY SHORT.
    //
    // It amends one term of an agreement that is already in force. Restating
    // liability, IP, termination and the rest would imply those are being
    // renegotiated too, and would bury the one thing the customer needs to
    // read. Everything not mentioned here continues unchanged, which the
    // clause below says explicitly.
    // ------------------------------------------------------------------
    if (isPriceChange) {
        // Replace the generic parties clause: an amendment does not run "until
        // the work is complete", it takes effect on signing and then gets out
        // of the way.
        sections.length = 0;
        sections.push({
            heading: 'The parties',
            emphasis: false,
            paragraphs: [
                `This is an amendment between ${COMPANY.legalName}, a ${COMPANY.state_full} business at `
                + `${COMPANY.addressOneLine} ("Provider", "we", "us"), and ${a.customer_name || 'Client'} `
                + `("Client", "you").`,
                `It amends the agreement already in force between us for your `
                + `${a.package_name ? String(a.package_name).replace(/ — price change$/, '') : 'plan'}. `
                + `It takes effect when you sign it and changes only what is set out below.`,
            ],
        });

        const from = money(a.previous_price != null ? a.previous_price : 0);
        const to = money(a.price != null ? a.price : 0);
        const per = interval === 'year' ? 'year' : 'month';
        const startsOn = prettyDate(a.price_effective_from) || 'your next scheduled charge';
        const delta = Math.abs(Number(a.price || 0) - Number(a.previous_price || 0));
        const dir = Number(a.price || 0) >= Number(a.previous_price || 0) ? 'increase' : 'decrease';

        sections.push({
            heading: 'What is changing',
            emphasis: true,
            paragraphs: [
                `THIS DOCUMENT CHANGES ONE THING: the amount you pay for your existing ${a.package_name || 'plan'}.`,
                `Now: ${from} per ${per}.   From ${startsOn}: ${to} per ${per}. That is ${dir === 'increase' ? 'an increase' : 'a decrease'} of ${money(delta)} per ${per}.`,
                `THIS IS NOT A NEW PLAN AND NOT A REPLACEMENT AGREEMENT. Your existing plan continues exactly as it is — the same start date, the same services, the same billing day, the same cancellation terms and the same payment method. Your original agreement remains in force and is unchanged apart from this amount.`,
                `YOU KEEP PAYING ${from} UNTIL YOU SIGN THIS. Nothing changes while this sits unsigned, and you will continue to be charged ${from} per ${per}. If you never sign it, your plan simply carries on at ${from} per ${per} — you are not cancelled and nothing is interrupted.`,
                `By signing, you authorize ${COMPANY.legalName} to change the automatic payment on your existing authorization to ${to} per ${per}, taken on the same day and the same payment method as now, beginning ${startsOn}.`,
            ],
        });

        sections.push({
            heading: 'Everything else stays the same',
            emphasis: false,
            paragraphs: [
                `All other terms of the agreement this amends continue in full force: what the plan covers, the automatic payment authorization, term and renewal, cancellation and notice, late fees, taxes and processing fees, liability, and governing law. Nothing in this document alters any of them.`,
                `If this amount and the amount in the original agreement ever appear to conflict, this document controls, because it is the later of the two.`,
                `You may cancel the plan instead of accepting this change, on the notice set out in your original agreement. Cancelling is not a breach and carries no penalty beyond what that agreement already provides.`,
                `Your right to a copy: this document and the original agreement are both downloadable from your customer portal at any time.`,
            ],
        });

        sections.push(clause(CLAUSES.electronicSignature));

        const customText = (a.terms || '').trim();
        if (customText) {
            sections.push({
                heading: 'Details of this change',
                emphasis: false,
                paragraphs: customText.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
            });
        }

        const pcSummary = [
            ['Document number', a.agreement_number || `#${a.id}`],
            ['Date issued', prettyDate(a.created_at) || prettyDate(new Date())],
            ['Client', a.customer_name || '—'],
            ['Plan', a.package_name || '—'],
            ['Current price', `${from} per ${per}`],
            ['New price', `${to} per ${per}`],
            ['Takes effect', startsOn],
            ['Amends', a.amends_agreement_id ? `Agreement #${a.amends_agreement_id}` : 'your existing agreement'],
        ];

        return {
            meta: {
                id: a.id, number: a.agreement_number || `#${a.id}`,
                title: 'Price Change Agreement',
                kind, isRecurring: true, isAnnual, interval,
                autopay: true,
                autopayAmount: Number(a.price || 0),
                autopayScheduleSentence: `${to} per ${per}`,
                autopayStart: a.price_effective_from,
                noticeDays,
                isPriceChange: true,
                previousPrice: Number(a.previous_price || 0),
                signed: !!(a.signed_at || a.status === 'signed'),
                signedAt: a.signed_at || null,
                signatureName: a.signature_name || null,
                company: COMPANY,
            },
            summary: pcSummary,
            totals: {
                lineItems: [], subtotal: Number(a.price || 0), deposit: 0, balance: 0,
                requiresDeposit: false, depositPct: 0,
                recurringAmount: Number(a.price || 0), isRecurring: true, isAnnual,
            },
            milestones: [],
            sections,
            autopayConsentText:
                `I authorize ${COMPANY.legalName} to change my automatic payment for `
                + `${a.package_name || 'my plan'} from ${from} to ${to} per ${per}, beginning `
                + `${startsOn}, on the same payment method and schedule as now.`,
        };
    }

    if (isRecurring) {
        sections.push(clause(CLAUSES.autopayAuthorization));
        sections.push(clause(CLAUSES.recurringScope));
        // A one-year period changes what "30 days' notice" means, so annual
        // plans get their own cancellation clause rather than the monthly one.
        sections.push(clause(isAnnual ? CLAUSES.annualTerm : CLAUSES.recurringTerm));
        sections.push(clause(CLAUSES.priceChanges));
        // The recurring version, NOT the generic invoice-terms one: a plan
        // charges the card on the due date, so "payable within N days of the
        // invoice" describes something that does not exist here.
        sections.push(clause(CLAUSES.recurringLatePayment));
        sections.push(clause(CLAUSES.taxesAndFees));
        sections.push(clause(CLAUSES.recurringProtections));
    } else {
        sections.push(clause(CLAUSES.scopeAndChanges));
        sections.push(clause(CLAUSES.projectPayment));
        sections.push(clause(CLAUSES.latePayment));
        sections.push(clause(CLAUSES.taxesAndFees));
        sections.push(clause(CLAUSES.clientResponsibilities));
    }

    sections.push(clause(CLAUSES.intellectualProperty));
    sections.push(clause(CLAUSES.confidentiality));
    sections.push(clause(CLAUSES.warrantyAndDisclaimer));
    sections.push(clause(CLAUSES.limitationOfLiability));
    sections.push(clause(CLAUSES.indemnity));
    sections.push(clause(CLAUSES.termination));
    sections.push(clause(CLAUSES.nonSolicitation));
    sections.push(clause(CLAUSES.disputes));
    sections.push(clause(CLAUSES.electronicSignature));
    sections.push(clause(CLAUSES.generalTerms));

    // Anything the admin typed on this specific agreement goes last, labelled
    // as specific to this job — and it OVERRIDES the standard terms, which is
    // stated so a custom promise can't be argued away by a boilerplate clause.
    const custom = (a.terms || '').trim();
    if (custom) {
        sections.push({
            heading: 'Additional terms specific to this agreement',
            emphasis: false,
            paragraphs: [
                ...custom.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
                'Where these additional terms conflict with the standard terms above, these additional terms control.',
            ],
        });
    }

    // ---- summary rows ------------------------------------------------------
    const summary = [
        ['Agreement number', a.agreement_number || `#${a.id}`],
        ['Date issued', prettyDate(a.created_at) || prettyDate(new Date())],
        ['Client', a.customer_name || '—'],
        ['Client email', a.customer_email || '—'],
        ['Service', serviceLabel(a.service_type)],
        a.package_name ? ['Plan', a.package_name] : null,
        a.project || a.vehicle ? ['Project', a.project || a.vehicle] : null,
    ].filter(Boolean);

    if (isRecurring) {
        summary.push(['Billing', isAnnual ? 'Annual — automatic payment' : 'Monthly — automatic payment']);
        summary.push(['Recurring amount', money(recurringAmount)]);
        summary.push(['First charge', prettyDate(startDate) || 'On signing']);
        summary.push(['Charged on', isAnnual
            ? (billingMonth && day ? `${MONTHS[billingMonth - 1]} ${day} each year` : 'The anniversary date each year')
            : (day ? `The ${ordinal(day)} of each month` : 'The same day each month')]);
        // Annual plans have NO notice period — printing "30 days" on one
        // contradicts the clause three pages later, and the summary is the part
        // customers actually read.
        summary.push(isAnnual
            ? ['Cancellation', 'No notice period — settles the year, ends the day before renewal']
            : ['Cancellation notice', `${noticeDays} days`]);
    } else {
        summary.push(['Start date', prettyDate(a.start_date) || 'To be scheduled']);
        if (a.est_completion_date) summary.push(['Estimated completion', prettyDate(a.est_completion_date)]);
        summary.push(['Total', money(subtotal)]);
        if (requiresDeposit) {
            summary.push(['Deposit due on signing', `${depositPct}% — ${money(deposit)}`]);
            summary.push(['Balance on completion', money(balance)]);
        }
    }

    return {
        meta: {
            id: a.id,
            number: a.agreement_number || `#${a.id}`,
            // A price change is an AMENDMENT to a plan that already exists.
            // Calling it a "Service Agreement" would make a customer think
            // they are re-signing the whole thing, which is exactly the
            // confusion this document was created to avoid.
            title: isPriceChange
                ? 'Price Change Agreement'
                : isRecurring
                    ? (isAnnual ? 'Annual Service Agreement' : 'Monthly Service Agreement')
                    : 'Service Agreement',
            kind,
            isRecurring,
            isAnnual,
            interval,
            autopay: isRecurring,
            autopayAmount: recurringAmount,
            autopayScheduleSentence: scheduleSentence,
            autopayStart: startDate,
            noticeDays,
            signed: !!(a.signed_at || a.status === 'signed'),
            signedAt: a.signed_at || null,
            signatureName: a.signature_name || null,
            company: COMPANY,
        },
        summary,
        // Structured, so the renderers don't re-derive money from raw columns.
        totals: {
            lineItems: lineItems.map((i) => ({
                description: i.description,
                detail: i.detail || null,
                quantity: Number(i.quantity || 1),
                unitPrice: Number(i.unit_price || 0),
                amount: Number(i.amount || 0),
            })),
            subtotal, deposit, balance, requiresDeposit, depositPct,
            recurringAmount, isRecurring, isAnnual,
        },
        milestones: (milestones || []).map((m) => ({
            title: m.title,
            description: m.description || null,
            dueDate: m.due_date ? prettyDate(m.due_date) : null,
        })),
        sections,
        // The exact consent text stored alongside the signature.
        autopayConsentText: isRecurring
            ? `I authorize ${COMPANY.legalName} to automatically charge my saved payment method ${scheduleSentence}, beginning ${prettyDate(startDate) || 'on signing'}, until I cancel with ${noticeDays} days' notice.`
            : null,
    };
}

// ============================================================================
// PLAIN TEXT RENDER — what gets hashed and stored as the signature snapshot
// ============================================================================
/**
 * Deterministic. The same document object always produces the same string, and
 * therefore the same hash — which is the whole basis of the tamper-evidence.
 */
function renderAgreementText(doc) {
    const L = [];
    L.push(COMPANY.legalName.toUpperCase());
    COMPANY.addressBlock.forEach((l) => L.push(l));
    L.push(`${COMPANY.phone}  |  ${COMPANY.email}`);
    L.push('');
    L.push(doc.meta.title.toUpperCase());
    L.push(doc.meta.number);
    L.push('');

    doc.summary.forEach(([k, v]) => L.push(`${k}: ${v}`));
    L.push('');

    if (doc.totals.lineItems.length) {
        L.push('SERVICES AND CHARGES');
        doc.totals.lineItems.forEach((i) => {
            L.push(`  ${i.description} — ${i.quantity} x ${money(i.unitPrice)} = ${money(i.amount)}`);
            if (i.detail) L.push(`      ${i.detail}`);
        });
        L.push(`  Subtotal: ${money(doc.totals.subtotal)}`);
        L.push('');
    }

    if (doc.milestones.length) {
        L.push('PROJECT MILESTONES');
        doc.milestones.forEach((m, i) => {
            L.push(`  ${i + 1}. ${m.title}${m.dueDate ? ` (target ${m.dueDate})` : ''}`);
            if (m.description) L.push(`      ${m.description}`);
        });
        L.push('');
    }

    doc.sections.forEach((s, i) => {
        L.push(`${i + 1}. ${s.heading.toUpperCase()}`);
        s.paragraphs.forEach((p) => L.push(`   ${p}`));
        L.push('');
    });

    if (doc.autopayConsentText) {
        L.push('AUTOPAY CONSENT');
        L.push(`   ${doc.autopayConsentText}`);
        L.push('');
    }

    return L.join('\n');
}

/** sha256 of the plain-text render. Stored in agreement_signatures. */
function hashAgreement(doc) {
    return crypto.createHash('sha256').update(renderAgreementText(doc), 'utf8').digest('hex');
}

// ============================================================================
// HTML RENDER — the on-screen signing view
// ============================================================================
/**
 * Renders the WHOLE document. Deliberately has no collapse, no accordion, no
 * "read more", no max-height on any clause: every requirement in this round
 * about the agreement being fully visible is enforced structurally here rather
 * than left to the front end to get right.
 *
 * Self-contained: styles are inline and scoped to .dbdoc, so it can be dropped
 * into the customer portal without touching its stylesheet.
 */
function renderAgreementHTML(doc) {
    assertReadable(PALETTE.INK, PALETTE.PAPER, 'agreement body');
    assertReadable(PALETTE.INK_INVERSE, PALETTE.INK_STRONG, 'agreement masthead');
    assertReadable(PALETTE.INK_MUTED, PALETTE.PANEL, 'summary labels');

    const P = PALETTE;

    const summaryRows = doc.summary.map(([k, v], i, arr) => `
      <tr>
        <th style="text-align:left;font-weight:600;font-size:13px;color:${P.INK_MUTED};
                   padding:10px 14px;width:44%;vertical-align:top;
                   ${i < arr.length - 1 ? `border-bottom:1px solid ${P.PANEL_EDGE};` : ''}">${esc(k)}</th>
        <td style="font-size:14px;font-weight:600;color:${P.INK_STRONG};padding:10px 14px;
                   ${i < arr.length - 1 ? `border-bottom:1px solid ${P.PANEL_EDGE};` : ''}">${esc(v)}</td>
      </tr>`).join('');

    const itemsTable = doc.totals.lineItems.length ? `
      <section class="dbdoc-block">
        <h2 style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;
                   color:${P.INK_STRONG};margin:0 0 10px;padding-bottom:8px;
                   border-bottom:2px solid ${P.RULE};">Services and charges</h2>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr>
              <th style="text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
                         color:${P.INK_MUTED};font-weight:700;padding:8px 0;border-bottom:1px solid ${P.PANEL_EDGE};">Description</th>
              <th style="text-align:right;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
                         color:${P.INK_MUTED};font-weight:700;padding:8px 0;border-bottom:1px solid ${P.PANEL_EDGE};width:64px;">Qty</th>
              <th style="text-align:right;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
                         color:${P.INK_MUTED};font-weight:700;padding:8px 0;border-bottom:1px solid ${P.PANEL_EDGE};width:96px;">Rate</th>
              <th style="text-align:right;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
                         color:${P.INK_MUTED};font-weight:700;padding:8px 0;border-bottom:1px solid ${P.PANEL_EDGE};width:104px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${doc.totals.lineItems.map((i) => `
            <tr>
              <td style="font-size:14px;color:${P.INK};padding:11px 0;border-bottom:1px solid ${P.PANEL_EDGE};">
                <strong style="color:${P.INK_STRONG};font-weight:600;">${esc(i.description)}</strong>
                ${i.detail ? `<div style="font-size:13px;color:${P.INK_MUTED};margin-top:3px;line-height:1.5;">${esc(i.detail)}</div>` : ''}
              </td>
              <td style="font-size:14px;color:${P.INK};text-align:right;padding:11px 0;border-bottom:1px solid ${P.PANEL_EDGE};">${i.quantity}</td>
              <td style="font-size:14px;color:${P.INK};text-align:right;padding:11px 0;border-bottom:1px solid ${P.PANEL_EDGE};">${money(i.unitPrice)}</td>
              <td style="font-size:14px;color:${P.INK_STRONG};font-weight:600;text-align:right;padding:11px 0;border-bottom:1px solid ${P.PANEL_EDGE};">${money(i.amount)}</td>
            </tr>`).join('')}
            <tr>
              <td colspan="3" style="text-align:right;font-size:14px;font-weight:700;color:${P.INK_STRONG};padding:13px 12px 13px 0;">
                ${doc.totals.isRecurring ? `Recurring total (per ${doc.totals.isAnnual ? 'year' : 'month'})` : 'Subtotal'}</td>
              <td style="text-align:right;font-size:17px;font-weight:800;color:${P.INK_STRONG};padding:13px 0;">
                ${money(doc.totals.isRecurring ? doc.totals.recurringAmount : doc.totals.subtotal)}</td>
            </tr>
          </tbody>
        </table>
        <p style="font-size:12px;color:${P.INK_MUTED};margin:10px 0 0;line-height:1.6;">
          Prices exclude tax. ${esc(COMPANY.state_full)} sales tax (${COMPANY.taxRatePct}%) and any card or bank
          processing fee are added to each invoice and shown separately.</p>
      </section>` : '';

    const milestonesBlock = doc.milestones.length ? `
      <section class="dbdoc-block">
        <h2 style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;
                   color:${P.INK_STRONG};margin:0 0 10px;padding-bottom:8px;
                   border-bottom:2px solid ${P.RULE};">Project milestones</h2>
        <ol style="margin:0;padding-left:20px;">
          ${doc.milestones.map((m) => `
          <li style="font-size:14px;color:${P.INK};line-height:1.65;margin-bottom:9px;">
            <strong style="color:${P.INK_STRONG};font-weight:600;">${esc(m.title)}</strong>
            ${m.dueDate ? `<span style="color:${P.INK_MUTED};font-size:13px;"> — target ${esc(m.dueDate)}</span>` : ''}
            ${m.description ? `<div style="font-size:13px;color:${P.INK_MUTED};margin-top:2px;line-height:1.6;">${esc(m.description)}</div>` : ''}
          </li>`).join('')}
        </ol>
        <p style="font-size:12px;color:${P.INK_MUTED};margin:10px 0 0;line-height:1.6;">
          Target dates are estimates, not guarantees, and may move if scope changes or if we are waiting on you.</p>
      </section>` : '';

    // Numbered because the clauses ARE a sequence you cite by number in a
    // dispute ("section 7 of your agreement"), not for decoration.
    const sectionsHTML = doc.sections.map((s, idx) => {
        if (s.emphasis) {
            assertReadable(P.INK, P.PANEL, 'autopay callout');
            return `
      <section class="dbdoc-block" style="background:${P.PANEL};border:2px solid ${P.INK_STRONG};
                                          border-radius:10px;padding:20px 22px;">
        <h2 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;
                   color:${P.INK_STRONG};margin:0 0 12px;">${idx + 1}. ${esc(s.heading)}</h2>
        ${s.paragraphs.map((p) => `<p style="font-size:14.5px;line-height:1.72;color:${P.INK};margin:0 0 12px;">${esc(p)}</p>`).join('')}
      </section>`;
        }
        return `
      <section class="dbdoc-block">
        <h2 style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;
                   color:${P.INK_STRONG};margin:0 0 10px;padding-bottom:8px;
                   border-bottom:2px solid ${P.RULE};">${idx + 1}. ${esc(s.heading)}</h2>
        ${s.paragraphs.map((p) => `<p style="font-size:14.5px;line-height:1.72;color:${P.INK};margin:0 0 11px;">${esc(p)}</p>`).join('')}
      </section>`;
    }).join('');

    const signedBlock = doc.meta.signed ? `
      <section class="dbdoc-block" style="background:${P.PANEL};border-radius:10px;padding:18px 20px;">
        <h2 style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;
                   color:${P.INK_STRONG};margin:0 0 10px;">Signed</h2>
        <p style="font-size:14px;color:${P.INK};margin:0;line-height:1.7;">
          Signed electronically by <strong style="color:${P.INK_STRONG};">${esc(doc.meta.signatureName || doc.summary[2]?.[1] || '')}</strong>
          on ${esc(prettyDateTime(doc.meta.signedAt) || '')}.
        </p>
      </section>` : '';

    return `
<div class="dbdoc" style="background:${P.PAPER};color:${P.INK};
     font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;
     -webkit-font-smoothing:antialiased;max-width:760px;margin:0 auto;">

  <style>
    .dbdoc .dbdoc-block { margin: 0 0 26px; }
    .dbdoc p:last-child { margin-bottom: 0; }
    /* Every clause is fully expanded. No max-height, no overflow, no collapse. */
    .dbdoc section, .dbdoc p, .dbdoc li { max-height: none !important; overflow: visible !important; }
    @media print {
      .dbdoc { max-width: none; }
      .dbdoc-block { break-inside: avoid; }
    }
    /* On a phone the masthead's two columns squeeze the address into a
       ~150px gutter and it wraps mid-line. Stack them instead: a table cell
       needs its parent set to block too, or the row keeps enforcing columns. */
    @media (max-width: 560px) {
      .dbdoc-masthead-table,
      .dbdoc-masthead-table tbody,
      .dbdoc-masthead-table tr { display: block !important; width: 100% !important; }
      .dbdoc-masthead-table td { display: block !important; width: 100% !important;
                                 text-align: left !important; }
      .dbdoc-masthead-addr { margin-top: 12px; }
    }
  </style>

  <!-- masthead: white on near-black, the only inverted block in the document -->
  <header style="background:${P.INK_STRONG};color:${P.INK_INVERSE};padding:24px 26px;border-radius:12px 12px 0 0;">
    <table class="dbdoc-masthead-table" style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="vertical-align:top;">
          <div style="font-size:15px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${P.INK_INVERSE};">
            ${esc(COMPANY.legalName)}</div>
          <div style="font-size:12px;color:${P.INK_INVERSE};opacity:.82;margin-top:5px;line-height:1.6;">
            Web Development &middot; CRM Implementation &middot; Digital Marketing</div>
        </td>
        <td class="dbdoc-masthead-addr" style="vertical-align:top;text-align:right;font-size:12px;
                   color:${P.INK_INVERSE};opacity:.82;line-height:1.65;">
          ${COMPANY.addressBlock.map((l) => esc(l)).join('<br>')}<br>
          ${esc(COMPANY.phone)}<br>${esc(COMPANY.email)}
        </td>
      </tr>
    </table>
  </header>

  <div style="border:1px solid ${P.PANEL_EDGE};border-top:0;border-radius:0 0 12px 12px;padding:28px 26px 30px;">

    <h1 style="font-size:27px;font-weight:800;letter-spacing:-.02em;color:${P.INK_STRONG};margin:0 0 4px;line-height:1.2;">
      ${esc(doc.meta.title)}</h1>
    <p style="font-size:13px;color:${P.INK_MUTED};margin:0 0 24px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      ${esc(doc.meta.number)}</p>

    ${doc.meta.autopay ? `
    <div style="background:${P.INK_STRONG};color:${P.INK_INVERSE};border-radius:10px;padding:16px 18px;margin:0 0 24px;">
      <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;font-weight:800;opacity:.85;margin-bottom:6px;">
        ${doc.meta.isPriceChange ? 'Price change' : 'Automatic payment'}</div>
      <div style="font-size:15.5px;line-height:1.6;font-weight:600;color:${P.INK_INVERSE};">
        ${doc.meta.isPriceChange
          ? `Your automatic payment changes from ${esc(money(doc.meta.previousPrice))} to
             ${esc(doc.meta.autopayScheduleSentence)}, from
             ${esc(prettyDate(doc.meta.autopayStart) || 'your next charge')}. Your plan, your payment
             method and everything else stay exactly as they are.`
          : `Signing this agreement enrolls you in autopay: ${esc(doc.meta.autopayScheduleSentence)}, starting
             ${esc(prettyDate(doc.meta.autopayStart) || 'on signing')}. Cancel any time from your portal with
             ${doc.meta.noticeDays} days' notice.`}</div>
    </div>` : ''}

    <section class="dbdoc-block">
      <table style="width:100%;border-collapse:collapse;background:${P.PANEL};border-radius:10px;overflow:hidden;">
        ${summaryRows}
      </table>
    </section>

    ${itemsTable}
    ${milestonesBlock}
    ${sectionsHTML}
    ${signedBlock}

    <footer style="margin-top:30px;padding-top:18px;border-top:2px solid ${P.RULE};
                   font-size:12px;color:${P.INK_MUTED};line-height:1.75;">
      <strong style="color:${P.INK_STRONG};font-weight:700;">${esc(COMPANY.legalName)}</strong><br>
      ${COMPANY.addressBlock.map((l) => esc(l)).join('<br>')}<br>
      ${esc(COMPANY.phone)} &middot; ${esc(COMPANY.email)} &middot; ${esc(COMPANY.website)}<br>
      <span style="display:inline-block;margin-top:8px;">
        ${esc(doc.meta.number)} &middot; Governed by the laws of ${esc(COMPANY.state_full)} &middot;
        Venue: ${esc(COMPANY.county)}, ${esc(COMPANY.state_full)}</span>
    </footer>
  </div>
</div>`;
}

// ============================================================================
// PDF RENDER — agreement
// ============================================================================
function pdfToBuffer(doc) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

// Page geometry, named so the layout code reads as intent rather than numbers.
const PAGE = { margin: 54, width: 612, height: 792 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;

/**
 * Footer on every page: identity, document number, page number.
 *
 * The footer sits BELOW the bottom margin, and PDFKit auto-inserts a page the
 * moment you write text past that margin — which is how an earlier version of
 * this produced a 52-page agreement out of six pages of content. Zeroing the
 * bottom margin for the duration of the write is what stops the cascade; it is
 * restored immediately afterwards.
 *
 * Only ever called from the buffered-pages pass at the end, never mid-flow.
 */
function paintFooter(pdf, docNumber, pageLabel) {
    const y = PAGE.height - 44;
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    try {
        pdf.moveTo(PAGE.margin, y - 10).lineTo(PAGE.width - PAGE.margin, y - 10)
           .lineWidth(0.5).strokeColor(PALETTE.PANEL_EDGE).stroke();
        pdf.font('Helvetica').fontSize(7.5).fillColor(PALETTE.INK_MUTED);
        pdf.text(`${COMPANY.legalName}  ·  ${COMPANY.addressOneLine}`,
                 PAGE.margin, y, { width: CONTENT_WIDTH - 110, lineBreak: false });
        pdf.text(`${COMPANY.phone}  ·  ${COMPANY.email}  ·  ${docNumber || ''}`,
                 PAGE.margin, y + 10, { width: CONTENT_WIDTH - 110, lineBreak: false });
        if (pageLabel) {
            pdf.text(pageLabel, PAGE.width - PAGE.margin - 110, y + 5,
                     { width: 110, align: 'right', lineBreak: false });
        }
    } finally {
        pdf.page.margins.bottom = savedBottom;
    }
}

/**
 * Room check. PDFKit will happily paint a heading at the bottom of a page and
 * strand it there, which is what makes a generated contract look amateur.
 *
 * Deliberately does NOT paint a footer — footers go on in one pass at the end,
 * over the buffered pages, so a page can't get two of them.
 */
function ensureRoom(pdf, needed) {
    if (pdf.y + needed > PAGE.height - 76) {
        pdf.addPage();
        pdf.y = PAGE.margin;
        return true;
    }
    return false;
}

async function agreementPDF(document) {
    const d = document;
    const num = d.meta.number;

    const pdf = new PDFDocument({
        size: 'LETTER',
        margin: PAGE.margin,
        bufferPages: true,
        info: {
            Title: `${d.meta.title} ${num}`,
            Author: COMPANY.legalName,
            Subject: d.meta.autopay ? 'Recurring service agreement with autopay authorization'
                                    : 'Service agreement',
        },
    });

    // ---- masthead: solid black band, white type. The one inverted block. ----
    pdf.rect(0, 0, PAGE.width, 92).fill(PALETTE.INK_STRONG);
    pdf.fillColor(PALETTE.INK_INVERSE).font('Helvetica-Bold').fontSize(15)
       .text(COMPANY.legalName.toUpperCase(), PAGE.margin, 26, { characterSpacing: 1.6 });
    pdf.font('Helvetica').fontSize(7.6).fillColor(PALETTE.INK_INVERSE)
       .text('WEB DEVELOPMENT  ·  CRM IMPLEMENTATION  ·  DIGITAL MARKETING',
             PAGE.margin, 47, { characterSpacing: .7 });
    pdf.font('Helvetica').fontSize(8).fillColor(PALETTE.INK_INVERSE)
       .text(`${COMPANY.addressOneLine}  ·  ${COMPANY.phone}  ·  ${COMPANY.email}`,
             PAGE.margin, 66, { width: CONTENT_WIDTH });

    pdf.y = 118;
    pdf.fillColor(PALETTE.INK_STRONG).font('Helvetica-Bold').fontSize(21)
       .text(d.meta.title, PAGE.margin, pdf.y);
    pdf.moveDown(0.15);
    pdf.font('Courier').fontSize(9.5).fillColor(PALETTE.INK_MUTED).text(num);
    pdf.moveDown(1);

    // ---- autopay banner, straight under the title --------------------------
    if (d.meta.autopay) {
        const text = d.meta.isPriceChange
            // They are already enrolled. "Signing enrolls you in autopay" on an
            // amendment reads as though they are signing up again.
            ? `PRICE CHANGE: your automatic payment changes from ${money(d.meta.previousPrice)} to `
              + `${d.meta.autopayScheduleSentence}, from `
              + `${prettyDate(d.meta.autopayStart) || 'your next charge'}. Your plan, your payment `
              + `method and everything else stay exactly as they are.`
            : `AUTOMATIC PAYMENT: Signing enrolls you in autopay — ${d.meta.autopayScheduleSentence}, `
              + `starting ${prettyDate(d.meta.autopayStart) || 'on signing'}. `
              + `Cancel any time from your customer portal with ${d.meta.noticeDays} days' notice.`;
        const h = pdf.font('Helvetica-Bold').fontSize(9.5)
                     .heightOfString(text, { width: CONTENT_WIDTH - 24, lineGap: 1.5 }) + 22;
        // pdf.text() MOVES pdf.y. Capture the top first and set y from it
        // afterwards, or the panel height gets counted twice and leaves a
        // page-sized hole in the document.
        const bannerTop = pdf.y;
        pdf.rect(PAGE.margin, bannerTop, CONTENT_WIDTH, h).fill(PALETTE.INK_STRONG);
        pdf.fillColor(PALETTE.INK_INVERSE).font('Helvetica-Bold').fontSize(9.5)
           .text(text, PAGE.margin + 12, bannerTop + 11, { width: CONTENT_WIDTH - 24, lineGap: 1.5 });
        pdf.y = bannerTop + h + 18;
        pdf.fillColor(PALETTE.INK);
    }

    // ---- summary panel -----------------------------------------------------
    ensureRoom(pdf, 120);
    const rowH = 17;
    const panelH = d.summary.length * rowH + 14;
    const panelTop = pdf.y;
    pdf.rect(PAGE.margin, panelTop, CONTENT_WIDTH, panelH).fill(PALETTE.PANEL);
    let ry = panelTop + 8;
    d.summary.forEach(([k, v]) => {
        pdf.font('Helvetica').fontSize(9).fillColor(PALETTE.INK_MUTED)
           .text(k, PAGE.margin + 12, ry, { width: 168, lineBreak: false });
        pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(PALETTE.INK_STRONG)
           .text(String(v), PAGE.margin + 188, ry, { width: CONTENT_WIDTH - 200, lineBreak: false });
        ry += rowH;
    });
    pdf.y = panelTop + panelH + 22;

    // ---- line items --------------------------------------------------------
    if (d.totals.lineItems.length) {
        ensureRoom(pdf, 90);
        sectionHeading(pdf, 'SERVICES AND CHARGES');
        const cols = { desc: PAGE.margin, qty: PAGE.margin + 300, rate: PAGE.margin + 358, amt: PAGE.margin + 430 };
        pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.INK_MUTED);
        pdf.text('DESCRIPTION', cols.desc, pdf.y, { lineBreak: false, characterSpacing: .5 });
        pdf.text('QTY', cols.qty, pdf.y, { width: 44, align: 'right', lineBreak: false });
        pdf.text('RATE', cols.rate, pdf.y, { width: 58, align: 'right', lineBreak: false });
        pdf.text('AMOUNT', cols.amt, pdf.y, { width: 74, align: 'right', lineBreak: false });
        pdf.y += 13;
        pdf.moveTo(PAGE.margin, pdf.y).lineTo(PAGE.width - PAGE.margin, pdf.y)
           .lineWidth(0.6).strokeColor(PALETTE.PANEL_EDGE).stroke();
        pdf.y += 7;

        d.totals.lineItems.forEach((i) => {
            ensureRoom(pdf, 34);
            const top = pdf.y;
            pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(PALETTE.INK_STRONG)
               .text(i.description, cols.desc, top, { width: 288 });
            let bottom = pdf.y;
            if (i.detail) {
                pdf.font('Helvetica').fontSize(8.5).fillColor(PALETTE.INK_MUTED)
                   .text(i.detail, cols.desc, pdf.y + 1, { width: 288, lineGap: 1 });
                bottom = pdf.y;
            }
            pdf.font('Helvetica').fontSize(9.5).fillColor(PALETTE.INK);
            pdf.text(String(i.quantity), cols.qty, top, { width: 44, align: 'right', lineBreak: false });
            pdf.text(money(i.unitPrice), cols.rate, top, { width: 58, align: 'right', lineBreak: false });
            pdf.font('Helvetica-Bold').fillColor(PALETTE.INK_STRONG)
               .text(money(i.amount), cols.amt, top, { width: 74, align: 'right', lineBreak: false });
            pdf.y = bottom + 7;
            pdf.moveTo(PAGE.margin, pdf.y - 3).lineTo(PAGE.width - PAGE.margin, pdf.y - 3)
               .lineWidth(0.4).strokeColor(PALETTE.PANEL_EDGE).stroke();
        });

        ensureRoom(pdf, 30);
        pdf.y += 4;
        const totalLabel = d.totals.isRecurring
            ? `RECURRING TOTAL (PER ${d.totals.isAnnual ? 'YEAR' : 'MONTH'})` : 'SUBTOTAL';
        pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(PALETTE.INK_STRONG)
           .text(totalLabel, cols.desc, pdf.y, { width: 404, align: 'right', lineBreak: false });
        pdf.fontSize(13)
           .text(money(d.totals.isRecurring ? d.totals.recurringAmount : d.totals.subtotal),
                 cols.amt, pdf.y - 3, { width: 74, align: 'right', lineBreak: false });
        pdf.y += 20;
        pdf.font('Helvetica-Oblique').fontSize(8).fillColor(PALETTE.INK_MUTED)
           .text(`Prices exclude tax. ${COMPANY.state_full} sales tax (${COMPANY.taxRatePct}%) and any card or bank `
               + 'processing fee are added to each invoice and shown separately.',
                 PAGE.margin, pdf.y, { width: CONTENT_WIDTH });
        pdf.y += 16;
    }

    // ---- milestones --------------------------------------------------------
    if (d.milestones.length) {
        ensureRoom(pdf, 70);
        sectionHeading(pdf, 'PROJECT MILESTONES');
        d.milestones.forEach((m, i) => {
            ensureRoom(pdf, 30);
            pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(PALETTE.INK_STRONG)
               .text(`${i + 1}.  ${m.title}${m.dueDate ? `  —  target ${m.dueDate}` : ''}`,
                     PAGE.margin, pdf.y, { width: CONTENT_WIDTH });
            if (m.description) {
                pdf.font('Helvetica').fontSize(8.8).fillColor(PALETTE.INK_MUTED)
                   .text(m.description, PAGE.margin + 16, pdf.y + 1,
                         { width: CONTENT_WIDTH - 16, lineGap: 1.2 });
            }
            pdf.y += 6;
        });
        pdf.font('Helvetica-Oblique').fontSize(8).fillColor(PALETTE.INK_MUTED)
           .text('Target dates are estimates, not guarantees, and may move if scope changes or if we are waiting on you.',
                 PAGE.margin, pdf.y + 2, { width: CONTENT_WIDTH });
        pdf.y += 16;
    }

    // ---- clauses -----------------------------------------------------------
    d.sections.forEach((s, idx) => {
        const heading = `${idx + 1}.  ${s.heading.toUpperCase()}`;

        if (s.emphasis) {
            // Autopay authorization: boxed, so it survives being printed,
            // photocopied and waved at a bank.
            const bodyH = s.paragraphs.reduce((sum, p) => sum + pdf.font('Helvetica').fontSize(9.5)
                .heightOfString(p, { width: CONTENT_WIDTH - 28, lineGap: 2 }) + 8, 0);
            ensureRoom(pdf, Math.min(bodyH + 46, 320), num);
            const boxTop = pdf.y;
            pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(PALETTE.INK_STRONG)
               .text(heading, PAGE.margin + 14, boxTop + 13, { width: CONTENT_WIDTH - 28, characterSpacing: .5 });
            pdf.y += 6;
            s.paragraphs.forEach((p) => {
                ensureRoom(pdf, 40);
                pdf.font('Helvetica').fontSize(9.5).fillColor(PALETTE.INK)
                   .text(p, PAGE.margin + 14, pdf.y, { width: CONTENT_WIDTH - 28, lineGap: 2, align: 'left' });
                pdf.y += 7;
            });
            const boxBottom = pdf.y + 8;
            pdf.rect(PAGE.margin, boxTop, CONTENT_WIDTH, boxBottom - boxTop)
               .lineWidth(1.4).strokeColor(PALETTE.INK_STRONG).stroke();
            pdf.y = boxBottom + 16;
            return;
        }

        ensureRoom(pdf, 56);
        sectionHeading(pdf, heading);
        s.paragraphs.forEach((p) => {
            ensureRoom(pdf, 34);
            pdf.font('Helvetica').fontSize(9.5).fillColor(PALETTE.INK)
               .text(p, PAGE.margin, pdf.y, { width: CONTENT_WIDTH, lineGap: 2, align: 'left' });
            pdf.y += 7;
        });
        pdf.y += 6;
    });

    // ---- signature block ---------------------------------------------------
    ensureRoom(pdf, 150);
    pdf.y += 6;
    sectionHeading(pdf, 'SIGNATURES');

    if (d.meta.signed) {
        const sigTop = pdf.y;
        pdf.rect(PAGE.margin, sigTop, CONTENT_WIDTH, 92).fill(PALETTE.PANEL);
        const sy = sigTop + 12;
        pdf.font('Helvetica').fontSize(8.5).fillColor(PALETTE.INK_MUTED)
           .text('SIGNED ELECTRONICALLY BY', PAGE.margin + 14, sy, { lineBreak: false, characterSpacing: .5 });
        pdf.font('Helvetica-Bold').fontSize(15).fillColor(PALETTE.INK_STRONG)
           .text(d.meta.signatureName || '', PAGE.margin + 14, sy + 14, { width: CONTENT_WIDTH - 28 });
        pdf.font('Helvetica').fontSize(9).fillColor(PALETTE.INK)
           .text(prettyDateTime(d.meta.signedAt) || '', PAGE.margin + 14, sy + 38);
        pdf.font('Helvetica').fontSize(7.6).fillColor(PALETTE.INK_MUTED)
           .text('Executed under the federal E-SIGN Act and the '
               + `${COMPANY.state_full} Uniform Electronic Transactions Act. `
               + 'The signing record — document hash, IP address and browser — is retained by '
               + `${COMPANY.legalName}.`,
                 PAGE.margin + 14, sy + 54, { width: CONTENT_WIDTH - 28, lineGap: 1 });
        pdf.y = sigTop + 104;
    } else {
        const y0 = pdf.y + 10;
        [['CLIENT', d.meta.company ? '' : ''], ['DIAMONDBACK CODING', '']].forEach(([who], i) => {
            const x = PAGE.margin + i * (CONTENT_WIDTH / 2 + 8);
            const w = CONTENT_WIDTH / 2 - 20;
            pdf.moveTo(x, y0 + 30).lineTo(x + w, y0 + 30)
               .lineWidth(0.8).strokeColor(PALETTE.INK).stroke();
            pdf.font('Helvetica').fontSize(7.6).fillColor(PALETTE.INK_MUTED)
               .text(`${who} — SIGNATURE`, x, y0 + 35, { characterSpacing: .5 });
            pdf.moveTo(x, y0 + 68).lineTo(x + w, y0 + 68)
               .lineWidth(0.8).strokeColor(PALETTE.INK).stroke();
            pdf.font('Helvetica').fontSize(7.6).fillColor(PALETTE.INK_MUTED)
               .text('PRINT NAME AND DATE', x, y0 + 73, { characterSpacing: .5 });
        });
        pdf.y = y0 + 92;
        pdf.font('Helvetica-Oblique').fontSize(8).fillColor(PALETTE.INK_MUTED)
           .text('This copy is unsigned. Sign electronically in your customer portal — '
               + 'typing your name there has the same legal effect as signing above.',
                 PAGE.margin, pdf.y, { width: CONTENT_WIDTH });
    }

    // Footers last, in one pass over the buffered pages, so every page gets
    // exactly one and none of them can trigger a new page.
    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        pdf.switchToPage(range.start + i);
        paintFooter(pdf, num, `Page ${i + 1} of ${range.count}`);
    }
    pdf.flushPages();

    return pdfToBuffer(pdf);
}

/**
 * One label-and-amount row on a single line.
 *
 * pdf.text() MOVES pdf.y, so writing the label and then the amount at `pdf.y`
 * puts the amount on the NEXT line — which is exactly what the breakdown block
 * was doing. Both halves are drawn at a captured y, and pdf.y is set explicitly
 * afterwards.
 */
function moneyRow(pdf, label, value, { bold = false, size = 9.5, gap = 16 } = {}) {
    const y = pdf.y;
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
       .fillColor(bold ? PALETTE.INK_STRONG : PALETTE.INK);
    pdf.text(label, PAGE.margin, y, { width: CONTENT_WIDTH - 120, lineBreak: false });
    pdf.text(value, PAGE.margin + CONTENT_WIDTH - 120, y,
             { width: 120, align: 'right', lineBreak: false });
    pdf.y = y + gap;
}

/** Uppercase label with the heavy rule beneath it. Used throughout. */
function sectionHeading(pdf, text) {
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(PALETTE.INK_STRONG)
       .text(text, PAGE.margin, pdf.y, { width: CONTENT_WIDTH, characterSpacing: .8 });
    pdf.y += 3;
    pdf.moveTo(PAGE.margin, pdf.y).lineTo(PAGE.width - PAGE.margin, pdf.y)
       .lineWidth(1.4).strokeColor(PALETTE.RULE).stroke();
    pdf.y += 10;
}

// ============================================================================
// PDF RENDER — receipt
// ============================================================================
/**
 * A receipt for a payment that has already cleared. Deliberately NOT an invoice:
 * no "amount due", no pay button, no due date — those turn a receipt into
 * something a customer reads as another bill.
 *
 * @param {object} ctx
 * @param {object} ctx.payment  payments row
 * @param {object} ctx.lead     leads row (name/email/address)
 * @param {object} ctx.invoice  invoices row, when the payment settled one
 * @param {object} ctx.plan     maintenance_plans row, for a recurring charge
 * @param {array}  ctx.refunds  refunds rows
 */
async function receiptPDF({ payment, lead = {}, invoice = null, plan = null, refunds = [] } = {}) {
    const p = payment || {};
    const receiptNo = p.receipt_number || `RCPT-${String(p.id).padStart(6, '0')}`;

    // What this receipt is FOR — "Monthly Maintenance Cancellation", not just a
    // receipt number. Used for the PDF's document title (what a viewer shows in
    // its title bar and what a print dialog names) and, via the route, for the
    // download filename.
    const what = (p.description && String(p.description).trim())
        || (plan && plan.label)
        || (invoice && `Invoice ${invoice.invoice_number}`)
        || null;

    const pdf = new PDFDocument({
        size: 'LETTER', margin: PAGE.margin, bufferPages: true,
        info: {
            Title: what ? `Receipt — ${what} (${receiptNo})` : `Receipt ${receiptNo}`,
            Author: COMPANY.legalName,
            Subject: what ? `Payment receipt — ${what}` : 'Payment receipt',
        },
    });

    // ---- masthead ----------------------------------------------------------
    pdf.rect(0, 0, PAGE.width, 92).fill(PALETTE.INK_STRONG);
    pdf.fillColor(PALETTE.INK_INVERSE).font('Helvetica-Bold').fontSize(15)
       .text(COMPANY.legalName.toUpperCase(), PAGE.margin, 26, { characterSpacing: 1.6 });
    // Width stops short of the right column so the address can't run underneath
    // the receipt number stacked there.
    pdf.font('Helvetica').fontSize(8).fillColor(PALETTE.INK_INVERSE)
       .text(COMPANY.addressOneLine, PAGE.margin, 50,
             { width: CONTENT_WIDTH - 175, lineBreak: false });
    pdf.font('Helvetica').fontSize(8).fillColor(PALETTE.INK_INVERSE)
       .text(`${COMPANY.phone}  ·  ${COMPANY.email}`, PAGE.margin, 62,
             { width: CONTENT_WIDTH - 175, lineBreak: false });
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(PALETTE.INK_INVERSE)
       .text('RECEIPT', PAGE.width - PAGE.margin - 120, 28,
             { width: 120, align: 'right', characterSpacing: 2.4 });
    pdf.font('Courier').fontSize(9).fillColor(PALETTE.INK_INVERSE)
       .text(receiptNo, PAGE.width - PAGE.margin - 160, 44, { width: 160, align: 'right' });

    pdf.y = 116;

    // The headline: what this payment was for, above the amount.
    if (what) {
        pdf.font('Helvetica-Bold').fontSize(13).fillColor(PALETTE.INK_STRONG)
           .text(what, PAGE.margin, pdf.y, { width: CONTENT_WIDTH });
        pdf.y += 6;
    }

    const refundedTotal = Number(p.refunded_amount || 0);
    const netPaid = Math.max(0, Number(p.amount || 0) - refundedTotal);
    const statusLabel = refundedTotal > 0
        ? (netPaid === 0 ? 'REFUNDED IN FULL' : 'PARTIALLY REFUNDED')
        : 'PAID IN FULL';
    const statusColor = refundedTotal > 0 ? PALETTE.ATTENTION : PALETTE.POSITIVE;
    assertReadable(statusColor, PALETTE.PAPER, 'receipt status');

    // ---- headline amount ---------------------------------------------------
    pdf.font('Helvetica').fontSize(9).fillColor(PALETTE.INK_MUTED)
       .text('AMOUNT RECEIVED', PAGE.margin, pdf.y, { characterSpacing: .8 });
    pdf.font('Helvetica-Bold').fontSize(34).fillColor(PALETTE.INK_STRONG)
       .text(money(p.amount), PAGE.margin, pdf.y + 4);
    pdf.font('Helvetica-Bold').fontSize(10).fillColor(statusColor)
       .text(statusLabel, PAGE.margin, pdf.y + 2, { characterSpacing: 1 });
    pdf.y += 18;

    // ---- billed-to / details, two columns ----------------------------------
    const colTop = pdf.y;
    const colW = CONTENT_WIDTH / 2 - 12;

    pdf.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.INK_MUTED)
       .text('RECEIVED FROM', PAGE.margin, colTop, { characterSpacing: .8 });
    pdf.font('Helvetica-Bold').fontSize(11).fillColor(PALETTE.INK_STRONG)
       .text(lead.name || p.customer_name || '—', PAGE.margin, colTop + 13, { width: colW });
    pdf.font('Helvetica').fontSize(9).fillColor(PALETTE.INK)
       .text([lead.email, lead.phone, lead.address].filter(Boolean).join('\n') || '',
             PAGE.margin, pdf.y + 1, { width: colW, lineGap: 1.5 });

    const rightX = PAGE.margin + CONTENT_WIDTH / 2 + 12;
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.INK_MUTED)
       .text('ISSUED BY', rightX, colTop, { characterSpacing: .8 });
    pdf.font('Helvetica-Bold').fontSize(11).fillColor(PALETTE.INK_STRONG)
       .text(COMPANY.legalName, rightX, colTop + 13, { width: colW });
    pdf.font('Helvetica').fontSize(9).fillColor(PALETTE.INK)
       .text([...COMPANY.addressBlock, COMPANY.phone, COMPANY.email].join('\n'),
             rightX, pdf.y + 1, { width: colW, lineGap: 1.5 });

    pdf.y = Math.max(pdf.y, colTop + 86) + 14;

    // ---- detail panel ------------------------------------------------------
    const details = [
        ['Receipt number', receiptNo],
        ['Payment date', prettyDateTime(p.paid_at) || prettyDate(p.created_at) || '—'],
        ['Payment method', p.method_last4
            ? `${(p.method_brand || p.method || 'Card')} ending ${p.method_last4}`
            // Raw column values are lowercase ('card', 'us_bank_account').
            // "card" on a customer document reads as a typo.
            : ({ card: 'Card', us_bank_account: 'Bank account', manual: 'Manual' }[p.method]
               || (p.method ? String(p.method).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
                            : 'Card'))],
        // Only when it adds something the headline above doesn't already say.
        (!what || (p.description && p.description !== what))
            ? ['Description', p.description
                || (plan ? `${plan.label} — recurring payment` : null)
                || (invoice ? `Invoice ${invoice.invoice_number}` : 'Payment')]
            : null,
        invoice ? ['Invoice', invoice.invoice_number] : null,
        plan ? ['Plan', `${plan.label} (${plan.interval_unit === 'year' ? 'annual' : 'monthly'} autopay)`] : null,
        plan && plan.next_charge_date ? ['Next scheduled charge', prettyDate(plan.next_charge_date)] : null,
        p.stripe_charge_id ? ['Processor reference', p.stripe_charge_id] : null,
    ].filter(Boolean);

    // Breakdown for an autopay charge, which has no invoice behind it. Without
    // this the customer sees only a total and cannot tell how much of it was
    // tax or the card surcharge — and an undisclosed surcharge is a chargeback
    // waiting to happen.
    const lateFee = Number(p.late_fee_amount || 0);
    const hasBreakdown = Number(p.tax_amount || 0) > 0
        || Number(p.processing_fee || 0) > 0 || lateFee > 0;
    const breakdownLines = hasBreakdown ? [
        ['Plan', money(p.base_amount ?? (Number(p.amount || 0)
            - Number(p.tax_amount || 0) - Number(p.processing_fee || 0) - lateFee))],
        Number(p.tax_amount || 0) > 0 ? ['Sales tax', money(p.tax_amount)] : null,
        // Its own line, named for what it is. A fee folded into a total is a
        // fee the customer disputes.
        lateFee > 0 ? ['Late fee (1.5%)', money(lateFee)] : null,
        Number(p.processing_fee || 0) > 0
            ? ['Credit card processing fee', money(p.processing_fee)] : null,
        ['Total charged', money(p.amount)],
    ].filter(Boolean) : null;

    const dRowH = 19;
    const dPanelH = details.length * dRowH + 16;
    const dTop = pdf.y;
    pdf.rect(PAGE.margin, dTop, CONTENT_WIDTH, dPanelH).fill(PALETTE.PANEL);
    let dy = dTop + 9;
    details.forEach(([k, v]) => {
        pdf.font('Helvetica').fontSize(9).fillColor(PALETTE.INK_MUTED)
           .text(k, PAGE.margin + 14, dy, { width: 168, lineBreak: false });
        pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(PALETTE.INK_STRONG)
           .text(String(v), PAGE.margin + 188, dy, { width: CONTENT_WIDTH - 202, lineBreak: false });
        dy += dRowH;
    });
    pdf.y = dTop + dPanelH + 22;

    // ---- breakdown for an autopay charge (no invoice) ----------------------
    if (breakdownLines && !invoice) {
        sectionHeading(pdf, 'BREAKDOWN');
        breakdownLines.forEach(([k, v], i) => {
            const last = i === breakdownLines.length - 1;
            moneyRow(pdf, k, v, { bold: last, size: last ? 10.5 : 9.5, gap: last ? 20 : 16 });
        });
        if (Number(p.processing_fee || 0) > 0) {
            pdf.font('Helvetica-Oblique').fontSize(8).fillColor(PALETTE.INK_MUTED)
               .text('The processing fee applies to credit card payments only. Paying by bank '
                   + 'account or debit card avoids it — you can switch in your customer portal.',
                     PAGE.margin, pdf.y, { width: CONTENT_WIDTH, lineGap: 1.2 });
            pdf.y += 14;
        }
    }

    // ---- invoice breakdown, when one exists --------------------------------
    if (invoice) {
        sectionHeading(pdf, 'BREAKDOWN');
        const lines = [
            ['Subtotal', money(invoice.subtotal ?? invoice.amount ?? p.amount)],
            invoice.tax_amount ? [`Sales tax (${Number(invoice.tax_rate || COMPANY.taxRatePct)}%)`, money(invoice.tax_amount)] : null,
            // Named as a CREDIT CARD surcharge, not a vague "processing fee".
            // Card network rules require the surcharge be identified as such on
            // the receipt; a generic label does not satisfy that.
            invoice.late_fee_amount ? ['Late fee (1.5%)', money(invoice.late_fee_amount)] : null,
            invoice.processing_fee ? ['Credit card processing fee', money(invoice.processing_fee)] : null,
            ['Invoice total', money(invoice.total_amount ?? p.amount)],
        ].filter(Boolean);
        lines.forEach(([k, v], i) => {
            const last = i === lines.length - 1;
            moneyRow(pdf, k, v, { bold: last, size: last ? 10.5 : 9.5, gap: last ? 20 : 16 });
        });
    }

    // ---- refunds -----------------------------------------------------------
    if (refunds && refunds.length) {
        ensureRoom(pdf, 70);
        sectionHeading(pdf, 'REFUNDS AGAINST THIS PAYMENT');
        refunds.forEach((r) => {
            const y = pdf.y;
            pdf.font('Helvetica').fontSize(9.5).fillColor(PALETTE.INK)
               .text(`${prettyDate(r.created_at) || ''}${r.reason ? ` — ${r.reason}` : ''}`,
                     PAGE.margin, y, { width: CONTENT_WIDTH - 120, lineBreak: false });
            pdf.font('Helvetica-Bold').fillColor(PALETTE.ATTENTION)
               .text(`-${money(r.amount)}`, PAGE.margin + CONTENT_WIDTH - 120, y,
                     { width: 120, align: 'right', lineBreak: false });
            pdf.y = y + 17;
        });
        pdf.y += 4;
        moneyRow(pdf, 'NET RETAINED', money(netPaid), { bold: true, size: 11, gap: 22 });
    }

    // ---- closing note ------------------------------------------------------
    ensureRoom(pdf, 70);
    pdf.y += 6;
    pdf.moveTo(PAGE.margin, pdf.y).lineTo(PAGE.width - PAGE.margin, pdf.y)
       .lineWidth(1.4).strokeColor(PALETTE.RULE).stroke();
    pdf.y += 12;
    pdf.font('Helvetica').fontSize(9).fillColor(PALETTE.INK)
       .text('Thank you. This receipt confirms payment has been received and cleared. '
           + 'No action is required.', PAGE.margin, pdf.y, { width: CONTENT_WIDTH, lineGap: 2 });
    pdf.y += 8;
    // A cancellation settlement is the LAST payment on a plan. Telling the
    // customer they can "cancel that authorization at any time" on a receipt
    // for having just cancelled it is the kind of line that generates a
    // support email.
    const isCancellation = /cancellation|cancelled|canceled/i.test(what || '');
    if (plan && !isCancellation) {
        pdf.font('Helvetica').fontSize(8.6).fillColor(PALETTE.INK_MUTED)
           .text(`This charge was made under your ${plan.interval_unit === 'year' ? 'annual' : 'monthly'} `
               + `automatic payment authorization for ${plan.label}. `
               + 'You can review or cancel that authorization at any time in your customer portal.',
                 PAGE.margin, pdf.y, { width: CONTENT_WIDTH, lineGap: 1.5 });
        pdf.y += 6;
    } else if (plan && isCancellation) {
        pdf.font('Helvetica').fontSize(8.6).fillColor(PALETTE.INK_MUTED)
           .text(`This settles ${plan.label} through the end of your notice period. `
               + 'No further payments will be taken, and your automatic payment authorization ends '
               + 'with the plan.',
                 PAGE.margin, pdf.y, { width: CONTENT_WIDTH, lineGap: 1.5 });
        pdf.y += 6;
    }
    pdf.font('Helvetica').fontSize(8.6).fillColor(PALETTE.INK_MUTED)
       .text(`Questions about this receipt: ${COMPANY.email} or ${COMPANY.phone}. `
           + 'Please quote the receipt number above.', PAGE.margin, pdf.y,
             { width: CONTENT_WIDTH, lineGap: 1.5 });

    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        pdf.switchToPage(range.start + i);
        paintFooter(pdf, receiptNo, range.count > 1 ? `Page ${i + 1} of ${range.count}` : null);
    }
    pdf.flushPages();

    return pdfToBuffer(pdf);
}

// ============================================================================
// EMAIL FRAGMENTS — same palette, so email can't drift from the documents
// ============================================================================
/**
 * A key/value block for transactional email. Every colour here is on the
 * READABLE_ON list, which is what stops the "white text on a white panel" class
 * of bug that made receipt numbers invisible in the last build.
 */
function emailRows(pairs) {
    assertReadable(PALETTE.INK_MUTED, PALETTE.PANEL, 'email row label');
    assertReadable(PALETTE.INK_STRONG, PALETTE.PANEL, 'email row value');
    const rows = pairs.filter(Boolean);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="margin:0 0 16px;background:${PALETTE.PANEL};border-radius:12px;">`
        + rows.map(([k, v, opts], i) => {
            const strong = opts && opts.strong;
            const color = (opts && opts.color) || PALETTE.INK_STRONG;
            assertReadable(color, PALETTE.PANEL, `email row "${k}"`);
            const edge = i < rows.length - 1 ? `border-bottom:1px solid ${PALETTE.PANEL_EDGE};` : '';
            return `
        <tr>
          <td style="padding:11px 16px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;
                     font-size:13px;color:${PALETTE.INK_MUTED};${edge}">${esc(k)}</td>
          <td align="right" style="padding:11px 16px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;
                     font-size:${strong ? '17px' : '14px'};font-weight:${strong ? 800 : 600};
                     color:${color};${edge}">${v}</td>
        </tr>`;
        }).join('') + '</table>';
}

/** The address block every email footer should carry. */
function emailFooterAddress() {
    return `${esc(COMPANY.legalName)} &middot; ${esc(COMPANY.addressOneLine)}`;
}

/**
 * Download filename for a receipt: "Receipt-Monthly-Maintenance-Cancellation-RCPT-INV000016.pdf".
 * The route uses this so the saved file says what it is without being opened.
 */
function receiptFilename(payment, plan = null, invoice = null) {
    const p = payment || {};
    const no = p.receipt_number || `RCPT-${String(p.id).padStart(6, '0')}`;
    const what = (p.description && String(p.description).trim())
        || (plan && plan.label)
        || (invoice && `Invoice ${invoice.invoice_number}`)
        || '';
    const slug = what
        .replace(/[^\w\s-]/g, ' ')      // drop punctuation, keep words
        .trim().split(/\s+/).join('-')
        .slice(0, 60)
        .replace(/-+$/, '');
    return (slug ? `Receipt-${slug}-${no}` : `Receipt-${no}`)
        .replace(/[^\w.\-]/g, '_') + '.pdf';
}

module.exports = {
    COMPANY,
    receiptFilename,
    PALETTE,
    assertReadable,
    CLAUSES,
    buildAgreementDocument,
    renderAgreementText,
    renderAgreementHTML,
    hashAgreement,
    agreementPDF,
    receiptPDF,
    emailRows,
    emailFooterAddress,
    // exported for reuse by the route module and tests
    money, esc, prettyDate, prettyDateTime, ordinal, serviceLabel,
};