/**
 * test_portal_dom.js — drives the REAL customer_portal.html in jsdom.
 *
 * The backend suite proves the API is right. This proves the page renders that
 * API correctly: the outstanding balance, the invoice list, and — after
 * signing — that the row flips to "Signed & complete" and moves into Docs
 * without a reload.
 */

const fs = require('fs');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail = '') {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- server state the mock API serves ---- */
let AGREEMENTS = [
    { id: 1, agreement_number: 'SA-00001', package_name: 'Website Rebuild', price: '7500.00',
      status: 'sent', signed_at: null, est_completion_date: '2026-09-05',
      terms: 'Net 14 from completion.', agreement_kind: 'sla' },
];
let INVOICES = [];
const CALLS = [];

function jsonRes(body, status = 200) {
    return Promise.resolve({
        ok: status < 400, status,
        json: async () => body,
        blob: async () => ({ size: 10 }),
    });
}

/* Mirrors the real endpoints, including the shapes the portal depends on. */
function mockFetch(url, opts = {}) {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    CALLS.push((opts.method || 'GET') + ' ' + path);

    if (path === '/api/portal/dashboard') {
        return jsonRes({ success: true, dashboard: {
            invoices: INVOICES, projects: [], salesAgreements: AGREEMENTS, tickets: [], activity: [] } });
    }
    if (path === '/api/portal/messages/unread-count') return jsonRes({ success: true, count: 2 });
    if (path === '/api/portal/messages') return jsonRes({ success: true, messages: [] });
    if (path === '/api/portal/payments') return jsonRes({ success: true, payments: [], totals: { paid: 0, refunded: 0, net: 0 } });
    if (path === '/api/portal/plans') return jsonRes({ success: true, plans: [], paymentMethods: [], noticeDays: 30 });
    if (path === '/api/portal/timeline') return jsonRes({ success: true, projects: [] });
    if (path === '/api/portal/service-requests') return jsonRes({ success: true, requests: [] });
    if (path === '/api/config/stripe') return jsonRes({ publishableKey: 'pk_test' });

    if (/\/api\/portal\/sales-agreements\/\d+\/sign$/.test(path)) {
        // Exactly what the server does: mark signed, raise the invoice.
        AGREEMENTS = AGREEMENTS.map(a => a.id === 1
            ? { ...a, status: 'signed', signed_at: new Date().toISOString() } : a);
        INVOICES = [{ id: 90, invoice_number: 'INV-00001', total_amount: '7500.00',
                      subtotal: '7500.00', status: 'sent', due_date: '2026-09-05',
                      due_date_estimated: true, paid_at: null }];
        return jsonRes({ success: true, kind: 'sla',
            message: 'Signed. Your project timeline and invoice are in your portal.',
            invoice: { number: 'INV-00001', total: '7500.00', dueDate: '2026-09-05', dueDateEstimated: true },
            assignedAdmin: 'taylor' });
    }
    return jsonRes({ success: true });
}

async function main() {
    const html = fs.readFileSync('/home/claude/work/customer_portal.html', 'utf8');
    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        url: 'https://diamondbackcoding.com/customer_portal.html',
        pretendToBeVisual: true,
        beforeParse(win) {
            win.fetch = (u, o) => mockFetch(u, o);
            // Signed-in session, so the app boots straight to Home.
            win.localStorage.setItem('db_portal_token', 'tok');
            win.localStorage.setItem('db_portal_me', JSON.stringify({ id: 1, name: 'Acme Corp', email: 'acme@x.com' }));
            win.scrollTo = () => {};
            win.confirm = () => true;
            win.Stripe = () => ({ elements: () => ({ create: () => ({ mount(){}, on(){} }) }) });
        },
    });
    const win = dom.window;
    const doc = win.document;
    const $ = s => doc.querySelector(s);
    const text = () => doc.getElementById('main').textContent.replace(/\s+/g, ' ');

    // let boot() + the first dashboard fetch settle
    await sleep(400);

    console.log('\n=== 1. the app boots past the login screen ===');
    check('login hidden', $('#login').style.display === 'none', $('#login').style.display);
    check('app shown', $('#app').classList.contains('on'));
    check('tab bar shown', !$('#tabs').classList.contains('hidden'));
    check('greets the customer', /Acme Corp/.test($('#greetName').textContent), $('#greetName').textContent);
    check('dashboard was fetched', CALLS.includes('GET /api/portal/dashboard'), JSON.stringify(CALLS));

    console.log('\n=== 2. unread badge appears ===');
    check('topbar badge visible', !$('#msgDot').classList.contains('hidden'));
    check('badge reads 2', $('#msgDot').textContent === '2', $('#msgDot').textContent);
    check('tab badge matches', $('#tabDot').textContent === '2', $('#tabDot').textContent);

    console.log('\n=== 3. BEFORE signing ===');
    let t = text();
    check('outstanding shows $0.00 with no invoices', /\$0\.00/.test(t), t.slice(0, 160));
    check('"Ready to sign" card present', /Ready to sign/.test(t));
    check('agreement listed', /Website Rebuild/.test(t));
    check('offers Review', /Review/.test(t));

    console.log('\n=== 4. sign it — the sheet opens and submits ===');
    win.openSign(1);
    await sleep(120);
    check('sign sheet opened', $('#sheet').classList.contains('on'));
    check('terms shown', /Net 14 from completion/.test($('#sheetBox').textContent));

    const nameEl = doc.getElementById('sgName');
    nameEl.value = 'John Acme';
    nameEl.dispatchEvent(new win.Event('input'));
    await sleep(60);
    check('signature preview rendered', !!doc.querySelector('#sgPad svg'));
    check('preview shows the typed name', /John Acme/.test($('#sgPad').textContent));

    // submit without consent first
    doc.getElementById('sgGo').click();
    await sleep(80);
    check('refuses without the consent tick',
        !$('#sgErr').classList.contains('hidden') && /agree to the terms/i.test($('#sgErr').textContent),
        $('#sgErr').textContent);

    doc.getElementById('sgAgree').checked = true;
    doc.getElementById('sgGo').click();
    await sleep(500);

    console.log('\n=== 5. THE REPORTED BUG: state after signing, no reload ===');
    check('sheet closed', !$('#sheet').classList.contains('on'));
    check('sign was POSTed', CALLS.some(c => /POST \/api\/portal\/sales-agreements\/1\/sign/.test(c)));
    check('dashboard refetched after signing',
        CALLS.filter(c => c === 'GET /api/portal/dashboard').length >= 2,
        String(CALLS.filter(c => c === 'GET /api/portal/dashboard').length));

    t = text();
    check('landed on Receipts & Docs', /Receipts & Docs/.test(t), t.slice(0, 120));
    check('shows "Signed & complete"', /Signed & complete/.test(t), t.slice(0, 400));
    check('NO "Review & sign" left', !/Review & sign/.test(t), t.slice(0, 400));
    check('NOT under "Awaiting your signature"', !/Awaiting your signature/.test(t), t.slice(0, 240));
    check('filed under "Signed agreements"', /Signed agreements/.test(t));
    check('offers a Download', /Download/.test(t));

    console.log('\n=== 6. THE REPORTED BUG: outstanding balance ===');
    win.go('home');
    await sleep(350);
    t = text();
    check('outstanding now shows $7,500.00', /\$7,500\.00/.test(t), t.slice(0, 200));
    check('no longer $0.00', !/\$0\.00/.test(t.slice(0, 200)), t.slice(0, 200));
    check('says 1 open invoice', /1 open invoice/.test(t), t.slice(0, 240));
    check('offers "Pay an invoice"', /Pay an invoice/.test(t));
    check('invoice listed by number', /INV-00001/.test(t), t.slice(0, 400));
    check('"Ready to sign" card gone', !/Ready to sign/.test(t), t.slice(0, 240));

    console.log('\n=== 7. Billing view agrees ===');
    win.go('billing');
    await sleep(350);
    t = text();
    check('invoice shown in Billing', /INV-00001/.test(t));
    check('marked as 1 open', /1 open/.test(t), t.slice(0, 260));
    check('total shown', /\$7,500\.00/.test(t));

    console.log('\n=== 8. no uncaught page errors ===');
    check('no console errors captured', ERRORS.length === 0, JSON.stringify(ERRORS.slice(0, 3)));

    console.log(`\n${'='.repeat(54)}`);
    console.log(`PASS ${pass}   FAIL ${fail}`);
    failures.forEach(f => console.log('  - ' + f));
    console.log('='.repeat(54));
    process.exit(fail ? 1 : 0);
}

const ERRORS = [];
const origErr = console.error;
console.error = (...a) => { ERRORS.push(a.map(String).join(' ')); origErr(...a); };

main().catch(e => { console.log('CRASH:', e.message); process.exit(2); });