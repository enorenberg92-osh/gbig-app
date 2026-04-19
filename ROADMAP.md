# GBIG App — Roadmap & Session Notes

_Kept in the repo so we can both pick up the thread at any time. Update as we go._

---

## Decisions locked in (Apr 18, 2026)

1. **Multi-tenancy:** move to a single app, one deployment, with **subdomain-per-location** routing (e.g. `gbig.app.com`, `milwaukee.app.com`). The current "one Vercel deploy per location via `VITE_LOCATION_ID`" stays working through the transition.
2. **Polish:** full design-system pass — shared components, per-location theme tokens, crafted SVG icons replacing emoji, consistent motion + empty/loading states.
3. **Stack changes:** stay on React + Vite + plain JS for now. Add **React Router** and a shared **theme + component layer** when they earn their weight. TypeScript only in spots where it clearly pays (e.g. `lib/handicapCalc.js`). No big-bang rewrites.
4. **Timeline:** ship security/scale fixes immediately; plan the rest in phases with check-ins at each boundary.

---

## Phase 0 — SHIPPED this session ✅

_All changes touch existing files only; no new dependencies._

**Security**
- `supabase/functions/send-alert/index.ts` — now identifies caller from JWT, verifies they're in `location_admins`, scopes the DB insert and fan-out to `location_id`. No more global broadcasts.
- `supabase/functions/send-social-push/index.ts` — now verifies caller + target player share a `location_id` before sending anything. Fan-out restricted to that location's subscriptions.
- `supabase/functions/create-player-account/index.ts` — now requires the caller's JWT and verifies they're an admin for the target player's location before creating an auth user.
- `src/components/admin/AdminAlerts.jsx` — sends the signed-in user's access token instead of the anon key.
- `src/components/admin/AdminPlayers.jsx` — same, at both `create-player-account` call sites.
- `src/components/FriendsTab.jsx` — same, in `sendSocialPush`.
- `src/lib/supabaseAdmin.js` — neutralized. Any future use throws a visible security warning. Privileged work stays inside Edge Functions.
- `deploy-alerts.sh` — plaintext VAPID keys removed; now reads from env. (**Rotate the leaked keys** — see below.)

**PWA / Install**
- `public/icon-96.png`, `icon-192.png`, `icon-512.png` — new crafted app icons (flag-and-ball on the brand green). Fixes the broken PWA install.
- `public/manifest.json` — references the real icons, including a `maskable` variant.
- `public/favicon.svg` — redesigned to match the app icon (no emoji dependency).

**Dev hygiene**
- `.env.example` — every variable documented, with notes on which are safe to ship to the browser and which (`VITE_SUPABASE_SERVICE_ROLE_KEY`) must never be set.

### What you need to do now (only if GBIG is already live)

1. **Rotate the VAPID keys.** The old ones were in `deploy-alerts.sh` in git history.
   ```bash
   npx web-push generate-vapid-keys
   ```
   Put the new **public** key in `.env.local` as `VITE_VAPID_PUBLIC_KEY`.
   Put **both** keys in Supabase via the updated `deploy-alerts.sh`:
   ```bash
   PROJECT_REF=mtuzmasicpcxcvtslevm \
   VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
   VAPID_EMAIL=admin@greenbayindoorgolf.com \
     bash deploy-alerts.sh
   ```
   _Every currently-subscribed device will need to resubscribe after the rotation — that's unavoidable with VAPID key changes, but it's a one-time prompt for each user._

2. **Redeploy the three Edge Functions** (the script above does this). They now reject anon-only calls.

3. **Confirm RLS is enabled** in Supabase → Auth → Policies on the tables listed in `SUPABASE_SCHEMA.md`. If it isn't, we schedule that as the first Phase-1 item — I can write the policies.

---

## Phase 1 — Stabilize (next session, ~1 chunk)

Goal: safe to build on, no regressions lurking.

