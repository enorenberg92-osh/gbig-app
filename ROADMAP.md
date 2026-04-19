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
- ✅ **Lucide icons — first pass (shipped 2026-04-19):** `lucide-react` added. Swapped emoji for crisp SVGs on the three highest-visibility surfaces: the player league-dashboard tile grid (Standings/Profile/Sub/Friends), the admin panel left-nav and mobile chip nav (11 sections), and the top-header flag on both reservations and league headers. Icons inherit `color` from the theme, so they tint with the brand automatically. Splash ⛳, conversational emoji in toasts/copy, and the 🎯 hole-event celebration were kept intentionally.
- ✅ **Lucide icons — admin polish pass (shipped 2026-04-19):** Cleaned up the scattered structural emoji across admin detail views. `AdminDashboard.jsx` stat tiles now use `Users / Handshake / Calendar / Zap`; checklist steps use `Check / CheckCircle2 / Square`; publish/copy/email buttons use `Lock / Clipboard / Mail`; the no-active-event hero uses a 44px `CheckCircle2`. `AdminSkins.jsx` tip-strip and CTA buttons use `AlertTriangle / Target`; the "ready to calculate" hero uses a 44px `Target`. `AdminScores.jsx` sub-player inline flag now uses `AlertTriangle`. `AdminImport.jsx` checkbox ✓ uses `Check`. Intentionally kept: 🥇🥈🥉 medals, 🎉 celebration, 🦅🐦 in `SCORE_LABELS`, ⏳/📭 transient states, 🤝 social moments, and playful splash/toast emoji — they carry warmth the SVGs don't.
- ✅ **Lucide icons — secondary admin surfaces (shipped 2026-04-19):** Closed out the structural emoji across every admin detail view. `AdminHandicap`: `Settings` on the rules card, `RefreshCw` on the recalc CTA, `Lock` on the locked-player badge. `AdminLeague`: `Calendar` on schedule preview + generate button, `Globe` on the "display on website" toggle, `Check` on the working-league indicator, `X` on the delete button. `AdminPlayers`: `Users` + `Upload` on the mobile & desktop sub-nav, `User` + `Handshake` on section headers, `Lock`/`Unlock` on the handicap-lock toggle, `Target` on the skins toggle + list pill, `CheckCircle2` on "Account active", `KeyRound` on "Create Account", `BarChart3` on the view-profile button, `X` on delete buttons, `Lock` on the handicap-locked list badge. `AdminSchedule`: `Target` on the weekly hole-event card + list tag, `Ban` on the bye-week toggle + list label, `Lock` on upcoming-event indicators, `Flag` on course pills, `X` on delete. `AdminSubs`: `AlertTriangle` on the pending-sub banner, `UserCheck` on "Sub profile on file", `Check`/`X` on Approve/Deny, `Link2` on "Sync Profile". Style objects migrated from `fontSize` to flex layouts so SVGs size and align correctly. Intentionally deferred: all `showToast('✅ …')` / `showToast('✓ …')` strings will be swapped when we build the shared `Toast` component with a real icon slot (two passes through the same strings makes no sense), and the 🏌️ empty-state illustration in `AdminSubs` stays as-is until we design an `EmptyState` component.
- **Component library (light, shared):** `Button`, `Card`, `Input`, `Modal`, `Toast`, `EmptyState`, `PageHeader`, `StatTile`, `Sheet`. Built on CSS vars we already have — no Tailwind yet unless we both want it. Kills the 22 scattered `const styles = {}` blocks.
    - ✅ **Foundation primitives shipped 2026-04-19:** `src/components/ui/` now has `Button` (variants: primary/secondary/danger/ghost, sizes: sm/md/lg, icon + iconRight + loading + fullWidth props), `Toast` (fixed top-center, success/error/info palette, auto-icon), `Callout` (persistent inline banner — warning/info/success/danger tones, distinct from transient `Toast`), and `EmptyState` (icon + title + description + optional action). Exported via `../ui` barrel. `AdminSubs.jsx` migrated end-to-end as the proof-of-concept: 7 duplicated style keys deleted (`toast`, `alertBanner`, `empty`, `emptyIcon`, `approveBtn`, `denyBtn`, `removeBtn`, `syncBtn`), ✓-prefix stripped from toast strings since the `Toast` component now owns the icon. The API is validated — ready to roll out across the other admin surfaces.
    - ✅ **Batch A rollout shipped 2026-04-19:** `AdminHandicap`, `AdminLeague`, `AdminPlayers` migrated to primitives. Replaced 3 `toast` divs with `<Toast toast={toast}/>`; swapped ~18 inline `<button>` elements (add/save/cancel/edit/delete/profile/create-account/load/generate/recalc) for `<Button>` with the right variant + size + loading state; replaced 4 ad-hoc "empty" paragraphs with `<EmptyState>` (no-players, no-leagues, no-teams, search-for-player). Stripped `✓` / `✅` prefixes from 4 toast message strings since `Toast` now owns the icon. Deleted 14 duplicated style keys across the three files (`toast`, `recalcBtn`, `empty` from Handicap; `toast`, `addBtn`, `empty`, `editBtn`, `deleteBtn`, `generateBtn`, `saveBtn`, `cancelBtn` from League; `toast`, `addBtn`, `saveBtn`, `cancelBtn`, `empty`, `profileBtn`, `editBtn`, `deleteBtn`, `createAccountBtn` from Players). Form-submit buttons now get proper `loading={saving} loadingText="Saving…"` states for free.
    - ✅ **Batch B rollout shipped 2026-04-19:** `AdminSchedule`, `AdminDashboard`, `AdminAlerts` migrated. Replaced 2 `toast` divs with `<Toast/>`; `AdminSchedule` got its create-event CTA, form save/cancel pair, per-row close/reopen/edit/delete actions swapped to `<Button>` variants with `Plus` / `Calendar` / `X` icons; `AdminAlerts` got its send CTA swapped to `<Button icon={<Megaphone/>}>` with proper `loading={sending}` state, 📣 emoji dropped in favor of the Lucide icon, ✅ stripped from the success toast string; both files got their "no events yet" / "no alerts sent" paragraphs replaced with `<EmptyState>`. `AdminDashboard` took a targeted migration — only the final `publishBtn` was swapped (`loading={publishing}` + `Lock` icon); the bespoke 4-step checklist `nextBtn`s and the email `copyBtn`/`mailtoBtn` were intentionally left as custom inline buttons since they're a tight one-off pattern where migration would be lower-value than a pure CRUD screen. Deleted 13 duplicated style keys across the three files (`toast`, `addBtn`, `saveBtn`, `cancelBtn`, `empty`, `closeBtn`, `reopenBtn`, `editBtn`, `deleteBtn` from Schedule; `publishBtn` from Dashboard; `toast`, `sendBtn`, `emptyText` from Alerts).
    - ✅ **Batch C rollout shipped 2026-04-19:** `AdminImport`, `AdminScores`, `AdminSkins` migrated. Replaced 3 `toast` divs with `<Toast/>`. `AdminImport` got its import/clear/import-another CTAs swapped to `<Button>` variants, the 📥 section title and 📂 upload icon replaced with crisp Lucide `Upload`/`FolderOpen`, and structural ✓ stripped from the success toast. `AdminScores` got the 🎯 Calculate Skins CTA and Skins Results heading swapped to `Target`; per-team `editBtn`/`enterBtn`/`saveBtn`/`cancelBtn` all migrated to `<Button>` with `Plus` icon on "Enter Scores" and proper `loading={saving}` state on "Save Scores"; ✓ stripped from the save toast. `AdminSkins` got the "Run Skin Report" CTA migrated to `<Button icon={<Target/>} loading={calculating}>` and both hero prompts (Ready to calculate / No skins scores found) converted to `<EmptyState>` — 📭 emoji dropped in favor of the `Inbox` Lucide. Deleted 11 duplicated style keys across the three files (`toast`, `importBtn`, `cancelBtn` from Import; `toast`, `skinsBtn`, `editBtn`, `enterBtn`, `saveBtn`, `cancelBtn` from Scores; `toast`, `runBtn`, `promptCard`, `promptTitle`, `promptSub` from Skins).
    - ✅ **Batch D rollout shipped 2026-04-19:** `AdminNews`, `AdminCourses` migrated. Both got their "Add/Write New" CTAs swapped to `<Button icon={<Plus/>}>`, form save/cancel pairs swapped to `<Button loading={saving} loadingText="…"/>` + `<Button variant="secondary"/>`, per-row Edit/Delete pairs swapped to green-xlight `<Button secondary>` + `<Button danger icon={<X/>}/>`, and "No posts/courses yet" paragraphs swapped to `<EmptyState>` with `FileText` / `Flag` icons. Replaced 2 `toast` divs with `<Toast/>`. Deleted 10 duplicated style keys across the two files. `AdminStandings` is a thin wrapper around the player-facing `Standings` component — no primitives to migrate. `AdminBookings` (~1,210 lines) has only one primitive-shaped button and its long-term fate is still undecided (WordPress iframe vs. native flow, per Phase 4), so it's **intentionally deferred** until the reservations direction is locked in. `AdminPanel` is the outer tab shell, navigation only.
    - ✅ **Primitive rollout complete.** Every active admin surface (Handicap, League, Players, Schedule, Dashboard, Alerts, Scores, Skins, Import, Subs, News, Courses) now shares the same `Button` / `Toast` / `Callout` / `EmptyState` vocabulary. Style files have had ~47 duplicated inline button/toast/empty style keys stripped out as a side effect. Form-submit buttons everywhere now get consistent `loading` / `loadingText` states, every toast uses the same positioning/palette/auto-icon, and every empty state has icon + title + description structure.
    - ✅ **Next-wave primitives shipped 2026-04-19:** `Card`, `PageHeader`, `StatTile`, `TabGroup` added to `src/components/ui/`. `Card` canonicalizes the white-surface-with-optional-title-row pattern used across 18+ admin locations (title, count pill, right-side actions slot, tone variants: default/dark/off-white, padding: sm/md/lg/none). `PageHeader` is the screen-level title + subtitle + icon + actions slot (default and `hero` tone — the green-dark treatment used in `AdminDashboard`'s closeout card). `StatTile` is the icon + value + label grid tile used in both `AdminDashboard`'s stat strip (size=`sm`, the default — 30px value, 11px uppercase gray label) and `LeagueDashboard`'s 2×2 grid (size=`md` — 28px value, 14px green-dark mixed-case label); supports `onClick` (renders as button), `disabled` dim, and a corner `badge` for the "Soon" pill. `TabGroup` has two variants: `pill` (full-width rounded pills, as in `FriendsTab` Following/Followers/Requests and `AdminSubs` Pending/Approved/All) and `underline` (horizontal scrolling row with underline-on-active, as in `AdminDashboard`'s 5-step closeout bar). All four exported via the `../ui` barrel. API is validated against the patterns they replace — ready to drive the player-facing rollout.
    - ✅ **Player rollout — Batch P1 shipped 2026-04-19:** `LeagueDashboard` + `FriendsTab` migrated. `LeagueDashboard`: 2×2 tile grid (Standings / My Profile / Request Sub / Friends) swapped to `<StatTile size="md">` with `badge="Soon"` for disabled tiles; "Open Admin Panel" CTA swapped to `<Button>` with `Shield` icon and green-dark override. Dropped `tile`, `tileDimmed`, `tileLabel`, `comingSoon`, `adminPanelBtn` style keys. `FriendsTab`: manual `toast` div swapped to `<Toast/>`; "Player record not linked" empty-state swapped to `<EmptyState icon={<Users/>}/>`; Following/Followers tabs swapped to `<TabGroup variant="pill">`; search `+ Follow` and `Follow Back` swapped to `<Button variant="primary" size="sm" icon={<Plus/>}>`; `Unfollow` / `Remove` swapped to `<Button variant="danger" size="sm">`; 💬 message button swapped to `<Button variant="ghost" icon={<MessageSquare/>}>`; 🔍 label prefix replaced with `Search` Lucide; 🤝 in Mutual pill replaced with `Handshake` Lucide; `Following ✓` pill now uses a `Check` SVG; ConversationView's Send button swapped to `<Button icon={<Send/>}>`. Dropped 12 duplicated style keys across the file (`toast`, `emptyState`, `emptyIcon`, `emptyTitle`, `emptySub`, `tabRow`, `tabBtn`, `tabBtnActive`, `tabCount`, `msgBtn`, `followBtn`, `unfollowBtn`, `removeBtn`, `sendBtn`). Intentionally kept: the bespoke `scoresBanner` in `LeagueDashboard` (specialized 2-state pattern — no primitive fits), `PlayerAvatar` (domain-specific circle avatar), `ConversationView` message bubbles (chat-specific layout).
    - ✅ **Player rollout — Batch P2 shipped 2026-04-19:** `ScoreEntry` + `PlayerProfile` migrated. `ScoreEntry`: manual `toast` div swapped to `<Toast/>`; Prev/Next hole nav swapped to `<Button variant="secondary" icon={<ArrowLeft/>}>` + `<Button variant="primary" iconRight={<ArrowRight/>}>`; Submit swapped to `<Button icon={<Check/>} loading={saving} loadingText="Saving…">`; Error-state and Done-state back buttons swapped to `<Button icon={<ArrowLeft/>}>`; structural `✓` stripped from Submit now that the icon is the `Check` SVG. Dropped `backBtn`, `backBtn2`, `toast`, `navBtn`, `nextBtn`, `submitBtn` style keys. `PlayerProfile`: CropModal Cancel/Confirm swapped to `<Button>` pair (primary uses `Check` icon); 🔍/🔎 zoom icons replaced with `ZoomOut`/`ZoomIn` Lucide; 📷 camera badge replaced with `Camera` Lucide (⏳ upload state kept — only visible for a brief moment); error-state back button swapped to `<Button icon={<ArrowLeft/>}>`; 📭 "no rounds" empty-state swapped to `<EmptyState icon={<Inbox/>}>` (styled as a card); inline `pwMsg` banner swapped to `<Callout tone="danger|success">`; Update Password button swapped to `<Button loading={pwSaving} loadingText="Saving…">`. Dropped `cancelBtn` + `confirmBtn` + `zoomIcon` from the CropModal style block and `backBtn` + `empty` + `pwMsg` + `pwBtn` from the main style block. Intentionally kept: ⛳ loading spinner, the bespoke welcome-hero `heroCard` + stat-row `tilesRow` (specialized 3-stat-with-subtitle pattern no primitive fits), and the in-card metric toggle (gross/net/handicap — small inline 3-pill is visually distinct from `TabGroup`). `ReservationsPage` is a pure WordPress iframe wrapper — no primitives to migrate; its long-term direction is still pending per Phase 4. **Player rollout complete.**
    - **Further primitives worth adding** as patterns emerge across the remaining work: `Input` (password change, search, form inputs across admin), `Modal` (crop modal, future confirm dialogs), `Sheet` (mobile drawer pattern for admin nav), `Avatar` (formalize the circle-with-initials-or-image pattern used in ~5 places).
    - ✅ **`Input` primitive shipped 2026-04-19:** `src/components/ui/Input.jsx` added. API: `label` (uppercase eyebrow above), `type` (native text/email/password/search/number/date pass-through), `size` (sm/md/lg), `prefixIcon` / `suffixIcon` (Lucide elements rendered inside the left/right edge with text inset accordingly), `helperText`, `error` (red border + red message below), `fullWidth` (default true), and full native-input passthrough (value/onChange/placeholder/required/autoComplete/min/max/step). Uses `forwardRef` so callers can grab the underlying input. Built-in focus ring — 3px `--green-xlight` shadow on focus, red shadow on focus-while-error — driven by local `focused` state since inline styles can't do `:focus`. Seeded with three migrations to prove the API: PlayerProfile password form (2 `<Input type="password">`s, dropped `pwInput` style key), AdminPlayers search box (`<Input type="search" prefixIcon={<Search/>}/>`, dropped `searchInput` style key), FriendsTab find-a-player search (`<Input label=… prefixIcon={<Search/>}/>`, dropped `label` + `searchInput` style keys). Select/date-picker and the specialized `ScoreEntry` ±-box are intentionally NOT part of this primitive — they have different semantics and will land as separate components.
