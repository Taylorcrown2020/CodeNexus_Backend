#!/usr/bin/env python3
"""
patch_customer_portal.py — add the missing customer-facing screens.

  * Sign an agreement (typed name -> platform-generated signature)
  * Payments & Receipts view (history, refunds shown, totals)
  * Plans view (maintenance plans, 30-day cancellation, reinstate)
  * Payment methods (card + ACH bank account, microdeposit verification)

Matches the file's existing conventions: nav('view') dispatch, innerHTML into
#main, and the esc/money/fmtDate helpers already defined there.

Idempotent.
"""

import re
import sys
import pathlib

MARKER = 'db-portal-billing'

# ---------------------------------------------------------------- nav links
NAV_ANCHOR = '''    <div class="nav-link" data-view="documents" onclick="nav('documents')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>Receipts &amp; Docs</div>'''

NAV_NEW = NAV_ANCHOR + '''
    <div class="nav-link" data-view="payments" onclick="nav('payments')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>Payments</div>
    <div class="nav-link" data-view="plans" onclick="nav('plans')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="23 4 23 10 17 10"/></svg>Plans<span class="nav-badge hidden" id="planBadge">0</span></div>'''

# ---------------------------------------------------------------- dispatch
DISPATCH_OLD = """  ({dashboard:viewDashboard,invoices:viewInvoices,projects:viewProjects,requests:viewRequests,
    documents:viewDocuments,messages:viewMessages}[view]||viewDashboard)();"""

DISPATCH_NEW = """  ({dashboard:viewDashboard,invoices:viewInvoices,projects:viewProjects,requests:viewRequests,
    documents:viewDocuments,messages:viewMessages,
    payments:viewPayments,plans:viewPlans}[view]||viewDashboard)();"""

# ------------------------------------------------------- sign button on cards
# The agreement card's status pill; a sign button goes next to it when unsigned.
SIGN_BTN_OLD = """        <span class="pill ${st==='completed'?'paid':(st==='cancelled'?'cancelled':'in-progress')}">${esc(st)}</span>
      </div>"""

SIGN_BTN_NEW = """        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
          <span class="pill ${st==='signed'?'paid':(st==='completed'?'paid':(st==='cancelled'?'cancelled':'in-progress'))}">${esc(st)}</span>
          ${(st==='sent'||st==='draft')?`<button class="btn btn-primary" onclick="openSign(${a.id})">Review &amp; sign</button>`:''}
          ${a.signed_at?`<div class="muted sm">Signed ${fmtDate(a.signed_at)}</div>`:''}
        </div>
      </div>"""

