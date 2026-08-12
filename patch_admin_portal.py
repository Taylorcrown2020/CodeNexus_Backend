#!/usr/bin/env python3
"""
patch_admin_portal.py — add the missing admin screens.

  * Maintenance tab   — create/see monthly, Brevo and database plans, MRR,
                        pending cancellations with days remaining
  * Past Due tab      — the dunning ladder's state per invoice
  * Payment log       — per-customer payments with refunds, openable from
                        anywhere via dbPaymentLog(leadId, name)
  * Refunds           — full or partial, with a reason, straight to Stripe
  * Notifications     — the lifecycle bell (failed charges, cancellations,
                        signatures, escalations)

Follows the file's existing conventions: nav-item[data-section], the
renderSection switch, #contentArea, and the api()/showToast() helpers.

Idempotent.
"""

import sys
import pathlib

MARKER = 'db-admin-billing'

# ------------------------------------------------------------------ nav items
NAV_ANCHOR = '''            <div class="nav-item" data-section="subscriptions">'''

NAV_NEW = '''            <div class="nav-item" data-section="maintenance">
                <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="23 4 23 10 17 10"/>
                </svg>
                Maintenance
                <span class="nav-badge" id="maintenanceBadge" style="display:none;">0</span>
            </div>
            <div class="nav-item" data-section="pastdue">
                <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                Past Due
                <span class="nav-badge" id="pastDueBadge" style="display:none;">0</span>
            </div>
            <div class="nav-item" data-section="notifications">
                <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                Notifications
                <span class="nav-badge" id="lifecycleBadge" style="display:none;">0</span>
            </div>
''' + NAV_ANCHOR

# ------------------------------------------------------------ render dispatch
DISPATCH_ANCHOR = """        case 'subscriptions':
            renderSubscriptions(content);
            break;"""

DISPATCH_NEW = """        case 'subscriptions':
            renderSubscriptions(content);
            break;

        case 'maintenance':
            renderMaintenance(content);
            break;

        case 'pastdue':
            renderPastDue(content);
            break;

        case 'notifications':
            renderLifecycleNotifications(content);
            break;"""

# --------------------------------------------------------------------- titles
TITLE_ANCHOR = """        followups: 'Follow-Up Queue',"""
TITLE_NEW = """        followups: 'Follow-Up Queue',
        maintenance: 'Maintenance Plans',
        pastdue: 'Past Due',
        notifications: 'Notifications',"""

