/* ==========================================================================
 * diamondback-agreement-view.js — Diamondback Coding
 *
 * Drop-in front end for the customer portal. Add ONE line to
 * customer_portal.html, just before </body>:
 *
 *     <script src="/js/diamondback-agreement-view.js"></script>
 *
 * It needs nothing else. No build step, no framework, no stylesheet changes.
 *
 * WHAT IT PROVIDES
 *
 *   DiamondbackAgreements.open(agreementId)
 *       Opens the full agreement in a reader. The whole document is rendered —
 *       every clause, nothing collapsed, nothing truncated. The sign controls
 *       stay disabled until the reader has actually been scrolled to the end,
 *       which is both fair to the customer and the strongest evidence you can
 *       hold that the document was displayed in full.
 *
 *   DiamondbackAgreements.download(agreementId)
 *   DiamondbackReceipts.download(paymentId)
 *   DiamondbackReceipts.downloadForInvoice(invoiceId)
 *       Authenticated downloads. A plain <a href> can't send the bearer token,
 *       which is why "Download Agreement" never worked — the browser requested
 *       the URL with no Authorization header and got a 401 that rendered as a
 *       broken file. These fetch with the header, then hand the browser a blob.
 *
 * AUTO-WIRING
 *   Any element carrying one of these attributes is wired automatically, now
 *   and for anything added to the page later:
 *
 *     data-db-sign="123"                 open agreement 123 to read and sign
 *     data-db-download-agreement="123"   download agreement 123 as PDF
 *     data-db-download-receipt="456"     download the receipt for payment 456
 *     data-db-receipt-for-invoice="789"  download the receipt for invoice 789
 *
 *   So in your existing markup you only need, e.g.:
 *     <button data-db-sign="123">Review &amp; sign</button>
 *     <button data-db-download-receipt="456">Download receipt</button>
 *
 * EVENTS
 *   window.addEventListener('db:agreement-signed', (e) => { ... })
 *       e.detail = { agreementId, kind, planActive, message }
 *   Use it to refresh your dashboard in place — no page reload needed, which is
 *   what makes the button flip from "Review & sign" to "Signed" immediately.
 * ========================================================================== */