# ------------------------------------------------------------------- styles
STYLES = '''
<style id="db-portal-billing-css">
/* Billing screens. Reuses the portal's existing tokens so nothing new is
   introduced visually — only new layouts. */
.db-modal{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;
  justify-content:center;z-index:200;padding:20px;overflow-y:auto}
.db-modal[hidden]{display:none}
.db-modal-box{background:var(--bg-panel,#141414);border:1px solid var(--border-subtle,#2a2a2a);
  border-radius:var(--radius-md,12px);max-width:560px;width:100%;padding:26px;max-height:90vh;overflow-y:auto}
.db-sign-pad{background:var(--bg-void,#0a0a0a);border:1px dashed var(--border-subtle,#333);
  border-radius:8px;padding:14px;margin:14px 0;min-height:96px;display:flex;align-items:center;justify-content:center}
.db-sign-pad svg{max-width:100%;height:auto}
.db-sign-pad .muted{font-size:12px}
.db-terms{background:var(--bg-void,#0a0a0a);border:1px solid var(--border-subtle,#2a2a2a);
  border-radius:8px;padding:14px;max-height:190px;overflow-y:auto;font-size:13px;line-height:1.6;
  color:var(--text-muted,#a0a0a0);white-space:pre-wrap}
.db-consent{display:flex;gap:10px;align-items:flex-start;margin:14px 0;font-size:13px;line-height:1.5}
.db-consent input{margin-top:3px;flex-shrink:0;width:16px;height:16px;accent-color:var(--accent,#10b981)}
.db-field{margin:12px 0}
.db-field label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.6px;
  color:var(--text-muted,#888);margin-bottom:6px}
.db-field input,.db-field select{width:100%;padding:11px 13px;background:var(--bg-void,#0a0a0a);
  border:1px solid var(--border-subtle,#2a2a2a);border-radius:8px;color:#fff;font:inherit;font-size:14px}
.db-field input:focus,.db-field select:focus{outline:none;border-color:var(--accent,#10b981)}
.db-row{display:flex;gap:12px}.db-row>*{flex:1}
.db-warn{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:8px;
  padding:13px 15px;font-size:13px;line-height:1.55;color:#fca5a5;margin:14px 0}
.db-info{background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.25);border-radius:8px;
  padding:13px 15px;font-size:13px;line-height:1.55;color:#6ee7b7;margin:14px 0}
.db-pm{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 0;
  border-bottom:1px solid var(--border-subtle,#222)}
.db-pm:last-child{border-bottom:none}
.db-pm-badge{font-size:10px;text-transform:uppercase;letter-spacing:.7px;padding:3px 8px;
  border-radius:4px;background:rgba(16,185,129,.15);color:#10b981;font-weight:700}
.db-pm-badge.pending{background:rgba(234,179,8,.15);color:#eab308}
.db-refund{font-size:12px;color:#fca5a5;margin-top:3px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
'''

