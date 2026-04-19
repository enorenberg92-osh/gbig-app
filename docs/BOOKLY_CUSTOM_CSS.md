# Bookly — Custom CSS for the App Booking Page

The reservation form inside the app iframes `https://greenbayindoorgolf.com/app-page-booking/`.
That page shows the player a Bookly widget, but by default Bookly looks like
any other 2010-era WordPress plugin. The CSS below modernizes it to match
the rest of the app — matte card surfaces, generous spacing, the GBIG
green + gold palette, and clean focus states.

## Where to paste it

You have two reasonable places to install this. Either works; pick one so
the rules don't fight each other.

**Option A — Bookly → Settings → Appearance → Custom CSS** (recommended).
Scoped to just the Bookly widget, survives theme updates, and is the
cleanest install.

**Option B — WordPress → Appearance → Customize → Additional CSS** and
wrap the whole block in a body selector that only matches the app
booking page, e.g.
`body.page-id-XXXX { ... }` (replace `XXXX` with the page's ID — find it
in the URL when you edit the page in wp-admin).

Option B is only necessary if you also want to hide WordPress page chrome
(site header, footer, the "RESERVATIONS" page title that's bleeding
through into the iframe). Those selectors are marked below.

---

## The CSS

```css
/* ───────────────────────────────────────────────────────────────
   GBIG App — Bookly modernization
   Matches the design language of the native app around the iframe:
   Playfair Display headings, matte cards, green + gold palette.
   ─────────────────────────────────────────────────────────────── */

/* === 0. Page chrome — hide only on this page ============================
   These rules belong in "Additional CSS" (Option B above), scoped to the
   app-booking page. Copy them OUT of this block if you're using
   Bookly's Custom CSS field, since Bookly-scoped CSS can't see the
   site header/footer.                                                    */
body.page-template-default #masthead,           /* default site header   */
body.page-template-default header.site-header,
body.page-template-default .site-header,
body.page-template-default #site-header,
body.page-template-default .entry-title,         /* "RESERVATIONS" title */
body.page-template-default .page-header,
body.page-template-default .page-title,
body.page-template-default #footer,
body.page-template-default .site-footer,
body.page-template-default footer.site-footer {
  display: none !important;
}

body.page-template-default {
  background: #f7f6f2 !important;
  margin: 0 !important;
  padding: 0 !important;
}

body.page-template-default .entry-content,
body.page-template-default .site-content,
body.page-template-default .site-main,
body.page-template-default #content {
  padding: 0 !important;
  margin: 0 !important;
  max-width: none !important;
  background: transparent !important;
}

/* === 1. Palette — pulled from the app's CSS custom properties ========= */
.bookly-form,
.bookly-form * {
  --gbig-green:        #1b4332;
  --gbig-green-dark:   #0d2618;
  --gbig-green-mid:    #2d6a4f;
  --gbig-gold:         #c9a84c;
  --gbig-gold-soft:    #e8c96a;
  --gbig-bg:           #f7f6f2;
  --gbig-surface:      #ffffff;
  --gbig-border:       #e5e3db;
  --gbig-text:         #1f2937;
  --gbig-text-muted:   #6b7280;
  --gbig-radius-sm:    8px;
  --gbig-radius-md:    12px;
  --gbig-radius-lg:    16px;
  --gbig-shadow:       0 1px 3px rgba(16,24,32,0.04), 0 1px 2px rgba(16,24,32,0.03);
  --gbig-shadow-lift:  0 4px 12px rgba(16,24,32,0.08);
}

/* === 2. Outer container ================================================ */
.bookly-form {
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI",
               Roboto, Helvetica, Arial, sans-serif !important;
  color: var(--gbig-text) !important;
  background: var(--gbig-bg) !important;
  padding: 18px 16px 24px !important;
  max-width: 520px !important;
  margin: 0 auto !important;
  line-height: 1.5 !important;
}

/* === 3. Steps / headings =============================================== */
.bookly-form .bookly-label,
.bookly-form legend,
.bookly-form h2,
.bookly-form h3 {
  font-family: "Playfair Display", Georgia, serif !important;
  font-weight: 600 !important;
  font-size: 18px !important;
  color: var(--gbig-green) !important;
  letter-spacing: 0.2px !important;
  margin: 4px 0 8px !important;
}

.bookly-form .bookly-progress-tracker {
  margin: 4px 0 20px !important;
}

.bookly-form .bookly-label-error {
  color: #b42318 !important;
  font-size: 13px !important;
}

/* === 4. "Cards" — wrap each step/section in a white surface =========== */
.bookly-form .bookly-box,
.bookly-form .bookly-form-group,
.bookly-form .bookly-js-step,
.bookly-form fieldset {
  background: var(--gbig-surface) !important;
  border: 1px solid var(--gbig-border) !important;
  border-radius: var(--gbig-radius-md) !important;
  box-shadow: var(--gbig-shadow) !important;
  padding: 16px !important;
  margin-bottom: 14px !important;
}

/* === 5. Inputs, selects, textareas ===================================== */
.bookly-form input[type="text"],
.bookly-form input[type="email"],
.bookly-form input[type="tel"],
.bookly-form input[type="number"],
.bookly-form input[type="date"],
.bookly-form input[type="time"],
.bookly-form select,
.bookly-form textarea {
  width: 100% !important;
  box-sizing: border-box !important;
  padding: 12px 14px !important;
  font-size: 16px !important;           /* 16px+ prevents iOS zoom on focus */
  line-height: 1.4 !important;
  color: var(--gbig-text) !important;
  background: #fff !important;
  border: 1.5px solid var(--gbig-border) !important;
  border-radius: var(--gbig-radius-sm) !important;
  transition: border-color 0.15s ease, box-shadow 0.15s ease,
              background 0.15s ease !important;
  -webkit-appearance: none !important;
  appearance: none !important;
  font-family: inherit !important;
}

.bookly-form input:focus,
.bookly-form select:focus,
.bookly-form textarea:focus {
  outline: none !important;
  border-color: var(--gbig-green) !important;
  box-shadow: 0 0 0 3px rgba(27, 67, 50, 0.15) !important;
}

.bookly-form input::placeholder,
.bookly-form textarea::placeholder {
  color: #9ca3af !important;
}

/* Select chevron */
.bookly-form select {
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='none' stroke='%231b4332' stroke-width='2' d='M1 1l5 5 5-5'/%3E%3C/svg%3E") !important;
  background-repeat: no-repeat !important;
  background-position: right 14px center !important;
  padding-right: 38px !important;
}

/* === 6. Time slot + day tiles ========================================== */
.bookly-form .bookly-day-slots,
.bookly-form .bookly-time-step,
.bookly-form .bookly-table {
  margin-top: 8px !important;
}

.bookly-form .bookly-day-slots a,
.bookly-form .bookly-time-slot,
.bookly-form .bookly-js-time-slot,
.bookly-form td.bookly-column-slot a {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 72px !important;
  padding: 10px 14px !important;
  margin: 4px !important;
  background: #fff !important;
  border: 1.5px solid var(--gbig-border) !important;
  border-radius: var(--gbig-radius-sm) !important;
  color: var(--gbig-text) !important;
  font-weight: 600 !important;
  font-size: 14px !important;
  text-decoration: none !important;
  transition: transform 0.08s ease, border-color 0.15s ease,
              background 0.15s ease, color 0.15s ease,
              box-shadow 0.18s ease !important;
  cursor: pointer !important;
}

.bookly-form .bookly-day-slots a:hover,
.bookly-form .bookly-time-slot:hover,
.bookly-form td.bookly-column-slot a:hover {
  border-color: var(--gbig-green) !important;
  background: #fafaf5 !important;
}

.bookly-form .bookly-day-slots a.bookly-selected,
.bookly-form .bookly-time-slot.bookly-selected,
.bookly-form .bookly-js-selected,
.bookly-form td.bookly-column-slot a.bookly-selected {
  background: var(--gbig-green) !important;
  border-color: var(--gbig-green) !important;
  color: #fff !important;
  box-shadow: 0 2px 6px rgba(27, 67, 50, 0.25) !important;
}

/* === 7. Buttons ======================================================== */
.bookly-form .bookly-btn,
.bookly-form .bookly-js-next-step,
.bookly-form .bookly-js-go-to-step,
.bookly-form button[type="submit"],
.bookly-form input[type="submit"],
.bookly-form .bookly-form-group input[type="submit"] {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 14px 22px !important;
  min-height: 48px !important;
  border-radius: var(--gbig-radius-md) !important;
  border: none !important;
  background: linear-gradient(180deg, var(--gbig-green-mid) 0%, var(--gbig-green) 100%) !important;
  color: #fff !important;
  font-family: "Playfair Display", Georgia, serif !important;
  font-weight: 600 !important;
  font-size: 16px !important;
  letter-spacing: 0.3px !important;
  cursor: pointer !important;
  box-shadow: 0 2px 8px rgba(27, 67, 50, 0.22) !important;
  transition: transform 0.08s ease, box-shadow 0.2s ease,
              background 0.2s ease !important;
  text-decoration: none !important;
  -webkit-appearance: none !important;
  appearance: none !important;
}

.bookly-form .bookly-btn:hover,
.bookly-form button[type="submit"]:hover,
.bookly-form input[type="submit"]:hover {
  box-shadow: 0 4px 14px rgba(27, 67, 50, 0.32) !important;
}

.bookly-form .bookly-btn:active,
.bookly-form button[type="submit"]:active,
.bookly-form input[type="submit"]:active {
  transform: translateY(1px) scale(0.995) !important;
  box-shadow: 0 1px 4px rgba(27, 67, 50, 0.22) !important;
}

/* Back button — same dark-green treatment as the primary button.
   (Originally a white "secondary" pill, but it read inconsistently across
   viewport sizes — the unified green is cleaner and matches the app.) */
.bookly-form .bookly-btn.bookly-js-back-step,
.bookly-form .bookly-btn.bookly-back,
.bookly-form .bookly-back-step {
  background: linear-gradient(180deg, var(--gbig-green-mid) 0%, var(--gbig-green) 100%) !important;
  color: #fff !important;
  border: none !important;
  box-shadow: 0 2px 8px rgba(27, 67, 50, 0.22) !important;
}
.bookly-form .bookly-btn.bookly-js-back-step:hover,
.bookly-form .bookly-btn.bookly-back:hover,
.bookly-form .bookly-back-step:hover {
  box-shadow: 0 4px 14px rgba(27, 67, 50, 0.32) !important;
}

/* === 8. Calendar ======================================================= */
.bookly-form .picker,
.bookly-form .picker__box,
.bookly-form .bookly-calendar {
  background: #fff !important;
  border-radius: var(--gbig-radius-md) !important;
  box-shadow: var(--gbig-shadow-lift) !important;
  border: 1px solid var(--gbig-border) !important;
  overflow: hidden !important;
}

.bookly-form .picker__day--highlighted,
.bookly-form .bookly-calendar td.available:hover {
  background: #fafaf5 !important;
  color: var(--gbig-green) !important;
}

.bookly-form .picker__day--selected,
.bookly-form .bookly-calendar td.selected {
  background: var(--gbig-green) !important;
  color: #fff !important;
}

/* === 9. Summary / confirmation ========================================= */
.bookly-form .bookly-box.bookly-summary,
.bookly-form .bookly-confirmation,
.bookly-form .bookly-js-done {
  background: linear-gradient(180deg, #ffffff 0%, #fafaf5 100%) !important;
  border: 1px solid var(--gbig-gold) !important;
  border-top-width: 3px !important;
  padding: 18px !important;
}

.bookly-form .bookly-summary .bookly-label-error {
  display: none !important;
}

/* === 10. Spinner + loading ============================================= */
.bookly-form .bookly-ajax-loader,
.bookly-form .bookly-spinner {
  border-top-color: var(--gbig-green) !important;
}

/* === 11. Typography cleanup ============================================ */
.bookly-form p,
.bookly-form span,
.bookly-form label {
  font-family: inherit !important;
}

.bookly-form a:not(.bookly-btn):not(.bookly-day-slots a):not(.bookly-js-time-slot) {
  color: var(--gbig-green) !important;
  text-decoration: underline !important;
  text-underline-offset: 2px !important;
}

/* === 12. Tighten up Bookly's default vertical rhythm =================== */
.bookly-form .bookly-form-group + .bookly-form-group {
  margin-top: 12px !important;
}

/* === 13. Disabled states =============================================== */
.bookly-form [disabled],
.bookly-form .bookly-disabled,
.bookly-form button:disabled {
  opacity: 0.55 !important;
  cursor: not-allowed !important;
  box-shadow: none !important;
}
```

---

## After pasting

1. Save the Bookly settings (or WordPress Customize) and hard-refresh
   the app booking page in a browser.
2. Open the app and tap the Reservations tab — the iframe should now
   render the modernized form.
3. If a specific Bookly field still looks 2005 (there are a lot of
   sub-widgets — cart, customer info, coupons, etc.), right-click it in
   a desktop browser → Inspect, grab the `.bookly-*` class name, and
   add a targeted rule to this block. Bookly's class names are stable
   across versions.

## If the "RESERVATIONS" text is still visible

That text is coming from the WordPress page template, not Bookly, so
Bookly's Custom CSS field can't hide it. Two paths:

- **Easy:** move the CSS block above (section `=== 0`) into Appearance →
  Customize → Additional CSS, replacing `page-template-default` with
  your actual page template class (visible in the page's `<body>` when
  you View Source — look for `page-id-XXXX` or `page-template-XXXX`).
- **Easier:** in the WordPress page editor for the app-booking page,
  switch the template to "Blank" / "No Header Footer" / "Empty" if your
  theme exposes one; that removes the entry title automatically.

The app-side edge masks in `ReservationsPage.jsx` are a belt-and-
suspenders safety net so the form looks clean even before the WP-side
CSS lands.
