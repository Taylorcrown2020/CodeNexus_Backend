#!/usr/bin/env python3
"""
add_portal_nav.py — give every public page a nav login menu with BOTH portals.

Before: a single  <a href="client_portal.html" class="login-link">LOG IN</a>
After:  a LOG IN dropdown offering the CodeNexus CRM portal and the customer
        portal, plus the same two links inside the mobile nav overlay (the
        desktop .login-link is display:none under 768px, so mobile needs its
        own entry or the customer portal is unreachable on a phone).

Styling deliberately reuses the values already in these pages' nav dropdowns
(#1a1a1a panel, 8px radius, rgba(255,255,255,.8) links, the same hover shift)
so this reads as part of the existing nav rather than a bolted-on component.

Idempotent: re-running skips files that already carry the marker.
"""

import re
import sys
import pathlib

MARKER = 'db-portal-css'

PAGES = [
    'index.html', 'pricing.html', 'process.html', 'portfolio.html',
    'contact.html', 'about.html', 'blog.html', 'careers.html',
    'terms_of_service.html', 'privacy_policy.html',
    'schedule.html', 'apply.html',
]

CSS = """
<style id="db-portal-css">
/* Dual-portal login menu. Values match the existing .dropdown-menu in this
   page's nav so the two are visually identical. */
.db-portal { position: relative; display: inline-flex; align-items: center; }
.db-portal-trigger {
    display: inline-flex; align-items: center; gap: 6px;
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--white, #fff); font: inherit; font-size: 13px;
    text-transform: uppercase; letter-spacing: .5px;
}
.db-portal-trigger svg { transition: transform .3s ease; }
.db-portal[data-open="true"] .db-portal-trigger svg { transform: rotate(180deg); }
.db-portal-panel {
    position: absolute; top: calc(100% + 20px); right: 0;
    background: #1a1a1a; min-width: 268px; padding: 8px 0;
    border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.3);
    opacity: 0; visibility: hidden; transition: all .3s ease; z-index: 1000;
}
.db-portal:hover .db-portal-panel,
.db-portal[data-open="true"] .db-portal-panel {
    opacity: 1; visibility: visible; top: calc(100% + 10px);
}
.db-portal-panel a {
    display: block; padding: 12px 24px; text-decoration: none;
    color: rgba(255,255,255,.8); transition: all .2s ease;
}
.db-portal-panel a:hover { background: rgba(255,255,255,.1); padding-left: 28px; }
.db-portal-panel strong {
    display: block; font-size: 13px; font-weight: 600;
    letter-spacing: .3px; color: #fff; text-transform: none;
}
.db-portal-panel span {
    display: block; margin-top: 2px; font-size: 11px;
    color: rgba(255,255,255,.5); letter-spacing: .2px; text-transform: none;
}
.db-portal-trigger:focus-visible,
.db-portal-panel a:focus-visible {
    outline: 2px solid var(--gold, #f4c87e); outline-offset: 2px;
}
/* Mobile: the desktop menu rides on .login-link, which the page already hides
   under 768px. These list items take over inside the nav overlay. */
.db-portal-mobile { display: none; }
@media (max-width: 768px) {
    .db-portal-mobile { display: block; }
    .db-portal-mobile > a { display: block; }
    .db-portal-mobile small {
        display: block; font-size: 11px; opacity: .55;
        text-transform: none; letter-spacing: .2px; margin-top: 2px;
    }
}
@media (prefers-reduced-motion: reduce) {
    .db-portal-panel, .db-portal-trigger svg { transition: none; }
}
</style>
"""

CHEVRON = ('<svg width="10" height="10" viewBox="0 0 24 24" fill="none" '
           'stroke="currentColor" stroke-width="3" aria-hidden="true">'
           '<polyline points="6 9 12 15 18 9"></polyline></svg>')

DESKTOP = f"""<div class="db-portal login-link">
                    <button type="button" class="db-portal-trigger" aria-expanded="false" aria-haspopup="true">LOG IN {CHEVRON}</button>
                    <div class="db-portal-panel" role="menu">
                        <a href="customer_portal.html" role="menuitem"><strong>Customer Portal</strong><span>Invoices, agreements and messages</span></a>
                        <a href="client_portal.html" role="menuitem"><strong>CodeNexus CRM</strong><span>For CRM subscribers</span></a>
                    </div>
                </div>"""

MOBILE = """<li class="db-portal-mobile"><a href="customer_portal.html">Customer Portal<small>Invoices and messages</small></a></li>
                <li class="db-portal-mobile"><a href="client_portal.html">CodeNexus CRM<small>For CRM subscribers</small></a></li>
            """

# The exact anchor these pages ship with, tolerant of attribute order/spacing.
OLD_LINK = re.compile(
    r'<a\s+href=["\']client_portal\.html["\']\s+class=["\']login-link["\']\s*>\s*LOG\s*IN\s*</a>',
    re.I)

# Fallback for pages whose login link is absent (schedule.html, apply.html):
# anchor onto .contact-info so they get one too.
CONTACT_INFO = re.compile(r'(<div\s+class=["\']contact-info["\']\s*>)', re.I)

NAV_UL_CLOSE = re.compile(r'(<ul\s+class=["\']nav-links["\']\s*>)(.*?)(</ul>)', re.S | re.I)


def patch(path: pathlib.Path) -> str:
    src = path.read_text(encoding='utf-8', errors='replace')
    if MARKER in src:
        return 'skipped (already patched)'

    out = src
    notes = []

    # 1. desktop menu
    n_replaced = len(OLD_LINK.findall(out))
    if n_replaced:
        out = OLD_LINK.sub(lambda m: DESKTOP, out)
        notes.append(f'{n_replaced} desktop menu(s) replaced')
    else:
        # no existing login link — inject after <div class="contact-info">
        if CONTACT_INFO.search(out):
            out, n_inj = CONTACT_INFO.subn(lambda m: m.group(1) + '\n                ' + DESKTOP, out, count=1)
            notes.append(f'{n_inj} desktop menu(s) injected into .contact-info')
        else:
            notes.append('NO desktop anchor point found')

    # 2. mobile entries inside every nav-links list
    def add_mobile(m):
        head, body, tail = m.group(1), m.group(2), m.group(3)
        if 'db-portal-mobile' in body:
            return m.group(0)
        return head + body.rstrip() + '\n                ' + MOBILE + tail

    out, n_nav = NAV_UL_CLOSE.subn(add_mobile, out)
    notes.append(f'{n_nav} nav list(s) given mobile entries')

    # 3. stylesheet, once, before </head>
    if '</head>' in out:
        out = out.replace('</head>', CSS + '</head>', 1)
        notes.append('css injected')
    else:
        notes.append('NO </head> — css NOT injected')

    path.write_text(out, encoding='utf-8')
    return '; '.join(notes)


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    for name in PAGES:
        p = root / name
        if not p.exists():
            print(f'{name:24} MISSING')
            continue
        print(f'{name:24} {patch(p)}')


if __name__ == '__main__':
    main()