# ------------------------------------------------------------------ scripts
SCRIPTS = r'''
<script id="db-portal-billing">
/* =====================================================================
   Billing screens — payments, plans, signing, payment methods.
   Talks only to /api/portal/*, which requires a 'portal' token.
   ===================================================================== */
let PAYMENTS = [], PAY_TOTALS = null, PLANS = [], PLAN_NOTICE = 30, PMS = [];

async function pget(path){
  const r = await fetch(API + path, { headers:{ 'Authorization':'Bearer ' + TOKEN }});
  if(!r.ok) throw new Error('Request failed (' + r.status + ')');
  return r.json();
}
async function ppost(path, body, method){
  const r = await fetch(API + path, {
    method: method || 'POST',
    headers:{ 'Authorization':'Bearer ' + TOKEN, 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let d = {}; try { d = await r.json(); } catch(_) {}
  if(!r.ok && d.message === undefined) d.message = 'Request failed (' + r.status + ')';
  return d;
}
function dbToast(msg, bad){
  let t = document.getElementById('dbToast');
  if(!t){
    t = document.createElement('div'); t.id = 'dbToast';
    t.style.cssText = 'position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:300;'+
      'padding:14px 22px;border-radius:8px;font-size:14px;font-weight:600;max-width:90vw;text-align:center';
    document.body.appendChild(t);
  }
  t.style.background = bad ? '#7f1d1d' : '#065f46';
  t.style.color = '#fff';
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(()=>{ t.style.display='none'; }, 5200);
}

/* ---------------- PAYMENTS ---------------- */
async function viewPayments(){
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-title">Payments</div>
    <div class="page-sub">Every payment on your account, with receipts.</div>
    <div class="card mt"><p class="muted sm">Loading…</p></div>`;
  try{
    const d = await pget('/api/portal/payments');
    PAYMENTS = d.payments || []; PAY_TOTALS = d.totals || null;
  }catch(e){
    main.innerHTML = `<div class="page-title">Payments</div>
      <div class="card mt"><p class="muted sm">Couldn't load your payments. Please refresh.</p></div>`;
    return;
  }

  const t = PAY_TOTALS || { paid:0, refunded:0, net:0 };
  const stats = `<div class="stats mt">
      <div class="stat"><div class="label">Total paid</div><div class="value">${money(t.paid)}</div></div>
      ${Number(t.refunded)>0?`<div class="stat"><div class="label">Refunded</div><div class="value">${money(t.refunded)}</div></div>`:''}
      <div class="stat"><div class="label">Net</div><div class="value">${money(t.net)}</div></div>
      <div class="stat"><div class="label">Payments</div><div class="value">${PAYMENTS.length}</div></div>
    </div>`;

  const rows = PAYMENTS.length ? PAYMENTS.map(p=>{
    const refunds = Array.isArray(p.refunds) ? p.refunds : [];
    const refunded = Number(p.refunded_amount||0);
    const label = p.kind === 'maintenance' ? (p.description || 'Maintenance')
                : (p.invoice_number ? ('Invoice ' + p.invoice_number) : (p.description || 'Payment'));
    const method = p.method_last4
      ? `${esc(p.method_brand || p.method || 'Card')} ····${esc(p.method_last4)}`
      : esc(p.method || '—');
    return `<div class="list-item">
      <div>
        <div class="mono sm">${esc(label)}</div>
        <div class="muted sm">${fmtDate(p.paid_at)} · ${method} · receipt ${esc(p.receipt_number||'—')}</div>
        ${refunds.map(r=>`<div class="db-refund">Refunded ${money(r.amount)} on ${fmtDate(r.created_at)}${r.reason?(' — '+esc(r.reason)):''}</div>`).join('')}
      </div>
      <div style="text-align:right">
        <div class="mono">${money(p.amount)}</div>
        <span class="pill ${p.status==='succeeded'?'paid':(p.status==='failed'?'cancelled':'in-progress')}">${esc((p.status||'').replace(/_/g,' '))}</span>
        ${refunded>0?`<div class="muted sm" style="margin-top:3px">net ${money(Number(p.amount)-refunded)}</div>`:''}
      </div></div>`;
  }).join('') : `<p class="muted sm">No payments yet. When you pay an invoice or a plan renews, it shows up here with a receipt.</p>`;

  main.innerHTML = `<div class="page-title">Payments</div>
    <div class="page-sub">Every payment on your account, with receipts.</div>
    ${stats}
    <div class="card mt"><h3>History</h3>${rows}</div>
    <div class="card mt" id="pmCard"><h3>Payment methods</h3><p class="muted sm">Loading…</p></div>`;
  renderPaymentMethods();
}

/* ---------------- PAYMENT METHODS ---------------- */
async function renderPaymentMethods(){
  const card = document.getElementById('pmCard');
  if(!card) return;
  try{
    const d = await pget('/api/portal/payment-methods');
    PMS = d.paymentMethods || [];
  }catch(e){
    card.innerHTML = `<h3>Payment methods</h3><p class="muted sm">Couldn't load your payment methods.</p>`;
    return;
  }
  const list = PMS.length ? PMS.map(m=>{
    const name = m.type === 'card'
      ? `${esc(m.brand||'Card')} ····${esc(m.last4||'')}${m.exp_month?` · exp ${m.exp_month}/${String(m.exp_year||'').slice(-2)}`:''}`
      : `${esc(m.bank_name||'Bank account')} ····${esc(m.last4||'')}`;
    const pending = m.status === 'pending_verification';
    return `<div class="db-pm">
      <div>
        <div class="mono sm">${name}</div>
        <div class="muted sm">${m.type==='card'?'Card':'Bank account (ACH)'}${m.is_default?' · default':''}</div>
        ${pending?`<div class="muted sm" style="color:#eab308;margin-top:3px">Awaiting verification — enter the two deposit amounts to finish.</div>`:''}
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="db-pm-badge ${pending?'pending':''}">${pending?'pending':'active'}</span>
        ${pending?`<button class="btn" onclick="openVerify()">Verify</button>`:''}
        <button class="btn" onclick="removePM(${m.id})">Remove</button>
      </div></div>`;
  }).join('') : `<p class="muted sm">No payment method saved. Add one to pay invoices faster, or to enroll in a maintenance plan.</p>`;

  card.innerHTML = `<h3>Payment methods</h3>${list}
    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="addPM('card')">Add a card</button>
      <button class="btn" onclick="addPM('us_bank_account')">Add a bank account</button>
    </div>`;
}

/* Stripe.js is loaded on demand — no third-party script on the login page. */
function loadStripeJs(){
  return new Promise((resolve, reject)=>{
    if(window.Stripe) return resolve(window.Stripe);
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = ()=> window.Stripe ? resolve(window.Stripe) : reject(new Error('Stripe.js failed to load'));
    s.onerror = ()=> reject(new Error('Stripe.js failed to load'));
    document.head.appendChild(s);
  });
}

async function addPM(type){
  try{
    dbToast('Opening secure form…');
    const intent = await ppost('/api/portal/payment-methods/setup-intent', { type });
    if(!intent.success) return dbToast(intent.message || 'Could not start.', true);
    if(!intent.publishableKey) return dbToast('Card payments are not configured yet. Please contact us.', true);

    const Stripe = await loadStripeJs();
    const stripe = Stripe(intent.publishableKey);

    /* Card and bank take different Stripe.js paths. Card uses an Elements
       form; bank uses collectBankAccountForSetup, which opens Stripe's own
       bank-login flow and handles microdeposit fallback. */
    if(type === 'us_bank_account'){
      const { setupIntent, error } = await stripe.collectBankAccountForSetup({
        clientSecret: intent.clientSecret,
        params: { payment_method_type: 'us_bank_account',
                  payment_method_data: { billing_details: { name: (CLIENT&&CLIENT.name)||'Customer',
                                                            email: (CLIENT&&CLIENT.email)||'' } } },
        expand: ['payment_method']
      });
      if(error) return dbToast(error.message, true);
      if(setupIntent.status === 'requires_confirmation'){
        const c = await stripe.confirmUsBankAccountSetup(intent.clientSecret);
        if(c.error) return dbToast(c.error.message, true);
      }
      const done = await ppost('/api/portal/payment-methods/confirm', { setupIntentId: intent.setupIntentId });
      sessionStorage.setItem('db_setup_intent', intent.setupIntentId);
      dbToast(done.message || 'Bank account added.', !done.success);
      renderPaymentMethods();
      return;
    }

    openCardModal(stripe, intent);
  }catch(e){
    dbToast(e.message || 'Something went wrong.', true);
  }
}

function openCardModal(stripe, intent){
  let m = document.getElementById('cardModal');
  if(m) m.remove();
  m = document.createElement('div');
  m.id = 'cardModal'; m.className = 'db-modal';
  m.innerHTML = `<div class="db-modal-box">
      <h3 style="margin:0 0 4px">Add a card</h3>
      <p class="muted sm" style="margin:0 0 16px">Your card details go straight to Stripe. We never see or store them.</p>
      <div id="cardElement" style="background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;padding:14px"></div>
      <div id="cardErr" class="db-warn" style="display:none"></div>
      <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
        <button class="btn" onclick="document.getElementById('cardModal').remove()">Cancel</button>
        <button class="btn btn-primary" id="cardSave">Save card</button>
      </div></div>`;
  document.body.appendChild(m);

  const elements = stripe.elements({ clientSecret: intent.clientSecret,
    appearance:{ theme:'night', variables:{ colorPrimary:'#10b981', colorBackground:'#0a0a0a' } } });
  const pe = elements.create('payment', { layout:'tabs' });
  pe.mount('#cardElement');

  document.getElementById('cardSave').onclick = async ()=>{
    const btn = document.getElementById('cardSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    const { error } = await stripe.confirmSetup({ elements, redirect:'if_required' });
    if(error){
      const e = document.getElementById('cardErr');
      e.style.display = 'block'; e.textContent = error.message;
      btn.disabled = false; btn.textContent = 'Save card';
      return;
    }
    const done = await ppost('/api/portal/payment-methods/confirm', { setupIntentId: intent.setupIntentId });
    m.remove();
    dbToast(done.message || 'Card saved.', !done.success);
    renderPaymentMethods();
  };
}

function openVerify(){
  const id = sessionStorage.getItem('db_setup_intent') || '';
  let m = document.getElementById('verifyModal');
  if(m) m.remove();
  m = document.createElement('div');
  m.id = 'verifyModal'; m.className = 'db-modal';
  m.innerHTML = `<div class="db-modal-box">
      <h3 style="margin:0 0 4px">Verify your bank account</h3>
      <p class="muted sm" style="margin:0 0 8px">We sent two small deposits to your account. Enter the amounts in cents, or the 6-digit code from your statement.</p>
      ${id?'':`<div class="db-field"><label>Setup reference</label><input id="vSetup" placeholder="seti_..."></div>`}
      <div class="db-row">
        <div class="db-field"><label>First amount (cents)</label><input id="vA1" inputmode="numeric" placeholder="32"></div>
        <div class="db-field"><label>Second amount (cents)</label><input id="vA2" inputmode="numeric" placeholder="45"></div>
      </div>
      <p class="muted sm" style="margin:6px 0 0">Or, if your statement shows a code:</p>
      <div class="db-field"><label>Descriptor code</label><input id="vCode" placeholder="SM11AA"></div>
      <div id="vErr" class="db-warn" style="display:none"></div>
      <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
        <button class="btn" onclick="document.getElementById('verifyModal').remove()">Cancel</button>
        <button class="btn btn-primary" id="vGo">Verify</button>
      </div></div>`;
  document.body.appendChild(m);

  document.getElementById('vGo').onclick = async ()=>{
    const setupIntentId = id || (document.getElementById('vSetup')||{}).value;
    const a1 = (document.getElementById('vA1')||{}).value;
    const a2 = (document.getElementById('vA2')||{}).value;
    const code = (document.getElementById('vCode')||{}).value;
    const body = { setupIntentId };
    if(code && code.trim()) body.descriptorCode = code.trim();
    else if(a1 && a2) body.amounts = [Number(a1), Number(a2)];
    else {
      const e = document.getElementById('vErr');
      e.style.display='block'; e.textContent='Enter both amounts, or the descriptor code.';
      return;
    }
    const btn = document.getElementById('vGo');
    btn.disabled = true; btn.textContent = 'Verifying…';
    const d = await ppost('/api/portal/payment-methods/verify-microdeposits', body);
    if(d.success){ m.remove(); dbToast(d.message||'Verified.'); renderPaymentMethods(); return; }
    const e = document.getElementById('vErr');
    e.style.display='block'; e.textContent = d.message || 'Verification failed.';
    btn.disabled = false; btn.textContent = 'Verify';
  };
}

async function removePM(id){
  if(!confirm('Remove this payment method?')) return;
  const d = await ppost('/api/portal/payment-methods/' + id, null, 'DELETE');
  dbToast(d.message || (d.success?'Removed.':'Could not remove it.'), !d.success);
  renderPaymentMethods();
}

/* ---------------- PLANS ---------------- */
async function viewPlans(){
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-title">Plans</div>
    <div class="page-sub">Your recurring maintenance plans.</div>
    <div class="card mt"><p class="muted sm">Loading…</p></div>`;
  try{
    const d = await pget('/api/portal/maintenance-plans');
    PLANS = d.plans || []; PLAN_NOTICE = d.noticeDays || 30;
  }catch(e){
    main.innerHTML = `<div class="page-title">Plans</div>
      <div class="card mt"><p class="muted sm">Couldn't load your plans. Please refresh.</p></div>`;
    return;
  }
  updatePlanBadge();

  if(!PLANS.length){
    main.innerHTML = `<div class="page-title">Plans</div>
      <div class="page-sub">Your recurring maintenance plans.</div>
      <div class="card mt"><p class="muted sm">You're not on a maintenance plan. If you'd like ongoing upkeep for your site, database or email setup, just send us a message.</p></div>`;
    return;
  }

  const cards = PLANS.map(p=>{
    const cancelling = p.status === 'pending_cancellation';
    const days = p.days_until_cancellation;
    const needsSig = p.status === 'pending_signature';
    const needsPm  = p.status === 'pending_payment_method';
    const method = p.last4
      ? `${esc(p.brand || p.bank_name || p.method_type || 'Card')} ····${esc(p.last4)}`
      : 'No payment method yet';
    return `<div class="card mt">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <h3>${esc(p.label)}</h3>
          <div class="muted sm" style="margin-top:4px">${money(p.amount)} per month · bills on day ${esc(String(p.billing_day))} · ${method}</div>
        </div>
        <span class="pill ${p.status==='active'?'paid':(cancelling?'cancelled':'in-progress')}">${esc((p.status||'').replace(/_/g,' '))}</span>
      </div>
      ${p.description?`<p class="muted sm" style="margin:12px 0 0">${esc(p.description)}</p>`:''}
      ${cancelling?`<div class="db-warn">Scheduled to cancel on <strong>${fmtDate(p.cancels_at)}</strong>${days!=null?` — ${days} day${days===1?'':'s'} from now`:''}. Your service continues until then, and you can reinstate any time before that date.</div>`:''}
      ${needsSig?`<div class="db-info">Waiting on your signature. Open your Agreements tab to review and sign, then add a payment method to start.</div>`:''}
      ${needsPm?`<div class="db-info">Signed — now add a payment method on the Payments tab and this plan will activate.</div>`:''}
      ${p.next_charge_date && p.status==='active'?`<div class="list-item" style="padding:12px 0 0"><div class="muted sm">Next payment</div><div class="mono sm">${fmtDate(p.next_charge_date)}</div></div>`:''}
      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        ${cancelling
          ? `<button class="btn btn-primary" onclick="reinstatePlan(${p.id})">Reinstate this plan</button>`
          : (p.status==='active' || p.status==='past_due')
            ? `<button class="btn" onclick="openCancel(${p.id})">Cancel plan</button>` : ''}
      </div></div>`;
  }).join('');

  main.innerHTML = `<div class="page-title">Plans</div>
    <div class="page-sub">Your recurring maintenance plans. Cancel any time — cancellation takes effect ${PLAN_NOTICE} days after you ask.</div>
    ${cards}`;
}

function updatePlanBadge(){
  const b = document.getElementById('planBadge');
  if(!b) return;
  const n = PLANS.filter(p=>['pending_signature','pending_payment_method','pending_cancellation','past_due'].includes(p.status)).length;
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
}

function openCancel(planId){
  const plan = PLANS.find(p=>p.id===planId) || {};
  let m = document.getElementById('cancelModal');
  if(m) m.remove();
  m = document.createElement('div');
  m.id = 'cancelModal'; m.className = 'db-modal';
  m.innerHTML = `<div class="db-modal-box">
      <h3 style="margin:0 0 4px">Cancel ${esc(plan.label||'this plan')}?</h3>
      <p class="muted sm" style="margin:0 0 4px">This plan has a ${PLAN_NOTICE}-day notice period.</p>
      <div class="db-info">You'll keep full service until the end of the notice period, and you'll be billed as normal until then. You can reinstate any time before it ends.</div>
      <div class="db-field">
        <label>Anything we could have done better? (optional)</label>
        <input id="cxReason" placeholder="Helps us improve — not required">
      </div>
      <div id="cxErr" class="db-warn" style="display:none"></div>
      <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
        <button class="btn" onclick="document.getElementById('cancelModal').remove()">Keep my plan</button>
        <button class="btn btn-primary" id="cxGo">Confirm cancellation</button>
      </div></div>`;
  document.body.appendChild(m);

  document.getElementById('cxGo').onclick = async ()=>{
    const btn = document.getElementById('cxGo');
    btn.disabled = true; btn.textContent = 'Cancelling…';
    const d = await ppost(`/api/portal/maintenance-plans/${planId}/cancel`,
                          { reason: (document.getElementById('cxReason')||{}).value || null });
    if(d.success){ m.remove(); dbToast(d.message || 'Cancellation confirmed.'); viewPlans(); return; }
    const e = document.getElementById('cxErr');
    e.style.display='block'; e.textContent = d.message || 'Could not cancel.';
    btn.disabled = false; btn.textContent = 'Confirm cancellation';
  };
}

async function reinstatePlan(planId){
  const d = await ppost(`/api/portal/maintenance-plans/${planId}/reinstate`);
  dbToast(d.message || (d.success?'Reinstated.':'Could not reinstate.'), !d.success);
  viewPlans();
}

/* ---------------- SIGNING ---------------- */
function openSign(agreementId){
  const a = (DASH.salesAgreements||[]).find(x=>x.id===agreementId);
  if(!a) return dbToast('Agreement not found.', true);
  const price = Number(a.price||0);

  let m = document.getElementById('signModal');
  if(m) m.remove();
  m = document.createElement('div');
  m.id = 'signModal'; m.className = 'db-modal';
  m.innerHTML = `<div class="db-modal-box">
      <h3 style="margin:0 0 4px">${esc(a.package_name || 'Service agreement')}</h3>
      <p class="muted sm" style="margin:0 0 14px">${esc(a.agreement_number||'')} · ${money(price)}${a.est_completion_date?` · estimated completion ${fmtDate(a.est_completion_date)}`:''}</p>
      ${a.intro?`<p class="muted sm" style="margin:0 0 12px">${esc(a.intro)}</p>`:''}
      <label style="display:block;font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#888;margin-bottom:6px">Terms</label>
      <div class="db-terms">${esc(a.terms || 'No additional terms were attached to this agreement.')}</div>

      <div class="db-field" style="margin-top:18px">
        <label>Type your full legal name to sign</label>
        <input id="sgName" placeholder="Your full name" autocomplete="name">
      </div>
      <div class="db-sign-pad" id="sgPad"><span class="muted">Your signature appears here as you type</span></div>

      <label class="db-consent">
        <input type="checkbox" id="sgAgree">
        <span>I have read and agree to the terms above, and I consent to signing this agreement electronically. I understand this is legally binding.</span>
      </label>

      <div class="db-info" style="margin-top:0">On signing, we'll create your project timeline and an invoice due at the estimated completion date. Nothing is charged today.</div>
      <div id="sgErr" class="db-warn" style="display:none"></div>
      <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
        <button class="btn" onclick="document.getElementById('signModal').remove()">Cancel</button>
        <button class="btn btn-primary" id="sgGo">Sign agreement</button>
      </div></div>`;
  document.body.appendChild(m);

  const nameEl = document.getElementById('sgName');
  const pad = document.getElementById('sgPad');
  /* Mirrors the server's generator so the preview matches the signature that
     actually gets stored. Same name in, same mark out. */
  function preview(name){
    const clean = (name||'').trim().slice(0,48);
    if(!clean){ pad.innerHTML = '<span class="muted">Your signature appears here as you type</span>'; return; }
    let seed = 0;
    for(let i=0;i<clean.length;i++) seed = (seed*31 + clean.charCodeAt(i)) % 100000;
    const rand = ()=>{ seed = (seed*1103515245 + 12345) % 2147483648; return seed/2147483648; };
    const W=420,H=110,base=74, pts=[], segs=26;
    for(let i=0;i<=segs;i++){
      const t=i/segs, x=24+t*(W-60);
      const y=base+12+Math.sin(t*Math.PI*3+rand()*0.4)*5+Math.sin(t*Math.PI*7)*1.6;
      pts.push(x.toFixed(1)+','+y.toFixed(1));
    }
    pad.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <text x="28" y="${base}" font-family="'Segoe Script','Brush Script MT','Lucida Handwriting',cursive" font-size="40" fill="#fff">${esc(clean)}</text>
      <polyline points="${pts.join(' ')}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.75"/></svg>`;
  }
  nameEl.addEventListener('input', ()=>preview(nameEl.value));
  nameEl.focus();

  document.getElementById('sgGo').onclick = async ()=>{
    const err = document.getElementById('sgErr');
    const name = nameEl.value.trim();
    const agree = document.getElementById('sgAgree').checked;
    if(name.length < 2){
      err.style.display='block'; err.textContent='Type your full name to sign.'; return;
    }
    if(!agree){
      err.style.display='block'; err.textContent='Please check the box to agree to the terms.'; return;
    }
    const btn = document.getElementById('sgGo');
    btn.disabled = true; btn.textContent = 'Signing…';
    const d = await ppost(`/api/portal/sales-agreements/${agreementId}/sign`, { typedName: name, agree: true });
    if(!d.success){
      err.style.display='block'; err.textContent = d.message || 'Could not sign.';
      btn.disabled = false; btn.textContent = 'Sign agreement';
      return;
    }
    m.remove();
    const inv = d.invoice;
    dbToast(inv ? `Signed. Invoice ${inv.number} is in your portal, due ${fmtDate(inv.dueDate)}.` : 'Signed.');
    if(typeof loadAll === 'function'){ await loadAll(); }
    nav('projects');
  };
}
</script>
'''


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    p = root / 'customer_portal.html'
    s = p.read_text(encoding='utf-8', errors='replace')
    report = []

    if MARKER in s:
        print('customer_portal.html: already patched')
        return 0

    # 1. nav links
    if s.count(NAV_ANCHOR) == 1:
        s = s.replace(NAV_ANCHOR, NAV_NEW, 1)
        report.append('nav links: added Payments + Plans')
    else:
        report.append(f'nav links: FAILED (anchor x{s.count(NAV_ANCHOR)})')

    # 2. dispatch
    if s.count(DISPATCH_OLD) == 1:
        s = s.replace(DISPATCH_OLD, DISPATCH_NEW, 1)
        report.append('nav dispatch: wired')
    else:
        report.append(f'nav dispatch: FAILED (anchor x{s.count(DISPATCH_OLD)})')

    # 3. sign button on agreement cards
    if s.count(SIGN_BTN_OLD) == 1:
        s = s.replace(SIGN_BTN_OLD, SIGN_BTN_NEW, 1)
        report.append('sign button: added to agreement cards')
    else:
        report.append(f'sign button: FAILED (anchor x{s.count(SIGN_BTN_OLD)})')

    # 4. styles before the REAL </head>
    #
    # These portal files build printable HTML documents inside JS template
    # literals, and those literals contain their own </head> and </body> tags.
    # A naive .replace('</body>', ...) hits the one inside the string literal
    # and injects the whole script block into the middle of JavaScript, which
    # breaks the entire file. So: first </head> (the print literals appear
    # later, inside the body), last </body>.
    i = s.find('</head>')
    if i != -1:
        s = s[:i] + STYLES + s[i:]
        report.append('styles: injected before first </head>')
    else:
        report.append('styles: FAILED (no </head>)')

    # 5. scripts before the LAST </body> — the real one
    j = s.rfind('</body>')
    if j != -1:
        s = s[:j] + SCRIPTS + s[j:]
        report.append(f'scripts: injected before last </body> (of {s.count("</body>")} total)')
    else:
        report.append('scripts: FAILED (no </body>)')

    p.write_text(s, encoding='utf-8')
    print('\n'.join('  ' + r for r in report))
    return 1 if any('FAILED' in r for r in report) else 0


if __name__ == '__main__':
    sys.exit(main())