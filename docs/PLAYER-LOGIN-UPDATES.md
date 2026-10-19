# Player login email corrections

Staff can correct an existing player's roster email and linked email/password login together from **Players → Manage Login**. The correction keeps the existing player and Auth account; it does not create or merge accounts.

This feature is implemented locally. **No player-login migration, Edge Function, or frontend release has been deployed for this feature yet.** Production release and live staff/player verification remain pending.

## Staff workflow

1. Open the correct venue's app, sign in with venue administrator access, and open **Players**.
2. Use **Search players…** to find the existing player. Confirm the player's identity and venue, then choose **Manage Login**. It is also available from **Edit Player** for a linked account.
3. Read the existing **Roster email**, **Login email**, **Last sign-in**, and **Email confirmation** rows. The login email comes from the linked Auth account, rather than being inferred from the roster. **Account linked** means the player has a linked account; it does not establish that the player previously signed in. An account can show **No sign-in recorded**.
4. Enter the corrected address confirmed by that player, then choose **Review email correction**. Review both the roster and login before/after values and the notice about immediate correction and old links.
5. Check **I confirmed this address and player identity, and approve changing this existing login.** Then choose **Update roster and login email**.
6. Wait for the verified result. A confirmed account can use the corrected email with its existing password. An unconfirmed account still needs its normal email verification before sign-in.

Names, handicap, skins, and other profile/league details remain in **Edit Player**. For a linked account, its roster email is read-only there, and the login password field is omitted. A player without a linked login continues through the existing **Create Account** workflow.

If the screen reports an unfinished correction or partial failure, use **Refresh login details** and give the correction ID to the account owner. Do not create a replacement account or repeatedly submit corrections. Changing the input invalidates the existing review and clears its checkbox; a fresh review is required.

## What changes and what is preserved

The only Auth mutation submitted through the supported admin API is `{ email: correctedEmail }` on the already linked user. After verifying that result, the service finalizes the existing roster row's email and reads both resources again.

- Player ID, linked Auth user ID, venue, team/history, roles, account metadata, existing password, and email confirmation state are preserved.
- The tool requests no welcome email, password reset email, or email-change confirmation email. It does not mark an unconfirmed account verified or change the project's global email verification settings.
- Previous verification or recovery links may stop working after the email correction. An unconfirmed account still follows the normal verification process.
- Whitespace is trimmed and the address is lowercased. An unchanged roster/login pair does not produce another correction.

## Authorization and blocked accounts

`update-player-login` verifies the caller's access token with `auth.getUser(jwt)` before handling `status`, `preview`, or `apply`. Service-only database functions then require a `location_admins` assignment for the player's actual venue or a `super_admins` assignment. Frontend venue selection alone does not grant access.

The tool blocks these cases before mutation and rechecks applicable conditions when applying/finalizing:

- No linked login, one Auth login shared by multiple player profiles (including across venues), or a staff/owner login.
- External-provider or mixed-provider identities instead of an email-only login.
- A pending email change on the linked login.
- The corrected address already used or pending on another Auth account, or already used by another roster profile.
- An unfinished correction, or player/account values that changed after review.

Staff/owner logins, shared accounts, provider accounts, and identity conflicts need the owner's account security process. This feature never merges profiles or accounts to resolve a conflict.

## Review, request status, and audit

Preview is read-only. The server signs a review valid for ten minutes, binding the actor, player, venue, existing Auth user, proposed address, existing roster/Auth values, and account fingerprint. Apply requires the signed review and explicit confirmation. Expired, modified, stale, or differently owned reviews are rejected.

The migration adds the private `public.player_login_updates` table. Anonymous and authenticated clients have no direct access to this table or the service RPCs. It stores durable request IDs, original/proposed values, timestamps, failure codes, and status:

| Status | Meaning |
| --- | --- |
| `applying` | The correction is reserved; Auth mutation or roster finalization is in progress or interrupted. |
| `complete` | Roster finalization completed. The service also verifies live roster/Auth values before returning success. |
| `failed` | Failure handling observed the old Auth email still present. Refresh and review current facts before any new attempt. |
| `needs_review` | The result needs owner reconciliation; Auth may have changed while the roster did not. |

An in-progress unique index serializes corrections per Auth user. While `applying` or `needs_review`, the player cannot be deleted or have its email, link, or venue changed through another editor. Linked roster email changes must use this correction path. Existing profile edits such as a name correction remain available.

`audit_events` records started, completed, failed, and needs-review outcomes, including the request ID and actor/venue context. Email values passed to audit payloads use the existing redaction helper; original and proposed addresses remain in the private request record for recovery.

Auth and the roster are two resources, so this is not one atomic transaction. A timed-out Auth write is read back before any decision; the service does not blindly repeat the API call or roll it back. An incomplete result returns the correction ID and attempts to persist its recovery status. A completed request can be verified again without another write. An attempted incomplete request is not automatically replayed.