- **Turn on RLS** across every tenant-scoped table with `location_id`-aware policies. Today the app depends on client code remembering to add `.eq('location_id', locationId)` — RLS makes it impossible to forget.
- **Unit tests for `lib/handicapCalc.js`** — highest-risk logic with zero tests today. This is also the right time to introduce a small test runner (Vitest).
- **Delete dead code:** `react-router-dom` is installed but unused (we'll add it for real in Phase 2); remove the deleted-but-uncommitted `src/lib/handicap.js` once committed; clean up the giant list of uncommitted work in `git status`.
- **Commit the existing uncommitted changes** — there's a big backlog of modifications from the earlier Sonnet work that haven't been committed. We'll do this in a single "Multi-location foundation" commit so git history tells a story.

**You'll see:** a clean `git status`, green tests for handicap math, and Supabase returning 401/403 if anyone bypasses the app.

---

## Phase 2 — Elevate (the visible overhaul)

Goal: the app _oozes class_ on every screen, for both admins and members.

- ✅ **Theme layer (shipped 2026-04-19):** `ThemeProvider` reads `locations.primary_color` at boot and overrides `--green`, `--green-dark`, `--green-light`, `--green-xlight` at runtime. Dark/light/xlight are derived from the primary via HSL math so one DB value drives the whole brand family. Also promoted the 6 hardcoded score-badge hex values in `scoreUtils.js` to CSS vars. Onboarding Location #2 with their own brand color is now one SQL `UPDATE`.
- **Component library (light, shared):** `Button`, `Card`, `Input`, `Modal`, `Toast`, `EmptyState`, `PageHeader`, `StatTile`, `Sheet`. Built on CSS vars we already have — no Tailwind yet unless we both want it. Kills the 22 scattered `const styles = {}` blocks.
- **Swap emoji for SVG icons** (Lucide React) across tab bar, admin navigation, and tile grids. Keep a little playfulness where it suits (splash flag is fine), but nothing that reads as "amateur."
- **Real URLs with React Router:** `/`, `/league`, `/standings`, `/profile`, `/admin`, `/admin/players`, etc. Browser back button works. Shareable links. Deep-link into a specific admin tab.
- **Loading + empty + error states** standardized — never a flash of blank screen.
- **Motion pass:** subtle, not-overdone page transitions and state changes. The splash is already strong; bring that energy to the app shell.
- **Accessibility baseline:** focus rings, ARIA on the tab bar, contrast check on the gold-on-green.

**You'll see:** a noticeably more polished app, but identical behavior. Nothing breaks for admins mid-league.

---

## Phase 3 — Scale to multi-location

Goal: adding Location #2 is a database row + a DNS record, not a new deployment.

- **Subdomain-aware LocationProvider:** reads `window.location.hostname`, looks up the matching `locations` row at boot, and wires `locationId` + theme tokens into the app. `VITE_LOCATION_ID` becomes a dev-only override.
- **Super-admin console:** a new surface (behind super_admin role in `location_admins`) to create locations, set brand colors, and promote per-location admins. You stop needing to touch SQL to onboard a new manager.
- **Location-aware alert defaults:** the send-alert PREVIEW already shows the right `appName`; we'll make sure every per-location text string (emails, push titles, meta tags) uses the resolved name.
- **Data model cleanup:** make `location_id NOT NULL` on the few tables the migration left nullable (`push_subscriptions`, `bay_services`, `bay_blocks`, `hour_overrides`). Add a `locations.timezone` column so schedules/handicap periods honor local time per location.
- **One deployment, one Vercel project:** DNS wildcard (`*.app.com`) routes every subdomain to the same build. Your old per-location Vercel projects can stay until you're ready to flip DNS over.

**You'll see:** the ability to spin up a second location in 10 minutes, end-to-end.

---

## Phase 4 — Launch polish

Goal: the second manager's day-one experience feels incredible.

- **Onboarding checklist** for new managers (set up course, add players, import schedule). First-run wizard.
- **Player-side onboarding:** first login walks a member through their profile, friends, and enabling alerts.
- **Email templates** (if not already via Supabase Auth): branded per-location with the manager's contact.
- **Reservations decision:** the current WordPress iframe is location-specific. Either keep it (and theme the surrounding chrome per-location), or flip to the native `AdminBookings.jsx` flow that's already ~1,200 lines in the tree. We'll talk through which is right before touching it.
- **Analytics hooks** so you can tell how each location is adopting the app without me or you guessing.
- **Docs and help:** a short in-app help center and a written runbook for each manager.

---

## Polish backlog (drive-by items, not a phase)

- **Friends chat: optimistic send.** When you send a message, it doesn't appear in the chat view until the realtime subscription catches it (or a refresh). Users expect their own message to appear instantly. Fix: append the message to local state immediately after the INSERT succeeds, then reconcile with realtime when it arrives. Noticed 2026-04-19.

---

## Open questions I'll bring up as we go

- Is the WordPress-iframe booking flow permanent, or is `AdminBookings.jsx` the intended replacement? That file's size suggests real work was started.
- What level of data isolation do you want between locations? (E.g. should a super_admin with permission see aggregate stats across all locations, or must every view be single-tenant?)
- Payments — are reservations paid through the iframe today? If so, that's a thing we deliberately don't touch in Phase 2/3. Otherwise Phase 4 might include a native payment flow.
- For subdomain routing, do you want to pick a parent domain now (something like `tees.app`, `indoorgolf.app`, or a neutral brand), or stick with co-branded subdomains per manager?

---

## How we work going forward

Short version: I'll ask before starting a phase, pause at each phase boundary for you to use the app and tell me what feels off, and keep this file current so you can always scroll back and see where we are. If any single session ever makes more than ~10 files of changes, I'll summarize at the top so you never need to read the whole diff.