(function () {
    'use strict';

    // ----------------------------------------------------------------------
    // Palette — identical values to diamondback-documents.js on the server.
    // Every pairing here is checked: nothing lighter than #5C646F ever sits on
    // white, and white only ever sits on near-black.
    // ----------------------------------------------------------------------
    var C = {
        PAPER: '#FFFFFF',
        PANEL: '#F4F5F7',
        EDGE: '#DCE0E6',
        INK: '#14171C',
        INK_STRONG: '#000000',
        INK_MUTED: '#5C646F',
        INVERSE: '#FFFFFF',
        POSITIVE: '#15803D',
        ATTENTION: '#A33A11',
        SCRIM: 'rgba(12,14,18,.55)'
    };

    var FONT = "'Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif";

    // ----------------------------------------------------------------------
    // Auth
    // ----------------------------------------------------------------------
    // The portal has stored its token under a few different keys across
    // rebuilds. Check all of them rather than assuming one.
    function token() {
        var keys = ['portalToken', 'portal_token', 'token', 'authToken', 'customerToken'];
        for (var i = 0; i < keys.length; i++) {
            var v = null;
            try { v = localStorage.getItem(keys[i]) || sessionStorage.getItem(keys[i]); } catch (e) { /* blocked */ }
            if (v) return v;
        }
        return null;
    }

    function authHeaders(extra) {
        var h = extra || {};
        var t = token();
        if (t) h.Authorization = 'Bearer ' + t;
        return h;
    }

    function api(path, opts) {
        opts = opts || {};
        opts.headers = authHeaders(opts.headers || {});
        if (opts.body && !opts.headers['Content-Type']) {
            opts.headers['Content-Type'] = 'application/json';
        }
        return fetch(path, opts).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (data) {
                if (!r.ok) {
                    var err = new Error(data.message || ('Request failed (' + r.status + ')'));
                    err.status = r.status;
                    err.data = data;
                    throw err;
                }
                return data;
            });
        });
    }

    /**
     * Authenticated file download.
     *
     * This is the fix for "Download Agreement is broken": the old markup used a
     * bare link, so the request carried no Authorization header, returned 401,
     * and the browser saved the error JSON as a .pdf.
     */
    function downloadFile(url, fallbackName) {
        return fetch(url, { headers: authHeaders() }).then(function (r) {
            if (!r.ok) {
                return r.json().catch(function () { return {}; }).then(function (d) {
                    throw new Error(d.message || 'That file could not be generated.');
                });
            }
            // Prefer the filename the server set, so a receipt keeps its number.
            var name = fallbackName;
            var cd = r.headers.get('Content-Disposition') || '';
            var m = cd.match(/filename="?([^";]+)"?/);
            if (m) name = m[1];
            return r.blob().then(function (blob) {
                var href = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = href;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                // Revoke late: Safari cancels the download if the URL dies too soon.
                setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
            });
        });
    }

    // ----------------------------------------------------------------------
    // Toast
    // ----------------------------------------------------------------------
    function toast(message, tone) {
        var el = document.createElement('div');
        el.setAttribute('role', 'status');
        el.textContent = message;
        el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(8px);'
            + 'background:' + C.INK_STRONG + ';color:' + C.INVERSE + ';font-family:' + FONT + ';'
            + 'font-size:14px;font-weight:600;padding:13px 20px;border-radius:12px;z-index:100000;'
            + 'box-shadow:0 8px 28px rgba(0,0,0,.24);max-width:min(92vw,460px);text-align:center;'
            + 'opacity:0;transition:opacity .18s ease,transform .18s ease;';
        if (tone === 'error') el.style.background = C.ATTENTION;
        if (tone === 'success') el.style.background = C.POSITIVE;
        document.body.appendChild(el);
        requestAnimationFrame(function () {
            el.style.opacity = '1';
            el.style.transform = 'translateX(-50%) translateY(0)';
        });
        setTimeout(function () {
            el.style.opacity = '0';
            el.style.transform = 'translateX(-50%) translateY(8px)';
            setTimeout(function () { el.remove(); }, 220);
        }, tone === 'error' ? 5200 : 3200);
    }

    // ----------------------------------------------------------------------
    // The reader
    // ----------------------------------------------------------------------
    var openReader = null;

    function closeReader() {
        if (!openReader) return;
        var o = openReader;
        openReader = null;
        document.removeEventListener('keydown', o.onKey);
        document.body.style.overflow = o.prevOverflow;
        o.root.style.opacity = '0';
        setTimeout(function () { o.root.remove(); }, 180);
        if (o.opener && o.opener.focus) o.opener.focus();
    }

    function openAgreement(agreementId) {
        if (openReader) closeReader();
        var opener = document.activeElement;

        var root = document.createElement('div');
        root.className = 'db-agreement-reader';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Agreement');
        root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:' + C.SCRIM + ';'
            + 'display:flex;align-items:flex-end;justify-content:center;font-family:' + FONT + ';'
            + 'opacity:0;transition:opacity .18s ease;';

        root.innerHTML = ''
            + '<div class="db-sheet" style="background:' + C.PAPER + ';width:min(860px,100%);height:min(94vh,100%);'
            +      'border-radius:20px 20px 0 0;display:flex;flex-direction:column;overflow:hidden;'
            +      'box-shadow:0 -10px 44px rgba(0,0,0,.3);">'

            // header
            + '  <div style="flex:0 0 auto;padding:16px 20px;border-bottom:1px solid ' + C.EDGE + ';'
            +      'display:flex;align-items:center;gap:12px;">'
            + '    <div style="flex:1 1 auto;min-width:0;">'
            + '      <div class="db-title" style="font-size:16px;font-weight:800;color:' + C.INK_STRONG + ';'
            +          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Loading agreement…</div>'
            + '      <div class="db-subtitle" style="font-size:12.5px;color:' + C.INK_MUTED + ';margin-top:2px;"></div>'
            + '    </div>'
            + '    <button class="db-dl" type="button" aria-label="Download PDF" style="flex:0 0 auto;background:' + C.PANEL + ';'
            +        'border:1px solid ' + C.EDGE + ';color:' + C.INK_STRONG + ';font:inherit;font-size:13px;font-weight:700;'
            +        'padding:9px 14px;border-radius:10px;cursor:pointer;">Download</button>'
            + '    <button class="db-x" type="button" aria-label="Close" style="flex:0 0 auto;background:transparent;'
            +        'border:0;color:' + C.INK_MUTED + ';font-size:26px;line-height:1;cursor:pointer;padding:2px 6px;">&times;</button>'
            + '  </div>'

            // scrolling document
            + '  <div class="db-scroll" tabindex="0" style="flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;'
            +      'padding:20px;background:' + C.PAPER + ';">'
            + '    <div class="db-body"></div>'
            + '    <div class="db-end" style="height:1px;"></div>'
            + '  </div>'

            // footer / sign controls
            + '  <div class="db-foot" style="flex:0 0 auto;border-top:1px solid ' + C.EDGE + ';'
            +      'padding:14px 20px calc(14px + env(safe-area-inset-bottom,0px));background:' + C.PAPER + ';"></div>'
            + '</div>';

        document.body.appendChild(root);
        var prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        requestAnimationFrame(function () { root.style.opacity = '1'; });

        function onKey(e) { if (e.key === 'Escape') closeReader(); }
        document.addEventListener('keydown', onKey);
        openReader = { root: root, onKey: onKey, prevOverflow: prevOverflow, opener: opener };

        root.querySelector('.db-x').addEventListener('click', closeReader);
        root.addEventListener('click', function (e) { if (e.target === root) closeReader(); });

        var scroller = root.querySelector('.db-scroll');
        var body = root.querySelector('.db-body');
        var foot = root.querySelector('.db-foot');

        root.querySelector('.db-dl').addEventListener('click', function () {
            downloadAgreement(agreementId);
        });

        api('/api/portal/sales-agreements/' + agreementId + '/document')
            .then(function (res) {
                root.querySelector('.db-title').textContent = res.meta.title;
                root.querySelector('.db-subtitle').textContent = res.meta.number
                    + (res.meta.signed ? ' · Signed' : '');
                body.innerHTML = res.html;
                buildFooter(res);
            })
            .catch(function (err) {
                body.innerHTML = '<p style="font-family:' + FONT + ';font-size:15px;color:' + C.INK + ';">'
                    + 'This agreement could not be loaded. ' + escapeHtml(err.message) + '</p>';
                foot.innerHTML = '';
            });

        // ------------------------------------------------------------------
        function buildFooter(res) {
            if (res.meta.signed) {
                foot.innerHTML = '<div style="display:flex;align-items:center;gap:10px;">'
                    + '<span style="font-size:14px;font-weight:700;color:' + C.POSITIVE + ';">Signed &amp; complete</span>'
                    + '<span style="font-size:13px;color:' + C.INK_MUTED + ';flex:1 1 auto;">'
                    + 'Your copy is in Receipts &amp; Docs.</span></div>';
                return;
            }

            var needsAutopay = !!res.autopay;

            foot.innerHTML = ''
                // The scroll gate. Replaced by the controls once the document
                // has actually been read to the end.
                + '<div class="db-gate" style="display:flex;align-items:center;gap:12px;">'
                + '  <div style="flex:1 1 auto;font-size:13.5px;color:' + C.INK_MUTED + ';line-height:1.5;">'
                + '    Scroll to the end of the agreement to sign it.</div>'
                + '  <button class="db-jump" type="button" style="flex:0 0 auto;background:' + C.INK_STRONG + ';'
                +      'color:' + C.INVERSE + ';border:0;font:inherit;font-size:13px;font-weight:700;padding:11px 16px;'
                +      'border-radius:10px;cursor:pointer;">Jump to end</button>'
                + '</div>'

                + '<div class="db-controls" hidden>'
                + (needsAutopay
                    ? '  <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:12px;cursor:pointer;">'
                    + '    <input class="db-autopay" type="checkbox" style="margin-top:3px;width:19px;height:19px;flex:0 0 auto;accent-color:' + C.INK_STRONG + ';">'
                    + '    <span style="font-size:13.5px;line-height:1.55;color:' + C.INK + ';">'
                    +        escapeHtml(res.autopayConsentText || '') + '</span>'
                    + '  </label>'
                    : '')
                + '  <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:12px;cursor:pointer;">'
                + '    <input class="db-agree" type="checkbox" style="margin-top:3px;width:19px;height:19px;flex:0 0 auto;accent-color:' + C.INK_STRONG + ';">'
                + '    <span style="font-size:13.5px;line-height:1.55;color:' + C.INK + ';">'
                + '      I have read this agreement in full and agree to its terms.</span>'
                + '  </label>'
                + '  <label style="display:block;font-size:12px;font-weight:700;letter-spacing:.05em;'
                +      'text-transform:uppercase;color:' + C.INK_MUTED + ';margin-bottom:6px;">Type your full name to sign</label>'
                + '  <div style="display:flex;gap:10px;align-items:stretch;flex-wrap:wrap;">'
                + '    <input class="db-name" type="text" autocomplete="name" placeholder="Your full name"'
                +        ' style="flex:1 1 200px;min-width:0;font:inherit;font-size:16px;color:' + C.INK_STRONG + ';'
                +        'background:' + C.PAPER + ';border:1.5px solid ' + C.EDGE + ';border-radius:10px;padding:12px 14px;">'
                + '    <button class="db-submit" type="button" disabled style="flex:0 0 auto;background:' + C.INK_STRONG + ';'
                +        'color:' + C.INVERSE + ';border:0;font:inherit;font-size:15px;font-weight:800;padding:12px 24px;'
                +        'border-radius:10px;cursor:pointer;">Sign agreement</button>'
                + '  </div>'
                + '  <p class="db-hint" style="margin:10px 0 0;font-size:12px;color:' + C.INK_MUTED + ';line-height:1.55;"></p>'
                + '</div>';

            var gate = foot.querySelector('.db-gate');
            var controls = foot.querySelector('.db-controls');
            var cbAgree = foot.querySelector('.db-agree');
            var cbAutopay = foot.querySelector('.db-autopay');
            var name = foot.querySelector('.db-name');
            var submit = foot.querySelector('.db-submit');
            var hint = foot.querySelector('.db-hint');

            foot.querySelector('.db-jump').addEventListener('click', function () {
                scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
            });

            var reachedEnd = false;
            function checkScroll() {
                if (reachedEnd) return;
                // 24px of slack: sub-pixel rounding means scrollTop rarely hits
                // the exact bottom, and a gate that can't be satisfied is worse
                // than no gate.
                var atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24;
                // A document shorter than the viewport is already fully read.
                var fitsWholly = scroller.scrollHeight <= scroller.clientHeight + 4;
                if (atEnd || fitsWholly) {
                    reachedEnd = true;
                    gate.hidden = true;
                    controls.hidden = false;
                    refresh();
                }
            }
            scroller.addEventListener('scroll', checkScroll, { passive: true });
            // Content renders after the fetch resolves; re-check once laid out.
            setTimeout(checkScroll, 60);
            window.addEventListener('resize', checkScroll);

            function refresh() {
                var ok = cbAgree.checked
                    && (!needsAutopay || (cbAutopay && cbAutopay.checked))
                    && name.value.trim().length >= 2;
                submit.disabled = !ok;
                submit.style.opacity = ok ? '1' : '.45';
                submit.style.cursor = ok ? 'pointer' : 'not-allowed';

                if (!cbAgree.checked) hint.textContent = 'Tick the box to confirm you agree to the terms.';
                else if (needsAutopay && cbAutopay && !cbAutopay.checked) hint.textContent = 'Autopay authorization is required for a recurring plan.';
                else if (name.value.trim().length < 2) hint.textContent = 'Type your full name — this is your signature.';
                else hint.textContent = 'Signing is legally binding and records the date, time and your IP address.';
            }

            cbAgree.addEventListener('change', refresh);
            if (cbAutopay) cbAutopay.addEventListener('change', refresh);
            name.addEventListener('input', refresh);
            name.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !submit.disabled) submit.click();
            });

            submit.addEventListener('click', function () {
                submit.disabled = true;
                submit.textContent = 'Signing…';
                api('/api/portal/sales-agreements/' + agreementId + '/sign', {
                    method: 'POST',
                    body: JSON.stringify({
                        typedName: name.value.trim(),
                        agree: true,
                        autopayConsent: needsAutopay ? !!(cbAutopay && cbAutopay.checked) : undefined,
                        viewedInFull: true,
                        // Proves the signature applies to the text that was on
                        // screen, not a version edited while it sat open.
                        documentHash: res.documentHash
                    })
                }).then(function (out) {
                    toast(out.message || 'Signed.', 'success');
                    // Let the dashboard update itself in place. No reload, so
                    // the button flips to "Signed" immediately.
                    window.dispatchEvent(new CustomEvent('db:agreement-signed', {
                        detail: {
                            agreementId: agreementId,
                            kind: out.kind,
                            planActive: out.planActive,
                            message: out.message
                        }
                    }));
                    closeReader();
                }).catch(function (err) {
                    submit.disabled = false;
                    submit.textContent = 'Sign agreement';
                    refresh();
                    // Already signed is a success from the customer's side —
                    // they should not see a red error for something that worked.
                    if (err.status === 409) {
                        toast('This agreement is already signed — your copy is in Docs.', 'success');
                        window.dispatchEvent(new CustomEvent('db:agreement-signed', {
                            detail: { agreementId: agreementId, alreadySigned: true }
                        }));
                        closeReader();
                        return;
                    }
                    toast(err.message, 'error');
                });
            });

            refresh();
        }
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ----------------------------------------------------------------------
    // Downloads
    // ----------------------------------------------------------------------
    function withBusy(el, promise) {
        var label = el ? el.textContent : null;
        if (el) { el.disabled = true; el.textContent = 'Preparing…'; }
        return promise
            .catch(function (err) { toast(err.message, 'error'); })
            .then(function () {
                if (el) { el.disabled = false; el.textContent = label; }
            });
    }

    function downloadAgreement(id, el) {
        return withBusy(el, downloadFile(
            '/api/portal/sales-agreements/' + id + '/pdf', 'Agreement-' + id + '.pdf'));
    }

    function downloadReceipt(paymentId, el) {
        return withBusy(el, downloadFile(
            '/api/portal/payments/' + paymentId + '/receipt', 'Receipt-' + paymentId + '.pdf'));
    }

    function downloadReceiptForInvoice(invoiceId, el) {
        return withBusy(el, downloadFile(
            '/api/portal/invoices/' + invoiceId + '/receipt', 'Receipt-invoice-' + invoiceId + '.pdf'));
    }

    // ----------------------------------------------------------------------
    // Auto-wiring
    // ----------------------------------------------------------------------
    // Delegated from the document, so it covers markup rendered after load —
    // which is all of it, in this portal.
    document.addEventListener('click', function (e) {
        var t = e.target.closest
            ? e.target.closest('[data-db-sign],[data-db-download-agreement],'
                             + '[data-db-download-receipt],[data-db-receipt-for-invoice]')
            : null;
        if (!t) return;
        e.preventDefault();

        if (t.hasAttribute('data-db-sign')) {
            openAgreement(t.getAttribute('data-db-sign'));
        } else if (t.hasAttribute('data-db-download-agreement')) {
            downloadAgreement(t.getAttribute('data-db-download-agreement'), t);
        } else if (t.hasAttribute('data-db-download-receipt')) {
            downloadReceipt(t.getAttribute('data-db-download-receipt'), t);
        } else if (t.hasAttribute('data-db-receipt-for-invoice')) {
            downloadReceiptForInvoice(t.getAttribute('data-db-receipt-for-invoice'), t);
        }
    });

    // ----------------------------------------------------------------------
    // Outstanding balance for the home screen
    // ----------------------------------------------------------------------
    /**
     * The rule lives on the server (diamondback-document-routes.js). This just
     * fetches it, so the home screen and the billing screen can never quote
     * different numbers.
     *
     *   outstanding.dueNow          monthly plans (current period, paid or not)
     *                               + due-now invoices  -> the HOME figure
     *   outstanding.upcomingAnnual  annual plans        -> BILLING screen only
     */
    function loadOutstanding() {
        return api('/api/portal/outstanding').then(function (r) { return r.outstanding; });
    }

    /**
     * Convenience renderer. Fills any element with data-db-outstanding-total
     * and data-db-outstanding-count. Optional — call it, or read
     * loadOutstanding() yourself and render it your own way.
     */
    function renderOutstanding() {
        return loadOutstanding().then(function (o) {
            document.querySelectorAll('[data-db-outstanding-total]').forEach(function (el) {
                el.textContent = o.totalLabel;
                el.style.color = o.overdueCount > 0 ? C.ATTENTION : C.INK_STRONG;
            });
            document.querySelectorAll('[data-db-outstanding-count]').forEach(function (el) {
                el.textContent = o.count === 0
                    ? 'Nothing outstanding'
                    : o.count + (o.count === 1 ? ' item due' : ' items due');
            });
            return o;
        }).catch(function () { /* home screen must not break on this */ });
    }

    // Refresh the balance whenever something is signed — a signed plan can turn
    // an amount outstanding the moment the signature lands.
    window.addEventListener('db:agreement-signed', function () {
        setTimeout(renderOutstanding, 400);
    });

    // ----------------------------------------------------------------------
    window.DiamondbackAgreements = {
        open: openAgreement,
        download: downloadAgreement,
        close: closeReader
    };
    window.DiamondbackReceipts = {
        download: downloadReceipt,
        downloadForInvoice: downloadReceiptForInvoice
    };
    window.DiamondbackBilling = {
        loadOutstanding: loadOutstanding,
        render: renderOutstanding
    };

    console.log('[DIAMONDBACK] Agreement reader + receipt downloads ready.');
})();