## Owner recovery runbook

Use a trusted owner/service administration environment. Keep private account details and credentials out of chat, browser client code, screenshots, and public logs.

1. Find the correction ID in `player_login_updates` and read its current status, actor/player/venue/user IDs, original/proposed email values, failure code, and timestamps. Review the associated audit events. If saving recovery status failed, the record can still be `applying`.
2. Read the live existing Auth user with the supported Auth admin API (`getUserById`). Verify the actual email, identity providers, pending change, and confirmation state. Read the current roster row, its linked user and venue, staff/owner roles, shared links, and duplicate/pending-address conflicts again. Establish the player's identity and approved address before deciding on a repair.
3. For `applying`, only consider `service_finish_player_login_update` after live Auth is verified at the approved new email, confirmation state is preserved, and every roster/link/role/conflict check still passes. The RPC requires the original actor ID and rechecks database conditions. If those facts do not hold, reconcile the specific discrepancy with the owner instead of forcing finalization.
4. **The finish RPC currently accepts only `applying` (or returns an already `complete` result). It rejects `needs_review`.** A failed `needs_review` record therefore requires explicit owner reconciliation and an approved, audited state repair before finalization is possible. There is no automatic recovery endpoint for this case. Do not change its status merely to unlock the UI.
5. Verify both resources and the audit outcome after any approved repair, then refresh the staff screen. Preserve the request history and correction ID.

Never automatically retry an ambiguous operation, clear `players.user_id`, reset a password, create a replacement account, merge accounts, or delete a request to bypass its lock. Any necessary Auth repair uses the supported admin API; do not write directly to Auth tables with SQL. Do not disclose service-role credentials or player passwords during recovery.

## Deployment order

1. Inspect the current production project **`mtuzmasicpcxcvtslevm`**, its schema, migration history, permissions, Auth signing configuration, and release state. Confirm the dependencies used by this migration are present, and rehearse the scoped change in a disposable/staging environment.
2. After production approval, apply **only** `supabase/migrations/20261019224333_player_login_updates.sql` through the repository's reviewed migration release process. The migration directory contains mixed historical work: do not blindly run `supabase db push` over the entire directory. Record the applied migration and preserve the normal release evidence.
3. Complete a successful Deno check or deployment build, then deploy `supabase/functions/update-player-login/index.ts` after the migration. It pins `@supabase/supabase-js` to **2.101.1**, verifies the caller internally with `getUser`, and uses the service role only on the server. Inspect the project's signing support and choose the function gateway JWT verification setting accordingly. Where the signing configuration requires it, `--no-verify-jwt` is a **per-function deployment setting** for `update-player-login`; it does not disable the handler's caller verification or the project's global email verification. Do not infer the correct gateway setting from another function's deployment.
4. Release the frontend to both **Appleton** and **GBIG** apps through the repository's existing release flow, after the database and function are ready. Validate both venue aliases and authenticated venue authorization.
5. Complete live staff/player verification with approved test accounts: status reads, review/confirmation, corrected-email sign-in using the existing password, unconfirmed-account behavior, cross-venue denial, conflict handling, and recovery visibility. Confirm no onboarding/reset/confirmation request was initiated by this path.

No deployment command is executed by these notes. Backend application, function deployment, frontend release, and deployed end-to-end validation remain pending.

## Validation and limits

- `npm test`: **237 passing, 5 live integration tests skipped** at the current handoff. Service tests use synthetic accounts and cover signed reviews, authorization, conflict/stale checks, preserved confirmation, timeout readback, partial failures, and completed-request verification. PGlite tests exercise migration permissions, serialization, guarded roster edits, and audit/recovery behavior.
- `npm run build`: passed after the final review fixes.
- Deno type-checking was not completed: the runtime was unavailable and both retrieval approaches failed. A successful Deno check or deployment build is required before release; the Node service tests do not substitute for this runtime check.
- Local browser checks use synthetic data and mocked service responses. They exercise the staff flow and responsive layout; they are not deployed end-to-end evidence or proof of real Auth email delivery behavior.
- Live migration compatibility, Edge Function deployment/runtime behavior, both deployed venue flows, and owner recovery against the actual production state still need release verification.

## Visual ground truth

This is a narrow expansion of the incumbent green/white admin interface. **Manage player login** appears as an in-flow white section above the player list, with the existing button components and green primary/focus treatment. It keeps roster and login facts in separate labeled rows rather than implying they are always equal. At widths up to 520px, those labels stack above their values and the section padding reduces from 22px to 16px. The corrected-email input uses the established `--gray-600` border (`#6c757d`), white background, 8px corners, and 16px text; the section has a light gray border and 14px corners. This documents the implemented addition without establishing a new app-wide design system.