- **Swap emoji for SVG icons** (Lucide React) across tab bar, admin navigation, and tile grids. Keep a little playfulness where it suits (splash flag is fine), but nothing that reads as "amateur."
- **Real URLs with React Router:** `/`, `/league`, `/standings`, `/profile`, `/admin`, `/admin/players`, etc. Browser back button works. Shareable links. Deep-link into a specific admin tab.
- **Loading + empty + error states** standardized — never a flash of blank screen.
- ✅ **Motion pass — primitive layer (shipped 2026-04-19):** Three subtle keyframes added to `index.css` — `uiToastIn` (slide down from top with fade), `uiFadeUp` (6px up + fade, used by `Callout` + `EmptyState`), `uiFadeIn` (pure opacity). `Toast`, `Callout`, and `EmptyState` now animate in instead of appearing instantly. `Button` and `StatTile` (when interactive) get a shared `ui-pressable` class that adds `translateY(1px) scale(0.995)` on `:active` — gives every tap a tactile "press" feel. All animations are gated by a global `prefers-reduced-motion: reduce` media query that clamps durations to 0.001ms — respects the user's OS accessibility preference. Button's inline `transition` was moved into `ui-pressable` so the class also drives color/background/opacity transitions. Bigger page-level motion (route transitions, tile-grid stagger, etc.) is deferred until React Router lands.
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