STYLES = '''
<style id="db-admin-billing-css">
/* Billing/admin screens. Uses the portal's own tokens; adds layout only. */
.dbm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:22px}
.dbm-stat{background:var(--dark-secondary,#1a1a1a);border:1px solid rgba(255,255,255,.07);
  border-radius:10px;padding:16px 18px}
.dbm-stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#8a8a8a;margin-bottom:7px}
.dbm-stat .v{font-size:23px;font-weight:800;color:#fff;line-height:1.1}
.dbm-stat.warn .v{color:#eab308}.dbm-stat.bad .v{color:#ef4444}.dbm-stat.good .v{color:#10b981}
.dbm-table{width:100%;border-collapse:collapse;font-size:13px}
.dbm-table th{text-align:left;padding:11px 12px;font-size:11px;text-transform:uppercase;
  letter-spacing:.6px;color:#8a8a8a;border-bottom:1px solid rgba(255,255,255,.09);font-weight:700}
.dbm-table td{padding:13px 12px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}
.dbm-table tr:last-child td{border-bottom:none}
.dbm-table tbody tr:hover{background:rgba(255,255,255,.02)}
.dbm-pill{display:inline-block;padding:3px 9px;border-radius:5px;font-size:10px;font-weight:800;
  text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.dbm-pill.active,.dbm-pill.succeeded,.dbm-pill.paid{background:rgba(16,185,129,.15);color:#10b981}
.dbm-pill.pending,.dbm-pill.pending_signature,.dbm-pill.pending_payment_method,
.dbm-pill.pending_cancellation,.dbm-pill.partially_refunded{background:rgba(234,179,8,.15);color:#eab308}
.dbm-pill.past_due,.dbm-pill.failed,.dbm-pill.escalated,.dbm-pill.refunded,
.dbm-pill.cancelled{background:rgba(239,68,68,.15);color:#ef4444}
.dbm-modal{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:flex-start;
  justify-content:center;z-index:9999;padding:36px 18px;overflow-y:auto}
.dbm-modal-box{background:#141414;border:1px solid rgba(255,255,255,.1);border-radius:12px;
  max-width:720px;width:100%;padding:26px}
.dbm-f{margin:13px 0}
.dbm-f label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#8a8a8a;margin-bottom:6px}
.dbm-f input,.dbm-f select,.dbm-f textarea{width:100%;padding:11px 13px;background:#0a0a0a;
  border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#fff;font:inherit;font-size:14px}
.dbm-f input:focus,.dbm-f select:focus,.dbm-f textarea:focus{outline:none;border-color:#10b981}
.dbm-r{display:flex;gap:13px;flex-wrap:wrap}.dbm-r>*{flex:1;min-width:150px}
.dbm-note{background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.25);border-radius:8px;
  padding:12px 15px;font-size:13px;line-height:1.55;color:#6ee7b7;margin:13px 0}
.dbm-alert{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:8px;
  padding:12px 15px;font-size:13px;line-height:1.55;color:#fca5a5;margin:13px 0}
.dbm-empty{padding:34px 20px;text-align:center;color:#8a8a8a;font-size:14px;line-height:1.6}
.dbm-refund{font-size:11px;color:#fca5a5;margin-top:4px}
.dbm-notif{display:flex;gap:13px;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.dbm-notif:last-child{border-bottom:none}
.dbm-notif.unread{background:rgba(16,185,129,.03)}
.dbm-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:6px;background:#333}
.dbm-dot.info{background:#3b82f6}.dbm-dot.success{background:#10b981}
.dbm-dot.warning{background:#eab308}.dbm-dot.error{background:#ef4444}
.dbm-ladder{display:flex;gap:3px;margin-top:5px}
.dbm-ladder i{width:11px;height:5px;border-radius:2px;background:#2a2a2a;display:block}
.dbm-ladder i.on{background:#eab308}.dbm-ladder i.max{background:#ef4444}
</style>
'''

