# Verification record

## Bay 4 integration — October 16, 2026

The final V2 archive was verified against 73,633 bytes and SHA-256 `072d335add39b5f92b66782fd8b223a48b06560ff0fe00ede8a7c6e1f05fe4ef` before applying it to the unchanged baseline below. The follow-up adds general-purpose direct-email labels and an interactive four-step owner setup guide with copyable instructions and server-confirmed account IDs.

- Vitest: 189 passed; 5 existing live integration tests skipped.
- Production Vite build: passed; existing large-chunk warning remains.
- Deno 2.9.6 type check of the actual Edge Function with its real pinned Supabase dependency: passed.
- Actual Deno handler with mocked auth/database: 7 tests passed, with no network/provider access. Run `deno test --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,RESEND_API_KEY --config scripts/email-runtime/deno.json scripts/email-runtime/check.ts`.
- Disposable PostgreSQL (PGlite 0.5.10): 7 checks passed for the exact email SQL, private grants/RLS, disabled venue defaults, one-recipient/cross-venue constraints, competing lease updates, stale-token rejection, and quota uniqueness. Run `npm run test:email:database`. PGlite serializes its single connection; these checks do not establish behavior across simultaneous live database sessions.
- Browser QA using the actual React components and a mocked email endpoint: GBIG direct preview/send/restart, blank-recipient reset, AIG direct preview with Jordan, pre-close weekly preview, and all four owner-setup steps passed. Only the mock direct endpoint was sent to; no real league or individual email was sent.
- Migration `20261016202402_weekly_email.sql` applied to project `mtuzmasicpcxcvtslevm`; its version matches remote migration history. Live queries confirm RLS on all four tables and no anon/authenticated read privileges. The security advisor's only findings for these private tables are informational RLS-with-no-policy notices, as expected for tables accessed solely by the service role.
- `weekly-email` deployed with gateway `verify_jwt=true` and in-function `auth.getUser`; missing and forged JWTs both return 401.
- A production-target frontend build is staged at `gbig-3cunog4wr-enorenberg92-oshs-projects.vercel.app`; venue-alias promotion is tracked separately below.

Still outstanding: authenticated live staff/browser checks, approved sender-user assignments, sender activation, provider/domain readiness, and an exactly approved private delivery test with inbox confirmation. Supabase's authenticated Secrets page shows `RESEND_API_KEY` absent. Both domains remain unverified from this session because Resend is signed out. No credential values were viewed or changed. Both sender records are disabled and no sender-user assignments have been added.

## Original V2 package verification (historical)

Prepared against main commit `d38bb8aeb55772026f4c7dcfbbde3f7fb85b5e40`, reverified through the GitHub connector on October 16, 2026.

## Passed

- Dependencies installed from the existing lockfile with npm ci --ignore-scripts. No dependency changes.
- Full Vitest unit suite, including existing closeout, onboarding, venue-branding, and league regression tests, plus new offline sender, direct-message isolation, per-user venue sender authorization, and component-logic tests. See packaged verification-results.txt for final counts.
- Vite production build. Existing large-chunk warning remains; it is not a build failure.
- New Edge Function TypeScript parsed/transformed using esbuild. This is a syntax check, not a Deno type check.
- Static independent review of authorization, recipient scope, lease fencing, immutable payloads, durable-before-provider writes, and retry cutoff. Static review covered the original weekly flow, the multi-venue/direct extension, and the final atomic quota and per-user/venue reload recovery. No must-fix remained in that final read-only review. Identified UI recovery issues were corrected before the final test run.
- Patch application checked against downloaded baseline source.

## Not run / not established

- Local Supabase database integration: CLI/Deno/database are not available here. The repository's five database integration cases remain intentionally skipped. New sender/history/quota table grants, per-user assignments, SQL execution, concurrent database claims and endpoint auth require local/staging integration validation.
- Deno type checking and deployed Edge Function behavior.
- Live database schema consistency, actual email key permissions, sender domain verification, sending limits, or inbox delivery.
- Browser-rendered visual/accessibility/end-to-end QA. Component tests use a hook harness rather than a browser or React DOM.

No live Supabase access, migration execution, production deployment, repository push, credential inspection/change, domain change, or real email send occurred. This is a reviewable implementation, not a production-ready deployment claim.