SCRIPTS = r'''
<script id="db-admin-billing">
/* =====================================================================
   Admin billing screens: maintenance plans, past due, payment log,
   refunds, lifecycle notifications.
   ===================================================================== */
const DBM = { plans:[], planSummary:null, pastDue:null, notifications:[] };

function dbmToken(){
  return localStorage.getItem('adminToken') || localStorage.getItem('token') ||
         sessionStorage.getItem('adminToken') || '';
}
async function dbmGet(path){
  const r = await fetch(path, { headers:{ 'Authorization':'Bearer ' + dbmToken() }});
  if(!r.ok) throw new Error('Request failed (' + r.status + ')');
  return r.json();
}
async function dbmSend(path, body, method){
  const r = await fetch(path, {
    method: method || 'POST',
    headers:{ 'Authorization':'Bearer ' + dbmToken(), 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let d = {}; try { d = await r.json(); } catch(_) {}
  if(!r.ok && d.message === undefined) d.message = 'Request failed (' + r.status + ')';
  return d;
}
function dbmNote(msg, type){
  if(typeof showToast === 'function') return showToast(msg, type || 'success');
  if(typeof showNotification === 'function') return showNotification(msg, type || 'success');
  alert(msg);
}
function dbmEsc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function dbmMoney(n){ return '$' + Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function dbmDate(d){
  if(!d) return '—';
  return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function dbmClose(id){ const e=document.getElementById(id); if(e) e.remove(); }

/* ---------------- MAINTENANCE ---------------- */
async function renderMaintenance(content){
  content.innerHTML = `<div class="dbm-empty">Loading maintenance plans…</div>`;
  try{
    const d = await dbmGet('/api/admin/maintenance-plans');
    DBM.plans = d.plans || []; DBM.planSummary = d.summary || {};
  }catch(e){
    content.innerHTML = `<div class="dbm-alert">Couldn't load maintenance plans. ${dbmEsc(e.message)}</div>`;
    return;
  }
  const s = DBM.planSummary || {};
  dbmUpdateBadge('maintenanceBadge', (s.cancelling||0) + (s.pastDue||0));

  const rows = DBM.plans.length ? DBM.plans.map(p=>{
    const method = p.last4 ? `${dbmEsc(p.brand||p.method_type||'card')} ····${dbmEsc(p.last4)}` : '<span style="color:#eab308">none</span>';
    const cancelNote = p.days_until_cancellation != null
      ? `<div class="dbm-refund">Cancels in ${p.days_until_cancellation} day${p.days_until_cancellation===1?'':'s'} (${dbmDate(p.cancels_at)})</div>` : '';
    return `<tr>
      <td>
        <div style="font-weight:700;color:#fff">${dbmEsc(p.customer_name||'—')}</div>
        <div style="color:#8a8a8a;font-size:12px">${dbmEsc(p.customer_email||'')}</div>
      </td>
      <td>
        <div>${dbmEsc(p.label)}</div>
        <div style="color:#8a8a8a;font-size:12px">${dbmEsc(String(p.plan_type||'').replace(/_/g,' '))}</div>
        ${cancelNote}
      </td>
      <td><strong style="color:#10b981">${dbmMoney(p.amount)}</strong><div style="color:#8a8a8a;font-size:12px">day ${dbmEsc(String(p.billing_day))}</div></td>
      <td><span class="dbm-pill ${dbmEsc(p.status)}">${dbmEsc(String(p.status||'').replace(/_/g,' '))}</span></td>
      <td>${p.status==='active'?dbmDate(p.next_charge_date):'—'}</td>
      <td>${method}</td>
      <td>${dbmMoney(p.collected)}<div style="color:#8a8a8a;font-size:12px">${p.charges_completed||0} charge${Number(p.charges_completed)===1?'':'s'}</div></td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" onclick="dbPaymentLog(${p.lead_id}, '${dbmEsc(String(p.customer_name||'').replace(/'/g,''))}')">Payments</button>
      </td></tr>`;
  }).join('') : '';

  content.innerHTML = `
    <div class="dbm-grid">
      <div class="dbm-stat good"><div class="l">Recurring revenue</div><div class="v">${dbmMoney(s.mrr)}</div></div>
      <div class="dbm-stat"><div class="l">Active plans</div><div class="v">${s.active||0}</div></div>
      <div class="dbm-stat warn"><div class="l">Cancelling</div><div class="v">${s.cancelling||0}</div></div>
      <div class="dbm-stat bad"><div class="l">Past due</div><div class="v">${s.pastDue||0}</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0;font-size:17px">Plans</h2>
      <button class="btn btn-primary" onclick="dbmNewPlan()">Set up a plan</button>
    </div>
    ${rows ? `<div style="overflow-x:auto"><table class="dbm-table">
        <thead><tr><th>Customer</th><th>Plan</th><th>Amount</th><th>Status</th><th>Next charge</th><th>Method</th><th>Collected</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<div class="dbm-empty">No maintenance plans yet.<br>Set one up and the customer gets an agreement to sign, then autopay starts once they add a payment method.</div>`}
  `;
}

function dbmUpdateBadge(id, n){
  const b = document.getElementById(id);
  if(!b) return;
  b.textContent = n;
  b.style.display = n > 0 ? '' : 'none';
}

async function dbmNewPlan(){
  /* Customer list comes from whatever the portal already loaded, so this works
     without another endpoint. Falls back to a manual lead id. */
  let customers = [];
  try{
    const src = (typeof state !== 'undefined' && state.leads) ? state.leads : [];
    customers = src.filter(l => l.is_customer && l.client_password);
    if(!customers.length) customers = src.filter(l => l.is_customer);
  }catch(_){}

  const options = customers.length
    ? customers.map(c=>`<option value="${c.id}">${dbmEsc(c.name)} — ${dbmEsc(c.email)}</option>`).join('')
    : '';

  let m = document.getElementById('dbmPlanModal');
  if(m) m.remove();
  m = document.createElement('div');
  m.id = 'dbmPlanModal'; m.className = 'dbm-modal';
  m.innerHTML = `<div class="dbm-modal-box">
    <h2 style="margin:0 0 4px;font-size:19px">Set up a maintenance plan</h2>
    <p style="color:#8a8a8a;font-size:13px;margin:0 0 4px">The customer gets an agreement to sign, then adds a payment method. Autopay begins once both are done.</p>
    <div class="dbm-f">
      <label>Customer</label>
      ${options ? `<select id="mpLead">${options}</select>`
                : `<input id="mpLead" placeholder="Customer lead ID" inputmode="numeric">
                   <div style="color:#8a8a8a;font-size:12px;margin-top:5px">Open the Customers tab first to load the list.</div>`}
    </div>
    <div class="dbm-r">
      <div class="dbm-f">
        <label>Plan type</label>
        <select id="mpType">
          <option value="monthly_maintenance">Monthly maintenance</option>
          <option value="brevo_maintenance">Brevo maintenance</option>
          <option value="database_maintenance">Database maintenance</option>
        </select>
      </div>
      <div class="dbm-f">
        <label>Amount per month (USD)</label>
        <input id="mpAmount" inputmode="decimal" placeholder="299.00">
      </div>
    </div>
    <div class="dbm-r">
      <div class="dbm-f">
        <label>Bills on day of month</label>
        <input id="mpDay" inputmode="numeric" value="1">
        <div style="color:#8a8a8a;font-size:12px;margin-top:5px">29–31 bill on the last day of shorter months.</div>
      </div>
      <div class="dbm-f">
        <label>Label shown to the customer</label>
        <input id="mpLabel" placeholder="Monthly Maintenance">
      </div>
    </div>
    <div class="dbm-f">
      <label>What's included (optional)</label>
      <textarea id="mpDesc" rows="3" placeholder="Monthly updates, backups, uptime monitoring and up to 2 hours of changes."></textarea>
    </div>
    <label style="display:flex;gap:9px;align-items:flex-start;font-size:13px;color:#b4b4b4;margin:6px 0 0">
      <input type="checkbox" id="mpInvoice" style="margin-top:3px;accent-color:#10b981">
      <span>Also generate an invoice each month. Off by default — autopay sends a receipt instead, so there's no invoice to chase.</span>
    </label>
    <div id="mpErr" class="dbm-alert" style="display:none"></div>
    <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end">
      <button class="btn" onclick="dbmClose('dbmPlanModal')">Cancel</button>
      <button class="btn btn-primary" id="mpGo">Create plan &amp; send agreement</button>
    </div></div>`;
  document.body.appendChild(m);

  document.getElementById('mpGo').onclick = async ()=>{
    const err = document.getElementById('mpErr');
    const leadId = (document.getElementById('mpLead')||{}).value;
    const amount = parseFloat((document.getElementById('mpAmount')||{}).value);
    const day = parseInt((document.getElementById('mpDay')||{}).value, 10);
    if(!leadId){ err.style.display='block'; err.textContent='Choose a customer.'; return; }
    if(!amount || amount <= 0){ err.style.display='block'; err.textContent='Enter a monthly amount greater than zero.'; return; }
    if(!day || day < 1 || day > 31){ err.style.display='block'; err.textContent='Billing day must be between 1 and 31.'; return; }

    const btn = document.getElementById('mpGo');
    btn.disabled = true; btn.textContent = 'Creating…';
    const d = await dbmSend('/api/admin/maintenance-plans', {
      leadId, planType: document.getElementById('mpType').value,
      label: (document.getElementById('mpLabel')||{}).value || null,
      description: (document.getElementById('mpDesc')||{}).value || null,
      amount, billingDay: day,
      generateInvoice: document.getElementById('mpInvoice').checked,
      sendAgreement: true
    });
    if(!d.success){
      err.style.display='block'; err.textContent = d.message || 'Could not create the plan.';
      btn.disabled = false; btn.textContent = 'Create plan & send agreement';
      return;
    }
    dbmClose('dbmPlanModal');
    dbmNote(d.message || 'Plan created.');
    renderMaintenance(document.getElementById('contentArea'));
  };
}

/* ---------------- PAST DUE ---------------- */
async function renderPastDue(content){
  content.innerHTML = `<div class="dbm-empty">Loading past-due invoices…</div>`;
  let d;
  try{
    d = await dbmGet('/api/admin/past-due');
    DBM.pastDue = d;
  }catch(e){
    content.innerHTML = `<div class="dbm-alert">Couldn't load past-due invoices. ${dbmEsc(e.message)}</div>`;
    return;
  }
  dbmUpdateBadge('pastDueBadge', d.count || 0);

  const rows = (d.invoices||[]).map(i=>{
    const days = Number(i.days_overdue);
    const day = Number(i.dunning_day||0);
    const maxDay = d.maxDay || 10;
    /* Ten pips: how far the reminder ladder has run for this invoice. */
    let ladder = '';
    for(let k=1;k<=maxDay;k++){
      ladder += `<i class="${k<=day?(k===maxDay?'max':'on'):''}"></i>`;
    }
    return `<tr>
      <td>
        <div style="font-weight:700;color:#fff">${dbmEsc(i.name||'—')}</div>
        <div style="color:#8a8a8a;font-size:12px">${dbmEsc(i.email||'')}</div>
      </td>
      <td><div style="font-family:monospace">${dbmEsc(i.invoice_number)}</div></td>
      <td><strong style="color:#ef4444">${dbmMoney(i.total_amount)}</strong></td>
      <td>${dbmDate(i.due_date)}</td>
      <td><strong style="color:${days>maxDay?'#ef4444':'#eab308'}">${days} day${days===1?'':'s'}</strong></td>
      <td>
        <span class="dbm-pill ${dbmEsc(i.dunning_status||'pending')}">${dbmEsc(i.dunning_status||'none')}</span>
        <div class="dbm-ladder" title="Reminder day ${day} of ${maxDay}">${ladder}</div>
        <div style="color:#8a8a8a;font-size:11px;margin-top:4px">${i.reminder_count||0} sent${i.last_reminder_at?' · last '+dbmDate(i.last_reminder_at):''}</div>
      </td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" onclick="dbPaymentLog(${i.lead_id}, '${dbmEsc(String(i.name||'').replace(/'/g,''))}')">Payments</button>
      </td></tr>`;
  }).join('');

  content.innerHTML = `
    <div class="dbm-grid">
      <div class="dbm-stat bad"><div class="l">Past due invoices</div><div class="v">${d.count||0}</div></div>
      <div class="dbm-stat bad"><div class="l">Total owed</div><div class="v">${dbmMoney(d.totalOwed)}</div></div>
      <div class="dbm-stat warn"><div class="l">In reminder window</div><div class="v">${(d.buckets&&d.buckets.days1_10)||0}</div></div>
      <div class="dbm-stat bad"><div class="l">Escalated</div><div class="v">${(d.buckets&&d.buckets.escalated)||0}</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0;font-size:17px">Past due</h2>
      <button class="btn" onclick="dbmRunDunning()">Run reminders now</button>
    </div>
    <div class="dbm-note">Reminders run automatically once a day for ${d.maxDay||10} days after an invoice's due date, then the invoice is escalated for manual follow-up. Invoices whose due date is still just an estimate are never chased.</div>
    ${rows ? `<div style="overflow-x:auto"><table class="dbm-table">
        <thead><tr><th>Customer</th><th>Invoice</th><th>Amount</th><th>Due</th><th>Overdue</th><th>Reminders</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<div class="dbm-empty">Nothing past due. Every invoice with a firm due date is current.</div>`}
  `;
}

async function dbmRunDunning(){
  dbmNote('Running reminders…');
  const d = await dbmSend('/api/admin/dunning/run');
  if(d.success){
    const r = d.results || {};
    dbmNote(`Done — ${r.sent||0} reminder${r.sent===1?'':'s'} sent, ${r.escalated||0} escalated.`);
    renderPastDue(document.getElementById('contentArea'));
  } else {
    dbmNote(d.message || 'Could not run reminders.', 'error');
  }
}

/* ---------------- PAYMENT LOG + REFUNDS ---------------- */
/* Callable from any customer row: dbPaymentLog(leadId, name) */
async function dbPaymentLog(leadId, name){
  let m = document.getElementById('dbmPayModal');
  if(m) m.remove();
  m = document.createElement('div');
  m.id = 'dbmPayModal'; m.className = 'dbm-modal';
  m.innerHTML = `<div class="dbm-modal-box"><div class="dbm-empty">Loading payments…</div></div>`;
  document.body.appendChild(m);

  let d;
  try{
    d = await dbmGet('/api/admin/customers/' + leadId + '/payments');
  }catch(e){
    m.querySelector('.dbm-modal-box').innerHTML =
      `<div class="dbm-alert">Couldn't load the payment log. ${dbmEsc(e.message)}</div>
       <div style="text-align:right;margin-top:14px"><button class="btn" onclick="dbmClose('dbmPayModal')">Close</button></div>`;
    return;
  }

  const s = d.summary || {};
  const rows = (d.payments||[]).map(p=>{
    const refunds = Array.isArray(p.refunds) ? p.refunds : [];
    const refunded = Number(p.refunded_amount||0);
    const refundable = Number(p.amount) - refunded;
    const label = p.invoice_number ? ('Invoice ' + p.invoice_number) : (p.description || p.kind || 'Payment');
    const method = p.method_last4 ? `${dbmEsc(p.method_brand||p.method||'card')} ····${dbmEsc(p.method_last4)}` : dbmEsc(p.method||'—');
    return `<tr>
      <td>
        <div style="color:#fff">${dbmEsc(label)}</div>
        <div style="color:#8a8a8a;font-size:12px">${dbmDate(p.paid_at)} · ${method}</div>
        <div style="color:#8a8a8a;font-size:11px;font-family:monospace">${dbmEsc(p.receipt_number||'')}</div>
        ${refunds.map(r=>`<div class="dbm-refund">− ${dbmMoney(r.amount)} refunded ${dbmDate(r.created_at)}${r.reason?(' · '+dbmEsc(r.reason)):''}</div>`).join('')}
      </td>
      <td><strong>${dbmMoney(p.amount)}</strong>${refunded>0?`<div style="color:#8a8a8a;font-size:12px">net ${dbmMoney(refundable)}</div>`:''}</td>
      <td><span class="dbm-pill ${dbmEsc(p.status)}">${dbmEsc(String(p.status||'').replace(/_/g,' '))}</span></td>
      <td style="white-space:nowrap">
        ${refundable > 0.001 && p.status !== 'failed'
          ? `<button class="btn btn-sm" onclick="dbmRefund(${p.id}, ${refundable.toFixed(2)}, ${leadId}, '${dbmEsc(String(name||'').replace(/'/g,''))}')">Refund</button>`
          : '<span style="color:#8a8a8a;font-size:12px">—</span>'}
      </td></tr>`;
  }).join('');

  m.querySelector('.dbm-modal-box').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:6px">
      <div>
        <h2 style="margin:0;font-size:19px">Payments — ${dbmEsc(name||'Customer')}</h2>
        <p style="color:#8a8a8a;font-size:13px;margin:4px 0 0">${s.paymentCount||0} payment${s.paymentCount===1?'':'s'} on record</p>
      </div>
      <button class="btn" onclick="dbmClose('dbmPayModal')">Close</button>
    </div>
    <div class="dbm-grid" style="margin:18px 0">
      <div class="dbm-stat good"><div class="l">Collected</div><div class="v">${dbmMoney(s.gross)}</div></div>
      ${Number(s.refunded)>0?`<div class="dbm-stat bad"><div class="l">Refunded</div><div class="v">${dbmMoney(s.refunded)}</div></div>`:''}
      <div class="dbm-stat"><div class="l">Net</div><div class="v">${dbmMoney(s.net)}</div></div>
      <div class="dbm-stat ${Number(s.openInvoices)>0?'warn':''}"><div class="l">Open invoices</div><div class="v">${s.openInvoices||0}</div>
        ${Number(s.openAmount)>0?`<div style="color:#8a8a8a;font-size:12px;margin-top:4px">${dbmMoney(s.openAmount)}</div>`:''}</div>
    </div>
    ${rows ? `<div style="overflow-x:auto"><table class="dbm-table">
        <thead><tr><th>Payment</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<div class="dbm-empty">No payments recorded for this customer yet.</div>`}
  `;
}

function dbmRefund(paymentId, maxAmount, leadId, name){
  let m = document.getElementById('dbmRefundModal');
  if(m) m.remove();
  m = document.createElement('div');
  m.id = 'dbmRefundModal'; m.className = 'dbm-modal';
  m.style.zIndex = '10000';
  m.innerHTML = `<div class="dbm-modal-box" style="max-width:480px">
    <h2 style="margin:0 0 4px;font-size:19px">Issue a refund</h2>
    <p style="color:#8a8a8a;font-size:13px;margin:0 0 4px">Up to ${dbmMoney(maxAmount)} can be refunded on this payment.</p>
    <div class="dbm-alert">This sends money back through Stripe immediately and cannot be undone. Card refunds reach the customer in 5–10 business days.</div>
    <div class="dbm-f">
      <label>Amount to refund (USD)</label>
      <input id="rfAmount" inputmode="decimal" value="${Number(maxAmount).toFixed(2)}">
    </div>
    <div class="dbm-f">
      <label>Reason (shown to the customer)</label>
      <input id="rfReason" placeholder="e.g. Scope reduced by agreement">
    </div>
    <div id="rfErr" class="dbm-alert" style="display:none"></div>
    <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
      <button class="btn" onclick="dbmClose('dbmRefundModal')">Cancel</button>
      <button class="btn btn-primary" id="rfGo">Issue refund</button>
    </div></div>`;
  document.body.appendChild(m);

  document.getElementById('rfGo').onclick = async ()=>{
    const err = document.getElementById('rfErr');
    const amt = parseFloat(document.getElementById('rfAmount').value);
    if(!amt || amt <= 0){ err.style.display='block'; err.textContent='Enter an amount greater than zero.'; return; }
    if(amt > Number(maxAmount) + 0.001){
      err.style.display='block'; err.textContent=`That's more than the ${dbmMoney(maxAmount)} still refundable.`; return;
    }
    const btn = document.getElementById('rfGo');
    btn.disabled = true; btn.textContent = 'Issuing…';
    const d = await dbmSend('/api/admin/payments/' + paymentId + '/refund',
                            { amount: amt, reason: document.getElementById('rfReason').value || null });
    if(!d.success){
      err.style.display='block'; err.textContent = d.message || 'Refund failed.';
      btn.disabled = false; btn.textContent = 'Issue refund';
      return;
    }
    dbmClose('dbmRefundModal');
    dbmNote(d.message || 'Refund issued.');
    dbPaymentLog(leadId, name);
  };
}

/* ---------------- NOTIFICATIONS ---------------- */
async function renderLifecycleNotifications(content){
  content.innerHTML = `<div class="dbm-empty">Loading notifications…</div>`;
  let d;
  try{
    d = await dbmGet('/api/admin/lifecycle-notifications');
    DBM.notifications = d.notifications || [];
  }catch(e){
    content.innerHTML = `<div class="dbm-alert">Couldn't load notifications. ${dbmEsc(e.message)}</div>`;
    return;
  }
  dbmUpdateBadge('lifecycleBadge', d.unreadCount || 0);

  const rows = DBM.notifications.length ? DBM.notifications.map(n=>`
    <div class="dbm-notif ${n.is_read?'':'unread'}">
      <span class="dbm-dot ${dbmEsc(n.severity||'info')}"></span>
      <div style="flex:1">
        <div style="color:#fff;font-size:14px;font-weight:600">${dbmEsc(n.title)}</div>
        ${n.body?`<div style="color:#a0a0a0;font-size:13px;margin-top:3px;line-height:1.5">${dbmEsc(n.body)}</div>`:''}
        <div style="color:#6b6b6b;font-size:11px;margin-top:5px">
          ${dbmEsc(String(n.kind||'').replace(/_/g,' '))} · ${dbmDate(n.created_at)}
          ${n.lead_id?` · <a href="#" style="color:#10b981;text-decoration:none" onclick="dbPaymentLog(${n.lead_id},'Customer');return false;">payments</a>`:''}
        </div>
      </div>
    </div>`).join('') : '';

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0;font-size:17px">Notifications${d.unreadCount?` <span style="color:#10b981">(${d.unreadCount} new)</span>`:''}</h2>
      ${d.unreadCount?`<button class="btn" onclick="dbmMarkRead()">Mark all read</button>`:''}
    </div>
    ${rows ? `<div style="background:var(--dark-secondary,#1a1a1a);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:6px 18px">${rows}</div>`
      : `<div class="dbm-empty">Nothing to report. Failed charges, pending cancellations, new signatures and escalated invoices show up here.</div>`}
  `;
}

async function dbmMarkRead(){
  await dbmSend('/api/admin/lifecycle-notifications/read', {});
  renderLifecycleNotifications(document.getElementById('contentArea'));
}

/* Badge counts on load, so the sidebar is accurate before you visit a tab. */
async function dbmRefreshBadges(){
  try{
    const n = await dbmGet('/api/admin/lifecycle-notifications');
    dbmUpdateBadge('lifecycleBadge', n.unreadCount || 0);
  }catch(_){}
  try{
    const p = await dbmGet('/api/admin/past-due');
    dbmUpdateBadge('pastDueBadge', p.count || 0);
  }catch(_){}
  try{
    const m = await dbmGet('/api/admin/maintenance-plans');
    const s = m.summary || {};
    dbmUpdateBadge('maintenanceBadge', (s.cancelling||0) + (s.pastDue||0));
  }catch(_){}
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', ()=>setTimeout(dbmRefreshBadges, 1500));
} else {
  setTimeout(dbmRefreshBadges, 1500);
}
</script>
'''


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    p = root / 'admin_portal.html'
    s = p.read_text(encoding='utf-8', errors='replace')
    report = []

    if MARKER in s:
        print('admin_portal.html: already patched')
        return 0

    if s.count(NAV_ANCHOR) == 1:
        s = s.replace(NAV_ANCHOR, NAV_NEW, 1)
        report.append('nav: added Maintenance, Past Due, Notifications')
    else:
        report.append(f'nav: FAILED (anchor x{s.count(NAV_ANCHOR)})')

    if s.count(DISPATCH_ANCHOR) == 1:
        s = s.replace(DISPATCH_ANCHOR, DISPATCH_NEW, 1)
        report.append('renderSection: wired 3 cases')
    else:
        report.append(f'renderSection: FAILED (anchor x{s.count(DISPATCH_ANCHOR)})')

    if s.count(TITLE_ANCHOR) == 1:
        s = s.replace(TITLE_ANCHOR, TITLE_NEW, 1)
        report.append('titles: added')
    else:
        report.append(f'titles: FAILED (anchor x{s.count(TITLE_ANCHOR)})')

    # admin_portal.html contains THREE </head> and THREE </body> tags: one real
    # pair plus two inside JS template literals that build printable documents.
    # Replacing the first </body> injects the script into the middle of a
    # JavaScript string and breaks the file. Use first </head>, last </body>.
    i = s.find('</head>')
    if i != -1:
        s = s[:i] + STYLES + s[i:]
        report.append('styles: injected before first </head>')
    else:
        report.append('styles: FAILED (no </head>)')

    j = s.rfind('</body>')
    if j != -1:
        s = s[:j] + SCRIPTS + s[j:]
        report.append('scripts: injected before last </body>')
    else:
        report.append('scripts: FAILED (no </body>)')

    p.write_text(s, encoding='utf-8')
    print('\n'.join('  ' + r for r in report))
    return 1 if any('FAILED' in r for r in report) else 0


if __name__ == '__main__':
    sys.exit(main())